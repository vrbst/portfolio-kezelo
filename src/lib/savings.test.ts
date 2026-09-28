import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import {
  computeSavingsProgress,
  holdCashAdvice,
  reservedCashByAccount,
  savingsGoalAlerts,
  savingsMonthlyStatus,
  suitableForGoalBuy,
  type SavingsGoal,
} from "./savings";

// Invented sample data — not a real portfolio. A fixed-rate bond pays a
// 300 000 Ft yearly coupon on 10 October; a T-bill maturing before the goal's
// date is assigned to the goal, which also earmarks the coupons.

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

const BASE_TXS: Transaction[] = [
  tx({ id: "dep", date: "2025-01-02", type: "deposit", grossAmount: 5_000_000, netAmount: 5_000_000 }),
  tx({ id: "b-bond", date: "2025-01-10", type: "buy", instrumentKey: BOND.key, quantity: 3_000_000, grossAmount: 3_000_000, netAmount: -3_000_000 }),
  tx({ id: "b-dkj", date: "2026-06-01", type: "buy", instrumentKey: DKJ.key, quantity: 400_000, grossAmount: 380_000, netAmount: -380_000 }),
];
const COUPON = tx({ id: "kupon", date: "2026-10-10", type: "interest", instrumentKey: BOND.key, grossAmount: 300_000, netAmount: 300_000 });

const GOAL: SavingsGoal = {
  id: "g",
  name: "Cél",
  targetHuf: 1_000_000,
  targetDate: "2026-12-15",
  instrumentKeys: [DKJ.key],
  includeCoupons: true,
  monthlyReminder: true,
  createdAt: "2026-01-01",
};

const at = (day: string) => new Date(`${day}T12:00:00`);
const progress = (txs: Transaction[], now: Date) =>
  computeSavingsProgress([GOAL], [ACC], txs, instruments, new Map(), {}, now)[0];
const status = (txs: Transaction[], now: Date) =>
  savingsMonthlyStatus([GOAL], [ACC], txs, instruments, new Map(), {}, now)[0];

describe("savings goal – a coupon credited this month", () => {
  it("fixture: before the coupon it is projected, the gap is 300 000", () => {
    const p = progress(BASE_TXS, at("2026-10-05"));
    expect(p.couponsHuf).toBeCloseTo(300_000);
    expect(p.gapHuf).toBeCloseTo(300_000);
    expect(p.monthsLeft).toBe(3);
  });

  it("counts the coupon only once in this month's quota", () => {
    // Month start (October): gap 300 000 over 3 months = 100 000/month. The
    // coupon arrives on 10 Oct and is expected to be reinvested on top:
    // 100 000 + 300 000 = 400 000 this month — not the arrived coupon ALSO
    // swelling the gap that is spread over the months (≈ 500 000).
    const s = status([...BASE_TXS, COUPON], at("2026-10-20"));
    expect(s.couponHuf).toBeCloseTo(300_000);
    expect(s.baseNeededHuf).toBeCloseTo(100_000);
    expect(s.neededHuf).toBeCloseTo(400_000);
  });

  it("the true remaining gap still includes the not-yet-reinvested coupon", () => {
    expect(progress([...BASE_TXS, COUPON], at("2026-10-20")).gapHuf).toBeCloseTo(600_000);
  });
});

