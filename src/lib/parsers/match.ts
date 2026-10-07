// Transaction identity across imports. Kept apart from parsers/index.ts so
// the store can use it without pulling the statement parsers (and xlsx) in.

import type { Transaction } from "../model";

/**
 * Match parsed transactions against the ones already stored, by the same chain
 * as dedupeTxs: an id held by the SAME transaction is a re-import (skipped); an
 * id held by a DIFFERENT one is a hash collision, so the row moves on to the
 * suffixed id (`~x`) instead of being dropped as a "duplicate". Deterministic,
 * so importing the statement again lands on the same ids. Shared by the import
 * and its preview, so both count the same rows as new.
 */
export function matchExisting(
  parsed: Transaction[],
  existing: Map<string, Transaction>,
): {
  newTxs: Transaction[];
  skipped: number;
  /** Per parsed row (same order): will it be imported? */
  isNew: boolean[];
} {
  const newTxs: Transaction[] = [];
  const isNew: boolean[] = [];
  const claimed = new Map<string, Transaction>();
  for (const t of parsed) {
    let id = t.id;
    for (;;) {
      const prev = existing.get(id) ?? claimed.get(id);
      if (!prev) {
        const out = id === t.id ? t : { ...t, id };
        claimed.set(id, out);
        newTxs.push(out);
        isNew.push(true);
        break;
      }
      if (sameTx(prev, t)) {
        isNew.push(false);
        break;
      }
      id = `${id}~x`;
    }
  }
  return { newTxs, skipped: parsed.length - newTxs.length, isNew };
}

/** Two rows with the same id but identical content = the same statement row. */
export function sameTx(a: Transaction, b: Transaction): boolean {
  return (
    a.accountId === b.accountId &&
    a.date === b.date &&
    a.type === b.type &&
    a.instrumentKey === b.instrumentKey &&
    a.currency === b.currency &&
    a.grossAmount === b.grossAmount &&
    a.netAmount === b.netAmount &&
    a.quantity === b.quantity
  );
}
