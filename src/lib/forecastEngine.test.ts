import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PortfolioSummary } from "./portfolio";
import type { Transaction } from "./model";
import {
  backtest,
  deflateResult,
  detectRecurringSavings,
  firstReach,
  forecastMilestones,
  loadForecastSnapshots,
  mergeForecastSnapshots,
  monthsUntil,
  probAtLeast,
  projectForecast,
  projectMonteCarlo,
  recordForecastSnapshot,
  requiredMonthlySaving,
  SCENARIOS,
  type ForecastAssumptions,
  type ForecastResult,
  type ForecastSnapshot,
  type PlannedExpense,
} from "./forecast";

// Invented sample data with round numbers: every expected value below can be
// checked by hand (0% return, fixed savings) or follows from a rule that must
// hold for any input (the scenarios stay in order, money is not created).

const NOW = new Date(2026, 9, 14, 10); // 14 Oct 2026, a Wednesday

/** A portfolio of `growth` HUF in growth assets plus the given bonds. */
function portfolio(
  growth: number,
  bonds: { key: string; face: number; value: number; maturity?: string; bond?: object }[] = [],
): PortfolioSummary {
  const bondValue = bonds.reduce((s, b) => s + b.value, 0);
  return {
    totalValueHuf: growth + bondValue,
    netDepositedHuf: growth + bondValue,
    accounts: [
      {
        holdings: bonds.map((b) => ({
          quantity: b.face,
          marketValueHuf: b.value,
          instrument: { key: b.key, type: "tbill", maturity: b.maturity, bond: b.bond },
        })),
      },
    ],
  } as unknown as PortfolioSummary;
}

const assume = (patch: Partial<ForecastAssumptions> = {}): ForecastAssumptions => ({
  annualReturn: { pess: 0, real: 0, opt: 0 },
  monthlySavingHuf: 0,
  reinvestTarget: "growth",
  reinvestBondRate: 0,
  months: 60,
  ...patch,
});

const run = (s: PortfolioSummary, a: Partial<ForecastAssumptions> = {}, e: PlannedExpense[] = []) =>
  projectForecast(s, assume(a), e, NOW);

describe("projectForecast – hand-checkable cases", () => {
  it("0% return: the value grows by exactly the savings", () => {
    const r = run(portfolio(1_000_000), { monthlySavingHuf: 100_000, months: 24 });
    expect(r.points[0].real).toBe(1_000_000);
    expect(r.points[12].real).toBe(2_200_000);
    expect(r.points[24].real).toBe(3_400_000);
    expect(r.points[24].contributed).toBe(3_400_000);
    expect(r.points.map((p) => p.month).slice(0, 3)).toEqual(["2026-10", "2026-11", "2026-12"]);
  });

  it("6% a year, compounded monthly, is exactly 6% after a year and 1.06^10 after ten", () => {
    const r = run(portfolio(1_000_000), { annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 }, months: 120 });
    expect(r.points[12].real).toBeCloseTo(1_060_000, 4);
    expect(r.points[12].pess).toBeCloseTo(1_030_000, 4);
    expect(r.points[120].opt).toBeCloseTo(1_000_000 * 1.09 ** 10, 2);
  });

  it("the yearly raise applies from the 13th month", () => {
    const r = run(portfolio(0), { monthlySavingHuf: 100_000, savingGrowth: 0.1, months: 24 });
    expect(r.points[12].real).toBeCloseTo(1_200_000, 6);
    expect(r.points[24].real).toBeCloseTo(1_200_000 + 12 * 110_000, 6);
  });

  it("a withdrawal phase stops the savings and takes the monthly amount", () => {
    const r = run(portfolio(1_000_000), {
      monthlySavingHuf: 100_000,
      months: 24,
      withdrawal: { enabled: true, start: "2027-10", monthlyHuf: 50_000 },
    });
    // Savings in months 1–11 (Nov 2026 – Sep 2027), withdrawals from month 12.
    expect(r.points[11].real).toBe(1_000_000 + 11 * 100_000);
    expect(r.points[24].real).toBe(1_000_000 + 11 * 100_000 - 13 * 50_000);
    expect(r.withdrawalHuf).toBe(13 * 50_000);
    expect(r.events.find((e) => e.kind === "withdrawal")?.month).toBe("2027-10");
  });

  it("a T-bill accretes to its face and pays it out in its maturity month", () => {
    const s = portfolio(500_000, [{ key: "DKJ", face: 1_000_000, value: 950_000, maturity: "2027-04-14" }]);
    const r = run(s, { months: 12, reinvestTarget: "cash" });
    expect(r.points[0].real).toBeCloseTo(1_450_000, 6);
    // Halfway (mid-January) about halfway to face; never above face before maturity.
    for (let i = 0; i < 6; i++) expect(r.points[i].real).toBeLessThanOrEqual(1_500_000 + 1e-6);
    expect(r.points[6].month).toBe("2027-04");
    expect(r.points[6].real).toBeCloseTo(1_500_000, 6);
    expect(r.points[12].real).toBeCloseTo(1_500_000, 6);
    expect(r.maturityHuf).toBe(1_000_000);
  });

  it("an expense is paid from the side pot first, then from growth", () => {
    const s = portfolio(500_000, [{ key: "DKJ", face: 1_000_000, value: 1_000_000, maturity: "2027-01-10" }]);
    const r = run(s, { months: 12, reinvestTarget: "cash" }, [{ id: "x", date: "2027-06-01", amountHuf: 1_200_000 }]);
    expect(r.points[8].real).toBe(300_000);
    expect(r.shortfall.real).toBeNull();
    const short = run(s, { months: 12, reinvestTarget: "cash" }, [{ id: "x", date: "2027-06-01", amountHuf: 1_600_000 }]);
    expect(short.shortfall.real).toBe("2027-06");
  });
});