describe("savings goal – which coupons the monthly status claims", () => {
  const LY: Account = { id: "ly", name: "LY", provider: "lightyear", kind: "regular", currency: "EUR" };
  const statusOf = (goals: SavingsGoal[], txs: Transaction[], day: string) =>
    savingsMonthlyStatus(goals, [ACC, LY], txs, instruments, new Map(), { EUR: 400 }, at(day));

  it("a broker's cash interest is not a coupon the goal claims", () => {
    const cashInterest = tx({ id: "ly-int", date: "2026-10-12", type: "interest", accountId: LY.id, currency: "EUR", netAmount: 50 });
    const s = statusOf([GOAL], [...BASE_TXS, cashInterest], "2026-10-20");
    expect(s[0].couponHuf).toBe(0);
  });

  it("a covered goal claims no coupon and raises no coupon quota", () => {
    const covered = { ...GOAL, targetHuf: 300_000 };
    const s = statusOf([covered], [...BASE_TXS, COUPON], "2026-10-20");
    expect(s[0].couponHuf).toBe(0);
    expect(s[0].neededHuf).toBe(0);
    expect(s[0].done).toBe(true);
  });

  it("a goal past its date claims no coupon", () => {
    const past = { ...GOAL, targetDate: "2026-10-15" };
    const late = tx({ ...COUPON, id: "kupon-late", date: "2026-10-18" });
    const s = statusOf([past], [...BASE_TXS, late], "2026-10-20");
    expect(s[0].couponHuf).toBe(0);
  });

  it("two claiming goals share this month's coupon in proportion to their room", () => {
    // Both count the same DKJ (400 000): rooms 1 000 000 − 400 000 = 600 000
    // and 700 000 − 400 000 = 300 000 → the 300 000 coupon splits 2:1.
    const other: SavingsGoal = { ...GOAL, id: "g2", name: "Másik", targetHuf: 700_000 };
    const s = statusOf([GOAL, other], [...BASE_TXS, COUPON], "2026-10-20");
    expect(s.find((x) => x.goalId === "g")!.couponHuf).toBeCloseTo(200_000);
    expect(s.find((x) => x.goalId === "g2")!.couponHuf).toBeCloseTo(100_000);
  });
});

describe("savings goal – coupon room is the actual shortfall", () => {
  it("equals the gap, and this month's own buys into the goal shrink it", () => {
    const before = progress([...BASE_TXS, COUPON], at("2026-10-20"));
    expect(before.couponRoomHuf).toBeCloseTo(600_000);
    expect(before.couponRoomHuf).toBe(before.gapHuf);
    // 200 000 face of the goal's DKJ bought this month → room 400 000.
    const buy = tx({ id: "b-dkj-2", date: "2026-10-15", type: "buy", instrumentKey: DKJ.key, quantity: 200_000, grossAmount: 195_000, netAmount: -195_000 });
    const after = progress([...BASE_TXS, COUPON, buy], at("2026-10-20"));
    expect(after.couponRoomHuf).toBeCloseTo(400_000);
    expect(after.couponRoomHuf).toBe(after.gapHuf);
  });

  it("a goal whose room this month's buys have used up claims less of the coupon", () => {
    // Room 600 000 − 450 000 bought = 150 000 → only that much of the 300 000 coupon.
    const buy = tx({ id: "b-dkj-3", date: "2026-10-15", type: "buy", instrumentKey: DKJ.key, quantity: 450_000, grossAmount: 440_000, netAmount: -440_000 });
    const s = status([...BASE_TXS, COUPON, buy], at("2026-10-20"));
    expect(s.couponHuf).toBeCloseTo(150_000);
  });
});

