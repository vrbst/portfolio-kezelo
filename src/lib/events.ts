// Upcoming portfolio events: TBSZ tax milestones, bond maturities, next coupons.

import {
  nextCouponDate,
  couponAmountHuf,
  type PortfolioSummary,
} from "./portfolio";
import type { Transaction } from "./model";
import { tbszStatus } from "./tbsz";

const DAY_MS = 86_400_000;

/**
 * A credited coupon may be booked a day or two off the nominal schedule date,
 * so match within a window. Coupons are quarterly at their most frequent, so
 * this can never reach the neighbouring one.
 */
const COUPON_MATCH_DAYS = 7;

/**
 * Local midnight ms for a stored date. Bare `YYYY-MM-DD` is read as local (UTC
 * parsing would shift the day east of UTC). Full ISO timestamps are the parsers'
 * output — built from a local midnight, so their UTC day can be the day before;
 * we take the LOCAL calendar day back out to compare like with like.
 */
function dayMs(date: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date.slice(0, 10)) && !date.includes("T")) {
    const [y, m, d] = date.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return NaN;
  return new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
  ).getTime();
}

export type EventKind = "tbsz" | "maturity" | "coupon";

export interface UpcomingEvent {
  /** ISO date. */
  date: string;
  daysUntil: number;
  kind: EventKind;
  title: string;
  detail?: string;
  /** HUF amount tied to the event (coupon, redemption, or affected value). */
  amountHuf?: number;
  accountId?: string;
}

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

/**
 * Collect future events across the portfolio, soonest first.
 *
 * `transactions` (optional) suppresses coupons that have already been credited:
 * the Államkincstár books the payment on the nominal date (often paying out the
 * day before), so once the statement is imported the event must stop showing as
 * "1 nap múlva" — we skip ahead to the next coupon that has NOT been paid.
 */
export function upcomingEvents(
  summary: PortfolioSummary,
  now: Date = new Date(),
  transactions: Transaction[] = [],
): UpcomingEvent[] {
  // Imported interest dates per instrument → "did this coupon already arrive?"
  const paidByInst = new Map<string, number[]>();
  for (const t of transactions) {
    if (t.type !== "interest" || !t.instrumentKey) continue;
    const ms = dayMs(t.date);
    if (!Number.isFinite(ms)) continue;
    paidByInst.set(t.instrumentKey, [
      ...(paidByInst.get(t.instrumentKey) ?? []),
      ms,
    ]);
  }

  // Compare against local midnight: Date.parse("YYYY-MM-DD") is UTC midnight,
  // which east of UTC would drop today's events after ~1-2 AM local time.
  const todayMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const out: UpcomingEvent[] = [];
  const push = (
    date: string,
    kind: EventKind,
    title: string,
    detail?: string,
    amountHuf?: number,
    accountId?: string,
  ) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
    const ms = m
      ? new Date(+m[1], +m[2] - 1, +m[3]).getTime()
      : Date.parse(date);
    if (!Number.isFinite(ms) || ms < todayMs) return;
    out.push({
      date,
      daysUntil: Math.round((ms - todayMs) / 86_400_000),
      kind,
      title,
      detail,
      amountHuf,
      accountId,
    });
  };

  for (const acc of summary.accounts) {
    const a = acc.account;
    if (a.kind === "tbsz" && a.tbszYear) {
      const st = tbszStatus(a.tbszYear, now);
      for (const ms of st.milestones) {
        if (ms.done) continue;
        // The 3-year mark drops the tax; the 5-year is the tax-free maturity.
        // No amount — the account value isn't a meaningful "event amount".
        const detail =
          ms.key === "three"
            ? `adó ${st.hasSzocho ? "18" : "10"}%-ra csökken`
            : ms.key === "five"
              ? "adómentessé válik"
              : undefined;
        push(
          ms.date,
          "tbsz",
          `TBSZ ${a.tbszYear} — ${ms.label}`,
          detail,
          undefined,
          a.id,
        );
      }
    }

    for (const h of acc.holdings) {
      const inst = h.instrument;
      if (!inst || !BOND_TYPES.has(inst.type)) continue;
      const face = h.quantity; // bonds: quantity = face value (HUF nominal)
      const maturity = inst.bond?.maturity ?? inst.maturity;
      if (maturity)
        push(
          maturity,
          "maturity",
          `${inst.name} — lejárat`,
          undefined,
          face,
          a.id,
        );
      // Walk forward past any coupon we've already received. The guard keeps a
      // pathological schedule from looping; maturity ends the chain anyway.
      const paid = paidByInst.get(inst.key) ?? [];
      let coupon = nextCouponDate(inst.bond, now);
      for (let i = 0; coupon && i < 6; i++) {
        const cMs = dayMs(coupon);
        const credited = paid.some(
          (ms) => Math.abs(ms - cMs) <= COUPON_MATCH_DAYS * DAY_MS,
        );
        if (!credited) break;
        coupon = nextCouponDate(inst.bond, new Date(cMs + DAY_MS));
      }
      if (coupon) {
        const amount = couponAmountHuf(inst.bond, face, coupon);
        const isFirst =
          !!inst.bond?.firstCouponDate &&
          coupon.slice(0, 10) === inst.bond.firstCouponDate.slice(0, 10);
        push(
          coupon,
          "coupon",
          `${inst.name} — kamatfizetés`,
          isFirst ? "első kamat (tört időszak)" : undefined,
          amount,
          a.id,
        );
      }
    }
  }

  return out.sort((x, y) => x.date.localeCompare(y.date));
}
