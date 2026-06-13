import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Check, X } from 'lucide-react'
import { usePortfolio, usePortfolioSummary } from '../lib/store'
import { accountReturn, isInternalTransfer } from '../lib/portfolio'
import {
  PageHeader,
  Card,
  StatCard,
  Badge,
  Delta,
  EmptyState,
} from '../components/ui'
import TbszTimeline from '../components/TbszTimeline'
import { formatMoney, formatNumber, formatDate } from '../lib/format'
import { accountKindLabel, txTypeLabel, instrumentTypeLabel } from '../lib/labels'
import type { AccountKind } from '../lib/model'

export default function AccountDetail() {
  const { id } = useParams()
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const summary = usePortfolioSummary()
  const updateAccount = usePortfolio((s) => s.updateAccount)

  const account = accounts.find((a) => a.id === id)
  const accSummary = summary.accounts.find((a) => a.account.id === id)

  const accTxs = useMemo(
    () =>
      transactions
        .filter((t) => t.accountId === id)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [transactions, id],
  )

  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'regular')
  const [year, setYear] = useState<string>(
    account?.tbszYear ? String(account.tbszYear) : '',
  )

  if (!account || !accSummary) {
    return (
      <EmptyState
        title="Számla nem található"
        description="Lehet, hogy törölted az adatokat."
        action={
          <Link to="/accounts" className="btn-primary mt-2">
            Vissza a számlákhoz
          </Link>
        }
      />
    )
  }

  const isTreasury = account.provider === 'allamkincstar'
  const isCashHub = account.kind === 'cash'
  const ret = accountReturn(accSummary)

  async function saveEdit() {
    await updateAccount(account!.id, {
      kind,
      tbszYear: kind === 'tbsz' && year ? Number(year) : undefined,
    })
    setEditing(false)
  }

  return (
    <div>
      <Link
        to="/accounts"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
      >
        <ArrowLeft className="h-4 w-4" /> Számlák
      </Link>

      <PageHeader
        title={account.name}
        subtitle={account.externalRef}
        action={
          editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as AccountKind)}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                <option value="regular">Befektetési</option>
                <option value="tbsz">TBSZ</option>
                <option value="treasury">Államkincstár</option>
                <option value="cash">Pénzszámla</option>
              </select>
              {kind === 'tbsz' && (
                <input
                  type="number"
                  placeholder="Év (pl. 2025)"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                />
              )}
              <button className="btn-primary" onClick={saveEdit}>
                <Check className="h-4 w-4" /> Mentés
              </button>
              <button className="btn-ghost" onClick={() => setEditing(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge tone="brand">{accountKindLabel(account)}</Badge>
              <button className="btn-ghost" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" /> Szerkesztés
              </button>
            </div>
          )
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Teljes érték"
          value={formatMoney(accSummary.totalValueHuf)}
          index={0}
          accent
        />
        {isCashHub ? (
          <>
            <StatCard
              label="Külső befizetés"
              value={formatMoney(accSummary.netDepositedHuf)}
              index={1}
            />
            <StatCard
              label="Befektetésekbe utalva"
              value={formatMoney(accSummary.transfersOutHuf)}
              index={2}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              index={3}
            />
          </>
        ) : (
          <>
            <StatCard
              label="Hozam"
              value={formatMoney(
                accSummary.totalValueHuf - accSummary.capitalBasisHuf,
                'HUF',
                { sign: true },
              )}
              deltaPct={ret}
              index={1}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              index={2}
            />
            <StatCard
              label={isTreasury ? 'Kapott kamat' : 'Befektetett tőke'}
              value={formatMoney(
                isTreasury
                  ? accSummary.interestHuf
                  : accSummary.capitalBasisHuf,
              )}
              index={3}
            />
          </>
        )}
      </div>

      {account.kind === 'tbsz' && account.tbszYear && (
        <div className="mt-6">
          <TbszTimeline year={account.tbszYear} />
        </div>
      )}

      {/* Holdings */}
      <div className="mt-6">
        <h2 className="mb-3 text-lg font-semibold">
          {isTreasury ? 'Értékpapírok' : 'Pozíciók'}
        </h2>
        {accSummary.holdings.length === 0 ? (
          <Card className="p-6 text-sm text-[var(--color-muted)]">
            Nincs nyitott pozíció ezen a számlán.
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-[var(--color-muted)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="px-4 py-3 font-medium">Eszköz</th>
                    <th className="px-4 py-3 text-right font-medium">
                      {isTreasury ? 'Névérték' : 'Mennyiség'}
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Bekerülés
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Érték</th>
                    <th className="px-4 py-3 text-right font-medium">Hozam</th>
                  </tr>
                </thead>
                <tbody>
                  {accSummary.holdings.map((h) => (
                    <tr
                      key={h.instrumentKey}
                      className="border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {h.instrument?.name ?? h.instrumentKey}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                          {h.instrument && (
                            <Badge tone="neutral">
                              {instrumentTypeLabel[h.instrument.type]}
                            </Badge>
                          )}
                          {h.instrument?.maturity && (
                            <span>
                              lejárat: {formatDate(h.instrument.maturity)}
                            </span>
                          )}
                          {h.instrument?.isin && <span>{h.instrument.isin}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatNumber(h.quantity, isTreasury ? 0 : 4)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                        {formatMoney(h.costBasisHuf)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {formatMoney(h.marketValueHuf)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {h.unrealizedPlHuf != null &&
                        Math.abs(h.unrealizedPlHuf) > 0.5 ? (
                          <Delta value={h.unrealizedPlHuf} className="text-xs" />
                        ) : (
                          <span className="text-[var(--color-muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* Cash by currency */}
      {Object.keys(accSummary.cash).length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-lg font-semibold">Készpénz egyenleg</h2>
          <div className="flex flex-wrap gap-3">
            {Object.entries(accSummary.cash).map(([ccy, amt]) => (
              <Card key={ccy} className="px-5 py-4">
                <div className="text-xs text-[var(--color-muted)]">{ccy}</div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatMoney(amt, ccy)}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Transactions */}
      <div className="mt-6">
        <h2 className="mb-3 text-lg font-semibold">
          Tranzakciók ({accTxs.length})
        </h2>
        <Card className="overflow-hidden">
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted)]">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-4 py-3 font-medium">Dátum</th>
                  <th className="px-4 py-3 font-medium">Típus</th>
                  <th className="px-4 py-3 font-medium">Eszköz</th>
                  <th className="px-4 py-3 text-right font-medium">Mennyiség</th>
                  <th className="px-4 py-3 text-right font-medium">Összeg</th>
                </tr>
              </thead>
              <tbody>
                {accTxs.map((t) => {
                  const inst = accSummary.holdings.find(
                    (h) => h.instrumentKey === t.instrumentKey,
                  )?.instrument
                  return (
                    <tr
                      key={t.id}
                      className="border-b border-[var(--color-border)]/40 last:border-0"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {formatDate(t.date)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone="neutral">
                          {isInternalTransfer(t)
                            ? t.type === 'deposit'
                              ? 'Transzfer be'
                              : 'Transzfer ki'
                            : txTypeLabel[t.type]}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--color-muted)]">
                        {inst?.name ?? t.instrumentKey ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {t.quantity != null ? formatNumber(t.quantity, 4) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {t.grossAmount != null
                          ? formatMoney(t.grossAmount, t.currency)
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}