describe("savings goal – instruments too close to maturity", () => {
  // DKJ matures 2026-12-01, the goal's date is 2026-12-15.
  const goal = (patch: Partial<SavingsGoal> = {}): SavingsGoal => ({ ...GOAL, ...patch });

  it("suitable while it matures more than N days after the buy and by the date", () => {
    expect(suitableForGoalBuy(DKJ, goal(), "2026-10-31")).toBe(true);
    // exactly N = 30 days before maturity: no longer
    expect(suitableForGoalBuy(DKJ, goal(), "2026-11-01")).toBe(false);
    expect(suitableForGoalBuy(DKJ, goal({ minDaysToMaturity: 10 }), "2026-11-01")).toBe(true);
  });

  it("not suitable if it matures after the target date; no maturity is fine", () => {
    expect(suitableForGoalBuy(DKJ, goal({ targetDate: "2026-11-30" }), "2026-09-01")).toBe(false);
    const etf: Instrument = { key: "etf", name: "ETF", type: "etf", currency: "EUR" };
    expect(suitableForGoalBuy(etf, goal(), "2026-11-30")).toBe(true);
  });

  it("with nothing left to buy: hold cash — a set-aside reminder until this month's part is set aside", () => {
    const s = status(BASE_TXS, at("2026-11-10"));
    expect(s.holdCash).toBe(true);
    expect(s.done).toBe(false);
    expect(s.instrumentNames).toBe("");
    expect(holdCashAdvice(s)).toMatch(/tartsd készpénzben a céldátumig/);
    const alerts = savingsGoalAlerts([GOAL], [ACC], BASE_TXS, instruments, new Map(), {}, at("2026-11-10"));
    expect(alerts.map((a) => a.title)).toEqual(["Havi félretétel – Cél"]);
    expect(alerts[0].detail).toMatch(/tegyél félre készpénzben, és rögzítsd a célnál/);
  });

  it("while still buyable the reminder works as before", () => {
    const s = status(BASE_TXS, at("2026-10-05"));
    expect(s.holdCash).toBe(false);
    expect(s.instrumentNames).toBe("DKJ 261201");
  });
});

describe("savings goal – maturity stored as an ISO timestamp", () => {
  // Stored the way the importer does: local midnight of 28 Oct, as UTC ISO
  // (e.g. "2026-10-27T23:00:00.000Z" in CEST). It must read as 28 Oct.
  const iso = new Date(2026, 9, 28).toISOString();
  const dkj: Instrument = { ...DKJ, key: "dkj-iso", maturity: iso };
  const goal: SavingsGoal = { ...GOAL, targetDate: "2026-11-01", instrumentKeys: [dkj.key] };

  it("31 days before the local maturity day it is still buyable (N = 30)", () => {
    expect(suitableForGoalBuy(dkj, goal, "2026-09-27")).toBe(true);
    expect(suitableForGoalBuy(dkj, goal, "2026-09-28")).toBe(false);
  });
});

