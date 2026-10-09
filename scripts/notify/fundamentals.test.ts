import { describe, expect, it } from "vitest";
import { parseQuoteSummary, refreshFundamentals, type FundamentalsTarget } from "./fundamentals";
import { memoryStore } from "./news/testFakes";
import { FUNDAMENTALS_PATH, sectorExposure, validateFundamentalsFile, type FundamentalsFile } from "../../src/lib/fundamentals";

const r = (raw: number) => ({ raw, fmt: String(raw) });

const etf = {
  quoteSummary: {
    result: [
      {
        price: { quoteType: "ETF", currency: "EUR", symbol: "VWCE.DE" },
        summaryDetail: { totalAssets: r(85_316_706_304), currency: "EUR" },
        defaultKeyStatistics: { fundFamily: "Vanguard Group (Ireland) Limited" },
        fundProfile: { family: "Vanguard Group (Ireland) Limited" },
        topHoldings: {
          equityHoldings: { priceToEarnings: r(0.05), priceToBook: r(0.25) },
          sectorWeightings: [{ technology: r(0.317) }, { financial_services: r(0.1675) }, { energy: r(0) }],
          holdings: [{ holdingName: "NVIDIA Corp", holdingPercent: r(0.048) }],
        },
      },
    ],
    error: null,
  },
};

const stock = {
  quoteSummary: {
    result: [
      {
        price: { quoteType: "EQUITY", currency: "USD" },
        summaryDetail: {
          trailingPE: r(38.27),
          forwardPE: r(34.8),
          dividendYield: r(0.0032),
          marketCap: r(4.87e12),
          beta: r(1.069),
        },
        defaultKeyStatistics: { priceToBook: r(45.3) },
        summaryProfile: { sector: "Technology", industry: "Consumer Electronics", country: "United States" },
        calendarEvents: { earnings: { earningsDate: [r(1793649600)] } },
      },
    ],
    error: null,
  },
};

const NOW = new Date("2026-10-09T05:00:00Z");

describe("parseQuoteSummary", () => {
  it("an ETF: sectors, top holdings, size; its P/E and P/B come inverted from Yahoo", () => {
    const f = parseQuoteSummary(etf, "VWCE.DE", NOW);
    expect(f).toMatchObject({
      symbol: "VWCE.DE",
      quoteType: "ETF",
      totalAssets: 85_316_706_304,
      family: "Vanguard Group (Ireland) Limited",
      sectors: [
        { name: "technology", weight: 0.317 },
        { name: "financial_services", weight: 0.1675 },
      ],
      topHoldings: [{ name: "NVIDIA Corp", weight: 0.048 }],
    });
    expect(f.pe).toBeCloseTo(20);
    expect(f.pb).toBeCloseTo(4);
    expect(f.forwardPe).toBeUndefined();
  });

  it("a stock: P/E, forward P/E, dividend, market cap, sector and the next earnings day", () => {
    expect(parseQuoteSummary(stock, "AAPL", NOW)).toMatchObject({
      pe: 38.27,
      forwardPe: 34.8,
      pb: 45.3,
      dividendYield: 0.0032,
      marketCap: 4.87e12,
      sector: "Technology",
      industry: "Consumer Electronics",
      nextEarnings: "2026-11-02",
    });
  });

  it("an empty or error answer is an error", () => {
    expect(() => parseQuoteSummary({ quoteSummary: { result: null, error: { description: "Not Found" } } }, "X", NOW)).toThrow(
      "Not Found",
    );
    expect(() => parseQuoteSummary(null, "X", NOW)).toThrow();
  });
});

