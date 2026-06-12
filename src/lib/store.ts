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

interface PortfolioState {
  loaded: boolean
  accounts: Account[]
  instruments: Instrument[]
  transactions: Transaction[]
  /** instrument key -> current price (instrument ccy). */
  prices: PriceMap
  /** currency -> HUF per 1 unit. */
  fx: Record<string, number>

  load: () => Promise<void>
  importParsed: (parsed: ParsedImport) => Promise<{
    added: number
    skipped: number
  }>
  updateAccount: (id: string, patch: Partial<Account>) => Promise<void>
  setPrices: (prices: PriceMap, fx?: Record<string, number>) => void
  clearAll: () => Promise<void>

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

export const usePortfolio = create<PortfolioState>((set, get) => ({
  loaded: false,
  accounts: [],
  instruments: [],
  transactions: [],
  prices: new Map(),
  fx: {},

  load: async () => {
    const [accounts, instruments, transactions, savedFx] = await Promise.all([
      db.accounts.toArray(),
      db.instruments.toArray(),
      db.transactions.toArray(),
      getMeta<Record<string, number>>('fx'),
    ])
    const fx = { ...deriveFx(transactions), ...(savedFx ?? {}) }
    set({ accounts, instruments, transactions, fx, loaded: true })
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

  setPrices: (prices, fx) => {
    set((s) => {
      const nextFx = fx ? { ...s.fx, ...fx } : s.fx
      if (fx) void setMeta('fx', nextFx)
      return { prices, fx: nextFx }
    })
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
