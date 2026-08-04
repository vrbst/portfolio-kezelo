// Render-time grouping for the transactions list: a foreign-currency buy/sell
// (the head) folds the currency-conversion pair that funded it under an
// expandable row, so one Lightyear purchase reads as one line instead of three.
//
// Deterministic by design (no AI, no fuzz beyond a cent of rounding): the
// conversion's trade-currency leg equals the head's gross amount on the same
// calendar day, and its counter-leg shares the conversion timestamp. Raw
// transactions are never modified — deposits/transfers stay standalone rows
// (their amounts don't match exactly: fees make e.g. 40 000 vs 40 003 Ft).

import type { Transaction } from "./model";

/** One display row: a transaction, optionally with folded conversion legs. */
export interface TxRow {
  tx: Transaction;
  /** Conversion legs hidden under this head (expandable in the UI). */
  details?: Transaction[];
}

/** Amount slack for matching (statement values are rounded to 2 decimals). */
const EPS = 0.02;

/**
 * Group an account's transactions (any order; output preserves input order).
 * Consumed conversion legs disappear as standalone rows and reappear inside
 * their head's `details`.
 */
export function groupTransactions(txs: Transaction[]): TxRow[] {
  const conversions = txs.filter((t) => t.type === "conversion");
  const consumed = new Set<string>();
  const detailsByHead = new Map<string, Transaction[]>();

  for (const head of txs) {
    if (
      (head.type !== "buy" && head.type !== "sell") ||
      head.currency === "HUF" ||
      head.grossAmount == null
    )
      continue;
    const day = head.date.slice(0, 10);
    const amt = Math.abs(head.grossAmount);
    const headMs = Date.parse(head.date);

    // Trade-currency leg: same day, same amount, money flowing the right way
    // (a buy needs incoming trade currency, a sell outgoing). Nearest in time
    // wins when several match (e.g. two same-sized buys on one day).
    let legA: Transaction | undefined;
    let bestGap = Infinity;
    for (const c of conversions) {
      if (consumed.has(c.id)) continue;
      if (c.currency !== head.currency) continue;
      if (c.date.slice(0, 10) !== day) continue;
      const g = c.grossAmount ?? c.netAmount ?? 0;
      if (head.type === "buy" ? g <= 0 : g >= 0) continue;
      if (Math.abs(Math.abs(g) - amt) > EPS) continue;
      const gap = Math.abs(Date.parse(c.date) - headMs);
      if (gap < bestGap) {
        bestGap = gap;
        legA = c;
      }
    }
    if (!legA) continue;
    const a = legA;

    // Counter-leg (the other currency) of the SAME conversion: Lightyear books
    // both legs at the identical timestamp.
    const legB = conversions.find(
      (c) =>
        !consumed.has(c.id) &&
        c.id !== a.id &&
        c.date === a.date &&
        c.currency !== a.currency,
    );

    const details = legB ? [a, legB] : [a];
    for (const d of details) consumed.add(d.id);
    detailsByHead.set(head.id, details);
  }

  const rows: TxRow[] = [];
  for (const t of txs) {
    if (consumed.has(t.id)) continue;
    const details = detailsByHead.get(t.id);
    rows.push(details ? { tx: t, details } : { tx: t });
  }
  return rows;
}
