import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Check, X } from 'lucide-react'
import { usePortfolio, usePortfolioSummary } from '../lib/store'
import {
  accountReturn,
  isInternalTransfer,
  isEmptyAccount,
  type HoldingView,
} from '../lib/portfolio'
import {
  PageHeader,
  Card,
  StatCard,
  Badge,
  Delta,
  EmptyState,
} from '../components/ui'
import TbszTimeline from '../components/TbszTimeline'
import {
  formatMoney,
  formatNumber,
  formatPercent,
  formatDate,
  eurEquivalent,
} from '../lib/format'
import { accountKindLabel, txTypeLabel, instrumentTypeLabel } from '../lib/labels'
import type { AccountKind } from '../lib/model'

export default function AccountDetail() {
  const { id } = useParams()
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const summary = usePortfolioSummary()
  const updateAccount = usePortfolio((s) => s.updateAccount)
  const eurHuf = usePortfolio((s) => s.fx['EUR'])
  const fx = usePortfolio((s) => s.fx)
  const priceFile = usePortfolio((s) => s.priceFile)

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
  const empty = isEmptyAccount(accSummary)
  const ret = accountReturn(accSummary)
  // Treasury: bonds' quantity = face value (névérték), so summing gives the
  // total nominal you get back at the maturities.
  const totalFaceHuf = accSummary.holdings.reduce((s, h) => s + h.quantity, 0)
  // EUR equivalent only makes sense for the (EUR-invested) Lightyear accounts,
  // not the HUF-denominated treasury bonds.
  const eur = (huf: number, opts?: { sign?: boolean }) =>
    isTreasury ? undefined : eurEquivalent(huf, eurHuf, opts)

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
          sub={eur(accSummary.totalValueHuf)}
          index={0}
          accent
        />
        {isCashHub ? (
          <>
            <StatCard
              label="Külső befizetés"
              value={formatMoney(accSummary.netDepositedHuf)}
              sub={eur(accSummary.netDepositedHuf)}
              index={1}
            />
            <StatCard
              label="Befektetésekbe utalva"
              value={formatMoney(accSummary.transfersOutHuf)}
              sub={eur(accSummary.transfersOutHuf)}
              index={2}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              sub={eur(accSummary.cashValueHuf)}
              index={3}
            />
          </>
        ) : isTreasury ? (
          // Bonds' mark-to-market return oscillates with the coupon cycle and
          // bakes in the 1% early-redemption fee, so we don't show a "Hozam"
          // here. The meaningful figures: total face value, coupons received,
          // and the capital invested.
          <>
            <StatCard
              label="Összes névérték"
              value={formatMoney(totalFaceHuf)}
              index={1}
            />
            <StatCard
              label="Kapott kamat"
              value={formatMoney(accSummary.interestHuf)}
              index={2}
            />
            <StatCard
              label="Befektetett tőke"
              value={formatMoney(accSummary.capitalBasisHuf)}
              index={3}
            />
          </>
        ) : (
          <>
            <StatCard
              label="Hozam"
              value={
                empty
                  ? 'üres'
                  : formatMoney(
                      accSummary.totalValueHuf - accSummary.capitalBasisHuf,
                      'HUF',
                      { sign: true },
                    )
              }
              sub={
                empty
                  ? 'a tőkét kiutaltad'
                  : eur(accSummary.totalValueHuf - accSummary.capitalBasisHuf, {
                      sign: true,
                    })
              }
              deltaPct={empty ? undefined : ret}
              index={1}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              sub={eur(accSummary.cashValueHuf)}
              index={2}
            />
            <StatCard
              label="Befektetett tőke"
              value={formatMoney(accSummary.capitalBasisHuf)}
              sub={eur(accSummary.capitalBasisHuf)}
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
                      Árfolyam
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Bekerülés
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Érték</th>
                    {!isTreasury && (
                      <th className="px-4 py-3 text-right font-medium">Hozam</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {accSummary.holdings.map((h) => {
                    const priceName = priceFile?.prices[h.instrumentKey]?.name
                    const unitHuf =
                      h.currentPrice != null && h.currency !== 'HUF'
                        ? h.currentPrice * (fx[h.currency] ?? 0)
                        : undefined
                    return (
                    <tr
                      key={h.instrumentKey}
                      className="border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {h.instrument?.name ?? h.instrumentKey}
                        </div>
                        {priceName && priceName !== h.instrument?.name && (
                          <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                            {priceName}
                          </div>
                        )}
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
                        {h.bondNeedsData && (
                          <Link
                            to="/settings"
                            className="mt-1 inline-block"
                            title="Add meg a sorozat adatait a pontos értékhez"
                          >
                            <Badge tone="warning">
                              névértéken — sorozat-adat hiányzik
                            </Badge>
                          </Link>
                        )}
                      </td>
                      <td className="amt px-4 py-3 text-right tabular-nums">
                        {formatNumber(h.quantity, isTreasury ? 0 : 4)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                        {h.currentPrice != null && h.currency !== 'HUF' ? (
                          <>
                            <div className="amt text-[var(--color-text)]">
                              {formatMoney(h.currentPrice, h.currency)}
                            </div>
                            {unitHuf != null && (
                              <div className="amt text-xs opacity-70">
                                ≈ {formatMoney(unitHuf)}
                              </div>
                            )}
                          </>
                        ) : isTreasury &&
                          h.marketValueHuf != null &&
                          h.quantity > 0 ? (
                          <div>
                            {((h.marketValueHuf / h.quantity) * 100).toFixed(2)}%
                          </div>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                        <div>{formatMoney(h.costBasisHuf)}</div>
                        {h.currency !== 'HUF' && (
                          <div className="text-xs opacity-70">
                            {formatMoney(h.costBasisCcy, h.currency)}
                          </div>
                        )}
                        {!isTreasury && h.quantity > 0 && (
                          <div className="mt-1 text-xs opacity-70">
                            átlagár: {formatMoney(h.avgCost, h.currency, {
                              decimals: h.currency === 'HUF' ? 0 : 2,
                            })}
                            {h.currency !== 'HUF' &&
                              ` · ≈ ${formatMoney(h.costBasisHuf / h.quantity)}`}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        <div className="amt">{formatMoney(h.marketValueHuf)}</div>
                        {h.currency !== 'HUF' && h.marketValueCcy != null && (
                          <div className="amt text-xs font-normal text-[var(--color-muted)]">
                            {formatMoney(h.marketValueCcy, h.currency)}
                          </div>
                        )}
                      </td>
                      {!isTreasury && <ReturnCell h={h} fx={fx} />}
                    </tr>
                    )
                  })}
                </tbody>
                {isTreasury && accSummary.holdings.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-[var(--color-border)] font-semibold">
                      <td className="px-4 py-3">Összesen</td>
                      <td className="amt px-4 py-3 text-right tabular-nums">
                        {formatNumber(
                          accSummary.holdings.reduce((s, h) => s + h.quantity, 0),
                          0,
                        )}
                      </td>
                      <td />
                      <td className="amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                        {formatMoney(
                          accSummary.holdings.reduce(
                            (s, h) => s + h.costBasisHuf,
                            0,
                          ),
                        )}
                      </td>
                      <td className="amt px-4 py-3 text-right tabular-nums">
                        {formatMoney(
                          accSummary.holdings.reduce(
                            (s, h) => s + (h.marketValueHuf ?? 0),
                            0,
                          ),
                        )}
                      </td>
                    </tr>
                  </tfoot>
                )}
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
                <div className="amt text-lg font-semibold tabular-nums">
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
                      <td className="amt px-4 py-2.5 text-right tabular-nums">
                        {t.quantity != null
                          ? isTreasury
                            ? formatMoney(t.quantity, 'HUF') // névérték Ft-ban, tizedes nélkül
                            : formatNumber(t.quantity, 4)
                          : '—'}
                      </td>
                      <td className="amt px-4 py-2.5 text-right tabular-nums">
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

/**
 * "Hozam" table cell: total P/L with its %, plus a hover bubble decomposing the
 * gain into the instrument-currency (price) return and the FX effect.
 *
 * Decomposition (cost basis is locked at the historical purchase FX):
 *   Total HUF      = marketValueHuf − costBasisHuf            (= unrealizedPlHuf)
 *   Jegyzési deviza = marketValueCcy − costBasisCcy           (price only, no FX)
 *   Devizahatás    = costBasisCcy × FX_now − costBasisHuf     (FX on the basis)
 *   Total = (price return × FX_now) + Devizahatás
 */
function ReturnCell({
  h,
  fx,
}: {
  h: HoldingView
  fx: Record<string, number>
}) {
  const [rect, setRect] = useState<DOMRect | null>(null)

  const total = h.unrealizedPlHuf
  const hasReturn = total != null && Math.abs(total) > 0.5
  const totalPct =
    h.costBasisHuf > 0 && total != null ? total / h.costBasisHuf : undefined

  const isFx = h.currency !== 'HUF' && h.marketValueCcy != null
  const ccyReturn = isFx ? h.marketValueCcy! - h.costBasisCcy : undefined
  const ccyPct =
    isFx && h.costBasisCcy > 0 && ccyReturn != null
      ? ccyReturn / h.costBasisCcy
      : undefined
  const rateNow = h.currency === 'HUF' ? 1 : fx[h.currency] ?? 0
  const fxEffect =
    isFx && rateNow > 0 ? h.costBasisCcy * rateNow - h.costBasisHuf : undefined
  // FX contribution as a share of the HUF cost basis, so total% ≈ price% + FX%.
  const fxPct =
    fxEffect != null && h.costBasisHuf > 0
      ? fxEffect / h.costBasisHuf
      : undefined

  return (
    <td className="px-4 py-3 text-right tabular-nums">
      {hasReturn ? (
        <span
          className="inline-flex cursor-help"
          onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setRect(null)}
        >
          <Delta value={total} pct={totalPct} className="text-xs" />
        </span>
      ) : (
        <span className="text-[var(--color-muted)]">—</span>
      )}

      {hasReturn &&
        rect &&
        createPortal(
          <div
            className="fixed z-50 w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left text-xs shadow-xl"
            style={{
              top: rect.bottom + 6,
              right: Math.max(8, window.innerWidth - rect.right),
            }}
          >
            <div className="mb-1.5 font-medium text-[var(--color-text)]">
              Hozam összetétele
            </div>
            <TipRow
              label="Teljes hozam"
              value={formatMoney(total!, 'HUF', { sign: true })}
              pct={totalPct}
              sign={total!}
            />
            {isFx && ccyReturn != null && (
              <TipRow
                label={`Jegyzési deviza hozam (${h.currency})`}
                value={formatMoney(ccyReturn, h.currency, { sign: true })}
                pct={ccyPct}
                sign={ccyReturn}
              />
            )}
            {isFx && fxEffect != null && (
              <TipRow
                label="Devizahatás"
                value={formatMoney(fxEffect, 'HUF', { sign: true })}
                pct={fxPct}
                sign={fxEffect}
              />
            )}
          </div>,
          document.body,
        )}
    </td>
  )
}

function TipRow({
  label,
  value,
  pct,
  sign,
}: {
  label: string
  value: string
  pct?: number
  sign: number
}) {
  const color =
    sign >= 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className={`whitespace-nowrap tabular-nums ${color}`}>
        <span className="amt">{value}</span>
        {pct != null && (
          <span className="ml-1 opacity-80">{formatPercent(pct)}</span>
        )}
      </span>
    </div>
  )
}