describe("projectForecast – a plan that runs out of money", () => {
  // 3 M Ft, a 5 M Ft expense in June 2027: the liquid part goes 2 M below 0.
  const r = run(
    portfolio(3_000_000),
    { annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 }, months: 120 },
    [{ id: "x", date: "2027-06-01", amountHuf: 5_000_000 }],
  );

  it("the shortfall is reported in every scenario", () => {
    expect(r.shortfall).toEqual({ pess: "2027-06", real: "2027-06", opt: "2027-06" });
  });

  it("the missing money does not earn (or cost) the scenario's return", () => {
    // Before: the deficit compounded at the return, so the optimistic line
    // fell the lowest (−4.07 M vs −2.56 M Ft ten years on).
    const june = r.points[8];
    const end = r.points[120];
    for (const k of SCENARIOS) expect(end[k]).toBeCloseTo(june[k], 6);
    expect(end.pess).toBeLessThanOrEqual(end.real);
    expect(end.real).toBeLessThanOrEqual(end.opt);
  });

  it("savings after it refill the hole, then grow again", () => {
    const refill = run(
      portfolio(3_000_000),
      { annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 }, months: 120, monthlySavingHuf: 100_000 },
      [{ id: "x", date: "2027-06-01", amountHuf: 5_000_000 }],
    );
    expect(refill.points[120].pess).toBeGreaterThan(0);
    expect(refill.points[120].pess).toBeLessThan(refill.points[120].opt);
  });
});

