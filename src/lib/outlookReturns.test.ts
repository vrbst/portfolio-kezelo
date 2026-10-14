import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  INFLATION_BY_CURRENCY,
  RHO,
  SIGMA,
  correlation,
  effectiveForecastSettings,
  growthInputs,
  outlookClassOf,
  outlookReturns,
  parseHorizonYears,
  pppAdjust,
  sigmaFromBand,
  targetMonths,
  type GrowthHolding,
  type ManualReturns,
} from "./outlookReturns";
import type { AssetClass as OutlookClass, ImpliedBand, OutlookFile, OutlookProfile } from "./outlook";
import type { Instrument } from "./model";
import type { PortfolioSummary } from "./portfolio";

// Invented numbers close to the real ones the outlook gave on 2026-10-14
// (VWCE: Vanguard 5,1 / Invesco 6,0 / J.P. Morgan 7,0 % in USD; OTP: Yahoo
// and the issuer's consensus around a 46 700 Ft price; BTC: bank targets).

const NOW = new Date(2026, 9, 14, 12);
const MANUAL: ManualReturns = {
  annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 },
  mcSigma: 0.15,
  months: 120,
  inflationPct: 0.035,
};

const inst = (key: string, type: Instrument["type"], name = key, currency = "EUR"): Instrument =>
  ({ key, name, type, currency }) as Instrument;

const holding = (key: string, type: Instrument["type"], valueHuf: number, over: Partial<GrowthHolding> = {}): GrowthHolding => ({
  key,
  name: key,
  instrument: inst(key, type, over.name ?? key, over.currency ?? "EUR"),
  currency: "EUR",
  valueHuf,
  ...over,
});

const profile = (assetClass: OutlookClass, underlying?: string): OutlookProfile => ({
  assetClass,
  ...(underlying ? { underlying } : {}),
  source: "ai",
  checkedAt: "2026-10-14T00:00:00Z",
});

const file = (profiles: OutlookFile["profiles"], items: OutlookFile["items"]): OutlookFile => ({
  v: 1,
  updatedAt: "2026-10-14T00:00:00Z",
  profiles,
  items,
  errors: {},
});

const cma = (house: string, value: number, horizon: string, unit = "USD", publishedAt = "2026-06-30") => ({
  house,
  kind: "annualReturn" as const,
  value,
  unit,
  horizon,
  publishedAt,
  url: `https://example.com/${house}`,
});

const vwceItem = {
  views: [cma("Vanguard", 0.051, "10 év"), cma("Invesco", 0.06, "10 év"), cma("J.P. Morgan", 0.07, "10–15 év")],
};

const band = (horizonDays: number, sigma: number, spot = 83_000): ImpliedBand => {
  const T = horizonDays / 365;
  const sd = sigma * Math.sqrt(T);
  const mu = Math.log(spot) - (sd * sd) / 2;
  const z = 1.2815515655446004;
  return {
    underlying: "BTC", horizonDays, expiry: "2027-09-24", spot, forward: spot,
    p10: Math.exp(mu - z * sd), p50: Math.exp(mu), p90: Math.exp(mu + z * sd), probUp: 0.5, asOf: "2026-10-14",
  };
};

