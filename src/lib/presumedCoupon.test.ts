import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { computePortfolio, futureBondCashflows } from "./portfolio";

// Invented sample data. A quarterly 7% FixMÁP: the coupon is 1.75% of face
// (17 500 Ft on 1 000 000 Ft). The Államkincstár pays it a day early, but the
// statement is only imported later — until then the coupon is presumed.

const MAK: Account = { id: "mak", name: "Kincstár", provider: "allamkincstar", kind: "treasury", currency: "HUF" };

const fix = (key: string, firstCouponDate: string, maturity: string): Instrument => ({
  key,
  name: key,
  type: "gov_bond",
  currency: "HUF",
  faceValue: 1,
  bond: { couponRate: 0.07, couponIntervalMonths: 3, issueDate: "2025-10-23", firstCouponDate, maturity },
});

const FIX = fix("FIX", "2026-01-23", "2031-10-23");

const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).toISOString();
let n = 0;
const tx = (t: Omit<Transaction, "id">): Transaction => ({ id: `t${++n}`, ...t });

const deposit = tx({ accountId: "mak", date: at(2026, 1, 2), type: "deposit", currency: "HUF", grossAmount: 1_000_000, netAmount: 1_000_000 });
const buy = (key: string, date = at(2026, 1, 5)) =>
  tx({ accountId: "mak", date, type: "buy", instrumentKey: key, quantity: 1_000_000, pricePerUnit: 1, currency: "HUF", grossAmount: 1_000_000, netAmount: -1_000_000 });
const coupon = (key: string, date: string) =>
  tx({ accountId: "mak", date, type: "interest", instrumentKey: key, currency: "HUF", grossAmount: 17_500, netAmount: 17_500 });

const summary = (instrument: Instrument, txs: Transaction[], now: Date) =>
  computePortfolio([MAK], txs, new Map([[instrument.key, instrument]]), new Map(), {}, now);
const total = (s: ReturnType<typeof summary>) => s.totalValueHuf;

describe("presumed coupon until the statement is imported", () => {
  const txs = [deposit, buy("FIX")];

  it("the 16:00 roll to the coupon day does not drop the position's value", () => {
    // Thu 22 Oct 2026: before 16:00 the accrual is still the quarter's 91/92,
    // after it the valuation day is the coupon day and the accrual restarts.
    const before = summary(FIX, txs, new Date(2026, 9, 22, 15, 59));
    const after = summary(FIX, txs, new Date(2026, 9, 22, 16, 1));
    expect(Math.abs(total(after) - total(before))).toBeLessThan(500);
    expect(after.cashValueHuf).toBeCloseTo(17_500, 6);
  });

  it("the presumed coupon is listed with its date and amount", () => {
    const after = summary(FIX, txs, new Date(2026, 9, 22, 16, 1));
    expect(after.presumedCoupons).toEqual([{ instrumentKey: "FIX", date: "2026-10-23", amountHuf: 17_500 }]);
  });

  it("is replaced, not doubled, once the real coupon is imported", () => {
    const imported = summary(FIX, [...txs, coupon("FIX", at(2026, 10, 22))], new Date(2026, 9, 22, 16, 1));
    expect(imported.presumedCoupons).toEqual([]);
    expect(imported.cashValueHuf).toBeCloseTo(17_500, 6);
    expect(total(imported)).toBeCloseTo(1_017_500, 6);
  });

  it("an import dated on the nominal day replaces it too", () => {
    const imported = summary(FIX, [...txs, coupon("FIX", at(2026, 10, 23))], new Date(2026, 9, 23, 12));
    expect(imported.presumedCoupons).toEqual([]);
    expect(imported.cashValueHuf).toBeCloseTo(17_500, 6);
  });

  it("does not appear before the evening roll", () => {
    const morning = summary(FIX, txs, new Date(2026, 9, 22, 10));
    expect(morning.presumedCoupons).toEqual([]);
    expect(morning.cashValueHuf).toBe(0);
  });

  it("a position bought on the coupon day never received that coupon", () => {
    const late = [deposit, buy("FIX", at(2026, 10, 23))];
    const s = summary(FIX, late, new Date(2026, 9, 23, 12));
    expect(s.presumedCoupons).toEqual([]);
  });

  it("the maturity day's final coupon is left to the redemption reminder", () => {
    const short = fix("SHORT", "2026-01-23", "2026-10-23");
    const s = summary(short, [deposit, buy("SHORT")], new Date(2026, 9, 22, 16, 1));
    expect(s.presumedCoupons).toEqual([]);
  });

  it("a coupon never imported stops being presumed after the lookback window", () => {
    const s = summary(FIX, txs, new Date(2026, 11, 20, 12)); // 58 days after 23 Oct
    expect(s.presumedCoupons).toEqual([]);
  });

  it("on a Friday afternoon a Monday coupon is already presumed", () => {
    const mon = fix("MON", "2026-01-26", "2031-10-26");
    const s = summary(mon, [deposit, buy("MON")], new Date(2026, 9, 23, 15, 30));
    expect(s.presumedCoupons.map((p) => p.date)).toEqual(["2026-10-26"]);
  });

  it("is not counted a second time as a future cash flow", () => {
    const now = new Date(2026, 9, 22, 16, 1);
    const s = summary(FIX, txs, now);
    const flows = futureBondCashflows(s, now, txs).filter((c) => c.kind === "coupon");
    expect(flows.map((c) => c.date)).not.toContain("2026-10-23");
  });
});
