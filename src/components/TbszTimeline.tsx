import { CalendarClock, Check, Circle } from 'lucide-react'
import { tbszStatus, type TbszPhase } from '../lib/tbsz'
import { formatDate } from '../lib/format'
import { Card, Badge } from './ui'

const phaseTone: Record<TbszPhase, 'brand' | 'warning' | 'positive'> = {
  collecting: 'brand',
  locked: 'warning',
  reduced: 'brand',
  matured: 'positive',
}

function formatDays(days: number): string {
  if (days <= 0) return 'ma'
  if (days < 60) return `${days} nap`
  const months = Math.round(days / 30.4)
  if (months < 24) return `${months} hónap`
  return `${(days / 365).toFixed(1)} év`
}

/** TBSZ tax timeline: phase, applicable rate, milestone markers and countdown. */
export default function TbszTimeline({
  year,
  now,
}: {
  year: number
  now?: Date
}) {
  const s = tbszStatus(year, now)

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">TBSZ adózási ütemterv</h2>
          <span className="text-sm text-[var(--color-muted)]">
            gyűjtőév {year}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={s.hasSzocho ? 'warning' : 'neutral'}>
            {s.hasSzocho ? 'szochoköteles (2025-től)' : 'szochomentes (2024-ig)'}
          </Badge>
          <Badge tone={phaseTone[s.phase]}>{s.phaseLabel}</Badge>
        </div>
      </div>

      <p className="mt-2 text-sm text-[var(--color-muted)]">{s.taxLabel}</p>

      {s.next && s.daysToNext != null && (
        <p className="mt-1 text-sm">
          Következő mérföldkő:{' '}
          <span className="font-medium">{s.next.label}</span> –{' '}
          <span className="text-[var(--color-brand)]">
            {formatDays(s.daysToNext)}
          </span>{' '}
          <span className="text-[var(--color-muted)]">
            ({formatDate(s.next.date)})
          </span>
        </p>
      )}

      {/* Progress bar */}
      <div className="relative mt-5 h-1.5 rounded-full bg-[var(--color-surface-2)]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-brand)]"
          style={{ width: `${s.progress * 100}%` }}
        />
      </div>

      {/* Milestones */}
      <ol className="mt-4 space-y-3">
        {s.milestones.map((m) => (
          <li key={m.key} className="flex items-start gap-3">
            <span className="mt-0.5">
              {m.done ? (
                <Check className="h-4 w-4 text-[var(--color-positive)]" />
              ) : (
                <Circle className="h-4 w-4 text-[var(--color-muted)]" />
              )}
            </span>
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span
                  className={
                    m.done
                      ? 'text-[var(--color-muted)] line-through'
                      : 'font-medium'
                  }
                >
                  {m.label}
                </span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  {formatDate(m.date)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {m.hint}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}
