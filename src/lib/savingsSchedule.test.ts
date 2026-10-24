import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { computePortfolio } from "./portfolio";
import {
  computeSavingsProgress,
  futureCouponOptions,
  reminderSettings,
  savingsMonthStates,
  type SavingsGoal,
} from "./savings";
import { goalHistory, goalSchedule, goalStartDay } from "./savingsSchedule";

// Invented sample data (same shape as savings.test.ts): a bond with a yearly
// 300 000 Ft coupon on 10 October and a T-bill held for the goal.

const ACC: Account = {
  id: "kincstar",
  name: "Kincstár",
  provider: "allamkincstar",
  kind: "treasury",
  currency: "HUF",
};

const BOND: Instrument = {
  key: "fix-2031",
  name: "Fix 2031",
  type: "gov_bond",
  currency: "HUF",
  faceValue: 1,
  maturity: "2031-10-10",
  bond: {
    couponRate: 0.1,
    couponIntervalMonths: 12,
    firstCouponDate: "2025-10-10",
    maturity: "2031-10-10",
  },
};

const DKJ: Instrument = {
  key: "dkj-261201",
  name: "DKJ 261201",
  type: "tbill",
  currency: "HUF",
  faceValue: 1,
  maturity: "2026-12-01",
};

const instruments = new Map([BOND, DKJ].map((i) => [i.key, i]));

const tx = (patch: Partial<Transaction> & Pick<Transaction, "id" | "date" | "type">): Transaction => ({
  accountId: ACC.id,
  currency: "HUF",
  ...patch,
});

const TXS: Transaction[] = [
  tx({ id: "dep", date: "2025-01-02", type: "deposit", grossAmount: 5_000_000, netAmount: 5_000_000 }),
  tx({ id: "b-bond", date: "2025-01-10", type: "buy", instrumentKey: BOND.key, quantity: 3_000_000, grossAmount: 3_000_000, netAmount: -3_000_000 }),
  tx({ id: "b-dkj", date: "2026-06-01", type: "buy", instrumentKey: DKJ.key, quantity: 400_000, grossAmount: 380_000, netAmount: -380_000 }),
];

const GOAL: SavingsGoal = {
  id: "g",
  name: "Cél",
  targetHuf: 1_000_000,
  targetDate: "2026-12-15",
  instrumentKeys: [DKJ.key],
  includeCoupons: true,
  createdAt: "2026-01-01",
};

const NOW = new Date("2026-10-05T12:00:00");

function build(goal: SavingsGoal) {
  const goals = [goal];
  const [p] = computeSavingsProgress(goals, [ACC], TXS, instruments, new Map(), {}, NOW);
  const summary = computePortfolio([ACC], TXS, instruments, new Map(), {}, NOW);
  const coupons = futureCouponOptions(summary, TXS, NOW);
  const [state] = savingsMonthStates(goals, [ACC], TXS, instruments, new Map(), {}, NOW);
  const schedule = goalSchedule(p, goals, coupons, summary, instruments, state.planHuf, NOW);
  return { p, schedule };
}

