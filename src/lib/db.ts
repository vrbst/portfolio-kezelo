import Dexie, { type EntityTable } from 'dexie'
import type { Account, Instrument, Transaction } from './model'

export interface PricePoint {
  /** `${instrumentKey}` */
  key: string
  /** ISO date (YYYY-MM-DD). */
  date: string
  price: number
  currency: string
  source?: string
}

export interface MetaKV {
  key: string
  value: unknown
}

// Composite primary key for prices: [key+date]
export const db = new Dexie('portfolio') as Dexie & {
  accounts: EntityTable<Account, 'id'>
  instruments: EntityTable<Instrument, 'key'>
  transactions: EntityTable<Transaction, 'id'>
  prices: EntityTable<PricePoint & { id: string }, 'id'>
  meta: EntityTable<MetaKV, 'key'>
}

db.version(1).stores({
  accounts: 'id, provider, kind, externalRef',
  instruments: 'key, type, isin, ticker',
  transactions: 'id, accountId, date, type, instrumentKey, reference',
  prices: 'id, key, date',
  meta: 'key',
})

/** Wipe everything (used by "reset" in settings). */
export async function clearAllData() {
  await Promise.all([
    db.accounts.clear(),
    db.instruments.clear(),
    db.transactions.clear(),
    db.prices.clear(),
    db.meta.clear(),
  ])
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key)
  return row?.value as T | undefined
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value })
}