describe("helpers", () => {
  it("horizon years: the first number before 'év'/'year'", () => {
    expect(parseHorizonYears("10 év")).toBe(10);
    expect(parseHorizonYears("10–15 év")).toBe(10);
    expect(parseHorizonYears("5-10 years")).toBe(5);
    expect(parseHorizonYears("2,5 év")).toBe(2.5);
    expect(parseHorizonYears("hosszú táv")).toBeUndefined();
    expect(parseHorizonYears(undefined)).toBeUndefined();
  });

  it("price-target horizons in months; 'long term' and the unreadable are left out", () => {
    expect(targetMonths("12 hó (2027 októberéig)", NOW)).toBe(12);
    expect(targetMonths("1 év", NOW)).toBe(12);
    expect(targetMonths("18 month", NOW)).toBe(18);
    expect(targetMonths("2026 vége", NOW)).toBe(3);
    expect(targetMonths("2027 vége", NOW)).toBe(15);
    expect(targetMonths("hosszú táv", NOW)).toBeUndefined();
    expect(targetMonths("valamikor", NOW)).toBeUndefined();
  });

  it("purchasing-power correction: the inflation gap carries over, forint and unknown currencies stay", () => {
    expect(pppAdjust(0.06, "USD", 0.035)).toBeCloseTo((1.06 * 1.035) / 1.025 - 1, 12);
    expect(pppAdjust(0.06, "EUR", 0.035)).toBeCloseTo((1.06 * 1.035) / 1.02 - 1, 12);
    expect(pppAdjust(0.06, "HUF", 0.035)).toBe(0.06);
    expect(pppAdjust(0.06, "CHF", 0.035)).toBe(0.06);
    expect(Object.keys(INFLATION_BY_CURRENCY).sort()).toEqual(["EUR", "USD"]);
  });

  it("σ from an option band is the inverse of the lognormal band", () => {
    for (const sigma of [0.2, 0.395, 0.8]) for (const days of [90, 180, 345])
      expect(sigmaFromBand(band(days, sigma))!).toBeCloseTo(sigma, 9);
    expect(sigmaFromBand({ ...band(90, 0.4), p10: 0 })).toBeUndefined();
    expect(sigmaFromBand({ ...band(90, 0.4), horizonDays: 0 })).toBeUndefined();
  });

  it("correlation: symmetric, 1 never needed for different assets, in [0,1]", () => {
    const classes: OutlookClass[] = ["equity", "equity_fund", "bond_fund", "crypto", "commodity", "other"];
    for (const a of classes) for (const b of classes) {
      expect(correlation(a, b)).toBe(correlation(b, a));
      expect(correlation(a, b)).toBeGreaterThan(0);
      expect(correlation(a, b)).toBeLessThan(1);
    }
    expect(correlation("crypto", "equity_fund")).toBe(RHO.crypto);
  });

  it("the class: the profile's, else crypto by name, stock, otherwise an equity fund", () => {
    expect(outlookClassOf(inst("A", "etf"), profile("bond_fund"))).toBe("bond_fund");
    expect(outlookClassOf(inst("WBIT", "etf", "WisdomTree Physical Bitcoin"))).toBe("crypto");
    expect(outlookClassOf(inst("OTP", "stock", "OTP Bank"))).toBe("equity");
    expect(outlookClassOf(inst("VWCE", "etf", "FTSE All-World"))).toBe("equity_fund");
    expect(outlookClassOf(undefined)).toBe("equity_fund");
  });
});

describe("no data: exactly the manual numbers", () => {
  const cases: [string, OutlookFile | null | undefined, GrowthHolding[]][] = [
    ["no outlook file", null, [holding("VWCE", "etf", 1_000_000)]],
    ["an outlook file with nothing about the papers", file({}, {}), [holding("VWCE", "etf", 1_000_000)]],
    ["no securities at all (only bonds and cash)", file({}, { X: vwceItem }), []],
    ["a security without value", file({ V: profile("equity_fund") }, { V: vwceItem }), [holding("V", "etf", 0)]],
  ];
  for (const [name, outlook, holdings] of cases)
    it(name, () => {
      const r = outlookReturns({ holdings, outlook, manual: MANUAL, now: NOW });
      expect(r.usable).toBe(false);
      expect(r.scenarios).toBe(MANUAL.annualReturn);
      expect(r.sigma).toBe(MANUAL.mcSigma);
      expect(r.coveredShare).toBe(0);
    });
});

