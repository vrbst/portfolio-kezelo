import { useState } from 'react'
import {
  Trash2,
  Database,
  Cloud,
  ShieldCheck,
  LineChart,
  RefreshCw,
} from 'lucide-react'
import { usePortfolio } from '../lib/store'
import { PageHeader, Card, Badge } from '../components/ui'
import { formatDateTime, formatNumber } from '../lib/format'
import { instrumentTypeLabel } from '../lib/labels'

const PRICED_TYPES = new Set(['etf', 'stock', 'fund'])

export default function Settings() {
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const instruments = usePortfolio((s) => s.instruments)
  const clearAll = usePortfolio((s) => s.clearAll)
  const [confirming, setConfirming] = useState(false)

  return (
    <div>
      <PageHeader title="Beállítások" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Database className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Tárolt adatok</h2>
          </div>
          <dl className="space-y-2 text-sm">
            <Row label="Számlák" value={accounts.length} />
            <Row label="Tranzakciók" value={transactions.length} />
            <Row label="Értékpapírok" value={instruments.length} />
          </dl>
          <p className="mt-4 flex items-start gap-2 text-xs text-[var(--color-muted)]">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-positive)]" />
            Minden adat a böngésződ helyi tárolójában (IndexedDB) marad, nem
            kerül szerverre.
          </p>
        </Card>

        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Cloud className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Szinkron (hamarosan)</h2>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            Több eszköz közti szinkron egy privát GitHub repón keresztül,
            személyes hozzáférési tokennel. Az adataid privátak maradnak. Ezt a
            következő fázisban kapcsoljuk be.
          </p>
        </Card>
      </div>

      <PriceSettings />

      <Card className="mt-4 border-[var(--color-negative)]/30 p-6">
        <div className="mb-2 flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-[var(--color-negative)]" />
          <h2 className="text-lg font-semibold">Veszélyes zóna</h2>
        </div>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          Az összes helyi adat végleges törlése. Ez nem vonható vissza.
        </p>
        {confirming ? (
          <div className="flex items-center gap-3">
            <button
              className="btn bg-[var(--color-negative)] text-white hover:brightness-110"
              onClick={async () => {
                await clearAll()
                setConfirming(false)
              }}
            >
              Igen, töröljem mindet
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              Mégse
            </button>
          </div>
        ) : (
          <button
            className="btn-ghost border-[var(--color-negative)]/40 text-[var(--color-negative)]"
            onClick={() => setConfirming(true)}
          >
            Összes adat törlése
          </button>
        )}
      </Card>
    </div>
  )
}

function PriceSettings() {
  const instruments = usePortfolio((s) => s.instruments)
  const priceFile = usePortfolio((s) => s.priceFile)
  const manualPrices = usePortfolio((s) => s.manualPrices)
  const setManualPrice = usePortfolio((s) => s.setManualPrice)
  const refreshPrices = usePortfolio((s) => s.refreshPrices)
  const pricesLoading = usePortfolio((s) => s.pricesLoading)
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt)
  const eurHuf = usePortfolio((s) => s.fx['EUR'])

  const priced = instruments.filter((i) => PRICED_TYPES.has(i.type))

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LineChart className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Árfolyamok</h2>
        </div>
        <button
          className="btn-ghost"
          onClick={() => refreshPrices()}
          disabled={pricesLoading}
        >
          <RefreshCw
            className={`h-4 w-4 ${pricesLoading ? 'animate-spin' : ''}`}
          />
          Frissítés
        </button>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Automatikus forrás: Yahoo Finance (ETF) + frankfurter.app (EUR/HUF
        {eurHuf ? ` = ${formatNumber(eurHuf, 2)}` : ''}).
        {priceUpdatedAt && ` Frissítve: ${formatDateTime(priceUpdatedAt)}.`} A
        kézi érték felülírja az automatikusat.
      </p>

      {priced.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Még nincs árazható értékpapír (ETF/részvény) importálva.
        </p>
      ) : (
        <div className="space-y-2">
          {priced.map((inst) => {
            const auto = priceFile?.prices[inst.key]
            const manual = manualPrices[inst.key]
            return (
              <div
                key={inst.key}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {inst.ticker || inst.name}
                    <Badge tone="neutral">{instrumentTypeLabel[inst.type]}</Badge>
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {auto
                      ? `Auto: ${formatNumber(auto.price, 2)} ${auto.currency}${
                          auto.symbol ? ` · ${auto.symbol}` : ''
                        }`
                      : 'Nincs automatikus ár'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="any"
                    defaultValue={manual ?? ''}
                    placeholder={auto ? String(auto.price) : 'Ár'}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      setManualPrice(inst.key, v === '' ? null : Number(v))
                    }}
                    className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-right text-sm"
                  />
                  <span className="text-xs text-[var(--color-muted)]">
                    {inst.currency}
                  </span>
                  {manual != null && (
                    <Badge tone="warning">kézi</Badge>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-border)]/50 pb-2">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
