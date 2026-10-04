import { describe, expect, it } from "vitest";
import { defaultGlobals, type Bucket, type GlideConfig, type InstrumentRule } from "./glidePath";
import type { Instrument } from "./model";
import type { Goal } from "./goals";
import type { SavingsGoal, SavingsProgress } from "./savings";
import type { Cashflow } from "./bonds";
import { allocationState, type Position } from "./rebalance";
import { freezeInflowPath, projectGlide, savingsHufOn, type ProjectionInput } from "./glideProjection";

// Invented sample data — generic buckets and round numbers, not a real portfolio.

const TODAY = "2026-09-29";

function bucket(id: string, finalWeight: number): Bucket {
  return {
    id,
    name: id,
    finalWeight,
    start: { mode: "manual", weight: finalWeight },
    startDate: "2026-09-29",
    endDate: "2030-01-01",
    interpolation: "linear",
    band: { kind: "abs", pp: 0.05 },
  };
}

const rule = (bucketId: string, patch: Partial<InstrumentRule> = {}): InstrumentRule => ({
  bucketId,
  sellable: true,
  acceptsContributions: true,
  ...patch,
});

function config(patch: Partial<GlideConfig> = {}): GlideConfig {
  return {
    id: "v1",
    validFrom: TODAY,
    savedAt: `${TODAY}T00:00:00Z`,
    buckets: [bucket("R", 0.6), bucket("K", 0.4)],
    instruments: { ETF: rule("R"), BOND: rule("K") },
    ...defaultGlobals(),
    monthlyAmount: { kind: "remainder" },
    ...patch,
  };
}

const instruments = new Map<string, Instrument>([
  ["ETF", { key: "ETF", name: "ETF", type: "etf" } as Instrument],
  ["BOND", { key: "BOND", name: "BOND", type: "gov_bond" } as Instrument],
]);

const positions = (etf: number, bond: number): Position[] => [
  { key: "ETF", name: "ETF", valueHuf: etf },
  { key: "BOND", name: "BOND", valueHuf: bond },
];

function input(patch: Partial<ProjectionInput> = {}): ProjectionInput {
  const cfg = patch.cfg ?? config();
  return {
    cfg,
    state: allocationState(cfg, positions(4_000_000, 6_000_000), TODAY),
    instruments,
    cashflows: [],
    savings: [],
    dcaGoals: [],
    budgetHuf: 0,
    annualReturn: 0,
    today: TODAY,
    until: "2040-01-01",
    ...patch,
  };
}

const coupon = (date: string, amountHuf: number, key = "BOND"): Cashflow => ({
  date,
  kind: "coupon",
  title: "kamat",
  amountHuf,
  instrumentKey: key,
});

function progress(goal: Partial<SavingsGoal>, patch: Partial<SavingsProgress> = {}): SavingsProgress {
  return {
    goal: {
      id: "g1",
      name: "Cél",
      targetHuf: 1_000_000,
      targetDate: "2027-03-31",
      instrumentKeys: [],
      includeCoupons: false,
      createdAt: TODAY,
      ...goal,
    },
    assignedValueHuf: 0,
    couponsHuf: 0,
    pickedCouponsHuf: 0,
    projectedHuf: 0,
    targetHuf: 1_000_000,
    progressPct: 0,
    projectedPct: 0,
    gapHuf: 1_000_000,
    monthsLeft: 6,
    daysLeft: 180,
    monthlyNeededHuf: 100_000,
    plannedMonthlyHuf: 100_000,
    couponRoomHuf: 0,
    thisMonthNetHuf: 0,
    reservedHuf: 0,
    autoCashHuf: 0,
    monthAdjective: "októberi",
    reached: false,
    ...patch,
  };
}

const weightOn = (p: ReturnType<typeof projectGlide>, day: string) =>
  p.points.find((x) => x.day === day)!.weights;

