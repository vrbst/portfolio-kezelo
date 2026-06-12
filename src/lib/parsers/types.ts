import type { Account, Instrument, Transaction } from '../model'

/** Normalised output of any importer, ready to merge into the store. */
export interface ParsedImport {
  source: string
  accounts: Account[]
  instruments: Instrument[]
  transactions: Transaction[]
  warnings: string[]
}

export const emptyParsed = (source: string): ParsedImport => ({
  source,
  accounts: [],
  instruments: [],
  transactions: [],
  warnings: [],
})