describe("VWCE: long-term return expectations", () => {
  const outlook = file({ VWCE: profile("equity_fund") }, { VWCE: vwceItem });
  const r = outlookReturns({ holdings: [holding("VWCE", "etf", 5_000_000)], outlook, manual: MANUAL, now: NOW });

  it("the median of the three houses, corrected for the dollar–forint inflation gap", () => {
    const med = (1.06 * 1.035) / 1.025 - 1; // Invesco 6,0 % is the median
    expect(r.assets[0].basis).toBe("views");
    expect(r.scenarios.real).toBeCloseTo(med, 9);
    expect(r.assets[0].fxAdjPp).toBeCloseTo((med - 0.06) * 100, 9);
    expect(r.assets[0].sources.map((s) => s.label)).toEqual(["Vanguard", "Invesco", "J.P. Morgan"]);
  });

  it("the band keeps (at least) the manual width: houses agreeing is no proof of certainty", () => {
    expect(r.scenarios.real - r.scenarios.pess).toBeGreaterThanOrEqual(0.03 - 1e-12);
    expect(r.scenarios.opt - r.scenarios.real).toBeGreaterThanOrEqual(0.03 - 1e-12);
    expect(r.scenarios.pess).toBeLessThanOrEqual(r.scenarios.real);
  });

  it("σ is the user's own for an equity fund (a VWCE-only portfolio does not move)", () => {
    expect(r.sigma).toBeCloseTo(MANUAL.mcSigma, 12);
    expect(r.coveredShare).toBe(1);
  });

  it("two houses: the mean; a euro-based view is corrected with the euro's inflation", () => {
    const two = file(
      { E: profile("equity_fund") },
      { E: { views: [cma("A", 0.04, "10 év", "EUR"), cma("B", 0.06, "10 év", "EUR")] } },
    );
    const e = outlookReturns({ holdings: [holding("E", "etf", 1_000_000)], outlook: two, manual: MANUAL, now: NOW });
    expect(e.scenarios.real).toBeCloseTo(((1.05 * 1.035) / 1.02) - 1, 9);
  });

  it("short-horizon expectations and an old dated house are handled: only ≥ 5 years count, one per house", () => {
    const mixed = file(
      { E: profile("equity_fund") },
      {
        E: {
          views: [
            cma("A", 0.2, "1 év"), // too short: ignored
            cma("B", 0.05, "10 év", "HUF", "2026-01-01"),
            cma("B", 0.07, "10 év", "HUF", "2026-06-01"), // the newer of the same house
          ],
        },
      },
    );
    const e = outlookReturns({ holdings: [holding("E", "etf", 1_000_000)], outlook: mixed, manual: MANUAL, now: NOW });
    expect(e.scenarios.real).toBeCloseTo(0.07, 12);
    expect(e.assets[0].sources).toHaveLength(1);
  });
});

describe("OTP: a share with analyst targets", () => {
  const price = 46_700;
  const yahoo = { source: "yahoo" as const, asOf: "2026-10-14", currency: "HUF", target: { min: 35_500, avg: 48_514.23, max: 55_000, count: 13 } };
  const issuer = {
    source: "issuer" as const,
    asOf: "2026-08-03",
    url: "https://example.com/c.pdf",
    currency: "HUF",
    target: { min: 29_000, avg: 45_888, max: 58_667, count: 17 },
    estimates: [{ year: 2026, eps: 4_577, dps: 1_251 }, { year: 2027, eps: 5_084, dps: 1_494 }],
  };
  const otp = (consensus: unknown[], over: Partial<GrowthHolding> = {}) => ({
    holdings: [holding("OTP", "stock", 3_000_000, { currency: "HUF", price, name: "OTP Bank", ...over })],
    outlook: file({ OTP: profile("equity") }, { OTP: { consensus: consensus as never } }),
    manual: MANUAL,
    now: NOW,
  });

  it("a 12-month target only pulls the manual number a little (time-weighted over ten years)", () => {
    const r = outlookReturns(otp([yahoo]));
    const a = 0.5 / 10;
    const move = (x: number) => x / price - 1;
    expect(r.assets[0].basis).toBe("targets");
    expect(r.scenarios.real).toBeCloseTo((1 - a) * 0.06 + a * move(48_514.23), 12);
    expect(r.scenarios.pess).toBeCloseTo((1 - a) * 0.03 + a * move(35_500), 12);
    expect(r.scenarios.opt).toBeCloseTo((1 - a) * 0.09 + a * move(55_000), 12);
    // far from the target-implied move itself
    expect(Math.abs(r.scenarios.real - 0.06)).toBeLessThan(0.005);
  });

  it("a shorter forecast horizon trusts the target more (H = 1 year → half)", () => {
    const long = outlookReturns({ ...otp([yahoo]), manual: { ...MANUAL, months: 240 } });
    const short = outlookReturns({ ...otp([yahoo]), manual: { ...MANUAL, months: 12 } });
    const mid = outlookReturns(otp([yahoo]));
    const pull = (x: number) => Math.abs(x - 0.06);
    expect(pull(short.scenarios.real)).toBeGreaterThan(pull(mid.scenarios.real));
    expect(pull(mid.scenarios.real)).toBeGreaterThan(pull(long.scenarios.real));
    expect(short.scenarios.real).toBeCloseTo(0.5 * 0.06 + 0.5 * (48_514.23 / price - 1), 12);
  });

  it("the issuer's own consensus is preferred, and next year's dividend is added to the price move", () => {
    const r = outlookReturns(otp([yahoo, issuer]));
    const dy = 1_251 / price;
    expect(r.assets[0].sources[0].label).toBe("Kibocsátói konszenzus");
    expect(r.scenarios.real).toBeCloseTo(0.95 * 0.06 + 0.05 * (45_888 / price - 1 + dy), 12);
  });

  it("an old consensus, or one in another currency, is not used", () => {
    expect(outlookReturns(otp([{ ...yahoo, asOf: "2026-04-01" }])).usable).toBe(false);
    expect(outlookReturns(otp([{ ...yahoo, currency: "USD" }])).usable).toBe(false);
  });

  it("without a price there is nothing to compare the target with", () => {
    expect(outlookReturns(otp([yahoo], { price: undefined })).usable).toBe(false);
  });

  it("an absurd target is clipped before it is used", () => {
    const wild = { ...yahoo, target: { min: 100, avg: 5_000_000, max: 9_000_000, count: 1 } };
    const r = outlookReturns(otp([wild]));
    expect(r.scenarios.real).toBeCloseTo(0.95 * 0.06 + 0.05 * 1.0, 12);
    expect(r.scenarios.pess).toBeCloseTo(0.95 * 0.03 + 0.05 * -0.5, 12);
  });

  it("σ of a single share is the share default", () => {
    expect(outlookReturns(otp([yahoo])).sigma).toBeCloseTo(SIGMA.equity, 12);
  });
});