describe("projectGlide", () => {
  it("stays put with no inflows and no return", () => {
    const p = projectGlide(input({ until: "2027-01-01" }));
    expect(p.points.map((x) => x.day)).toEqual(["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(weightOn(p, "2027-01-01").R).toBeCloseTo(0.4);
    expect(p.reachedOn).toBeUndefined();
  });

  it("routes a free coupon to the underweight bucket", () => {
    const p = projectGlide(input({ cashflows: [coupon("2026-11-15", 5_000_000)] }));
    // 9M stocks / 15M total = 60% → arrived.
    expect(weightOn(p, "2026-11-01").R).toBeCloseTo(0.4);
    expect(weightOn(p, "2026-12-01").R).toBeCloseTo(0.6);
    expect(p.reachedOn).toBe("2026-12-01");
  });

  it("leaves a coupon a goal picked with the goal", () => {
    const picked = progress({ couponIds: ["BOND@2026-11-15"], targetDate: "2027-03-31" });
    const p = projectGlide(
      input({ cashflows: [coupon("2026-11-15", 5_000_000)], savings: [picked] }),
    );
    expect(weightOn(p, "2026-12-01").R).toBeCloseTo(0.4);
  });

  it("gives an includeCoupons goal its room first, the rest to the path", () => {
    const g = progress({ includeCoupons: true }, { couponRoomHuf: 1_000_000 });
    const p = projectGlide(
      input({ cashflows: [coupon("2026-11-15", 2_000_000)], savings: [g] }),
    );
    // 1M to the goal, 1M to stocks: 5M / 11M.
    expect(weightOn(p, "2026-12-01").R).toBeCloseTo(5 / 11);
  });

  it("the monthly remainder grows once a goal's date has passed", () => {
    const g = progress({ targetDate: "2026-11-30" });
    const p = projectGlide(
      input({ savings: [g], budgetHuf: 100_000, until: "2027-01-01" }),
    );
    // Oct, Nov: the goal takes the whole budget. Dec, Jan: 100k/month to stocks.
    expect(weightOn(p, "2026-11-01").R).toBeCloseTo(0.4);
    expect(weightOn(p, "2027-01-01").R).toBeCloseTo(4_200_000 / 10_200_000);
  });

  it("counts a DCA goal buying a bucket instrument", () => {
    const dca: Goal = { id: "d", instrumentKey: "ETF", amountHuf: 300_000, periodMonths: 3, createdAt: TODAY };
    const other: Goal = { id: "x", instrumentKey: "ELSEWHERE", amountHuf: 50_000, periodMonths: 1, createdAt: TODAY };
    const p = projectGlide(input({ dcaGoals: [dca, other], until: "2026-10-01" }));
    // 100k/month into ETF; the other DCA is outside the buckets.
    expect(weightOn(p, "2026-10-01").R).toBeCloseTo(4_100_000 / 10_100_000);
  });

  it("a maturing bucket bond leaves its bucket and its money is routed", () => {
    const flows: Cashflow[] = [
      { date: "2027-02-10", kind: "maturity", title: "lejárat", amountHuf: 6_000_000, instrumentKey: "BOND" },
    ];
    const p = projectGlide(input({ cashflows: flows }));
    // The 6M bond becomes 6M of routed cash: 60/40 of 10M.
    expect(weightOn(p, "2027-03-01").R).toBeCloseTo(0.6);
    expect(weightOn(p, "2027-03-01").K).toBeCloseTo(0.4);
  });

  it("a goal's own maturing bond is its payout, not routed", () => {
    const flows: Cashflow[] = [
      { date: "2027-02-10", kind: "maturity", title: "lejárat", amountHuf: 6_000_000, instrumentKey: "BOND" },
    ];
    const owner = progress({ instrumentKeys: ["BOND"], targetDate: "2027-03-31" });
    const p = projectGlide(input({ cashflows: flows, savings: [owner] }));
    expect(weightOn(p, "2027-03-01").R).toBeCloseTo(1);
  });

  it("the return grows the non-bond part only", () => {
    const p = projectGlide(input({ annualReturn: 0.1, until: "2027-09-01" }));
    // 4M × 1.1 after 12 months, bonds flat at 6M.
    expect(weightOn(p, "2027-09-01").R).toBeCloseTo(4.4 / 10.4, 3);
  });

  it("does not report arrival for a line that never gets there", () => {
    const p = projectGlide(input({ budgetHuf: 0 }));
    expect(p.reachedOn).toBeUndefined();
  });
});

describe("savingsHufOn", () => {
  it("counts a goal until its date and from its saving start", () => {
    const g = progress({ targetDate: "2027-03-31" }, { savingStartsOn: "2026-12-01" });
    expect(savingsHufOn([g], "2026-11-01")).toBe(0);
    expect(savingsHufOn([g], "2026-12-01")).toBe(100_000);
    expect(savingsHufOn([g], "2027-04-01")).toBe(0);
    expect(savingsHufOn([progress({}, { reached: true })], "2026-12-01")).toBe(0);
  });
});

describe("freezeInflowPath", () => {
  it("starts from today's actual weights and rises at 0% return", () => {
    const { annualReturn: _, ...base } = input({ budgetHuf: 100_000, annualReturn: 0.1 });
    const f = freezeInflowPath(base);
    const path = f.inflowPath!;
    expect(path[0]).toEqual({ day: TODAY, weights: { R: 0.4, K: 0.6 } });
    // Only the money moves it: same as the 0% projection, whatever the return.
    const zero = projectGlide({ ...base, annualReturn: 0 });
    expect(zero.reachedOn).toBeDefined();
    expect(path.slice(1)).toEqual(zero.points.filter((p) => p.day <= zero.reachedOn!));
    expect(path[path.length - 1].day).toBe(zero.reachedOn);
    for (let i = 1; i < path.length; i++)
      expect(path[i].weights.R).toBeGreaterThanOrEqual(path[i - 1].weights.R - 1e-12);
    expect(f.inflowReached).toBe(true);
  });

  it("no inflows: never arrives", () => {
    const { annualReturn: _, ...base } = input();
    expect(freezeInflowPath(base).inflowReached).toBe(false);
  });
});
