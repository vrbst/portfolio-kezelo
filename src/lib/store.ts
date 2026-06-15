import { useMemo } from 'react'
import { create } from 'zustand'
import { db, getMeta, setMeta } from './db'
import type { Account, Instrument, Transaction } from './model'
import type { ParsedImport } from './parsers'
import {
  computePortfolio,
  type PortfolioSummary,
  type PriceMap,
} from './portfolio'
import {
  loadPriceFile,
  loadHistoryFile,
  fetchLiveFx,
  fetchLivePrices,
  type PriceFile,
  type HistoryFile,
} from './prices'
import {
  loadSyncConfig,
  saveSyncConfig,
  loadAutoSync,
  saveAutoSync,
  getRemoteSnapshot,
  putRemoteSnapshot,
  type SyncConfig,
  type PortfolioSnapshot,
} from './sync'
import {
  computeAlerts,
  loadAlertConfig,
  saveIdleCashThreshold,
  saveTbszCheck,
  reconcileAlertState,
  type Alert,
  type AlertState,
  type AlertConfig,
} from './alerts'

interface PortfolioState {
  loaded: boolean
  accounts: Account[]
  instruments: Instrument[]
  transactions: Transaction[]
  /** instrument key -> current price (instrument ccy). */
  prices: PriceMap
  /** currency -> HUF per 1 unit. */
  fx: Record<string, number>
  /** Last loaded committed snapshot (for symbol/currency display). */
  priceFile: PriceFile | null
  /** Daily price/FX history for the value chart (from public/history.json). */
  historyFile: HistoryFile | null
  /** Live quotes (Worker→Yahoo): instrument key -> price (instrument ccy). */
  livePrices: Record<string, number>
  /** User overrides: instrument key -> price (instrument ccy). */
  manualPrices: Record<string, number>
  /** ISO timestamp shown in the UI. */
  priceUpdatedAt?: string
  pricesLoading: boolean

  /** Alert history (seen / dismissed), synced. Keyed by stable alert id. */
  alertState: AlertState
  /** Per-device alert config (idle-cash threshold). */
  alertConfig: AlertConfig
  /** Fold the current active alerts into the synced history (persists if changed). */
  reconcileAlerts: (active: Alert[]) => void
  dismissAlert: (alert: Alert) => Promise<void>
  restoreAlert: (id: string) => Promise<void>
  setIdleCashThreshold: (huf: number) => void
  setTbszCheckEnabled: (enabled: boolean) => void

  /** Privacy mode: blur all Ft/EUR amounts and quantities (percentages stay). */
  privacy: boolean
  togglePrivacy: () => void

  load: () => Promise<void>
  importParsed: (parsed: ParsedImport) => Promise<{
    added: number
    skipped: number
  }>
  updateAccount: (id: string, patch: Partial<Account>) => Promise<void>
  updateInstrument: (key: string, patch: Partial<Instrument>) => Promise<void>
  setPrices: (prices: PriceMap, fx?: Record<string, number>) => void
  refreshPrices: () => Promise<void>
  setManualPrice: (key: string, price: number | null) => Promise<void>
  clearAll: () => Promise<void>

  // ---- Cross-device sync (private GitHub repo) ----
  syncConfig: SyncConfig | null
  syncing: boolean
  lastSyncedAt?: string
  /** Auto-push to the cloud after imports and edits. */
  autoSync: boolean
  /** Message from the last failed auto-push, if any. */
  syncError?: string
  setSyncConfig: (config: SyncConfig | null) => void
  setAutoSync: (enabled: boolean) => void
  pushToCloud: () => Promise<void>
  pullFromCloud: () => Promise<{ added: number }>

  instrumentMap: () => Map<string, Instrument>
  summary: () => PortfolioSummary
}

