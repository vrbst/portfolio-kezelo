// Which goals claim a piece of incoming money, and how much each gets. Pure
// and dependency-light (savings.ts uses it for the monthly status; income.ts
// adds the glide-path remainder on top).
//
// Rule: a medium-term goal with `includeCoupons` claims the BOND coupons
// (Államkincstár `interest` with a bond as source — not a broker's cash
// interest) credited on or before its target date, while it is still ahead
// and short. Claiming goals share a coupon in proportion to their room, each
// capped at it; whatever is left belongs to the glide path.

import type { Instrument, Transaction } from "./model";
import { toHuf } from "./portfolio";
import type { SavingsProgress } from "./savings";

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

/** A credited bond coupon (a bond instrument as source, not a mirror row). */
export function isBondCoupon(
  t: Transaction,
  instruments: Map<string, Instrument>,
): boolean {
  if (t.type !== "interest" || t.internal || !t.instrumentKey) return false;
  const inst = instruments.get(t.instrumentKey);
  return !!inst && BOND_TYPES.has(inst.type);
}

/** HUF that actually arrived (net of tax), at today's rate for a foreign amount. */
export function incomeHuf(t: Transaction, fx: Record<string, number>): number {
  return toHuf(Math.abs(t.netAmount ?? t.grossAmount ?? 0), t.currency, fx);
}

/**
 * The goal claims a bond coupon credited on `day` (YYYY-MM-DD): it earmarks
 * coupons, the coupon falls on or before its date, the goal is still ahead
 * (not expired) and it still has room (not yet covered).
 */
export function claimsCoupon(p: SavingsProgress, day: string): boolean {
  return (
    p.goal.includeCoupons &&
    day <= p.goal.targetDate.slice(0, 10) &&
    p.daysLeft > 0 &&
    p.couponRoomHuf > 0
  );
}

export interface Claimant {
  goalId: string;
  /** The most the goal can take. */
  capHuf: number;
}

/**
 * Split `amountHuf` among claiming goals in proportion to their caps, none
 * above its cap. Goals get everything they can when the caps don't reach the
 * amount; the rest (amount − Σ shares) is left for the glide path.
 */
export function splitAmongGoals(
  amountHuf: number,
  claimants: Claimant[],
): Map<string, number> {
  const out = new Map<string, number>();
  const live = claimants.filter((c) => c.capHuf > 0);
  const total = live.reduce((s, c) => s + c.capHuf, 0);
  if (!(amountHuf > 0) || total <= 0) return out;
  const k = Math.min(1, amountHuf / total);
  for (const c of live) out.set(c.goalId, c.capHuf * k);
  return out;
}
