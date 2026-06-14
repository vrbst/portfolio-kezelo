import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import { usePortfolio, usePortfolioSummary } from '../lib/store'
import { futureBondCashflows, isInternalTransfer } from '../lib/portfolio'
import { tbszStatus } from '../lib/tbsz'
import { PageHeader, Card, Badge } from '../components/ui'
import { formatMoney, formatCompact, formatDate } from '../lib/format'
import { txTypeLabel } from '../lib/labels'

const WEEKDAYS = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V']
const MONTHS = [
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
]

/** Cash-flow sign per transaction type (inflow +, outflow −, 0 = skip). */
const SIGN: Record<string, number> = {
  deposit: 1,
  sell: 1,
  redemption: 1,
  interest: 1,
  dividend: 1,
  buy: -1,
  withdrawal: -1,
  fee: -1,
  tax: -1,
  conversion: 0,
  transfer: 0,
}

interface DayItem {
  title: string
  /** Signed HUF amount (+ inflow, − outflow); undefined for markers (TBSZ). */
  amountHuf?: number
  future: boolean
  tag: string
  /** Category drives the dot colour. */
  cat: 'coupon' | 'maturity' | 'tbsz' | 'in' | 'out'
}

const CAT_COLOR: Record<DayItem['cat'], string> = {
  coupon: '#22d3ee',
  maturity: '#6366f1',
  tbsz: '#fbbf24',
  in: '#34d399',
  out: '#fb7185',
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`

export default function Calendar() {
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const instruments = usePortfolio((s) => s.instruments)
  const fx = usePortfolio((s) => s.fx)
  const summary = usePortfolioSummary()

  const today = new Date()
  const todayIso = isoDay(today.getFullYear(), today.getMonth(), today.getDate())

  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() })
  const [selected, setSelected] = useState<string | null>(todayIso)

  const instMap = useMemo(
    () => new Map(instruments.map((i) => [i.key, i])),
    [instruments],
  )

  // Build a per-day item map across past transactions + future cash-flows + TBSZ.
  const byDay = useMemo(() => {
    const map = new Map<string, DayItem[]>()
    const push = (date: string, item: DayItem) => {
      const key = date.slice(0, 10)
      const arr = map.get(key)
      if (arr) arr.push(item)
      else map.set(key, [item])
    }

    // Past transactions
    for (const t of transactions) {
      if (isInternalTransfer(t)) continue
      const sign = SIGN[t.type] ?? 0
      if (sign === 0) continue
      const raw = Math.abs(t.grossAmount ?? t.netAmount ?? 0)
      if (raw === 0) continue
      const huf = t.currency === 'HUF' ? raw : raw * (fx[t.currency] ?? 0)
      const inst = t.instrumentKey ? instMap.get(t.instrumentKey) : undefined
      push(t.date, {
        title: inst?.name ?? txTypeLabel[t.type],
        amountHuf: sign * huf,
        future: false,
        tag: txTypeLabel[t.type],
        cat: sign > 0 ? 'in' : 'out',
      })
    }

    // Future bond cash-flows (coupons + redemptions)
    for (const cf of futureBondCashflows(summary, today)) {
      push(cf.date, {
        title: cf.title,
        amountHuf: cf.amountHuf,
        future: true,
        tag: cf.kind === 'coupon' ? 'kamat' : 'lejárat',
        cat: cf.kind,
      })
    }

    // TBSZ milestones (markers, no cash amount)
    for (const a of accounts) {
      if (a.kind !== 'tbsz' || !a.tbszYear) continue
      const st = tbszStatus(a.tbszYear, today)
      for (const ms of st.milestones) {
        push(ms.date, {
          title: `TBSZ ${a.tbszYear} — ${ms.label}`,
          future: !ms.done,
          tag: 'TBSZ',
          cat: 'tbsz',
        })
      }
    }

    return map
  }, [transactions, instMap, fx, summary, accounts, today])

  // Month grid cells (Monday-first weeks).
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1)
    const lead = (first.getDay() + 6) % 7 // Monday = 0
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate()
    const out: (number | null)[] = []
    for (let i = 0; i < lead; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(d)
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [view])

  // This month's expected (future) inflow total.
  const monthExpected = useMemo(() => {
    let sum = 0
    for (let d = 1; d <= 31; d++) {
      const items = byDay.get(isoDay(view.y, view.m, d))
      if (!items) continue
      for (const it of items)
        if (it.future && it.amountHuf != null) sum += it.amountHuf
    }
    return sum
  }, [byDay, view])

  const move = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1)
    setView({ y: d.getFullYear(), m: d.getMonth() })
  }

  const selectedItems = selected ? byDay.get(selected) ?? [] : []

  return (
    <div>
      <PageHeader
        title="Naptár"
        subtitle="Várható kifizetések és múltbeli tranzakciók napokra bontva."
      />

      <Card className="p-5 sm:p-6">
        {/* Month nav */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">
              {view.y}. {MONTHS[view.m]}
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="btn-ghost px-2.5 py-1.5"
              onClick={() => move(-1)}
              title="Előző hónap"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => setView({ y: today.getFullYear(), m: today.getMonth() })}
            >
              Ma
            </button>
            <button
              className="btn-ghost px-2.5 py-1.5"
              onClick={() => move(1)}
              title="Következő hónap"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {monthExpected > 0 && (
          <p className="mb-3 text-sm text-[var(--color-muted)]">
            Várható bevétel ebben a hónapban:{' '}
            <span className="amt font-semibold text-[var(--color-positive)]">
              {formatMoney(monthExpected)}
            </span>
          </p>
        )}

        {/* Weekday header */}
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-[var(--color-muted)]">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1 font-medium">
              {w}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (d == null) return <div key={i} />
            const key = isoDay(view.y, view.m, d)
            const items = byDay.get(key)
            const isToday = key === todayIso
            const isSel = key === selected
            const net = items?.reduce((s, it) => s + (it.amountHuf ?? 0), 0) ?? 0
            const hasAmount = items?.some((it) => it.amountHuf != null)
            const cats = items ? [...new Set(items.map((it) => it.cat))] : []
            return (
              <button
                key={i}
                onClick={() => setSelected(key)}
                className={`flex min-h-[3.6rem] flex-col rounded-lg border p-1.5 text-left transition sm:min-h-[4.5rem] ${
                  isSel
                    ? 'border-[var(--color-brand)]/60 bg-[var(--color-brand)]/10'
                    : 'border-[var(--color-border)]/60 hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-surface-2)]/40'
                }`}
              >
                <span
                  className={`text-xs tabular-nums ${
                    isToday
                      ? 'grid h-5 w-5 place-items-center rounded-full bg-[var(--color-brand)] font-semibold text-white'
                      : 'text-[var(--color-muted)]'
                  }`}
                >
                  {d}
                </span>
                <div className="mt-auto">
                  {hasAmount && (
                    <span
                      className={`amt block truncate text-[11px] font-medium tabular-nums sm:text-xs ${
                        net > 0
                          ? 'text-[var(--color-positive)]'
                          : net < 0
                            ? 'text-[var(--color-negative)]'
                            : 'text-[var(--color-muted)]'
                      }`}
                    >
                      {net > 0 ? '+' : ''}
                      {formatCompact(net)}
                    </span>
                  )}
                  {cats.length > 0 && (
                    <span className="mt-0.5 flex gap-0.5">
                      {cats.map((c) => (
                        <span
                          key={c}
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: CAT_COLOR[c] }}
                        />
                      ))}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[var(--color-muted)]">
          {(
            [
              ['coupon', 'Kamat'],
              ['maturity', 'Lejárat'],
              ['tbsz', 'TBSZ mérföldkő'],
              ['in', 'Bejövő tranzakció'],
              ['out', 'Kimenő tranzakció'],
            ] as const
          ).map(([c, label]) => (
            <span key={c} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: CAT_COLOR[c] }}
              />
              {label}
            </span>
          ))}
        </div>
      </Card>

      {/* Selected day detail */}
      {selected && (
        <Card className="mt-4 p-5 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold">
            {formatDate(selected)}
          </h3>
          {selectedItems.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">
              Nincs tétel ezen a napon.
            </p>
          ) : (
            <div className="space-y-2">
              {selectedItems
                .slice()
                .sort((a, b) => (b.amountHuf ?? 0) - (a.amountHuf ?? 0))
                .map((it, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: CAT_COLOR[it.cat] }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {it.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <Badge tone="neutral">{it.tag}</Badge>
                        {it.future && <Badge tone="warning">várható</Badge>}
                      </div>
                    </div>
                    {it.amountHuf != null && (
                      <div
                        className={`amt shrink-0 text-sm font-semibold tabular-nums ${
                          it.amountHuf >= 0
                            ? 'text-[var(--color-positive)]'
                            : 'text-[var(--color-negative)]'
                        }`}
                      >
                        {it.amountHuf > 0 ? '+' : ''}
                        {formatMoney(it.amountHuf)}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