describe("projectForecast – rules for any input", () => {
  const input = fc.record({
    growth: fc.integer({ min: 0, max: 20_000_000 }),
    saving: fc.integer({ min: 0, max: 500_000 }),
    raise: fc.constantFrom(0, 0.03, 0.1),
    pess: fc.double({ min: -0.05, max: 0.05, noNaN: true }),
    gap1: fc.double({ min: 0, max: 0.05, noNaN: true }),
    gap2: fc.double({ min: 0, max: 0.05, noNaN: true }),
    months: fc.integer({ min: 1, max: 240 }),
    target: fc.constantFrom("growth", "bond", "cash") as fc.Arbitrary<ForecastAssumptions["reinvestTarget"]>,
    expense: fc.option(fc.record({ inMonths: fc.integer({ min: 0, max: 240 }), huf: fc.integer({ min: 0, max: 40_000_000 }) }), { nil: undefined }),
    withdraw: fc.option(fc.record({ inMonths: fc.integer({ min: 1, max: 240 }), huf: fc.integer({ min: 1, max: 1_000_000 }) }), { nil: undefined }),
    bond: fc.option(fc.record({ face: fc.integer({ min: 100_000, max: 5_000_000 }), inMonths: fc.integer({ min: 1, max: 120 }) }), { nil: undefined }),
  });
  const ym = (monthsAhead: number) => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth() + monthsAhead, 15);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  it("pessimistic ≤ realistic ≤ optimistic in every month", () => {
    fc.assert(
      fc.property(input, (x) => {
        const s = portfolio(
          x.growth,
          x.bond ? [{ key: "B", face: x.bond.face, value: x.bond.face * 0.95, maturity: `${ym(x.bond.inMonths)}-15` }] : [],
        );
        const r = projectForecast(
          s,
          assume({
            annualReturn: { pess: x.pess, real: x.pess + x.gap1, opt: x.pess + x.gap1 + x.gap2 },
            monthlySavingHuf: x.saving,
            savingGrowth: x.raise,
            months: x.months,
            reinvestTarget: x.target,
            reinvestBondRate: 0.05,
            withdrawal: x.withdraw && { enabled: true, start: ym(x.withdraw.inMonths), monthlyHuf: x.withdraw.huf },
          }),
          x.expense ? [{ id: "e", date: `${ym(x.expense.inMonths)}-20`, amountHuf: x.expense.huf }] : [],
          NOW,
        );
        expect(r.points).toHaveLength(x.months + 1);
        for (const p of r.points) {
          for (const k of SCENARIOS) expect(Number.isFinite(p[k])).toBe(true);
          expect(p.pess).toBeLessThanOrEqual(p.real + 1e-6 * Math.max(1, Math.abs(p.real)));
          expect(p.real).toBeLessThanOrEqual(p.opt + 1e-6 * Math.max(1, Math.abs(p.opt)));
        }
      }),
    );
  });

  it("at 0% return nothing is created or lost: value = start + savings − outflows (+ bond accretion)", () => {
    fc.assert(
      fc.property(input, (x) => {
        const r = projectForecast(
          portfolio(x.growth),
          assume({
            monthlySavingHuf: x.saving,
            savingGrowth: x.raise,
            months: x.months,
            reinvestTarget: x.target,
            withdrawal: x.withdraw && { enabled: true, start: ym(x.withdraw.inMonths), monthlyHuf: x.withdraw.huf },
          }),
          x.expense ? [{ id: "e", date: `${ym(x.expense.inMonths)}-20`, amountHuf: x.expense.huf }] : [],
          NOW,
        );
        for (const p of r.points) expect(p.real).toBeCloseTo(p.contributed, 3);
      }),
    );
  });
});

describe("deflateResult – today's forint", () => {
  const r = run(portfolio(1_000_000), { annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 }, months: 24 });

  it("divides month i by (1+inflation)^(i/12); the paid-in capital stays nominal", () => {
    const d = deflateResult(r, 0.05);
    expect(d.points[12].real).toBeCloseTo(r.points[12].real / 1.05, 6);
    expect(d.points[24].opt).toBeCloseTo(r.points[24].opt / 1.05 ** 2, 6);
    expect(d.points[0].real).toBe(r.points[0].real);
    expect(d.points[24].contributed).toBe(r.points[24].contributed);
    // The nominal result is left untouched.
    expect(r.points[12].real).toBeCloseTo(1_060_000, 4);
  });

  it("6% return with 6% inflation is flat in today's forint", () => {
    const flat = deflateResult(run(portfolio(1_000_000), { annualReturn: { pess: 0.06, real: 0.06, opt: 0.06 }, months: 60 }), 0.06);
    for (const p of flat.points) expect(p.real).toBeCloseTo(1_000_000, 4);
  });

  it("no inflation: the same result", () => {
    expect(deflateResult(r, 0)).toBe(r);
  });
});

