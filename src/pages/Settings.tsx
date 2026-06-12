import { useState } from 'react'
import { Trash2, Database, Cloud, ShieldCheck } from 'lucide-react'
import { usePortfolio } from '../lib/store'
import { PageHeader, Card } from '../components/ui'

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

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-border)]/50 pb-2">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
