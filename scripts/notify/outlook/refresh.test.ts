import { describe, expect, it } from "vitest";
import { refreshOutlook, type OutlookDeps, type OutlookTarget } from "./refresh";
import { memoryStore } from "../news/testFakes";
import { OUTLOOK_PATH, validateOutlookFile, type ImpliedBand, type OutlookFile } from "../../../src/lib/outlook";

const NOW = new Date(2026, 9, 13, 6, 50);
const r = (raw: number) => ({ raw, fmt: String(raw) });

const stockJson = {
  quoteSummary: {
    result: [
      {
        price: { quoteType: "EQUITY", currency: "HUF" },
        financialData: {
          numberOfAnalystOpinions: r(13),
          targetLowPrice: r(38_000),
          targetMeanPrice: r(45_525),
          targetHighPrice: r(52_900),
        },
        recommendationTrend: { trend: [{ strongBuy: 2, buy: 5, hold: 6, sell: 0, strongSell: 0 }] },
      },
    ],
  },
};
const etfJson = { quoteSummary: { result: [{ price: { quoteType: "ETF", currency: "EUR" } }] } };

const band: ImpliedBand = {
  underlying: "BTC",
  horizonDays: 90,
  expiry: "2027-01-15",
  spot: 83_000,
  forward: 84_000,
  p10: 65_000,
  p50: 83_000,
  p90: 105_000,
  probUp: 0.49,
  asOf: "2026-10-13",
};

const stock: OutlookTarget = { key: "S", name: "Példa Bank", isin: "HU0000000001", currency: "HUF", type: "stock" };
const btc: OutlookTarget = { key: "B", name: "Példa Physical Bitcoin ETP", isin: "GB0000000001", currency: "EUR", type: "etf" };
const world: OutlookTarget = { key: "W", name: "Példa FTSE All-World UCITS ETF", isin: "IE0000000001", currency: "EUR", type: "etf" };

function deps(over: Partial<OutlookDeps> = {}, files: Record<string, string> = {}) {
  const store = memoryStore(files);
  const bandCalls: string[] = [];
  const d: OutlookDeps = {
    resolve: async (t) => `${t.key}.SYM`,
    fetch: async (s) => (s.startsWith("S") ? stockJson : etfJson),
    bands: async (u) => {
      bandCalls.push(u);
      return [band];
    },
    store,
    ...over,
  };
  return { d, store, bandCalls };
}

const written = (store: { files: Record<string, string> }) => JSON.parse(store.files[OUTLOOK_PATH]) as OutlookFile;