const PRIVACY_KEY = 'pf-privacy'
function loadPrivacy(): boolean {
  try {
    return localStorage.getItem(PRIVACY_KEY) === '1'
  } catch {
    return false
  }
}
function savePrivacy(v: boolean) {
  try {
    localStorage.setItem(PRIVACY_KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** Derive a fallback EUR->HUF rate from the latest conversion legs. */
function deriveFx(txs: Transaction[]): Record<string, number> {
  const fx: Record<string, number> = {}
  const eurLegs = txs
    .filter(
      (t) =>
        t.type === 'conversion' &&
        t.currency === 'EUR' &&
        typeof t.fxRate === 'number' &&
        t.fxRate > 1,
    )
    .sort((a, b) => b.date.localeCompare(a.date))
  if (eurLegs[0]?.fxRate) fx['EUR'] = eurLegs[0].fxRate
  return fx
}

/**
 * Layer prices by freshness: committed snapshot < live quotes < user overrides
 * (later wins). Live fills in fresh intraday values; manual always trumps.
 */
function buildPriceMap(
  file: PriceFile | null,
  live: Record<string, number>,
  manual: Record<string, number>,
): PriceMap {
  const map: PriceMap = new Map()
  if (file) {
    for (const [key, entry] of Object.entries(file.prices)) {
      if (typeof entry?.price === 'number') map.set(key, entry.price)
    }
  }
  for (const [key, price] of Object.entries(live)) map.set(key, price)
  for (const [key, price] of Object.entries(manual)) map.set(key, price)
  return map
}

function buildSnapshot(s: PortfolioState): PortfolioSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: s.accounts,
    instruments: s.instruments,
    transactions: s.transactions,
    manualPrices: s.manualPrices,
    alertState: s.alertState,
  }
}

/** Merge a remote snapshot into local state + IndexedDB. Returns # new txs. */
async function mergeSnapshot(
  set: (partial: Partial<PortfolioState>) => void,
  get: () => PortfolioState,
  snap: PortfolioSnapshot,
): Promise<number> {
  const s = get()

  const txById = new Map(s.transactions.map((t) => [t.id, t]))
  let added = 0
  for (const t of snap.transactions ?? []) {
    if (!txById.has(t.id)) {
      txById.set(t.id, t)
      added++
    }
  }
  const transactions = [...txById.values()]

  // Remote wins so instrument edits (e.g. bond series terms) propagate across
  // devices, mirroring the account-merge policy below.
  const instByKey = new Map(s.instruments.map((i) => [i.key, i]))
  for (const i of snap.instruments ?? []) instByKey.set(i.key, i)
  const instruments = [...instByKey.values()]

  // Accounts: remote wins so TBSZ labels / edits propagate across devices.
  const accById = new Map(s.accounts.map((a) => [a.id, a]))
  for (const a of snap.accounts ?? []) accById.set(a.id, a)
  const accounts = [...accById.values()]

  const manualPrices = { ...s.manualPrices, ...(snap.manualPrices ?? {}) }
  // Alert history: remote wins per-id (mirrors the manualPrices / account merge).
  const alertState = { ...s.alertState, ...(snap.alertState ?? {}) }

  await Promise.all([
    db.accounts.bulkPut(accounts),
    db.instruments.bulkPut(instruments),
    db.transactions.bulkPut(transactions),
    setMeta('manualPrices', manualPrices),
    setMeta('alertState', alertState),
  ])

  set({
    accounts,
    instruments,
    transactions,
    manualPrices,
    alertState,
    prices: buildPriceMap(s.priceFile, s.livePrices, manualPrices),
    fx: { ...deriveFx(transactions), ...s.fx },
  })
  return added
}

// Debounced background auto-push: coalesces a burst of imports/edits into one
// upload a couple of seconds after the last change.
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleAutoSync(
  set: (partial: Partial<PortfolioState>) => void,
  get: () => PortfolioState,
) {
  const s = get()
  if (!s.syncConfig || !s.autoSync) return
  if (autoSyncTimer) clearTimeout(autoSyncTimer)
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null
    const st = get()
    if (!st.syncConfig || !st.autoSync) return
    if (st.syncing) {
      scheduleAutoSync(set, get) // a push is in flight — try again shortly
      return
    }
    try {
      await st.pushToCloud()
    } catch (e) {
      set({ syncError: (e as Error).message })
    }
  }, 2500)
}