describe("WBIT: a bitcoin product", () => {
  const target = (house: string, value: number, horizon: string) => ({
    house, kind: "target" as const, value, unit: "USD", horizon, publishedAt: "2026-10-01", url: `https://example.com/${house}`,
  });
  const btc = (item: OutlookFile["items"][string]) => ({
    holdings: [holding("WBIT", "etf", 1_000_000, { name: "WisdomTree Physical Bitcoin" })],
    outlook: file({ WBIT: profile("crypto", "BTC") }, { WBIT: item }),
    manual: MANUAL,
    now: NOW,
  });

  it("σ comes from the longest option band", () => {
    const r = outlookReturns(btc({ implied: [band(72, 0.5), band(345, 0.395)], views: [cma("X", 0.1, "10 év")] }));
    expect(r.assets[0].sigma).toBeCloseTo(0.395, 9);
    expect(r.sigma).toBeCloseTo(0.395, 9);
  });

  it("without a band the default crypto σ", () => {
    expect(outlookReturns(btc({ views: [cma("X", 0.1, "10 év")] })).sigma).toBeCloseTo(SIGMA.crypto, 12);
  });

  it("only 12-month targets count: '2026 vége' (too near) and 'hosszú táv' are left out; the rest is annualised and pulled gently", () => {
    const r = outlookReturns(
      btc({
        implied: [band(345, 0.4, 83_000)],
        views: [
          target("Citi", 113_000, "12 hó (2027 októberéig)"),
          target("StanChart", 100_000, "2026 vége"),
          target("JPM", 266_000, "hosszú táv"),
        ],
      }),
    );
    const u = 113_000 / 83_000 - 1;
    expect(r.assets[0].basis).toBe("targets");
    expect(r.assets[0].sources.map((s) => s.label)).toEqual(["Citi"]);
    expect(r.scenarios.real).toBeCloseTo(0.95 * 0.06 + 0.05 * u, 12);
  });

  it("a target without an option-market spot to compare with is not used", () => {
    expect(outlookReturns(btc({ views: [target("Citi", 113_000, "12 hó")] })).usable).toBe(false);
  });
});

