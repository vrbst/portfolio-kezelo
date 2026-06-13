// ---------------------------------------------------------------------------
// TBSZ (Tartós Befektetési Számla) tax timeline — Szja tv. 67/B §.
//
// A TBSZ opened in the "gyűjtőév" Y:
//   • during Y you may still deposit (the collection year);
//   • the 5-year lock then runs to the end of Y+5.
// Tax on the gain if the account is broken / withdrawn:
//   • within the 3-year lock (up to 31 Dec Y+3):   15%  (no relief)
//   • after 3 full years, before 5 (…to 31 Dec Y+5): 10%  (kedvezményes)
//   • after the 5-year lock (from 1 Jan Y+6):         0%  (adómentes)
// At the 3-year turn a partial withdrawal is allowed while re-locking the rest.
// ---------------------------------------------------------------------------

export type TbszPhase = 'collecting' | 'locked' | 'reduced' | 'matured'

export interface TbszMilestone {
  key: 'deposit' | 'three' | 'five'
  /** ISO date (end of the calendar year). */
  date: string
  label: string
  hint: string
  done: boolean
}

export interface TbszStatus {
  year: number
  phase: TbszPhase
  phaseLabel: string
  /** Szja rate applicable if broken today (0–0.15). */
  taxRate: number
  taxLabel: string
  milestones: TbszMilestone[]
  /** Next milestone not yet reached, if any. */
  next?: TbszMilestone
  daysToNext?: number
  /** 0–1 progress from the opening year to the 5-year maturity. */
  progress: number
}

/** End of the given calendar year (31 Dec, last moment). */
function yearEnd(year: number): Date {
  return new Date(year, 11, 31, 23, 59, 59)
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000)
}

export function tbszStatus(year: number, now: Date = new Date()): TbszStatus {
  const depositEnd = yearEnd(year)
  const threeEnd = yearEnd(year + 3)
  const fiveEnd = yearEnd(year + 5)

  const milestones: TbszMilestone[] = [
    {
      key: 'deposit',
      date: depositEnd.toISOString(),
      label: 'Gyűjtőév vége',
      hint: 'Utolsó nap, amikor befizethetsz erre a TBSZ-re.',
      done: now > depositEnd,
    },
    {
      key: 'three',
      date: threeEnd.toISOString(),
      label: '3 éves lekötés',
      hint: 'Innentől a hozam adója 10%-ra csökken (részkivét lehetséges).',
      done: now > threeEnd,
    },
    {
      key: 'five',
      date: fiveEnd.toISOString(),
      label: '5 éves lejárat',
      hint: 'A teljes hozam adómentes (0%).',
      done: now > fiveEnd,
    },
  ]

  let phase: TbszPhase
  let phaseLabel: string
  let taxRate: number
  let taxLabel: string
  if (now <= depositEnd) {
    phase = 'collecting'
    phaseLabel = 'Gyűjtési időszak'
    taxRate = 0.15
    taxLabel = 'Megszakításkor 15% szja (a gyűjtőévben még be is fizethetsz).'
  } else if (now <= threeEnd) {
    phase = 'locked'
    phaseLabel = 'Lekötés (3 év előtt)'
    taxRate = 0.15
    taxLabel = 'Megszakításkor 15% szja a hozamra.'
  } else if (now <= fiveEnd) {
    phase = 'reduced'
    phaseLabel = 'Kedvezményes szakasz'
    taxRate = 0.1
    taxLabel = 'Kivétkor 10% szja a hozamra.'
  } else {
    phase = 'matured'
    phaseLabel = 'Lejárt — adómentes'
    taxRate = 0
    taxLabel = 'A hozam teljesen adómentes.'
  }

  const next = milestones.find((m) => !m.done)
  const daysToNext = next ? daysBetween(now, new Date(next.date)) : undefined

  const start = new Date(year, 0, 1).getTime()
  const span = fiveEnd.getTime() - start
  const progress = Math.max(
    0,
    Math.min(1, (now.getTime() - start) / span),
  )

  return {
    year,
    phase,
    phaseLabel,
    taxRate,
    taxLabel,
    milestones,
    next,
    daysToNext,
    progress,
  }
}