describe("refreshFundamentals", () => {
  const targets: FundamentalsTarget[] = [
    { key: "IE00BK5BQT80", name: "VWCE", isin: "IE00BK5BQT80", currency: "EUR" },
    { key: "US0378331005", name: "Apple", isin: "US0378331005", currency: "USD" },
  ];
  const deps = (store: ReturnType<typeof memoryStore>, failing = new Set<string>()) => ({
    store,
    resolve: async (t: FundamentalsTarget) => (t.name === "VWCE" ? "VWCE.DE" : "AAPL"),
    fetch: async (symbol: string) => {
      if (failing.has(symbol)) throw new Error("401 Unauthorized");
      return symbol === "AAPL" ? stock : etf;
    },
  });
  const stored = (store: ReturnType<typeof memoryStore>) =>
    validateFundamentalsFile(JSON.parse(store.files[FUNDAMENTALS_PATH])) as FundamentalsFile;
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 5));

  it("writes every held paper's data to the sync repo", async () => {
    const store = memoryStore();
    const { messages } = await refreshFundamentals(targets, deps(store), at(9));
    expect(messages).toEqual([]);
    expect(Object.keys(stored(store).items)).toEqual(["IE00BK5BQT80", "US0378331005"]);
    expect(stored(store).errors).toEqual({});
  });

  it("a failing paper keeps its last data; after 3 days of failing the bot says so, then at most weekly", async () => {
    const store = memoryStore();
    await refreshFundamentals(targets, deps(store), at(1));
    const fail = new Set(["AAPL"]);
    for (const day of [2, 3, 4]) expect((await refreshFundamentals(targets, deps(store, fail), at(day))).messages).toEqual([]);
    expect(stored(store).items["US0378331005"].pe).toBe(38.27);
    expect(stored(store).errors["US0378331005"]).toEqual({ since: at(2).toISOString(), message: "401 Unauthorized" });

    const first = await refreshFundamentals(targets, deps(store, fail), at(5));
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("Apple: 401 Unauthorized (2026-10-02 óta)");
    for (const day of [6, 7, 8, 9, 10, 11]) expect((await refreshFundamentals(targets, deps(store, fail), at(day))).messages).toEqual([]);
    expect((await refreshFundamentals(targets, deps(store, fail), at(12))).messages).toHaveLength(1);

    await refreshFundamentals(targets, deps(store), at(13));
    expect(stored(store).errors).toEqual({});
    expect(stored(store).notifiedAt).toBeUndefined();
  });

  it("a damaged stored file does not stop the job", async () => {
    const store = memoryStore({ [FUNDAMENTALS_PATH]: "{csonka" });
    const { file } = await refreshFundamentals(targets, deps(store), at(9));
    expect(Object.keys(file.items)).toHaveLength(2);
  });

  it("a broken Yahoo session fails every paper the same way", async () => {
    const store = memoryStore();
    const broken = {
      ...deps(store),
      fetch: async () => {
        throw new Error("a Yahoo crumb-kérés nem sikerült (429)");
      },
    };
    await refreshFundamentals(targets, broken, at(1));
    expect(Object.values(stored(store).errors).map((e) => e.message)).toEqual([
      "a Yahoo crumb-kérés nem sikerült (429)",
      "a Yahoo crumb-kérés nem sikerült (429)",
    ]);
  });
});

describe("sectorExposure", () => {
  it("looks through ETFs by their sector weights; a stock counts fully to its own sector", () => {
    const file = validateFundamentalsFile({
      v: 1,
      updatedAt: NOW.toISOString(),
      items: {
        A: { symbol: "A", fetchedAt: NOW.toISOString(), sectors: [{ name: "technology", weight: 0.6 }, { name: "energy", weight: 0.4 }] },
        B: { symbol: "B", fetchedAt: NOW.toISOString(), sector: "Technology" },
      },
      errors: {},
    });
    const e = sectorExposure(
      [
        { key: "A", valueHuf: 1_000 },
        { key: "B", valueHuf: 1_000 },
        { key: "C", valueHuf: 2_000 },
      ],
      file,
    );
    expect(e.coveredHuf).toBe(2_000);
    expect(e.totalHuf).toBe(4_000);
    expect(e.sectors).toEqual([
      { name: "technology", weight: 0.8 },
      { name: "energy", weight: 0.2 },
    ]);
  });
});
