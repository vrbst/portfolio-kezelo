import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import {
  computeSavingsProgress,
  savingsMonthlyStatus,
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
