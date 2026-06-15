// Fixed savings goals (DCA): "invest X HUF into instrument Y every period".
// Progress is derived from the buy transactions; an unmet goal becomes an alert.
//
// Period boundary rule (user-specified): the LAST WORKING DAY of a month counts
// toward the NEXT month. So a buy on 30 June (June's last working day) lands in
// July's goal. The same shift is applied to "now" when picking the current
// period, so the two always agree.

import type { Instrument, Transaction } from './model'
import { toHuf } from './portfolio'
import { formatMoney } from './format'
import type { Alert } from './alerts'

export type GoalPeriod = 1 | 3 | 6 | 12

export interface Goal {
  id: string
  instrumentKey: string
  /** Target amount (HUF) to invest within one period. */
  amountHuf: number
  periodMonths: GoalPeriod
  createdAt: string
}

export const PERIOD_LABEL: Record<GoalPeriod, string> = {
  1: 'Havi',
  3: 'Negyedéves',
  6: 'Féléves',
  12: 'Éves',
}

const MONTHS = [
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
]

/** Last Mon–Fri date-of-month (holidays ignored — weekend-only approximation). */
function lastWorkingDayOfMonth(year: number, month0: number): number {
  const last = new Date(year, month0 + 1, 0)
  const dow = last.getDay()
  let day = last.getDate()
  if (dow === 6) day -= 1 // Sat → Fri
  else if (dow === 0) day -= 2 // Sun → Fri
  return day
}

/** Apply the "last working day rolls into next month" rule. */
function effectiveMonth(date: Date): { year: number; month0: number } {
  const y = date.getFullYear()
  const m = date.getMonth()
  if (date.getDate() >= lastWorkingDayOfMonth(y, m)) {
    const nm = m + 1
    return nm > 11 ? { year: y + 1, month0: 0 } : { year: y, month0: nm }
  }
  return { year: y, month0: m }
}

/** Calendar-aligned period bucket for an (already effective) month. */
function periodInfo(
  year: number,
  month0: number,
  periodMonths: GoalPeriod,
): { key: string; label: string } {
  if (periodMonths === 1)
    return { key: `${year}-${month0}`, label: `${year}. ${MONTHS[month0]}` }
  if (periodMonths === 12) return { key: `${year}`, label: `${year}` }
  const idx = Math.floor(month0 / periodMonths)
  if (periodMonths === 3)
    return { key: `${year}-Q${idx + 1}`, label: `${year} Q${idx + 1}` }
  return { key: `${year}-H${idx + 1}`, label: `${year} H${idx + 1}` }
}

export interface GoalProgress {
  goal: Goal
  instrumentName: string
  periodKey: string
  periodLabel: string
  investedHuf: number
  targetHuf: number
  remainingHuf: number
  /** investedHuf / target (can exceed 1). */
  ratio: number
  done: boolean
}

/** Progress of each goal in its CURRENT period (with the working-day shift). */
export function computeGoalProgress(
  goals: Goal[],
  transactions: Transaction[],
  instruments: Instrument[],
  fx: Record<string, number>,
  now: Date = new Date(),
): GoalProgress[] {
  const instById = new Map(instruments.map((i) => [i.key, i]))
  const eff = effectiveMonth(now)

  return goals.map((goal) => {
    const cur = periodInfo(eff.year, eff.month0, goal.periodMonths)
    let invested = 0
    for (const t of transactions) {
      if (t.type !== 'buy' || t.instrumentKey !== goal.instrumentKey) continue
      const d = new Date(t.date)
      if (Number.isNaN(d.getTime())) continue
      const em = effectiveMonth(d)
      if (periodInfo(em.year, em.month0, goal.periodMonths).key !== cur.key)
        continue
      const amt = Math.abs(t.netAmount ?? t.grossAmount ?? 0)
      invested += toHuf(amt, t.currency, fx)
    }
    const target = goal.amountHuf
    return {
      goal,
      instrumentName: instById.get(goal.instrumentKey)?.name ?? goal.instrumentKey,
      periodKey: cur.key,
      periodLabel: cur.label,
      investedHuf: invested,
      targetHuf: target,
      remainingHuf: Math.max(0, target - invested),
      ratio: target > 0 ? invested / target : 0,
      // 0.5 Ft slack so rounding never leaves a goal "1 Ft short".
      done: invested + 0.5 >= target,
    }
  })
}

/** One alert per unmet goal. The period key in the id resets it each period. */
export function goalAlerts(progress: GoalProgress[]): Alert[] {
  const out: Alert[] = []
  for (const p of progress) {
    if (p.done) continue
    out.push({
      id: `goal:${p.goal.id}:${p.periodKey}`,
      severity: 'medium',
      title: `Cél – ${p.instrumentName} (${PERIOD_LABEL[p.goal.periodMonths].toLowerCase()})`,
      detail: `${p.periodLabel}: ${formatMoney(p.investedHuf)} / ${formatMoney(
        p.targetHuf,
      )} — még ${formatMoney(p.remainingHuf)} hiányzik`,
      to: '/settings',
      actionLabel: 'Célok',
    })
  }
  return out
}