describe("savings goal – money already the goal's but not in a security (hold-cash window)", () => {
  // The Babaváró shape: the goal's DKJ matures 1 Dec, 14 days before the
  // target date, so from 1 Nov (30 days before maturity) nothing is buyable
  // any more — the advice is to hold cash. A bond pays a 300 000 coupon on
  // 10 Nov, inside that window, and the DKJ pays out its face on 1 Dec.
  const BOND_N: Instrument = {
    ...BOND,
    key: "fix-nov",
    name: "Fix nov",
    bond: { ...BOND.bond!, firstCouponDate: "2025-11-10" },
  };
  const insts = new Map([BOND_N, DKJ].map((i) => [i.key, i]));
  const TXS: Transaction[] = [
    BASE_TXS[0],
    tx({ id: "b-bond-n", date: "2025-01-10", type: "buy", instrumentKey: BOND_N.key, quantity: 3_000_000, grossAmount: 3_000_000, netAmount: -3_000_000 }),
    BASE_TXS[2],
    // Last year's coupon, long before the window: not the goal's money.
    tx({ id: "kupon-2025", date: "2025-11-10", type: "interest", instrumentKey: BOND_N.key, grossAmount: 300_000, netAmount: 300_000 }),
  ];
  const HOLD_COUPON = tx({ id: "kupon-nov", date: "2026-11-10", type: "interest", instrumentKey: BOND_N.key, grossAmount: 300_000, netAmount: 300_000 });
  const REDEEM = tx({ id: "lejarat", date: "2026-12-01", type: "redemption", instrumentKey: DKJ.key, quantity: 400_000, grossAmount: 400_000, netAmount: 400_000 });
  const prog = (day: string, extra: Transaction[] = []) =>
    computeSavingsProgress([GOAL], [ACC], [...TXS, ...extra], insts, new Map(), {}, at(day))[0];
  const stat = (day: string, extra: Transaction[] = []) =>
    savingsMonthlyStatus([GOAL], [ACC], [...TXS, ...extra], insts, new Map(), {}, at(day))[0];

  it("fixture: before the coupon — DKJ 400 000 + coupon 300 000 projected, gap 300 000", () => {
    expect(stat("2026-11-05").holdCash).toBe(true);
    const p = prog("2026-11-05");
    expect(p.projectedHuf).toBeCloseTo(700_000);
    expect(p.gapHuf).toBeCloseTo(300_000);
  });

  it("a coupon credited in the hold-cash window still counts for the goal", () => {
    const p = prog("2026-11-12", [HOLD_COUPON]);
    expect(p.projectedHuf).toBeCloseTo(700_000);
    expect(p.gapHuf).toBeCloseTo(300_000);
  });

  it("the matured DKJ's payout still counts for the goal", () => {
    const p = prog("2026-12-02", [HOLD_COUPON, REDEEM]);
    expect(p.assignedValueHuf).toBeCloseTo(700_000);
    expect(p.projectedHuf).toBeCloseTo(700_000);
    expect(p.gapHuf).toBeCloseTo(300_000);
  });

  it("the quota does not jump when the coupon or the payout arrives", () => {
    const before = prog("2026-11-05").monthlyNeededHuf;
    expect(prog("2026-11-12", [HOLD_COUPON]).monthlyNeededHuf).toBeCloseTo(before);
    expect(prog("2026-12-02", [HOLD_COUPON, REDEEM]).monthlyNeededHuf).toBeCloseTo(
      prog("2026-12-02", [HOLD_COUPON]).monthlyNeededHuf,
    );
  });

  it("the arrived hold-window coupon is claimed in full by the goal (not split off to the glide path)", () => {
    // Room for the coupon being distributed = the shortfall without it.
    expect(prog("2026-11-12", [HOLD_COUPON]).couponRoomHuf).toBeCloseTo(600_000);
    // …but it counts for the goal on its own: nothing extra to set aside.
    expect(stat("2026-11-12", [HOLD_COUPON]).couponHuf).toBe(0);
  });

  describe("cash set aside by hand (reserves)", () => {
    const withReserves = (...reserves: { date: string; amountHuf: number }[]): SavingsGoal => ({
      ...GOAL,
      reserves: reserves.map((r, i) => ({ id: `r${i}`, ...r })),
    });
    const progOf = (goal: SavingsGoal, day: string, extra: Transaction[] = []) =>
      computeSavingsProgress([goal], [ACC], [...TXS, ...extra], insts, new Map(), {}, at(day))[0];
    const statOf = (goal: SavingsGoal, day: string) =>
      savingsMonthlyStatus([goal], [ACC], TXS, insts, new Map(), {}, at(day))[0];

    it("counts toward the goal: less missing", () => {
      // Before the 10 Nov coupon: DKJ 400 000 + coupon 300 000 + reserve 100 000.
      const p = progOf(withReserves({ date: "2026-11-05", amountHuf: 100_000 }), "2026-11-08");
      expect(p.reservedHuf).toBe(100_000);
      expect(p.projectedHuf).toBeCloseTo(800_000);
      expect(p.gapHuf).toBeCloseTo(200_000);
    });

    it("this month's reserve is this month's saving — the month-start quota stays", () => {
      const plain = progOf(GOAL, "2026-11-12");
      const g = withReserves({ date: "2026-11-05", amountHuf: 100_000 });
      expect(progOf(g, "2026-11-12").monthlyNeededHuf).toBeCloseTo(plain.monthlyNeededHuf);
      expect(progOf(g, "2026-11-12").thisMonthNetHuf).toBeCloseTo(100_000);
      expect(statOf(g, "2026-11-12").boughtHuf).toBeCloseTo(100_000);
    });

    it("an earlier month's reserve lowers the following quota", () => {
      const plain = progOf(GOAL, "2026-12-02");
      const g = withReserves({ date: "2026-11-05", amountHuf: 100_000 });
      expect(progOf(g, "2026-12-02").monthlyNeededHuf).toBeLessThan(plain.monthlyNeededHuf - 1);
    });

    it("a hold-cash goal is done once this month's part is set aside", () => {
      const need = statOf(GOAL, "2026-11-12").neededHuf;
      expect(statOf(GOAL, "2026-11-12").done).toBe(false);
      const g = withReserves({ date: "2026-11-10", amountHuf: need });
      expect(statOf(g, "2026-11-12").done).toBe(true);
      expect(savingsGoalAlerts([g], [ACC], TXS, insts, new Map(), {}, at("2026-11-12"))).toEqual([]);
      // …and its "Rendben" line says so.
      expect(holdCashAdvice(statOf(g, "2026-11-12"))).toMatch(/e havi rész félretéve .* ✓/);
    });

    it("a future-dated reserve does not count yet", () => {
      expect(progOf(withReserves({ date: "2026-11-20", amountHuf: 100_000 }), "2026-11-12").reservedHuf).toBe(0);
    });

    it("no double count with the automatic cash (coupon + payout)", () => {
      const REDEEM2 = tx({ id: "lejarat2", date: "2026-12-01", type: "redemption", instrumentKey: DKJ.key, quantity: 400_000, grossAmount: 400_000, netAmount: 400_000 });
      const p = progOf(withReserves({ date: "2026-11-05", amountHuf: 100_000 }), "2026-12-02", [HOLD_COUPON, REDEEM2]);
      expect(p.autoCashHuf).toBeCloseTo(700_000);
      expect(p.projectedHuf).toBeCloseTo(800_000);
    });
  });

  it("outside the window nothing changes: a credited, not reinvested coupon is still missing", () => {
    expect(progress([...BASE_TXS, COUPON], at("2026-10-20")).gapHuf).toBeCloseTo(600_000);
  });
});