describe("a mix", () => {
  const outlook = file(
    { VWCE: profile("equity_fund"), WBIT: profile("crypto", "BTC"), OTP: profile("equity") },
    {
      VWCE: vwceItem,
      WBIT: { implied: [band(345, 0.4)], views: [] },
      OTP: { consensus: [{ source: "yahoo", asOf: "2026-10-14", currency: "HUF", target: { min: 40_000, avg: 48_000, max: 55_000 } }] },
    },
  );
  const holdings = [
    holding("VWCE", "etf", 7_000_000),
    holding("WBIT", "etf", 2_000_000, { name: "WisdomTree Physical Bitcoin" }),
    holding("OTP", "stock", 1_000_000, { currency: "HUF", price: 46_700 }),
  ];
  const r = outlookReturns({ holdings, cashHuf: 1_000_000, outlook, manual: MANUAL, now: NOW });

  it("weights by value; uncovered assets (the bitcoin has no view or target) take the manual numbers", () => {
    expect(r.assets.map((a) => [a.key, a.weight])).toEqual([["VWCE", 0.7], ["WBIT", 0.2], ["OTP", 0.1]]);
    expect(r.assets.find((a) => a.key === "WBIT")!.basis).toBe("manual");
    expect(r.coveredShare).toBeCloseTo(0.8, 12);
    const w = Object.fromEntries(r.assets.map((a) => [a.key, a]));
    expect(r.scenarios.real).toBeCloseTo(0.7 * w.VWCE.scenarios.real + 0.2 * 0.06 + 0.1 * w.OTP.scenarios.real, 12);
  });

  it("the cash share of the growth pot is reported", () => {
    expect(r.cashShare).toBeCloseTo(1 / 11, 12);
    expect(r.warnings.some((w) => /készpénz/.test(w))).toBe(true);
  });

  it("σ: with the bitcoin's band in, between the parts and below their weighted sum", () => {
    const sum = r.assets.reduce((s, a) => s + a.weight * a.sigma, 0);
    expect(r.sigma).toBeLessThan(sum - 0.005); // clearly below: diversification is counted
    expect(r.sigma).toBeGreaterThan(0.1);
  });

  it("σ is exactly the portfolio formula: two assets, weights 0,5 / 0,5, crypto with the default σ", () => {
    const two = outlookReturns({
      holdings: [holding("E", "etf", 5e6), holding("B", "etf", 5e6, { name: "Bitcoin ETP" })],
      outlook: file(
        { E: profile("equity_fund"), B: profile("crypto", "BTC") },
        { E: { views: [cma("A", 0.06, "10 év")] }, B: { views: [cma("A", 0.1, "10 év")] } },
      ),
      manual: MANUAL,
      now: NOW,
    });
    const se = MANUAL.mcSigma;
    const sc = SIGMA.crypto;
    const expected = Math.sqrt(0.25 * se * se + 0.25 * sc * sc + 2 * 0.25 * se * sc * RHO.crypto);
    expect(two.sigma).toBeCloseTo(expected, 12);
  });

  it("a poor coverage is warned about", () => {
    const poor = outlookReturns({ holdings, outlook: file({ OTP: profile("equity") }, { OTP: outlook.items.OTP }), manual: MANUAL, now: NOW });
    expect(poor.coveredShare).toBeCloseTo(0.1, 12);
    expect(poor.warnings.some((w) => /csak 10%/.test(w))).toBe(true);
  });
});

describe("effectiveForecastSettings", () => {
  const settings = { annualReturn: MANUAL.annualReturn, mcSigma: 0.15, returnSource: "outlook" as const, other: 1 };
  const usable = outlookReturns({
    holdings: [holding("VWCE", "etf", 1_000_000)],
    outlook: file({ VWCE: profile("equity_fund") }, { VWCE: vwceItem }),
    manual: MANUAL,
    now: NOW,
  });

  it("in manual mode, or without usable data, it is the very same object", () => {
    const manual = { ...settings, returnSource: "manual" as const };
    expect(effectiveForecastSettings(manual, usable)).toBe(manual);
    expect(effectiveForecastSettings(settings, null)).toBe(settings);
    expect(effectiveForecastSettings(settings, undefined)).toBe(settings);
    const unusable = outlookReturns({ holdings: [], outlook: null, manual: MANUAL, now: NOW });
    expect(effectiveForecastSettings(settings, unusable)).toBe(settings);
    expect(effectiveForecastSettings({ ...settings, returnSource: undefined }, usable).annualReturn).toBe(settings.annualReturn);
  });

  it("in outlook mode the derived returns and σ replace the manual ones, the rest stays — and the input is not touched", () => {
    const eff = effectiveForecastSettings(settings, usable);
    expect(eff).not.toBe(settings);
    expect(eff.annualReturn).toBe(usable.scenarios);
    expect(eff.mcSigma).toBe(usable.sigma);
    expect(eff.other).toBe(1);
    expect(settings.annualReturn).toBe(MANUAL.annualReturn);
    expect(settings.mcSigma).toBe(0.15);
  });
});

