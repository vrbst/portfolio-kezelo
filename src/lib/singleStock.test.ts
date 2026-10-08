import { describe, expect, it, vi } from "vitest";
import {
  fetchLiveFx,
  fxCurrencies,
  mergeDatedSeries,
  refinedInstrumentType,
} from "./prices";
import { buildFxHistory, computePortfolio, histFxRate } from "./portfolio";
import { liveDayOverrides, valueOnDay } from "./series";
import { assignByAssetClass, withAssignments } from "./glidePath";
import { allocationState, unassignedAlerts } from "./rebalance";
import { parseLightyear } from "./parsers/lightyear";
import type { Instrument } from "./model";
import { glideConfig, instruments as fixtureInstruments, VWCE } from "../test/fixture";

const LY_HEADER =
  "Date,Reference,Ticker,ISIN,Type,Quantity,CCY,Price/share,Gross Amount,FX Rate,Fee,Net Amt.,Tax Amt.";
const AAPL = "US0378331005";
const OTP = "HU0000061726";

const statement = [
  LY_HEADER,
  "02/01/2026 09:00:00,DEP-1,,,Deposit,,HUF,,1000000,,,1000000,",
  "02/01/2026 09:10:00,CV-1,HUF,,Conversion,,HUF,,-400000,,,-400000,",
  "02/01/2026 09:10:00,CV-1,EUR,,Conversion,,EUR,,1000,,,1000,",
  "05/01/2026 09:10:00,CV-2,EUR,,Conversion,,EUR,,-500,,,-500,",
  "05/01/2026 09:10:00,CV-2,USD,,Conversion,,USD,,580,,,580,",
  "05/01/2026 15:30:00,OR-1,AAPL,US0378331005,Buy,2,USD,250,500,,,-500,",
  "06/01/2026 10:30:00,OR-2,OTP,HU0000061726,Buy,10,HUF,30000,300000,,,-300000,",
].join("\n");

function imported() {
  const out = parseLightyear("AccountStatement_LY-TESZT26.csv", statement);
  const account = { ...out.accounts[0], kind: "tbsz" as const, tbszYear: 2026 };
  return { ...out, account, instMap: new Map(out.instruments.map((i) => [i.key, i])) };
}

const yahooChart = (price: number, instrumentType?: string) => ({
  chart: { result: [{ meta: { regularMarketPrice: price, instrumentType } }] },
});