describe("goalSchedule", () => {
  it("has one saving row per month left, summing to the gap", () => {
    const { p, schedule } = build(GOAL);
    const savings = schedule.rows.filter((r) => r.kind === "saving");
    expect(savings).toHaveLength(p.monthsLeft);
    const sum = savings.reduce((s, r) => s + r.huf, 0);
    expect(sum).toBeCloseTo(p.gapHuf, -2);
  });

  it("starts the saving at a later saveFrom, on that day", () => {
    const { p, schedule } = build({ ...GOAL, saveFrom: "2026-11-15" });
    expect(p.savingStartsOn).toBe("2026-11-15");
    const savings = schedule.rows.filter((r) => r.kind === "saving");
    expect(savings[0].day).toBe("2026-11-15");
    expect(savings.every((r) => r.day >= "2026-11-15")).toBe(true);
    expect(schedule.startDay).toBe("2026-11-15");
  });

  it("lists days as local calendar days, ending on the target", () => {
    const { schedule } = build(GOAL);
    for (const r of schedule.rows) expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(schedule.rows.at(-1)).toMatchObject({ kind: "target", day: "2026-12-15" });
    const days = schedule.rows.map((r) => r.day);
    expect(days).toEqual([...days].sort());
  });

  it("the expected-value path ends at the target date on the target", () => {
    const { schedule } = build(GOAL);
    const last = schedule.path.at(-1)!;
    expect(last.day).toBe("2026-12-15");
    expect(last.valueHuf).toBeCloseTo(GOAL.targetHuf, -2);
  });

  it("marks the coupon and the assigned maturity", () => {
    const { schedule } = build(GOAL);
    expect(schedule.rows.find((r) => r.kind === "coupon")).toMatchObject({ day: "2026-10-10", huf: 300_000 });
    expect(schedule.rows.find((r) => r.kind === "maturity")).toMatchObject({ day: "2026-12-01", adds: false });
  });

  it("a covered goal has no saving rows", () => {
    const { schedule } = build({ ...GOAL, targetHuf: 300_000 });
    expect(schedule.rows.some((r) => r.kind === "saving")).toBe(false);
  });
});

describe("goalStartDay", () => {
  it("is the creation day, or a later saving start", () => {
    expect(goalStartDay(GOAL)).toBe("2026-01-01");
    expect(goalStartDay({ ...GOAL, saveFrom: "2026-11-15" })).toBe("2026-11-15");
    expect(goalStartDay({ ...GOAL, saveFrom: "2025-05-01" })).toBe("2026-01-01");
  });
});

describe("surplus", () => {
  const surplusOf = (goal: SavingsGoal) => build(goal).p;

  it("instruments beyond the target are a surplus", () => {
    const p = surplusOf({ ...GOAL, targetHuf: 300_000, includeCoupons: false });
    expect(p.surplusHuf).toBeCloseTo(100_000);
    expect(p.unneededCouponsHuf).toBe(0);
  });

  it("free coupons that are not needed are no surplus, but are reported", () => {
    const p = surplusOf({ ...GOAL, targetHuf: 600_000 });
    expect(p.surplusHuf).toBe(0);
    expect(p.unneededCouponsHuf).toBeCloseTo(100_000);
  });

  it("no surplus while the goal is short", () => {
    const p = surplusOf(GOAL);
    expect(p.surplusHuf).toBe(0);
    expect(p.unneededCouponsHuf).toBe(0);
  });
});

describe("reminderSettings", () => {
  it("keeps the stored minimum days when the reminder is off or no instrument is left", () => {
    const prev = { minDaysToMaturity: 60 };
    expect(reminderSettings(prev, true, false, "30")).toEqual({ monthlyReminder: undefined, minDaysToMaturity: 60 });
    expect(reminderSettings(prev, false, true, "30")).toEqual({ monthlyReminder: undefined, minDaysToMaturity: 60 });
  });

  it("an active reminder writes the entered days (empty = the default)", () => {
    expect(reminderSettings({ minDaysToMaturity: 60 }, true, true, "45")).toEqual({
      monthlyReminder: true,
      minDaysToMaturity: 45,
    });
    expect(reminderSettings(undefined, true, true, "")).toEqual({ monthlyReminder: true, minDaysToMaturity: undefined });
  });
});

describe("goalHistory", () => {
  it("is empty before the start, otherwise runs from the start day to today", () => {
    expect(goalHistory({ ...GOAL, createdAt: "2026-10-05" }, [ACC], TXS, instruments, new Map(), {}, NOW)).toEqual([]);
    const h = goalHistory(GOAL, [ACC], TXS, instruments, new Map(), {}, NOW);
    expect(h[0].day).toBe("2026-01-01");
    expect(h.at(-1)!.day).toBe("2026-10-05");
    // the T-bill was bought on 1 June: nothing before, its face value after
    expect(h.find((x) => x.day === "2026-05-31")!.valueHuf).toBe(0);
    expect(h.find((x) => x.day === "2026-06-30")!.valueHuf).toBeCloseTo(400_000);
  });
});