describe("growthInputs: the securities of a portfolio", () => {
  it("leaves out bonds, T-bills and cash instruments, merges accounts, reports the cash beside them", () => {
    const h = (key: string, type: string, value: number, quantity = 1) => ({
      instrumentKey: key, instrument: { key, name: key, type }, quantity, currency: "EUR", marketValueHuf: value,
      costBasisCcy: 0, costBasisHuf: 0,
    });
    const summary = {
      cashValueHuf: 123_000,
      accounts: [
        { account: { kind: "tbsz" }, holdings: [h("VWCE", "etf", 1_000_000), h("MAP", "gov_bond", 5_000_000), h("DKJ", "tbill", 1_000_000)], cashValueHuf: 100_000 },
        { account: { kind: "tbsz" }, holdings: [h("VWCE", "etf", 500_000), h("OTP", "stock", 700_000), h("X", "etf", 0, 0)], cashValueHuf: 23_000 },
      ],
    } as unknown as PortfolioSummary;
    const g = growthInputs(summary);
    expect(g.holdings.map((x) => [x.key, x.valueHuf]).sort()).toEqual([["OTP", 700_000], ["VWCE", 1_500_000]]);
    expect(g.cashHuf).toBe(123_000);
  });
});

// ---- properties -------------------------------------------------------------

const classArb = fc.constantFrom<OutlookClass>("equity", "equity_fund", "bond_fund", "crypto", "commodity", "other");

interface Asset {
  cls: OutlookClass;
  value: number;
  data: "none" | "views" | "target";
  returns: number[];
  ccy: string;
  targetAvg: number;
  withBand: boolean;
}

/** A random asset with random outlook data (or none). */
const assetArb: fc.Arbitrary<Asset> = fc.record({
  cls: classArb,
  value: fc.integer({ min: 1_000, max: 50_000_000 }),
  data: fc.constantFrom("none", "views", "target"),
  returns: fc.array(fc.double({ min: -0.05, max: 0.15, noNaN: true }), { minLength: 1, maxLength: 5 }),
  ccy: fc.constantFrom("USD", "EUR", "HUF"),
  targetAvg: fc.double({ min: 0.2, max: 3, noNaN: true }),
  withBand: fc.boolean(),
});

function build(assets: Asset[]) {
  const profiles: OutlookFile["profiles"] = {};
  const items: OutlookFile["items"] = {};
  const holdings = assets.map((a, i) => {
    const key = `A${i}`;
    profiles[key] = profile(a.cls, a.cls === "crypto" ? "BTC" : undefined);
    const item: OutlookFile["items"][string] = {};
    if (a.data === "views") item.views = a.returns.map((v, j) => cma(`H${j}`, v, "10 év", a.ccy));
    if (a.data === "target") {
      item.consensus = [
        { source: "yahoo", asOf: "2026-10-14", currency: "HUF", target: { min: 1_000 * a.targetAvg * 0.8, avg: 1_000 * a.targetAvg, max: 1_000 * a.targetAvg * 1.2 } },
      ];
      item.views = [{ house: "T", kind: "target", value: 100_000 * a.targetAvg, unit: "USD", horizon: "12 hó", publishedAt: "2026-10-01", url: "https://example.com/t" }];
    }
    if (a.withBand) item.implied = [band(345, 0.45)];
    items[key] = item;
    return holding(key, a.cls === "equity" ? "stock" : "etf", a.value, { currency: "HUF", price: 1_000 });
  });
  return { holdings, outlook: file(profiles, items) };
}

