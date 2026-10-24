import type { Account, Instrument, Transaction } from "../model";
import type { CashflowMonth } from "../cashflow";

/** Monthly income / spending sums from an 1Money export (no single items). */
export interface CashflowImport {
  months: CashflowMonth[];
  /** The last day the export covers ("YYYY-MM-DD"). */
  through: string;
  /** Transfers between own accounts, left out. */
  skippedTransfers: number;
}

/** Normalised output of any importer, ready to merge into the store. */
export interface ParsedImport {
  source: string;
  accounts: Account[];
  instruments: Instrument[];
  transactions: Transaction[];
  warnings: string[];
  cashflow?: CashflowImport;
}

export const emptyParsed = (source: string): ParsedImport => ({
  source,
  accounts: [],
  instruments: [],
  transactions: [],
  warnings: [],
});