describe("projectMonteCarlo", () => {
  const s = portfolio(5_000_000);
  const a = assume({ annualReturn: { pess: 0.02, real: 0.06, opt: 0.1 }, monthlySavingHuf: 100_000, months: 120 });

  it("zero volatility is exactly the deterministic realistic path", () => {
    const mc = projectMonteCarlo(s, a, [], { sigma: 0, runs: 50 }, NOW);
    const det = projectForecast(s, a, [], NOW);
    for (let i = 0; i <= 120; i += 12) {
      expect(mc.points[i].pess).toBeCloseTo(det.points[i].real, 2);
      expect(mc.points[i].opt).toBeCloseTo(det.points[i].real, 2);
    }
  });

  it("the same seed gives the same fan; the percentiles are in order", () => {
    const one = projectMonteCarlo(s, a, [], { sigma: 0.15, runs: 300, seed: 7 }, NOW);
    const two = projectMonteCarlo(s, a, [], { sigma: 0.15, runs: 300, seed: 7 }, NOW);
    expect(two.points).toEqual(one.points);
    for (const p of one.points) {
      expect(p.pess).toBeLessThanOrEqual(p.real);
      expect(p.real).toBeLessThanOrEqual(p.opt);
    }
    for (const d of one.dist!) for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]);
    expect(one.shortfallProb).toBe(0);
  });

  it("the average path grows at the realistic return (the median a bit below)", () => {
    const mc = projectMonteCarlo(portfolio(1_000_000), assume({ annualReturn: { pess: 0, real: 0.06, opt: 0 }, months: 120 }), [], { sigma: 0.15, runs: 4000, seed: 3 }, NOW);
    const last = mc.dist![120];
    const mean = last.reduce((t, v) => t + v, 0) / last.length;
    expect(mean / (1_000_000 * 1.06 ** 10)).toBeGreaterThan(0.95);
    expect(mean / (1_000_000 * 1.06 ** 10)).toBeLessThan(1.05);
    expect(mc.points[120].real).toBeLessThan(1_000_000 * 1.06 ** 10);
  });

  it("an unaffordable expense runs dry on every path", () => {
    const mc = projectMonteCarlo(portfolio(1_000_000), assume({ months: 24 }), [{ id: "x", date: "2027-03-01", amountHuf: 5_000_000 }], { sigma: 0.1, runs: 100 }, NOW);
    expect(mc.shortfallProb).toBe(1);
    expect(mc.shortfall.real).toBe("2027-03");
  });
});

