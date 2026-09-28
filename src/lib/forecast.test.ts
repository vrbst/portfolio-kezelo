import { describe, expect, it } from "vitest";
import { projectForecast, type ForecastAssumptions, type PlannedExpense } from "./forecast";
import type { PortfolioSummary } from "./portfolio";
import { savingsGoalExpenses, type SavingsGoal, type SavingsProgress } from "./savings";

// Invented sample data — one bond and round numbers, not a real portfolio.
// A 1 000 000 Ft bond paying 6% (60 000 Ft) every 15 December up to its
// maturity on 2029-12-15, next to 500 000 Ft of growth assets.
const NOW = new Date(2026, 9, 1);
const summary = {
  totalValueHuf: 1_500_000,
  netDepositedHuf: 1_500_000,
  accounts: [
    {
      holdings: [
        {
          quantity: 1_000_000,
          marketValueHuf: 1_000_000,
          instrument: {
            key: "BOND",
            type: "gov_bond",
            bond: {
              couponRate: 0.06,
              couponIntervalMonths: 12,
              firstCouponDate: "2025-12-15",
              maturity: "2029-12-15",
            },
          },
        },
      ],
    },
  ],
} as unknown as PortfolioSummary;

const assume = (patch: Partial<ForecastAssumptions> = {}): ForecastAssumptions => ({
  annualReturn: { pess: 0, real: 0, opt: 0 },
  monthlySavingHuf: 0,
  reinvestTarget: "growth",
  reinvestBondRate: 0,
  months: 60,
  ...patch,
});

const goal = (patch: Partial<PlannedExpense> = {}): PlannedExpense => ({
  id: "goal:G",
  date: "2028-06-30",
  amountHuf: 200_000,
  note: "Cél",
  ...patch,
});

const run = (expenses: PlannedExpense[], a: Partial<ForecastAssumptions> = {}) =>
  projectForecast(summary, assume(a), expenses, NOW);
const at = (r: ReturnType<typeof run>, month: string) =>
  r.points.find((p) => p.month === month)!;

describe("forecast – coupons claimed by a savings goal", () => {
  it("a goal without the claim: every coupon is reinvested (as before)", () => {
    const r = run([goal()]);
    expect(r.couponHuf).toBeCloseTo(240_000);
    expect(r.goalCouponHuf).toBe(0);
    expect(r.events.find((e) => e.kind === "goal")?.huf).toBe(200_000);
  });

  it("claimed coupons leave when they arrive; the date takes only the rest", () => {
    const plain = run([goal()]);
    const claim = run([goal({ couponCapHuf: 200_000 })]);
    // 2026-12 and 2027-12 fall before the goal date: 120 000 Ft goes to it.
    expect(claim.goalCouponHuf).toBeCloseTo(120_000);
    expect(claim.couponHuf).toBeCloseTo(240_000);
    expect(claim.events.find((e) => e.kind === "goal")?.huf).toBeCloseTo(80_000);
    // Not in the portfolio (neither as growth nor as cash) until the date…
    expect(plain.points[0].real - claim.points[0].real).toBeCloseTo(0);
    expect(at(plain, "2027-01").real - at(claim, "2027-01").real).toBeCloseTo(60_000);
    expect(at(plain, "2028-01").real - at(claim, "2028-01").real).toBeCloseTo(120_000);
    // …and the same total leaves: with 0% return the paths meet on the date.
    expect(at(claim, "2028-06").real).toBeCloseTo(at(plain, "2028-06").real);
    expect(claim.points.at(-1)!.real).toBeCloseTo(plain.points.at(-1)!.real);
    // The contributed-capital baseline ends the same, too.
    expect(claim.points.at(-1)!.contributed).toBeCloseTo(plain.points.at(-1)!.contributed);
  });

  it("with a positive return only the coupons' lost growth remains", () => {
    const ret = { annualReturn: { pess: 0.06, real: 0.06, opt: 0.06 } };
    const plain = run([goal()], ret);
    const claim = run([goal({ couponCapHuf: 200_000 })], ret);
    const gap = plain.points.at(-1)!.real - claim.points.at(-1)!.real;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.2 * 120_000);
  });

  it("coupons after the goal date follow the reinvest setting", () => {
    const r = run([goal({ date: "2027-06-30", couponCapHuf: 200_000 })]);
    expect(r.goalCouponHuf).toBeCloseTo(60_000); // only the 2026-12 coupon
    expect(r.events.find((e) => e.kind === "goal")?.huf).toBeCloseTo(140_000);
  });

  it("claims no more than the goal's cap — the rest is reinvested", () => {
    const r = run([goal({ couponCapHuf: 50_000 })]);
    expect(r.goalCouponHuf).toBeCloseTo(50_000);
    expect(r.events.find((e) => e.kind === "goal")?.huf).toBeCloseTo(150_000);
    const plain = run([goal()]);
    expect(at(plain, "2027-01").real - at(r, "2027-01").real).toBeCloseTo(50_000);
  });

  it("two goals share a coupon in proportion to their room", () => {
    const r = run([
      goal({ id: "goal:A", date: "2027-06-30", amountHuf: 30_000, couponCapHuf: 30_000 }),
      goal({ id: "goal:B", date: "2027-06-30", amountHuf: 90_000, couponCapHuf: 90_000 }),
    ]);
    // 60 000 Ft for a room of 120 000 Ft: half of each.
    expect(r.goalCouponHuf).toBeCloseTo(60_000);
    const due = r.events.filter((e) => e.kind === "goal").map((e) => Math.round(e.huf));
    expect(due.sort((x, y) => x - y)).toEqual([15_000, 45_000]);
  });

  it("the cash and bond reinvest settings leave the goal's coupons out too", () => {
    for (const reinvestTarget of ["cash", "bond"] as const) {
      const plain = run([goal()], { reinvestTarget });
      const claim = run([goal({ couponCapHuf: 200_000 })], { reinvestTarget });
      expect(at(plain, "2027-01").real - at(claim, "2027-01").real).toBeCloseTo(60_000);
    }
  });

  it("a goal already past is ignored", () => {
    const r = run([goal({ date: "2026-09-01", couponCapHuf: 200_000 })]);
    expect(r.goalCouponHuf).toBe(0);
  });
});

describe("savingsGoalExpenses – coupon cap", () => {
  const g: SavingsGoal = {
    id: "G",
    name: "Cél",
    targetHuf: 200_000,
    targetDate: "2028-06-30",
    instrumentKeys: [],
    includeCoupons: true,
    createdAt: "2026-01-01",
  } as SavingsGoal;
  // 90 000 Ft from its instruments/cash + 60 000 Ft of counted coupons.
  const progress = [{ goal: g, projectedHuf: 150_000, couponsHuf: 60_000 } as SavingsProgress];

  it("the goal claims what its instruments and cash don't cover", () => {
    expect(savingsGoalExpenses([g], progress)[0].couponCapHuf).toBeCloseTo(110_000);
  });

  it("no claim without includeCoupons, without progress, or when covered", () => {
    expect(savingsGoalExpenses([{ ...g, includeCoupons: false }], progress)[0].couponCapHuf).toBeUndefined();
    expect(savingsGoalExpenses([g])[0].couponCapHuf).toBeUndefined();
    const covered = [{ goal: g, projectedHuf: 260_000, couponsHuf: 60_000 } as SavingsProgress];
    expect(savingsGoalExpenses([g], covered)[0].couponCapHuf).toBeUndefined();
  });
});
