import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { buildValueSeries } from "./series";
import {
  BENCHMARK,
  benchmarkIndex,
  computeReturns,
  monthlyPerformance,
  type MonthPerformance,
} from "./returns";

// Invented sample data. A EUR account, EUR/HUF fixed at 400 so every move is
// the ETF's own:
//  - 3 Aug: 1 000 EUR in, 10 ETF bought at 100 → 400 000 Ft
//  - 31 Aug: close 110 → 440 000 Ft (August: +10%, +40 000 Ft)
//  - 1 Sep, LOCAL midnight (= 31 Aug 22:00 UTC): +1 000 EUR, kept as cash;
//    close 120 → 880 000 Ft
//  - 30 Sep: close 99 → 796 000 Ft (September: −44 000 Ft)
//  - 2 Oct (today, live 99): October so far 0.

const LY: Account = { id: "ly", name: "Lightyear", provider: "lightyear", kind: "regular", currency: "EUR" };
const ETF: Instrument = { key: "IE00TEST", name: "Teszt ETF", type: "etf", currency: "EUR" };
const inst = new Map([[ETF.key, ETF]]);
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).toISOString();

const TXS: Transaction[] = [
  { id: "d1", accountId: "ly", date: at(2026, 8, 3, 9), type: "deposit", currency: "EUR", grossAmount: 1000, netAmount: 1000 },
  { id: "b1", accountId: "ly", date: at(2026, 8, 3), type: "buy", instrumentKey: ETF.key, quantity: 10, pricePerUnit: 100, currency: "EUR", grossAmount: 1000, netAmount: -1000 },
  { id: "d2", accountId: "ly", date: at(2026, 9, 1, 0), type: "deposit", currency: "EUR", grossAmount: 1000, netAmount: 1000 },
];
const HISTORY = {
  prices: {
    [ETF.key]: [
      ["2026-08-03", 100],
      ["2026-08-31", 110],
      ["2026-09-01", 120],
      ["2026-09-30", 99],
    ] as [string, number][],
    [BENCHMARK.key]: [
      ["2026-08-01", 100],
      ["2026-08-31", 105],
      ["2026-09-30", 94.5],
    ] as [string, number][],
  },
  fx: { EUR: [["2026-08-01", 400]] as [string, number][] },
};
const prices = new Map([[ETF.key, 99]]);
const fx = { EUR: 400 };
const now = new Date(2026, 9, 2, 12);

function months(): MonthPerformance[] {
  const r = computeReturns([LY], TXS, inst, prices, fx, HISTORY, now);
  const series = buildValueSeries([LY], TXS, inst, prices, fx, HISTORY, now);
  const bench = benchmarkIndex(HISTORY, r.twrIndex.map((p) => p.date));
  return monthlyPerformance(r.twrIndex, series, bench, "2026-10-02");
}

describe("monthlyPerformance", () => {
  it("splits the curve into calendar months, deposits removed", () => {
    const m = months();
    expect(m.map((x) => x.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    const [aug, sep, oct] = m;
    expect(aug.twr).toBeCloseTo(0.1, 10);
    expect(aug.profitHuf).toBeCloseTo(40_000, 6);
    // 1 Sep: (880 − 440 − 400) / (440 + 400/2); 30 Sep: 796 / 880.
    expect(sep.twr).toBeCloseTo((1 + 40 / 640) * (796 / 880) - 1, 10);
    expect(sep.profitHuf).toBeCloseTo(-44_000, 6);
    expect(oct.twr).toBeCloseTo(0, 10);
    expect(oct.profitHuf).toBeCloseTo(0, 6);
    expect(m.map((x) => x.current)).toEqual([false, false, true]);
  });

  it("a deposit at local midnight on the 1st belongs to the new month", () => {
    // In UTC that instant is still 31 Aug — filed there, August's market
    // result would absorb the 400 000 Ft deposit.
    const [aug] = months();
    expect(aug.profitHuf).toBeCloseTo(40_000, 6);
  });

  it("months compound to the total TWR and add up to today's profit", () => {
    const r = computeReturns([LY], TXS, inst, prices, fx, HISTORY, now);
    const series = buildValueSeries([LY], TXS, inst, prices, fx, HISTORY, now);
    const m = months();
    const compounded = m.reduce((f, x) => f * (1 + x.twr), 1) - 1;
    expect(compounded).toBeCloseTo(r.twrCumulativePct!, 10);
    const last = series[series.length - 1];
    expect(m.reduce((s, x) => s + x.profitHuf, 0)).toBeCloseTo(
      last.value - last.invested,
      6,
    );
  });

  it("benchmark months are chained from the same index", () => {
    const [aug, sep] = months();
    expect(aug.benchmark).toBeCloseTo(0.05, 10);
    expect(sep.benchmark).toBeCloseTo(-0.1, 10);
  });

  it("no data → no months", () => {
    expect(monthlyPerformance([], [], null, "2026-10-02")).toEqual([]);
  });
});
