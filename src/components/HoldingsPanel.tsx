import { Layers } from 'lucide-react'
import { usePortfolioSummary } from '../lib/store'
import { consolidatedHoldings } from '../lib/portfolio'
import { Card, Badge, Delta } from './ui'
import { formatMoney, formatNumber } from '../lib/format'
import { instrumentTypeLabel } from '../lib/labels'

const BOND_TYPES = new Set(['gov_bond', 'tbill'])

/**
 * Consolidated holdings: every instrument aggregated across all accounts, so the
 * same ETF held in several accounts shows one combined total. Amounts respect
 * privacy mode (.amt); percentages stay readable.
 */
export default function HoldingsPanel() {
  const summary = usePortfolioSummary()
  const rows = consolidatedHoldings(summary)
  if (rows.length === 0) return null

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-6 pb-3">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Eszközeim</h2>
        </div>
        <span className="text-xs text-[var(--color-muted)]">
          instrumentumonként, számlákon átívelve
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--color-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-4 py-3 font-medium">Eszköz</th>
              <th className="px-4 py-3 text-right font-medium">Mennyiség</th>
              <th className="px-4 py-3 text-right font-medium">Érték</th>
              <th className="px-4 py-3 text-right font-medium">Nem realizált</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const isBond = h.instrument
                ? BOND_TYPES.has(h.instrument.type)
                : false
              const pct =
                h.costBasisHuf > 0
                  ? h.unrealizedPlHuf / h.costBasisHuf
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
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                      {h.instrument && (
                        <Badge tone="neutral">
                          {instrumentTypeLabel[h.instrument.type]}
                        </Badge>
                      )}
                      {h.accountCount > 1 && (
                        <span>{h.accountCount} számlán</span>
                      )}
                    </div>
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums">
                    {formatNumber(h.quantity, isBond ? 0 : 4)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    <div className="amt">{formatMoney(h.marketValueHuf)}</div>
                    {h.currency !== 'HUF' && h.marketValueCcy != null && (
                      <div className="amt text-xs font-normal text-[var(--color-muted)]">
                        {formatMoney(h.marketValueCcy, h.currency)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Math.abs(h.unrealizedPlHuf) > 0.5 ? (
                      <Delta
                        value={h.unrealizedPlHuf}
                        pct={pct}
                        className="text-xs"
                      />
                    ) : (
                      <span className="text-[var(--color-muted)]">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
