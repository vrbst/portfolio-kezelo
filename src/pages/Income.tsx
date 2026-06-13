import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Coins, TrendingUp, Landmark, Receipt, Banknote } from 'lucide-react'
import { usePortfolio } from '../lib/store'
import { computeIncomeByYear, computeReturns } from '../lib/portfolio'
import { PageHeader, Card, StatCard, EmptyState } from '../components/ui'
import { formatMoney, formatPercent } from '../lib/format'

export default function Income() {
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const instruments = usePortfolio((s) => s.instruments)
  const prices = usePortfolio((s) => s.prices)
  const fx = usePortfolio((s) => s.fx)
  const historyFile = usePortfolio((s) => s.historyFile)

  const instMap = useMemo(
    () => new Map(instruments.map((i) => [i.key, i])),
    [instruments],
  )

  const years = useMemo(
    () => computeIncomeByYear(accounts, transactions, instMap, fx),
    [accounts, transactions, instMap, fx],
  )

  const returns = useMemo(
    () =>
      computeReturns(
        accounts,
        transactions,
        instMap,
        prices,
        fx,
        historyFile,
      ),
    [accounts, transactions, instMap, prices, fx, historyFile],
  )

  const total = useMemo(
    () =>
      years.reduce(
        (acc, y) => ({
          realizedPlHuf: acc.realizedPlHuf + y.realizedPlHuf,
          interestHuf: acc.interestHuf + y.interestHuf,
          dividendHuf: acc.dividendHuf + y.dividendHuf,
          feesHuf: acc.feesHuf + y.feesHuf,
          taxHuf: acc.taxHuf + y.taxHuf,
        }),
        {
          realizedPlHuf: 0,
          interestHuf: 0,
          dividendHuf: 0,
          feesHuf: 0,
          taxHuf: 0,
        },
      ),
    [years],
  )

  if (transactions.length === 0) {
    return (
      <div>
        <PageHeader title="Realizált hozam" />
        <EmptyState
          title="Még nincsenek adatok"
          description="Importálj kivonatokat, és itt jelenik meg a realizált hozamod évenként."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás
            </Link>
          }
        />
      </div>
    )
  }

  const net =
    total.realizedPlHuf +
    total.interestHuf +
    total.dividendHuf -
    total.feesHuf -
    total.taxHuf

  return (
    <div>
      <PageHeader
        title="Hozam"
        subtitle="Teljesítmény-mutatók és a realizált eredmény évenként."
      />

      <Card className="mb-6 p-6">
        <h2 className="mb-1 text-lg font-semibold">Teljesítmény</h2>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          Évesített hozam-mutatók ({returns.days} nap adat alapján).
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Metric
            label="XIRR — pénzsúlyozott"
            pct={returns.xirrPct}
            hint="A te pénzed tényleges évesített hozama, a be- és kifizetések időzítését is figyelembe véve."
          />
          <Metric
            label="TWR — idősúlyozott"
            pct={returns.twrPct}
            sub={
              returns.twrCumulativePct != null
                ? `${formatPercent(returns.twrCumulativePct)} a teljes időszakban`
                : undefined
            }
            hint="A befektetéseid teljesítménye, a befizetések időzítésétől megtisztítva — benchmarkhoz."
          />
          <Metric
            label="Egyszerű hozam"
            pct={returns.simplePct}
            hint="Jelenlegi érték a befektetett tőkéhez képest. A befizetések időzítése torzítja."
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Realizált eredmény"
          value={formatMoney(total.realizedPlHuf, 'HUF', { sign: true })}
          icon={<TrendingUp className="h-5 w-5" />}
          index={0}
          accent
        />
        <StatCard
          label="Kapott kamat"
          value={formatMoney(total.interestHuf)}
          icon={<Landmark className="h-5 w-5" />}
          index={1}
        />
        <StatCard
          label="Osztalék"
          value={formatMoney(total.dividendHuf)}
          icon={<Coins className="h-5 w-5" />}
          index={2}
        />
        <StatCard
          label="Fizetett díjak"
          value={formatMoney(total.feesHuf)}
          icon={<Receipt className="h-5 w-5" />}
          index={3}
        />
      </div>

      <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-5 py-4">
        <Banknote className="h-5 w-5 text-[var(--color-brand)]" />
        <span className="text-sm text-[var(--color-muted)]">
          Nettó pénzbeáramlás (realizált + kamat + osztalék − díj − adó)
        </span>
        <span className="amt ml-auto text-lg font-semibold tabular-nums">
          {formatMoney(net, 'HUF', { sign: true })}
        </span>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-3 font-medium">Év</th>
                <th className="px-4 py-3 text-right font-medium">Realizált</th>
                <th className="px-4 py-3 text-right font-medium">Kamat</th>
                <th className="px-4 py-3 text-right font-medium">Osztalék</th>
                <th className="px-4 py-3 text-right font-medium">Díjak</th>
                <th className="px-4 py-3 text-right font-medium">Adó</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr
                  key={y.year}
                  className="border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40"
                >
                  <td className="px-4 py-3 font-medium">{y.year}</td>
                  <td
                    className={`amt px-4 py-3 text-right tabular-nums ${
                      y.realizedPlHuf < 0
                        ? 'text-[var(--color-negative)]'
                        : 'text-[var(--color-positive)]'
                    }`}
                  >
                    {formatMoney(y.realizedPlHuf, 'HUF', { sign: true })}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums">
                    {formatMoney(y.interestHuf)}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums">
                    {formatMoney(y.dividendHuf)}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                    {formatMoney(y.feesHuf)}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                    {formatMoney(y.taxHuf)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
        Az XIRR (pénzsúlyozott) a saját pénzed évesített hozama; a TWR
        (idősúlyozott) a befektetések teljesítménye a befizetések időzítésétől
        függetlenül. Friss portfóliónál az évesítés még zajos lehet.
        {' '}
        A realizált eredmény átlagos bekerülési áron, a vételkori árfolyamon
        számol. A díjak tájékoztató jellegűek (a vétel díja a bekerülésben is
        benne van). A lakossági állampapír kamata és a TBSZ a lekötési időszak
        alatt adómentes.
      </p>
    </div>
  )
}

function Metric({
  label,
  pct,
  sub,
  hint,
}: {
  label: string
  pct?: number
  sub?: string
  hint?: string
}) {
  const color =
    pct == null
      ? 'text-[var(--color-muted)]'
      : pct >= 0
        ? 'text-[var(--color-positive)]'
        : 'text-[var(--color-negative)]'
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {pct == null ? '—' : formatPercent(pct)}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">{sub}</div>
      )}
      {hint && (
        <div className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
          {hint}
        </div>
      )}
    </div>
  )
}