describe("savings goal – picked coupons (couponIds)", () => {
  const PICKED: SavingsGoal = {
    ...GOAL,
    id: "p",
    name: "Nózi",
    includeCoupons: false,
    couponIds: [`${BOND.key}@2026-10-10`],
  };
  const progs = (goals: SavingsGoal[], txs: Transaction[], day: string) =>
    computeSavingsProgress(goals, [ACC], txs, instruments, new Map(), {}, at(day));
  const stats = (goals: SavingsGoal[], txs: Transaction[], day: string) =>
    savingsMonthlyStatus(goals, [ACC], txs, instruments, new Map(), {}, at(day));

  it("a picked future coupon counts in the projection", () => {
    const [p] = progs([PICKED], BASE_TXS, "2026-10-05");
    expect(p.couponsHuf).toBeCloseTo(300_000);
    expect(p.pickedCouponsHuf).toBeCloseTo(300_000);
    expect(p.gapHuf).toBeCloseTo(300_000);
  });

  // An includeCoupons goal whose date is past the picked coupon's (so it
  // doesn't own it) — it still earmarks the later coupons.
  const LATER: SavingsGoal = { ...GOAL, targetDate: "2027-12-15" };
  const EARLY: SavingsGoal = { ...GOAL, targetDate: "2026-10-01" };

  it("an includeCoupons goal does not count a coupon another goal picked", () => {
    // EARLY's date is before the coupon: the pick holds, EARLY never had it.
    const [p] = progs([PICKED, EARLY], BASE_TXS, "2026-09-05");
    expect(p.pickedCouponsHuf).toBeCloseTo(300_000);
    // LATER (includeCoupons past it) owns it by its date: the pick is void.
    const [q, l] = progs([PICKED, LATER], BASE_TXS, "2026-10-05");
    expect(q.pickedCouponsHuf).toBe(0);
    expect(q.couponsHuf).toBe(0);
    expect(l.couponsHuf).toBeGreaterThanOrEqual(300_000);
  });

  it("a goal earmarking every coupon keeps the credited one too", () => {
    const [q] = progs([PICKED, LATER], [...BASE_TXS, COUPON], "2026-10-20");
    expect(q.autoCashHuf).toBe(0);
    const s = stats([{ ...PICKED, monthlyReminder: true }, { ...LATER, id: "l" }], [...BASE_TXS, COUPON], "2026-10-20");
    expect(s.find((x) => x.goalId === "l")!.couponHuf).toBeGreaterThan(0);
    expect(reservedCashByAccount([PICKED, LATER], "2026-10-20", [...BASE_TXS, COUPON], {}).size).toBe(0);
  });

  it("once credited it is the goal's cash, not shared out", () => {
    const [p, g] = progs([PICKED, EARLY], [...BASE_TXS, COUPON], "2026-10-20");
    expect(p.autoCashHuf).toBeCloseTo(300_000);
    expect(p.couponsHuf).toBe(0);
    expect(p.projectedHuf).toBeCloseTo(700_000);
    expect(g.autoCashHuf).toBe(0);
    const s = stats([PICKED, EARLY], [...BASE_TXS, COUPON], "2026-10-20");
    expect(s.find((x) => x.goalId === "p")!.couponHuf).toBe(0);
    // Quota: (1 000 000 − 400 000 − 300 000) / 3 months.
    expect(s.find((x) => x.goalId === "p")!.baseNeededHuf).toBeCloseTo(100_000);
  });

  it("a coupon booked a few days off the schedule still matches", () => {
    const late = tx({ ...COUPON, id: "kupon-late", date: "2026-10-12" });
    const [p] = progs([PICKED], [...BASE_TXS, late], "2026-10-20");
    expect(p.autoCashHuf).toBeCloseTo(300_000);
  });

  it("the credited coupon is held on its account (not free cash)", () => {
    const r = reservedCashByAccount([PICKED], "2026-10-20", [...BASE_TXS, COUPON], {});
    expect(r.get(ACC.id)).toBeCloseTo(300_000);
    expect(reservedCashByAccount([PICKED], "2026-12-20", [...BASE_TXS, COUPON], {}).size).toBe(0);
  });
});

