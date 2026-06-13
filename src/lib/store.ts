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
  type PriceFile,
  type HistoryFile,
} from './prices'
import {
  loadSyncConfig,
  saveSyncConfig,
  getRemoteSnapshot,
  putRemoteSnapshot,
  type SyncConfig,
  type PortfolioSnapshot,
} from './sync'

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
  /** User overrides: instrument key -> price (instrument ccy). */
  manualPrices: Record<string, number>
  /** ISO timestamp shown in the UI. */
  priceUpdatedAt?: string
  pricesLoading: boolean

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
  setSyncConfig: (config: SyncConfig | null) => void
  pushToCloud: () => Promise<void>
  pullFromCloud: () => Promise<{ added: number }>

  instrumentMap: () => Map<string, Instrument>
  summary: () => PortfolioSummary
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

/** Merge committed snapshot prices with user overrides (overrides win). */
function buildPriceMap(
  file: PriceFile | null,
  manual: Record<string, number>,
): PriceMap {
  const map: PriceMap = new Map()
  if (file) {
    for (const [key, entry] of Object.entries(file.prices)) {
      if (typeof entry?.price === 'number') map.set(key, entry.price)
    }
  }
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

  await Promise.all([
    db.accounts.bulkPut(accounts),
    db.instruments.bulkPut(instruments),
    db.transactions.bulkPut(transactions),
    setMeta('manualPrices', manualPrices),
  ])

  set({
    accounts,
    instruments,
    transactions,
    manualPrices,
    prices: buildPriceMap(s.priceFile, manualPrices),
    fx: { ...deriveFx(transactions), ...s.fx },
  })
  return added
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
  manualPrices: {},
  priceUpdatedAt: undefined,
  pricesLoading: false,
  syncConfig: loadSyncConfig(),
  syncing: false,
  lastSyncedAt: undefined,

  load: async () => {
    const [accounts, instruments, transactions, savedFx, manualPrices] =
      await Promise.all([
        db.accounts.toArray(),
        db.instruments.toArray(),
        db.transactions.toArray(),
        getMeta<Record<string, number>>('fx'),
        getMeta<Record<string, number>>('manualPrices'),
      ])
    const fx = { ...deriveFx(transactions), ...(savedFx ?? {}) }
    set({
      accounts,
      instruments,
      transactions,
      fx,
      manualPrices: manualPrices ?? {},
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
    return { added: newTxs.length, skipped }
  },

  updateAccount: async (id, patch) => {
    const accounts = get().accounts.map((a) =>
      a.id === id ? { ...a, ...patch } : a,
    )
    const updated = accounts.find((a) => a.id === id)
    if (updated) await db.accounts.put(updated)
    set({ accounts })
  },

  updateInstrument: async (key, patch) => {
    const instruments = get().instruments.map((i) =>
      i.key === key ? { ...i, ...patch } : i,
    )
    const updated = instruments.find((i) => i.key === key)
    if (updated) await db.instruments.put(updated)
    set({ instruments })
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
    const [file, history, liveFx] = await Promise.all([
      loadPriceFile(),
      loadHistoryFile(),
      fetchLiveFx(),
    ])
    set((s) => {
      const priceFile = file ?? s.priceFile
      const prices = buildPriceMap(priceFile, s.manualPrices)
      // Live FX wins, then snapshot FX, then whatever we had (derived).
      const fx = { ...s.fx, ...(priceFile?.fx ?? {}), ...liveFx }
      void setMeta('fx', fx)
      return {
        priceFile,
        historyFile: history ?? s.historyFile,
        prices,
        fx,
        priceUpdatedAt: priceFile?.updatedAt,
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
      prices: buildPriceMap(s.priceFile, manualPrices),
    }))
  },

  setSyncConfig: (config) => {
    saveSyncConfig(config)
    set({ syncConfig: config })
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
      set({ lastSyncedAt: snapshot.exportedAt })
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
      manualPrices: {},
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