describe("USD-ben jegyzett részvény", () => {
  it("a jelen lévő devizák mind lekérendők, a HUF nem", () => {
    const { instruments, transactions } = imported();
    expect(fxCurrencies(instruments, transactions)).toEqual(["EUR", "USD"]);
    expect(fxCurrencies([])).toEqual(["EUR"]);
  });

  it("a live FX minden kért devizát hoz, nem csak az EUR-t", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const target = decodeURIComponent(decodeURIComponent(url));
      asked.push(target);
      const rate = target.includes("USDHUF=X") ? 345 : 400;
      return { ok: true, json: async () => yahooChart(rate) };
    });
    try {
      const fx = await fetchLiveFx(["EUR", "USD"]);
      expect(fx.EUR.price).toBe(400);
      expect(fx.USD.price).toBe(345);
      expect(asked.some((u) => u.includes("USDHUF=X"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("EUR→USD váltásból is lesz USD/HUF árfolyam (a bekerülési értékhez)", () => {
    const { transactions } = imported();
    const hist = buildFxHistory(transactions);
    const usd = histFxRate(hist, "USD", "2026-01-05T16:00:00", {});
    expect(usd).toBeCloseTo((400 * 500) / 580, 6);
  });

  it("USD-árfolyammal a pozíció forintértéke helyes, nincs hiányzó deviza", () => {
    const { account, transactions, instMap } = imported();
    const prices = new Map([
      [AAPL, 260],
      [OTP, 33000],
    ]);
    const s = computePortfolio([account], transactions, instMap, prices, { EUR: 400, USD: 345 });
    expect(s.missingFxCcys).toEqual([]);
    const aapl = s.accounts[0].holdings.find((h) => h.instrumentKey === AAPL)!;
    expect(aapl.marketValueHuf).toBeCloseTo(2 * 260 * 345, 6);
    expect(aapl.costBasisHuf).toBeCloseTo(500 * ((400 * 500) / 580), 6);
  });

  it("az értéksor a history USD/HUF árfolyamával számol", () => {
    const { account, transactions, instMap } = imported();
    const history = {
      prices: { [AAPL]: [["2026-01-07", 260]] as [string, number][] },
      fx: {
        EUR: [["2026-01-07", 400]] as [string, number][],
        USD: [["2026-01-07", 350]] as [string, number][],
      },
    };
    const v = valueOnDay([account], transactions, instMap, { EUR: 400 }, history, "2026-01-07");
    const withoutUsd = valueOnDay(
      [account],
      transactions,
      instMap,
      { EUR: 400 },
      { ...history, fx: { EUR: history.fx.EUR } },
      "2026-01-07",
    );
    expect(v.value - withoutUsd.value).toBeCloseTo((2 * 260 + 80) * (350 - (400 * 500) / 580), 4);
  });

  it("a mai mozgásnál a USD tegnapi záróárfolyama is számít", () => {
    const now = new Date(2026, 0, 7, 12);
    const o = liveDayOverrides(
      {
        EUR: { price: 401, prevClose: 400, marketTime: now.getTime() },
        USD: { price: 346, prevClose: 344, marketTime: now.getTime() },
        [AAPL]: { price: 260, prevClose: 255, marketTime: now.getTime() },
      },
      (k) => k === AAPL,
      "2026-01-07",
    );
    expect(o?.fx).toEqual({ EUR: 400, USD: 344 });
    expect(o?.prices).toEqual({ [AAPL]: 255 });
  });
});

describe("részvény típus", () => {
  const etf = (over: Partial<Instrument> = {}): Instrument => ({
    key: AAPL,
    name: "AAPL",
    type: "etf",
    currency: "USD",
    ...over,
  });

  it("a Lightyear import mindent ETF-nek vesz, a Yahoo EQUITY típusa részvénnyé javítja", () => {
    expect(imported().instruments.every((i) => i.type === "etf")).toBe(true);
    expect(refinedInstrumentType(etf(), { price: 1, quoteType: "EQUITY" })).toBe("stock");
    expect(refinedInstrumentType(etf({ type: "stock" }), { price: 1, quoteType: "ETF" })).toBe("etf");
  });

  it("nem nyúl hozzá: kézi típus, MUTUALFUND (.SG-listák), ismeretlen, nem tőzsdei papír", () => {
    expect(refinedInstrumentType(etf({ typeManual: true }), { price: 1, quoteType: "EQUITY" })).toBeUndefined();
    expect(refinedInstrumentType(etf(), { price: 1, quoteType: "MUTUALFUND" })).toBeUndefined();
    expect(refinedInstrumentType(etf(), { price: 1 })).toBeUndefined();
    expect(refinedInstrumentType(etf(), undefined)).toBeUndefined();
    expect(refinedInstrumentType(etf({ type: "gov_bond" }), { price: 1, quoteType: "EQUITY" })).toBeUndefined();
    expect(refinedInstrumentType(etf({ type: "stock" }), { price: 1, quoteType: "EQUITY" })).toBeUndefined();
  });
});

describe("új papír a célpályán", () => {
  const instMap = new Map<string, Instrument>([
    ...fixtureInstruments().map((i) => [i.key, i] as const),
    [AAPL, { key: AAPL, name: "AAPL", ticker: "AAPL", type: "stock", currency: "USD" }],
    [OTP, { key: OTP, name: "OTP", ticker: "OTP", type: "etf", currency: "HUF" }],
    ["bitcoin-x", { key: "bitcoin-x", name: "Bitcoin ETP X", type: "etf", currency: "EUR" }],
  ]);

  it("az azonos eszközosztályú papírok csoportjába kerül, nem kap pénzt és nem adható el", () => {
    const cfg = glideConfig();
    const a = assignByAssetClass(cfg, [AAPL, OTP, "bitcoin-x", "cash:EUR", VWCE], instMap);
    expect(a).toEqual([
      { key: AAPL, bucketId: "eq" },
      { key: OTP, bucketId: "eq" },
      { key: "bitcoin-x", bucketId: "crypto" },
    ]);
    const next = withAssignments(cfg, a);
    expect(next.instruments[AAPL]).toEqual({ bucketId: "eq", sellable: false, acceptsContributions: false });
    expect(next.instruments[VWCE]).toEqual(cfg.instruments[VWCE]);
  });

  it("ha nincs azonos osztályú papír, a csoport neve dönt; kétértelműnél nem sorol be", () => {
    const cfg = { ...glideConfig(), instruments: {} };
    expect(assignByAssetClass(cfg, [AAPL], instMap)).toEqual([{ key: AAPL, bucketId: "eq" }]);
    const tie = {
      ...glideConfig(),
      instruments: {
        [VWCE]: { bucketId: "eq", sellable: true, acceptsContributions: true },
        [OTP]: { bucketId: "bond", sellable: true, acceptsContributions: true },
      },
    };
    expect(assignByAssetClass(tie, [AAPL], instMap)).toEqual([]);
  });

  it("a csoporton kívüli tőzsdei papírra figyelmeztetés jön, a szabad készpénzre és az új DKJ-ra nem", () => {
    const state = allocationState(
      glideConfig(),
      [
        { key: VWCE, name: "VWCE", valueHuf: 1_000_000, listed: true },
        { key: AAPL, name: "AAPL", valueHuf: 180_000, listed: true },
        { key: "HU0000TESZT9", name: "DKJ", valueHuf: 100_000 },
        { key: "cash:EUR", name: "EUR", valueHuf: 50_000 },
      ],
      "2026-03-01",
    );
    const alerts = unassignedAlerts(state);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(`glide-unassigned:${AAPL}`);
    expect(alerts[0].title).toContain("AAPL");
    const assigned = allocationState(
      withAssignments(glideConfig(), [{ key: AAPL, bucketId: "eq" }]),
      [
        { key: VWCE, name: "VWCE", valueHuf: 1_000_000, listed: true },
        { key: AAPL, name: "AAPL", valueHuf: 180_000, listed: true },
      ],
      "2026-03-01",
    );
    expect(unassignedAlerts(assigned)).toEqual([]);
  });
});

describe("élő history a commitolt mellé", () => {
  it("új papír sorozata egészben bekerül, a meglévőhöz csak az újabb napok", () => {
    const merged = mergeDatedSeries(
      { [VWCE]: [["2026-01-01", 1], ["2026-01-02", 2]] },
      { [VWCE]: [["2026-01-02", 9], ["2026-01-03", 3]], [AAPL]: [["2026-01-02", 250]] },
    );
    expect(merged[VWCE]).toEqual([["2026-01-01", 1], ["2026-01-02", 2], ["2026-01-03", 3]]);
    expect(merged[AAPL]).toEqual([["2026-01-02", 250]]);
  });
});
