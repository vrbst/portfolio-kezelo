import { Link } from 'react-router-dom'
import { motion } from 'motion/react'
import { Wallet, Landmark, ArrowRight } from 'lucide-react'
import { usePortfolio, usePortfolioSummary } from '../lib/store'
import { PageHeader, Card, EmptyState, Badge, Delta } from '../components/ui'
import { formatMoney, eurEquivalent } from '../lib/format'
import { accountKindLabel } from '../lib/labels'
import {
  accountReturn,
  isEmptyAccount,
  type AccountSummary,
} from '../lib/portfolio'
import { tbszStatus } from '../lib/tbsz'

export default function Accounts() {
  const accounts = usePortfolio((s) => s.accounts)
  const summary = usePortfolioSummary()
  const eurHuf = usePortfolio((s) => s.fx['EUR'])

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title="Számlák" />
        <EmptyState
          title="Nincs számla"
          description="Importálj egy kivonatot, és a számláid itt jelennek meg."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás
            </Link>
          }
        />
      </div>
    )
  }

  const treasury = summary.accounts.filter(
    (a) => a.account.provider === 'allamkincstar',
  )
  const investing = summary.accounts.filter(
    (a) => a.account.provider !== 'allamkincstar',
  )

  return (
    <div>
      <PageHeader
        title="Számlák"
        subtitle="TBSZ és államkincstári számláid részletesen."
      />

      <Section
        title="Befektetési számlák"
        icon={<Wallet className="h-5 w-5" />}
        items={investing}
        eurHuf={eurHuf}
      />
      <Section
        title="Magyar Államkincstár"
        icon={<Landmark className="h-5 w-5" />}
        items={treasury}
      />
    </div>
  )
}

function Section({
  title,
  icon,
  items,
  eurHuf,
}: {
  title: string
  icon: React.ReactNode
  items: AccountSummary[]
  /** When set, show an EUR equivalent under each account's value. */
  eurHuf?: number
}) {
  if (items.length === 0) return null
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2 text-[var(--color-muted)]">
        {icon}
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          {title}
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((a, i) => {
          const ret = accountReturn(a)
          const empty = isEmptyAccount(a)
          const tbsz =
            a.account.kind === 'tbsz' && a.account.tbszYear
              ? tbszStatus(a.account.tbszYear)
              : undefined
          return (
            <motion.div
              key={a.account.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Link to={`/accounts/${a.account.id}`}>
                <Card hover className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {a.account.name}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge tone="brand">
                          {accountKindLabel(a.account)}
                        </Badge>
                        {a.account.externalRef && (
                          <span className="text-xs text-[var(--color-muted)]">
                            {a.account.externalRef}
                          </span>
                        )}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                  </div>

                  <div className="mt-4 flex items-end justify-between">
                    <div>
                      <div className="text-xs text-[var(--color-muted)]">
                        Teljes érték
                      </div>
                      <div className="amt text-xl font-semibold tabular-nums">
                        {formatMoney(a.totalValueHuf)}
                      </div>
                      {eurEquivalent(a.totalValueHuf, eurHuf) && (
                        <div className="amt text-xs tabular-nums text-[var(--color-muted)]">
                          {eurEquivalent(a.totalValueHuf, eurHuf)}
                        </div>
                      )}
                    </div>
                    {empty ? (
                      <Badge tone="neutral">üres</Badge>
                    ) : (
                      ret != null && <Delta pct={ret} className="text-sm" />
                    )}
                  </div>

                  {tbsz && (
                    <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-xs">
                      <span className="text-[var(--color-muted)]">
                        {tbsz.phaseLabel} · {Math.round(tbsz.taxRate * 100)}% adó
                      </span>
                      {tbsz.next && (
                        <span className="text-[var(--color-muted)]">
                          {tbsz.next.label}: {tbsz.next.date.slice(0, 4)}
                        </span>
                      )}
                    </div>
                  )}
                </Card>
              </Link>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
