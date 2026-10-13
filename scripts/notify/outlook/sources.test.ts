import { describe, expect, it } from "vitest";
import { parseAnalystTargets } from "./yahooTargets";
import { bandsFromChain, expiryQuotes, fetchImpliedBands, parseOption, type OptionSummary } from "./optionsImplied";

const r = (raw: number) => ({ raw, fmt: String(raw) });
const NOW = new Date(2026, 9, 13, 12);

const summary = (o: Record<string, unknown> = {}) => ({
  quoteSummary: {
    result: [
      {
        price: { currency: "HUF" },
        financialData: {
          numberOfAnalystOpinions: r(13),
          targetLowPrice: r(38_000),
          targetMeanPrice: r(45_525),
          targetHighPrice: r(52_900),
          ...o,
        },
        recommendationTrend: { trend: [{ period: "0m", strongBuy: 2, buy: 5, hold: 6, sell: 0, strongSell: 0 }] },
      },
    ],
    error: null,
  },
});

describe("parseAnalystTargets", () => {
  it("target range, analyst count and ratings from Yahoo", () => {
    expect(parseAnalystTargets(summary(), NOW)).toEqual({
      source: "yahoo",
      asOf: "2026-10-13",
      currency: "HUF",
      target: { min: 38_000, avg: 45_525, max: 52_900, count: 13 },
      ratings: { buy: 7, hold: 6, sell: 0 },
    });
  });

  it("null without analysts (an ETF) or with a pence-quoted listing", () => {
    expect(parseAnalystTargets(summary({ numberOfAnalystOpinions: undefined }), NOW)).toBeNull();
    const pence = summary();
    (pence.quoteSummary.result[0].price as { currency: string }).currency = "GBp";
    expect(parseAnalystTargets(pence, NOW)).toBeNull();
    expect(parseAnalystTargets({ quoteSummary: { result: null } }, NOW)).toBeNull();
  });

  it("null for an inconsistent range", () => {
    expect(parseAnalystTargets(summary({ targetLowPrice: r(60_000) }), NOW)).toBeNull();
  });
});

describe("parseOption", () => {
  it("expiry at 08:00 UTC, strike and side", () => {
    expect(parseOption("BTC-26MAR27-90000-C")).toEqual({
      expiryMs: Date.UTC(2027, 2, 26, 8),
      strike: 90_000,
      call: true,
      key: "26MAR27",
    });
    expect(parseOption("BTC-5NOV26-80000-P")?.expiryMs).toBe(Date.UTC(2026, 10, 5, 8));
    expect(parseOption("BTC-26MAR27")).toBeNull();
    expect(parseOption("BTC-26XXX27-90000-C")).toBeNull();
  });
});

const opt = (exp: string, strike: number, side: "C" | "P", iv: number, fwd: number): OptionSummary => ({
  instrument_name: `BTC-${exp}-${strike}-${side}`,
  mark_iv: iv,
  underlying_price: fwd,
});

// A forward of 84 000 for every expiry; the 85 000 strike is the closest.
const chain = (exp: string, fwd = 84_000, iv = 50): OptionSummary[] => [
  opt(exp, 70_000, "P", iv + 15, fwd),
  opt(exp, 85_000, "C", iv + 1, fwd),
  opt(exp, 85_000, "P", iv - 1, fwd),
  opt(exp, 100_000, "C", iv + 8, fwd),
];

describe("expiryQuotes", () => {
  it("takes the at-the-money volatility (call and put averaged) per expiry", () => {
    const q = expiryQuotes([...chain("15JAN27"), ...chain("25JUN27", 86_000, 55)]);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ forward: 84_000 });
    expect(q[0].iv).toBeCloseTo(0.5, 6);
    expect(q[1].iv).toBeCloseTo(0.55, 6);
  });

  it("skips quotes without volatility or forward", () => {
    const bad: OptionSummary[] = [
      { instrument_name: "BTC-15JAN27-85000-C", mark_iv: 0, underlying_price: 84_000 },
      { instrument_name: "BTC-15JAN27-85000-P", mark_iv: 50, underlying_price: null },
    ];
    expect(expiryQuotes(bad)).toEqual([]);
  });
});

describe("bandsFromChain / fetchImpliedBands", () => {
  const now = Date.UTC(2026, 9, 13, 12);
  const options = [...chain("15JAN27"), ...chain("26MAR27"), ...chain("25JUN27"), ...chain("24SEP27")];

  it("one band per horizon, each from a different expiry near it", () => {
    const bands = bandsFromChain("BTC", 83_000, options, now);
    expect(bands.map((b) => b.expiry)).toEqual(["2027-01-15", "2027-03-26", "2027-09-24"]);
    expect(bands.map((b) => b.horizonDays)).toEqual([94, 164, 346]);
    for (const b of bands) {
      expect(b.p10).toBeLessThan(b.p50);
      expect(b.p90).toBeGreaterThan(b.forward);
    }
  });

  it("no band for a horizon with no expiry anywhere near it", () => {
    expect(bandsFromChain("BTC", 83_000, chain("15JAN27"), now).map((b) => b.horizonDays)).toEqual([94]);
  });

  it("fetches index price and option chain; unsupported underlying is null, an empty chain an error", async () => {
    const calls: string[] = [];
    const getJson = async (url: string) => {
      calls.push(url);
      return url.includes("get_index_price") ? { result: { index_price: 83_000 } } : { result: options };
    };
    const bands = await fetchImpliedBands("btc", now, getJson);
    expect(bands).toHaveLength(3);
    expect(calls[0]).toContain("index_name=btc_usd");
    expect(calls[1]).toContain("currency=BTC&kind=option");
    expect(await fetchImpliedBands("DOGE", now, getJson)).toBeNull();
    await expect(
      fetchImpliedBands("ETH", now, async (u) => (u.includes("index") ? { result: { index_price: 2_000 } } : { result: [] })),
    ).rejects.toThrow();
  });
});
