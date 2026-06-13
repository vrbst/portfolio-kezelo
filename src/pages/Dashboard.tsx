import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import {
  Wallet,
  TrendingUp,
  PiggyBank,
  Coins,
  ArrowRight,
  RefreshCw,
} from 'lucide-react'
import { usePortfolio, usePortfolioSummary } from '../lib/store'
import { accountReturn } from '../lib/portfolio'
import { tbszStatus } from '../lib/tbsz'
import {
  PageHeader,
  StatCard,
  Card,
  EmptyState,
  Delta,
  Badge,
} from '../components/ui'
import { formatMoney, formatPercent, formatDateTime, formatDate } from '../lib/format'
import { accountKindLabel } from '../lib/labels'
import { CalendarClock } from 'lucide-react'

const COLORS = ['#6366f1', '#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#fb7185']

export default function Dashboard() {
  const accounts = usePortfolio((s) => s.accounts)
  const summary = usePortfolioSummary()
  const refreshPrices = usePortfolio((s) => s.refreshPrices)
  const pricesLoading = usePortfolio((s) => s.pricesLoading)
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt)
  const eurHuf = usePortfolio((s) => s.fx['EUR'])

  const allocation = useMemo(
    () =>
      summary.accounts
        .filter((a) => a.totalValueHuf > 0)
        .map((a) => ({ name: a.account.name, value: a.totalValueHuf }))
        .sort((a, b) => b.value - a.value),
    [summary],
  )

  const tbszUpcoming = useMemo(
    () =>
      summary.accounts
        .filter((a) => a.account.kind === 'tbsz' && a.account.tbszYear)
        .map((a) => ({
          account: a.account,
          status: tbszStatus(a.account.tbszYear!),
        }))
        .filter((t) => t.status.next)
        .sort(
          (a, b) =>
            (a.status.daysToNext ?? 0) - (b.status.daysToNext ?? 0),
        ),
    [summary],
  )

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title="Áttekintés" />
        <EmptyState
          title="Még nincsenek adatok"
          description="Importáld a Lightyear és Magyar Államkincstár kivonataidat, és itt megjelenik a teljes portfóliód."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás indítása
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Áttekintés"
        subtitle="A teljes portfóliód egy helyen."
        action={
          <div className="flex items-center gap-3 text-sm">
            {eurHuf && (
              <span className="hidden text-[var(--color-muted)] sm:inline">
                EUR/HUF{' '}
                <span className="font-medium text-[var(--color-text)]">
                  {eurHuf.toLocaleString('hu-HU', {
                    maximumFractionDigits: 2,
                  })}
                </span>
              </span>
            )}
            <button
              className="btn-ghost"
              onClick={() => refreshPrices()}
              disabled={pricesLoading}
              title={
                priceUpdatedAt
                  ? `Árfolyamok frissítve: ${formatDateTime(priceUpdatedAt)}`
                  : 'Árfolyamok frissítése'
              }
            >
              <RefreshCw
                className={`h-4 w-4 ${pricesLoading ? 'animate-spin' : ''}`}
              />
              Árfolyamok
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Teljes érték"
          value={formatMoney(summary.totalValueHuf)}
          icon={<Wallet className="h-5 w-5" />}
          index={0}
          accent
        />
        <StatCard
          label="Teljes hozam"
          value={formatMoney(summary.totalPlHuf, 'HUF', { sign: true })}
          deltaPct={summary.totalReturnPct}
          icon={<TrendingUp className="h-5 w-5" />}
          index={1}
        />
        <StatCard
          label="Befektetett tőke"
          value={formatMoney(summary.netDepositedHuf)}
          icon={<PiggyBank className="h-5 w-5" />}
          index={2}
        />
        <StatCard
          label="Kapott kamat"
          value={formatMoney(summary.interestHuf)}
          icon={<Coins className="h-5 w-5" />}
          index={3}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Allocation donut */}
        <Card className="p-6 lg:col-span-2">
          <h2 className="mb-1 text-lg font-semibold">Eszközallokáció</h2>
          <p className="mb-4 text-sm text-[var(--color-muted)]">
            Számlák szerinti megoszlás
          </p>
          <div className="relative h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={allocation}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={3}
                  stroke="none"
                >
                  {allocation.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v) => formatMoney(Number(v))}
                  contentStyle={tooltipStyle}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xs text-[var(--color-muted)]">Összesen</span>
              <span className="text-xl font-semibold">
                {formatMoney(summary.totalValueHuf)}
              </span>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {allocation.map((a, i) => (
              <div key={a.name} className="flex items-center gap-2 text-sm">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                <span className="flex-1 truncate text-[var(--color-muted)]">
                  {a.name}
                </span>
                <span className="tabular-nums">
                  {formatPercent(a.value / summary.totalValueHuf).replace(
                    '+',
                    '',
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* Accounts breakdown */}
        <Card className="p-6 lg:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Számláim</h2>
            <Link
              to="/accounts"
              className="inline-flex items-center gap-1 text-sm text-[var(--color-brand)] hover:underline"
            >
              Összes <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="space-y-3">
            {summary.accounts.map((a) => (
              <Link key={a.account.id} to={`/accounts/${a.account.id}`}>
                <div className="card-hover flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {a.account.name}
                      </span>
                      <Badge tone="neutral">
                        {accountKindLabel(a.account)}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {a.holdings.length} pozíció · készpénz{' '}
                      {formatMoney(a.cashValueHuf)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums">
                      {formatMoney(a.totalValueHuf)}
                    </div>
                    {accountReturn(a) != null && (
                      <Delta pct={accountReturn(a)} className="text-xs" />
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      {tbszUpcoming.length > 0 && (
        <Card className="mt-6 p-6">
          <div className="mb-4 flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">TBSZ mérföldkövek</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tbszUpcoming.map(({ account, status }) => (
              <Link
                key={account.id}
                to={`/accounts/${account.id}`}
                className="card-hover rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">TBSZ {account.tbszYear}</span>
                  <Badge tone="neutral">
                    {Math.round(status.taxRate * 100)}% adó
                  </Badge>
                </div>
                <div className="mt-2 text-sm text-[var(--color-muted)]">
                  {status.next?.label}
                </div>
                <div className="text-sm">
                  <span className="font-medium text-[var(--color-brand)]">
                    {formatDate(status.next?.date)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

const tooltipStyle = {
  background: '#141a2e',
  border: '1px solid #232b45',
  borderRadius: 12,
  color: '#e8ecf8',
} as const