describe("target finder", () => {
  const r = run(portfolio(1_000_000), { monthlySavingHuf: 100_000, months: 36 });

  it("firstReach: the first month at or above the target, or null", () => {
    expect(firstReach(r, "real", 1_000_000)).toBe("2026-10");
    expect(firstReach(r, "real", 2_000_000)).toBe("2027-08"); // 10 savings in
    expect(firstReach(r, "real", 99_000_000)).toBeNull();
  });

  it("probAtLeast: the share of paths at or above", () => {
    const fake = { dist: [Float64Array.from([1, 2, 3, 4])] } as unknown as ForecastResult;
    expect(probAtLeast(fake, 0, 0)).toBe(1);
    expect(probAtLeast(fake, 0, 2.5)).toBe(0.5);
    expect(probAtLeast(fake, 0, 3)).toBe(0.5);
    expect(probAtLeast(fake, 0, 5)).toBe(0);
    expect(probAtLeast(r, 0, 1)).toBeNull();
  });

  it("requiredMonthlySaving: the smallest whole thousand, not one more", () => {
    // 36 553 126 Ft in 14 months at 0%: 2 610 937.6 Ft/month → 2 611 000.
    const valueAt = (saving: number) => 14 * saving;
    expect(requiredMonthlySaving(valueAt, 36_553_126)).toBe(2_611_000);
    expect(requiredMonthlySaving(valueAt, 14_000)).toBe(1_000);
    expect(requiredMonthlySaving(valueAt, 0)).toBe(0);
    expect(requiredMonthlySaving(() => 0, 1)).toBeNull();
    // Needs 51.2 M Ft/month: reachable within the 100 M limit (was null).
    expect(requiredMonthlySaving((s) => s, 51_200_001)).toBe(51_201_000);
    expect(requiredMonthlySaving((s) => s, 100_000_000)).toBe(100_000_000);
    expect(requiredMonthlySaving((s) => s, 100_000_001)).toBeNull();
  });

  it("requiredMonthlySaving: the answer reaches the target, 1000 Ft less does not", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 60_000_000 }),
        fc.integer({ min: 1, max: 120 }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        (start, target, months, ret) => {
          const valueAt = (saving: number) =>
            run(portfolio(start), { monthlySavingHuf: saving, months, annualReturn: { pess: ret, real: ret, opt: ret } }).points[months].real;
          const need = requiredMonthlySaving(valueAt, target);
          if (need === null) {
            expect(valueAt(100_000_000)).toBeLessThan(target);
            return;
          }
          expect(valueAt(need)).toBeGreaterThanOrEqual(target - 1e-6);
          if (need > 0) expect(valueAt(need - 1000)).toBeLessThan(target);
          expect(need % 1000).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("backtest", () => {
  const y = 365.25 * 24 * 3600 * 1000;
  it("replays the assumed returns with the actual deposits", () => {
    const bt = backtest(
      [
        { ts: 0, value: 1_000_000, invested: 1_000_000 },
        { ts: y, value: 1_300_000, invested: 1_200_000 },
      ],
      { pess: 0, real: 0.1, opt: 0.2 },
    );
    expect(bt[1].pess).toBeCloseTo(1_200_000, 6);
    expect(bt[1].real).toBeCloseTo(1_300_000, 6);
    expect(bt[1].opt).toBeCloseTo(1_400_000, 6);
    expect(backtest([{ ts: 0, value: 1, invested: 1 }], { pess: 0, real: 0, opt: 0 })).toEqual([]);
  });
});

describe("detectRecurringSavings – the monthly budget", () => {
  let n = 0;
  const dep = (y: number, m: number, d: number, huf: number, type: "deposit" | "withdrawal" = "deposit"): Transaction => ({
    id: `d${++n}`,
    accountId: "a",
    date: new Date(y, m - 1, d, 10).toISOString(),
    type,
    currency: "HUF",
    grossAmount: huf,
    netAmount: type === "deposit" ? huf : -huf,
  });
  const monthly = (fromM: number, toM: number, huf: number, day = 10) =>
    Array.from({ length: toM - fromM + 1 }, (_, i) => {
      const k = fromM + i - 1; // months since Jan 2025, 0-based
      return dep(2025 + Math.floor(k / 12), (k % 12) + 1, day, huf);
    });

  it("a steady monthly deposit is the budget; the current month is left out", () => {
    const txs = [...monthly(10, 21, 150_000), dep(2026, 10, 5, 999_000)];
    expect(detectRecurringSavings(txs, {}, NOW).monthlyHuf).toBe(150_000);
  });

  it("a one-off lump sum is not a habit", () => {
    const txs = [...monthly(10, 21, 150_000), dep(2026, 3, 12, 25_000_000)];
    const r = detectRecurringSavings(txs, {}, NOW);
    expect(r.oneOffs.map((o) => o.month)).toEqual(["2026-03"]);
    // Only the months AFTER the lump count (Apr–Sep 2026).
    expect(r.monthlyHuf).toBe(150_000);
  });

  it("paying every other month reads as half", () => {
    const txs = Array.from({ length: 6 }, (_, i) => dep(2025 + Math.floor((9 + 2 * i) / 12), ((9 + 2 * i) % 12) + 1, 10, 200_000));
    expect(detectRecurringSavings(txs, {}, NOW).monthlyHuf).toBe(100_000);
  });

  it("a payday deposit (the month's last working day) counts for the next month", () => {
    // 30 Sep 2026 is September's last working day → October, the current month.
    const txs = [...monthly(10, 20, 150_000), dep(2026, 9, 30, 150_000)];
    const r = detectRecurringSavings(txs, {}, NOW);
    expect(r.months.at(-1)?.month).toBe("2026-10");
  });
});

describe("snapshots, milestones, helpers", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  const snap = (month: string, createdAt: string): ForecastSnapshot => ({ month, createdAt, startValueHuf: 1, points: [] });

  it("merge: one snapshot per month (the earlier wins), ascending, at most 36", () => {
    const m = mergeForecastSnapshots([snap("2026-02", "b"), snap("2026-01", "x")], [snap("2026-02", "a")]);
    expect(m.map((s) => [s.month, s.createdAt])).toEqual([["2026-01", "x"], ["2026-02", "a"]]);
    const many = Array.from({ length: 40 }, (_, i) => snap(`20${30 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, "c"));
    const capped = mergeForecastSnapshots(many, []);
    expect(capped).toHaveLength(36);
    expect(capped[0].month).toBe("2030-05");
    expect(mergeForecastSnapshots(capped, capped)).toEqual(capped);
  });

  it("record: once a month, the next 24 months", () => {
    const r = run(portfolio(1_000_000), { months: 30 });
    expect(recordForecastSnapshot(r, NOW)).toBe(true);
    expect(recordForecastSnapshot(r, NOW)).toBe(false);
    const [s] = loadForecastSnapshots();
    expect(s.month).toBe("2026-10");
    expect(s.points).toHaveLength(24);
    expect(s.points[0][0]).toBe("2026-11");
  });

  it("milestones at whole years within the horizon", () => {
    const r = run(portfolio(1), { months: 60 });
    expect(forecastMilestones(r).map((m) => [m.years, m.point.month])).toEqual([
      [1, "2027-10"],
      [3, "2029-10"],
      [5, "2031-10"],
    ]);
  });

  it("monthsUntil", () => {
    expect(monthsUntil("2026-10", NOW)).toBe(0);
    expect(monthsUntil("2027-01-31", NOW)).toBe(3);
    expect(monthsUntil("2025-12", NOW)).toBe(-10);
    expect(monthsUntil("rossz", NOW)).toBeNaN();
  });
});