describe("savings goal – a later saving start (saveFrom)", () => {
  const plain: SavingsGoal = { ...GOAL, includeCoupons: false };
  const prog = (g: SavingsGoal, day: string) =>
    computeSavingsProgress([g], [ACC], BASE_TXS, instruments, new Map(), {}, at(day))[0];

  it("asks nothing before the start month, then spreads the gap from it", () => {
    const g = { ...plain, saveFrom: "2026-11-15" };
    const p = prog(g, "2026-10-05");
    expect(p.monthlyNeededHuf).toBe(0);
    expect(p.savingStartsOn).toBe("2026-11-15");
    // November + December's pay day (30 Nov) → 600 000 / 2.
    expect(p.plannedMonthlyHuf).toBeCloseTo(300_000);
    const s = savingsMonthlyStatus([g], [ACC], BASE_TXS, instruments, new Map(), {}, at("2026-10-05"));
    expect(s[0].done).toBe(true);
    // Not a to-do (nor a "done" one) before the start: the plan leaves it out.
    expect(s[0].notStarted).toBe(true);
    const later = savingsMonthlyStatus([g], [ACC], BASE_TXS, instruments, new Map(), {}, at("2026-11-20"));
    expect(later[0].notStarted).toBe(false);
  });

  it("all in the last month", () => {
    const g = { ...plain, saveFrom: "2026-12-01" };
    expect(prog(g, "2026-10-05").plannedMonthlyHuf).toBeCloseTo(600_000);
    const later = prog(g, "2026-12-02");
    expect(later.savingStartsOn).toBeUndefined();
    expect(later.monthlyNeededHuf).toBeCloseTo(600_000);
  });

  it("a start in the current month changes nothing", () => {
    expect(prog({ ...plain, saveFrom: "2026-10-20" }, "2026-10-05").monthlyNeededHuf).toBeCloseTo(
      prog(plain, "2026-10-05").monthlyNeededHuf,
    );
  });
});
