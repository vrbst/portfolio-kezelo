// Upcoming portfolio events: TBSZ tax milestones, bond maturities, next coupons.

import {
  nextCouponDate,
  couponAmountHuf,
  type PortfolioSummary,
} from './portfolio'
import { tbszStatus } from './tbsz'

export type EventKind = 'tbsz' | 'maturity' | 'coupon'

export interface UpcomingEvent {
  /** ISO date. */
  date: string
  daysUntil: number
  kind: EventKind
  title: string
  detail?: string
  /** HUF amount tied to the event (coupon, redemption, or affected value). */
  amountHuf?: number
  accountId?: string
}

const BOND_TYPES = new Set(['gov_bond', 'tbill'])

/** Collect future events across the portfolio, soonest first. */
export function upcomingEvents(
  summary: PortfolioSummary,
  now: Date = new Date(),
): UpcomingEvent[] {
  const nowMs = now.getTime()
  const out: UpcomingEvent[] = []
  const push = (
    date: string,
    kind: EventKind,
    title: string,
    detail?: string,
    amountHuf?: number,
    accountId?: string,
  ) => {
    const ms = Date.parse(date)
    if (!Number.isFinite(ms) || ms < nowMs) return
    out.push({
      date,
      daysUntil: Math.ceil((ms - nowMs) / 86_400_000),
      kind,
      title,
      detail,
      amountHuf,
      accountId,
    })
  }

  for (const acc of summary.accounts) {
    const a = acc.account
    if (a.kind === 'tbsz' && a.tbszYear) {
      const st = tbszStatus(a.tbszYear, now)
      if (st.next)
        push(
          st.next.date,
          'tbsz',
          `TBSZ ${a.tbszYear} — ${st.next.label}`,
          `${Math.round(st.taxRate * 100)}% adó`,
          acc.totalValueHuf,
          a.id,
        )
    }

    for (const h of acc.holdings) {
      const inst = h.instrument
      if (!inst || !BOND_TYPES.has(inst.type)) continue
      const face = h.quantity // bonds: quantity = face value (HUF nominal)
      const maturity = inst.bond?.maturity ?? inst.maturity
      if (maturity)
        push(maturity, 'maturity', `${inst.name} — lejárat`, undefined, face, a.id)
      const coupon = nextCouponDate(inst.bond, now)
      if (coupon) {
        const amount = couponAmountHuf(inst.bond, face, coupon)
        const isFirst =
          !!inst.bond?.firstCouponDate &&
          coupon.slice(0, 10) === inst.bond.firstCouponDate.slice(0, 10)
        push(
          coupon,
          'coupon',
          `${inst.name} — kamatfizetés`,
          isFirst ? 'első kamat (tört időszak)' : undefined,
          amount,
          a.id,
        )
      }
    }
  }

  return out.sort((x, y) => x.date.localeCompare(y.date))
}