export const usePortfolio = create<PortfolioState>((set, get) => ({
  loaded: false,
  accounts: [],
  instruments: [],
  transactions: [],
  prices: new Map(),
  fx: {},
  priceFile: null,
  historyFile: null,
  livePrices: {},
  manualPrices: {},
  priceUpdatedAt: undefined,
  pricesLoading: false,
  alertState: {},
  alertConfig: loadAlertConfig(),
  privacy: loadPrivacy(),
  togglePrivacy: () => {
    const v = !get().privacy
    savePrivacy(v)
    set({ privacy: v })
  },
  syncConfig: loadSyncConfig(),
  syncing: false,
  lastSyncedAt: undefined,
  autoSync: loadAutoSync(),
  syncError: undefined,

  load: async () => {
    const [accounts, instruments, transactions, savedFx, manualPrices, alertState] =
      await Promise.all([
        db.accounts.toArray(),
        db.instruments.toArray(),
        db.transactions.toArray(),
        getMeta<Record<string, number>>('fx'),
        getMeta<Record<string, number>>('manualPrices'),
        getMeta<AlertState>('alertState'),
      ])
    const fx = { ...deriveFx(transactions), ...(savedFx ?? {}) }
    set({
      accounts,
      instruments,
      transactions,
      fx,
      manualPrices: manualPrices ?? {},
      alertState: alertState ?? {},
      loaded: true,
    })
    // Pull live prices in the background (non-blocking).
    void get().refreshPrices()
  },

  importParsed: async (parsed) => {
    const state = get()
    const existingTxIds = new Set(state.transactions.map((t) => t.id))

    const newTxs = parsed.transactions.filter((t) => !existingTxIds.has(t.id))
    const skipped = parsed.transactions.length - newTxs.length

    // Merge accounts (keep user edits like TBSZ year already set).
    const accountById = new Map(state.accounts.map((a) => [a.id, a]))
    for (const a of parsed.accounts) {
      const existing = accountById.get(a.id)
      accountById.set(a.id, existing ? { ...a, ...existing } : a)
    }
    const accounts = [...accountById.values()]

    const instrumentByKey = new Map(
      state.instruments.map((i) => [i.key, i]),
    )
    for (const i of parsed.instruments) {
      if (!instrumentByKey.has(i.key)) instrumentByKey.set(i.key, i)
    }
    const instruments = [...instrumentByKey.values()]

    const transactions = [...state.transactions, ...newTxs]
    const fx = { ...deriveFx(transactions), ...state.fx }

    await Promise.all([
      db.accounts.bulkPut(accounts),
      db.instruments.bulkPut(instruments),
      db.transactions.bulkPut(newTxs),
    ])

    set({ accounts, instruments, transactions, fx })
    if (newTxs.length > 0) scheduleAutoSync(set, get)
    return { added: newTxs.length, skipped }
  },

  updateAccount: async (id, patch) => {
    const accounts = get().accounts.map((a) =>
      a.id === id ? { ...a, ...patch } : a,
    )
    const updated = accounts.find((a) => a.id === id)
    if (updated) await db.accounts.put(updated)
    set({ accounts })
    scheduleAutoSync(set, get)
  },

  updateInstrument: async (key, patch) => {
    const instruments = get().instruments.map((i) =>
      i.key === key ? { ...i, ...patch } : i,
    )
    const updated = instruments.find((i) => i.key === key)
    if (updated) await db.instruments.put(updated)
    set({ instruments })
    scheduleAutoSync(set, get)
  },

  setPrices: (prices, fx) => {
    set((s) => {
      const nextFx = fx ? { ...s.fx, ...fx } : s.fx
      if (fx) void setMeta('fx', nextFx)
      return { prices, fx: nextFx }
    })
  },

  refreshPrices: async () => {
    set({ pricesLoading: true })
    const [file, history, liveFx, livePrices] = await Promise.all([
      loadPriceFile(),
      loadHistoryFile(),
      fetchLiveFx(),
      fetchLivePrices(),
    ])
    set((s) => {
      const priceFile = file ?? s.priceFile
      // Keep the last good live quote for any symbol that failed this round.
      const live = { ...s.livePrices, ...livePrices }
      const prices = buildPriceMap(priceFile, live, s.manualPrices)
      // Live FX wins, then snapshot FX, then whatever we had (derived).
      const fx = { ...s.fx, ...(priceFile?.fx ?? {}), ...liveFx }
      void setMeta('fx', fx)
      const gotLive = Object.keys(livePrices).length > 0
      return {
        priceFile,
        historyFile: history ?? s.historyFile,
        livePrices: live,
        prices,
        fx,
        // Live quote → "now"; otherwise fall back to the snapshot's timestamp.
        priceUpdatedAt: gotLive
          ? new Date().toISOString()
          : (priceFile?.updatedAt ?? s.priceUpdatedAt),
        pricesLoading: false,
      }
    })
  },

  setManualPrice: async (key, price) => {
    const manualPrices = { ...get().manualPrices }
    if (price == null || Number.isNaN(price)) delete manualPrices[key]
    else manualPrices[key] = price
    await setMeta('manualPrices', manualPrices)
    set((s) => ({
      manualPrices,
      prices: buildPriceMap(s.priceFile, s.livePrices, manualPrices),
    }))
    scheduleAutoSync(set, get)
  },

  reconcileAlerts: (active) => {
    const { state, changed } = reconcileAlertState(
      get().alertState,
      active,
      new Date().toISOString(),
    )
    if (!changed) return
    void setMeta('alertState', state)
    set({ alertState: state })
    scheduleAutoSync(set, get)
  },

  dismissAlert: async (alert) => {
    const now = new Date().toISOString()
    const prev = get().alertState
    const rec = prev[alert.id]
    const alertState: AlertState = {
      ...prev,
      [alert.id]: {
        status: 'dismissed',
        firstSeenAt: rec?.firstSeenAt ?? now,
        dismissedAt: now,
        title: rec?.title ?? alert.title,
        detail: rec?.detail ?? alert.detail,
        severity: rec?.severity ?? alert.severity,
      },
    }
    await setMeta('alertState', alertState)
    set({ alertState })
    scheduleAutoSync(set, get)
  },

  restoreAlert: async (id) => {
    const prev = get().alertState
    const rec = prev[id]
    if (!rec) return
    const alertState: AlertState = {
      ...prev,
      [id]: { ...rec, status: 'seen', dismissedAt: undefined },
    }
    await setMeta('alertState', alertState)
    set({ alertState })
    scheduleAutoSync(set, get)
  },

  setIdleCashThreshold: (huf) => {
    saveIdleCashThreshold(huf)
    set((s) => ({ alertConfig: { ...s.alertConfig, idleCashHuf: huf } }))
  },

  setTbszCheckEnabled: (enabled) => {
    saveTbszCheck(enabled)
    set((s) => ({ alertConfig: { ...s.alertConfig, tbszCheck: enabled } }))
  },

  setSyncConfig: (config) => {
    saveSyncConfig(config)
    set({ syncConfig: config })
  },

  setAutoSync: (enabled) => {
    saveAutoSync(enabled)
    set({ autoSync: enabled })
    if (enabled) scheduleAutoSync(set, get)
  },

  pushToCloud: async () => {
    const { syncConfig } = get()
    if (!syncConfig) throw new Error('Nincs beállítva szinkron.')
    set({ syncing: true })
    try {
      const snapshot = buildSnapshot(get())
      // Use the remote sha if a file already exists (required for update).
      const existing = await getRemoteSnapshot(syncConfig)
      await putRemoteSnapshot(syncConfig, snapshot, existing?.sha)
      set({ lastSyncedAt: snapshot.exportedAt, syncError: undefined })
    } finally {
      set({ syncing: false })
    }
  },

  pullFromCloud: async () => {
    const { syncConfig } = get()
    if (!syncConfig) throw new Error('Nincs beállítva szinkron.')
    set({ syncing: true })
    try {
      const remote = await getRemoteSnapshot(syncConfig)
      if (!remote) return { added: 0 }
      const added = await mergeSnapshot(set, get, remote.snapshot)
      set({ lastSyncedAt: new Date().toISOString() })
      return { added }
    } finally {
      set({ syncing: false })
    }
  },

  clearAll: async () => {
    await Promise.all([
      db.accounts.clear(),
      db.instruments.clear(),
      db.transactions.clear(),
      db.prices.clear(),
      db.meta.clear(),
    ])
    set({
      accounts: [],
      instruments: [],
      transactions: [],
      prices: new Map(),
      fx: {},
      livePrices: {},
      manualPrices: {},
      alertState: {},
      priceFile: null,
      priceUpdatedAt: undefined,
    })
  },

  instrumentMap: () => new Map(get().instruments.map((i) => [i.key, i])),

  summary: () => {
    const s = get()
    return computePortfolio(
      s.accounts,
      s.transactions,
      s.instrumentMap(),
      s.prices,
      s.fx,
    )
  },
}))

/**
 * Memoised portfolio summary for components.
 *
 * IMPORTANT: never select `s.summary()` directly — it returns a fresh object on
 * every call, which makes Zustand re-render in an infinite loop. Select the raw
 * slices (each a stable reference) and derive with useMemo instead.
 */
export function usePortfolioSummary(): PortfolioSummary {
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const instruments = usePortfolio((s) => s.instruments)
  const prices = usePortfolio((s) => s.prices)
  const fx = usePortfolio((s) => s.fx)

  return useMemo(
    () =>
      computePortfolio(
        accounts,
        transactions,
        new Map(instruments.map((i) => [i.key, i])),
        prices,
        fx,
      ),
    [accounts, transactions, instruments, prices, fx],
  )
}

/** Currently-active alerts derived from the live summary + tunable threshold. */
export function useActiveAlerts(): Alert[] {
  const summary = usePortfolioSummary()
  const config = usePortfolio((s) => s.alertConfig)
  return useMemo(() => computeAlerts(summary, config), [summary, config])
}