describe("refreshOutlook", () => {
  it("each asset gets the sources its profile calls for, nothing hard-wired", async () => {
    const { d, store, bandCalls } = deps();
    const { file } = await refreshOutlook([stock, btc, world], d, NOW);
    expect(file.profiles.S.assetClass).toBe("equity");
    expect(file.profiles.B).toMatchObject({ assetClass: "crypto", underlying: "BTC", source: "rule" });
    expect(file.profiles.W.assetClass).toBe("equity_fund");
    expect(file.items.S.consensus?.[0]).toMatchObject({ source: "yahoo", target: { avg: 45_525, count: 13 } });
    expect(file.items.B.implied).toEqual([band]);
    expect(file.items.W).toBeUndefined();
    expect(bandCalls).toEqual(["BTC"]);
    expect(validateOutlookFile(written(store), NOW)).not.toBeNull();
    expect(store.writes).toEqual([OUTLOOK_PATH]);
  });

  it("a fund-typed asset is an equity fund by rule; Yahoo having nothing is no error", async () => {
    const fund: OutlookTarget = { key: "O", name: "Valami", isin: "X", currency: "HUF", type: "fund" };
    const { d } = deps({ fetch: async () => null });
    const { file } = await refreshOutlook([fund], d, NOW);
    expect(file.profiles.O.assetClass).toBe("equity_fund");
    expect(file.items.O).toBeUndefined();
    expect(file.errors).toEqual({});
  });

  it("keeps the AI's profile, issuer consensus and views, and refreshes the rest", async () => {
    const prev: OutlookFile = {
      v: 1,
      updatedAt: "2026-10-12T05:00:00Z",
      profiles: { S: { assetClass: "equity", consensusUrl: "https://example.com/c", source: "ai", checkedAt: "2026-10-10" } },
      items: {
        S: {
          consensus: [
            { source: "issuer", asOf: "2026-08-03", currency: "HUF", target: { min: 29_000, avg: 45_888, max: 58_667, count: 17 } },
            { source: "yahoo", asOf: "2026-10-12", currency: "HUF", target: { min: 1, avg: 2, max: 3 } },
          ],
          views: [
            { house: "UBS", kind: "target", value: 52_900, unit: "HUF", publishedAt: "2026-07-20", url: "https://example.com/ubs" },
          ],
        },
      },
      errors: {},
    };
    const { d } = deps({}, { [OUTLOOK_PATH]: JSON.stringify(prev) });
    const { file } = await refreshOutlook([stock], d, NOW);
    expect(file.profiles.S.source).toBe("ai");
    expect(file.profiles.S.consensusUrl).toBe("https://example.com/c");
    expect(file.items.S.consensus?.map((c) => c.source)).toEqual(["yahoo", "issuer"]);
    expect(file.items.S.consensus?.[0].target.avg).toBe(45_525);
    expect(file.items.S.views).toHaveLength(1);
  });

  it("a failed Yahoo call keeps the last good consensus and records the error", async () => {
    const first = deps();
    await refreshOutlook([stock], first.d, new Date(2026, 9, 10, 6, 50));
    const { d, store } = deps(
      {
        fetch: async () => {
          throw new Error("503");
        },
      },
      { ...first.store.files },
    );
    const { file } = await refreshOutlook([stock], d, NOW);
    expect(file.items.S.consensus?.[0].asOf).toBe("2026-10-10");
    expect(file.errors.S).toMatchObject({ message: "503" });
    expect(written(store).errors.S.message).toBe("503");
  });

  it("a failed Deribit call keeps the old band; a failing Yahoo does not matter for crypto", async () => {
    const first = deps();
    await refreshOutlook([btc], first.d, new Date(2026, 9, 10, 6, 50));
    const { d } = deps(
      {
        fetch: async () => {
          throw new Error("yahoo down");
        },
        bands: async () => {
          throw new Error("deribit down");
        },
      },
      { ...first.store.files },
    );
    const { file } = await refreshOutlook([btc], d, NOW);
    expect(file.items.B.implied).toEqual([band]);
    expect(file.errors.B.message).toBe("deribit down");

    const ok = deps({ fetch: async () => { throw new Error("yahoo down"); } });
    const res = await refreshOutlook([btc], ok.d, NOW);
    expect(res.file.errors).toEqual({});
    expect(res.file.items.B.implied).toEqual([band]);
  });

  it("the instrument's own name can be a bare ticker: Yahoo's long name makes it a crypto product", async () => {
    const wbit: OutlookTarget = { key: "B", name: "WBIT", isin: "GB0000000001", currency: "EUR", type: "etf" };
    const named = {
      quoteSummary: { result: [{ price: { quoteType: "ETF", currency: "EUR", longName: "WisdomTree Physical Bitcoin" } }] },
    };
    const { d } = deps({ fetch: async () => named });
    const { file } = await refreshOutlook([wbit], d, NOW);
    expect(file.profiles.B).toMatchObject({ assetClass: "crypto", underlying: "BTC" });
    expect(file.items.B.implied).toEqual([band]);
  });

  it("when Yahoo does not answer, a known rule profile stays (the band does not vanish)", async () => {
    const wbit: OutlookTarget = { key: "B", name: "WBIT", isin: "GB0000000001", currency: "EUR", type: "etf" };
    const named = {
      quoteSummary: { result: [{ price: { quoteType: "ETF", currency: "EUR", longName: "WisdomTree Physical Bitcoin" } }] },
    };
    const first = deps({ fetch: async () => named });
    await refreshOutlook([wbit], first.d, new Date(2026, 9, 10, 6, 50));
    const { d } = deps(
      {
        fetch: async () => {
          throw new Error("yahoo down");
        },
      },
      { ...first.store.files },
    );
    const { file } = await refreshOutlook([wbit], d, NOW);
    expect(file.profiles.B).toMatchObject({ assetClass: "crypto", underlying: "BTC" });
    expect(file.items.B.implied).toEqual([band]);
  });

  it("a crypto asset with no option market keeps no band and no error", async () => {
    const { d } = deps({ bands: async () => null });
    const { file } = await refreshOutlook([btc], d, NOW);
    expect(file.items.B).toBeUndefined();
    expect(file.errors).toEqual({});
  });

  it("warns once a week after three days of failure, and stays quiet when it recovers", async () => {
    const failing = (n: number) => deps({ fetch: async () => { throw new Error("503"); } }, n === 0 ? {} : undefined);
    const day = (n: number) => new Date(2026, 9, 5 + n, 6, 50);
    let files: Record<string, string> = {};
    const msgs: number[] = [];
    for (let n = 0; n < 10; n++) {
      const f = deps({ fetch: failing(0).d.fetch }, files);
      const { messages } = await refreshOutlook([stock], f.d, day(n));
      files = f.store.files;
      msgs.push(messages.length);
    }
    // since = day 0; alert from day 3, then not again until day 10
    expect(msgs).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const ok = deps({}, files);
    const res = await refreshOutlook([stock], ok.d, day(10));
    expect(res.file.errors).toEqual({});
    expect(res.file.notifiedAt).toBeUndefined();
  });

  it("an asset that is no longer held drops out", async () => {
    const first = deps();
    await refreshOutlook([stock, btc], first.d, new Date(2026, 9, 10, 6, 50));
    const { d } = deps({}, { ...first.store.files });
    const { file } = await refreshOutlook([stock], d, NOW);
    expect(Object.keys(file.profiles)).toEqual(["S"]);
    expect(file.items.B).toBeUndefined();
  });
});