describe("properties (any portfolio, any data)", () => {
  const run = (assets: Asset[], manual = MANUAL) => {
    const { holdings, outlook } = build(assets);
    return outlookReturns({ holdings, outlook, manual, now: NOW });
  };

  it("the scenarios stay in order, everything is finite, the weights add up to one", () => {
    fc.assert(
      fc.property(fc.array(assetArb, { minLength: 1, maxLength: 6 }), (assets) => {
        const r = run(assets);
        expect(r.scenarios.pess).toBeLessThanOrEqual(r.scenarios.real + 1e-12);
        expect(r.scenarios.real).toBeLessThanOrEqual(r.scenarios.opt + 1e-12);
        for (const x of [r.scenarios.pess, r.scenarios.real, r.scenarios.opt, r.sigma, r.coveredShare, r.cashShare]) expect(Number.isFinite(x)).toBe(true);
        expect(r.assets.reduce((s, a) => s + a.weight, 0)).toBeCloseTo(1, 9);
        expect(r.coveredShare).toBeGreaterThanOrEqual(0);
        expect(r.coveredShare).toBeLessThanOrEqual(1 + 1e-12);
        for (const a of r.assets) {
          expect(a.scenarios.pess).toBeLessThanOrEqual(a.scenarios.real + 1e-12);
          expect(a.scenarios.real).toBeLessThanOrEqual(a.scenarios.opt + 1e-12);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("σ never exceeds the weighted sum of the parts (correlations are below one) and is not negative", () => {
    fc.assert(
      fc.property(fc.array(assetArb, { minLength: 1, maxLength: 6 }), (assets) => {
        const r = run(assets);
        if (!r.usable) return;
        expect(r.sigma).toBeGreaterThanOrEqual(0);
        expect(r.sigma).toBeLessThanOrEqual(r.assets.reduce((s, a) => s + a.weight * a.sigma, 0) + 1e-12);
      }),
      { numRuns: 300 },
    );
  });

  it("no asset with data: exactly the manual numbers", () => {
    fc.assert(
      fc.property(fc.array(assetArb, { minLength: 1, maxLength: 5 }), (assets) => {
        const r = run(assets.map((a) => ({ ...a, data: "none" as const, withBand: false })));
        expect(r.scenarios).toBe(MANUAL.annualReturn);
        expect(r.sigma).toBe(MANUAL.mcSigma);
      }),
      { numRuns: 100 },
    );
  });

  it("a larger long-term expectation gives a larger real return", () => {
    fc.assert(
      fc.property(fc.double({ min: -0.04, max: 0.12, noNaN: true }), fc.double({ min: 0.001, max: 0.05, noNaN: true }), (r, d) => {
        const one = (v: number) =>
          outlookReturns({
            holdings: [holding("E", "etf", 1_000_000)],
            outlook: file({ E: profile("equity_fund") }, { E: { views: [cma("A", v, "10 év")] } }),
            manual: MANUAL,
            now: NOW,
          }).scenarios.real;
        expect(one(r + d)).toBeGreaterThan(one(r));
      }),
    );
  });

  it("a longer horizon trusts a 12-month target less", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.5, max: 2, noNaN: true }), fc.integer({ min: 12, max: 200 }), (avgRel, months) => {
        const at = (m: number) =>
          outlookReturns({
            holdings: [holding("O", "stock", 1_000_000, { currency: "HUF", price: 1_000 })],
            outlook: file(
              { O: profile("equity") },
              { O: { consensus: [{ source: "yahoo", asOf: "2026-10-14", currency: "HUF", target: { min: 500 * avgRel, avg: 1_000 * avgRel, max: 1_500 * avgRel } }] } },
            ),
            manual: { ...MANUAL, months: m },
            now: NOW,
          }).scenarios.real;
        expect(Math.abs(at(months + 12) - 0.06)).toBeLessThanOrEqual(Math.abs(at(months) - 0.06) + 1e-12);
      }),
    );
  });

  it("more bitcoin, more σ — when the coin is volatile enough for the correlation to leave it so (ρσ_c ≥ σ_e)", () => {
    const sig = (wCrypto: number) =>
      outlookReturns({
        holdings: [
          holding("E", "etf", (1 - wCrypto) * 1e7),
          holding("B", "etf", wCrypto * 1e7, { name: "Bitcoin ETP" }),
        ],
        outlook: file(
          { E: profile("equity_fund"), B: profile("crypto", "BTC") },
          { E: { views: [cma("A", 0.06, "10 év")] }, B: { views: [cma("A", 0.1, "10 év")] } },
        ),
        manual: MANUAL,
        now: NOW,
      }).sigma;
    // default crypto σ 0,6 × ρ 0,3 = 0,18 ≥ 0,15
    const ws = [0.05, 0.1, 0.2, 0.4, 0.7, 0.95];
    for (let i = 1; i < ws.length; i++) expect(sig(ws[i])).toBeGreaterThan(sig(ws[i - 1]));
    expect(sig(0.999)).toBeCloseTo(SIGMA.crypto, 1);
  });
});
