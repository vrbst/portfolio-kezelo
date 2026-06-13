import { useState } from 'react'
import {
  Trash2,
  Database,
  Cloud,
  ShieldCheck,
  LineChart,
  RefreshCw,
  CloudUpload,
  CloudDownload,
  CheckCircle2,
  AlertTriangle,
  Landmark,
} from 'lucide-react'
import { usePortfolio } from '../lib/store'
import { PageHeader, Card, Badge } from '../components/ui'
import { formatDateTime, formatNumber } from '../lib/format'
import { instrumentTypeLabel } from '../lib/labels'
import { verifyAccess, type SyncConfig } from '../lib/sync'
import type { BondTerms, Instrument } from '../lib/model'

const PRICED_TYPES = new Set(['etf', 'stock', 'fund'])
const BOND_TYPES = new Set(['gov_bond', 'tbill'])

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

        <SyncSettings />
      </div>

      <PriceSettings />

      <BondSeriesSettings />

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

function SyncSettings() {
  const syncConfig = usePortfolio((s) => s.syncConfig)
  const setSyncConfig = usePortfolio((s) => s.setSyncConfig)
  const pushToCloud = usePortfolio((s) => s.pushToCloud)
  const pullFromCloud = usePortfolio((s) => s.pullFromCloud)
  const syncing = usePortfolio((s) => s.syncing)
  const lastSyncedAt = usePortfolio((s) => s.lastSyncedAt)

  const [form, setForm] = useState<SyncConfig>(
    syncConfig ?? { token: '', owner: '', repo: '', path: 'data.json' },
  )
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const connected = !!syncConfig

  const update = (patch: Partial<SyncConfig>) =>
    setForm((f) => ({ ...f, ...patch }))

  async function connect() {
    setMsg(null)
    try {
      const full = await verifyAccess(form)
      setSyncConfig({ ...form, path: form.path || 'data.json' })
      setMsg({ ok: true, text: `Kapcsolódva: ${full}` })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }

  async function doPush() {
    setMsg(null)
    try {
      await pushToCloud()
      setMsg({ ok: true, text: 'Feltöltve a privát repóba.' })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }

  async function doPull() {
    setMsg(null)
    try {
      const { added } = await pullFromCloud()
      setMsg({ ok: true, text: `Letöltve. ${added} új tranzakció.` })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }

  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Szinkron (több eszköz)</h2>
        </div>
        {connected && <Badge tone="positive">kapcsolódva</Badge>}
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Egy <strong>privát</strong> GitHub repóba menti az adataidat
        (fine-grained token, Contents: read &amp; write). A token csak ezen az
        eszközön tárolódik, sosem kerül fel sehova.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:col-span-2"
          type="password"
          placeholder="GitHub token (github_pat_…)"
          value={form.token}
          onChange={(e) => update({ token: e.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          placeholder="Felhasználónév (owner)"
          value={form.owner}
          onChange={(e) => update({ owner: e.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          placeholder="Repó neve (pl. portfolio-data)"
          value={form.repo}
          onChange={(e) => update({ repo: e.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:col-span-2"
          placeholder="Fájl útvonal (data.json)"
          value={form.path}
          onChange={(e) => update({ path: e.target.value })}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-ghost" onClick={connect} disabled={syncing}>
          {connected ? 'Újrakapcsolódás' : 'Kapcsolódás'}
        </button>
        <button className="btn-primary" onClick={doPush} disabled={!connected || syncing}>
          <CloudUpload className="h-4 w-4" /> Feltöltés
        </button>
        <button className="btn-ghost" onClick={doPull} disabled={!connected || syncing}>
          <CloudDownload className="h-4 w-4" /> Letöltés
        </button>
        {syncing && (
          <RefreshCw className="h-4 w-4 animate-spin text-[var(--color-muted)]" />
        )}
      </div>

      {lastSyncedAt && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Utolsó szinkron: {formatDateTime(lastSyncedAt)}
        </p>
      )}
      {msg && (
        <p
          className={`mt-2 flex items-center gap-1.5 text-xs ${
            msg.ok ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'
          }`}
        >
          {msg.ok ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          {msg.text}
        </p>
      )}
    </Card>
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

const INTERVALS = [
  { months: 12, label: 'éves' },
  { months: 6, label: 'féléves' },
  { months: 3, label: 'negyedéves' },
  { months: 1, label: 'havi' },
]

const inputCls =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm'

function BondSeriesSettings() {
  const instruments = usePortfolio((s) => s.instruments)
  const updateInstrument = usePortfolio((s) => s.updateInstrument)

  const bonds = instruments.filter((i) => BOND_TYPES.has(i.type))
  if (bonds.length === 0) return null

  const setBond = (inst: Instrument, patch: Partial<BondTerms>) =>
    updateInstrument(inst.key, { bond: { ...inst.bond, ...patch } })

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex items-center gap-2">
        <Landmark className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Állampapír sorozatok</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        A pontos értékeléshez add meg a sorozat adatait: kibocsátás, éves kamat,
        kamatperiódus és az első kamatfizetés dátuma — ebből számoljuk a
        felhalmozott kamatot a kupon-ütemterv szerint. A diszkont kincstárjegyek
        automatikusan a vételár → névérték akkrécióval értékelődnek.
      </p>

      <div className="space-y-3">
        {bonds.map((inst) => {
          const isTbill = inst.type === 'tbill'
          const b = inst.bond ?? {}
          const missing = !isTbill && b.couponRate == null
          return (
            <div
              key={inst.key}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{inst.name}</span>
                <Badge tone="neutral">{instrumentTypeLabel[inst.type]}</Badge>
                {missing && <Badge tone="warning">hiányzó adat</Badge>}
                {!isTbill && !missing && (
                  <Badge tone="positive">megadva</Badge>
                )}
                <span className="text-xs text-[var(--color-muted)]">
                  lejárat:{' '}
                  {(b.maturity ?? inst.maturity)?.slice(0, 10) ?? '—'}
                </span>
              </div>

              {isTbill ? (
                <p className="text-xs text-[var(--color-muted)]">
                  Diszkont kincstárjegy — automatikus akkréció a lejáratig (
                  {inst.maturity?.slice(0, 10) ?? 'ismeretlen lejárat'}).
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Kibocsátás">
                    <input
                      type="date"
                      className={inputCls}
                      value={b.issueDate?.slice(0, 10) ?? ''}
                      onChange={(e) =>
                        setBond(inst, { issueDate: e.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="Éves kamat %">
                    <input
                      type="number"
                      step="any"
                      className={`${inputCls} w-24 text-right`}
                      defaultValue={
                        b.couponRate != null ? b.couponRate * 100 : ''
                      }
                      placeholder="pl. 7.04"
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        setBond(inst, {
                          couponRate: v === '' ? undefined : Number(v) / 100,
                        })
                      }}
                    />
                  </Field>
                  <Field label="Kamatperiódus">
                    <select
                      className={inputCls}
                      value={b.couponIntervalMonths ?? 12}
                      onChange={(e) =>
                        setBond(inst, {
                          couponIntervalMonths: Number(e.target.value),
                        })
                      }
                    >
                      {INTERVALS.map((iv) => (
                        <option key={iv.months} value={iv.months}>
                          {iv.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Első kamatfizetés">
                    <input
                      type="date"
                      className={inputCls}
                      value={b.firstCouponDate?.slice(0, 10) ?? ''}
                      onChange={(e) =>
                        setBond(inst, {
                          firstCouponDate: e.target.value || undefined,
                        })
                      }
                    />
                  </Field>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
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
