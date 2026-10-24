// The single 1Money items live in this device's database only (they can carry
// people's names in their notes). What is synced are the monthly sums and the
// skips (see cashflow.ts).

import { db } from "./db";
import {
  applyCashflowImport,
  loadCashflowSkips,
  reconcileSkips,
  saveCashflowSkips,
  type CashflowItem,
} from "./cashflow";
import type { CashflowImport } from "./parsers/types";

export async function loadCashflowItems(): Promise<CashflowItem[]> {
  try {
    return await db.cashflowItems.toArray();
  } catch {
    return [];
  }
}

/** The items of the given months are replaced by the new ones; other months stay. */
export async function replaceCashflowItems(items: CashflowItem[], months: string[]) {
  await db.transaction("rw", db.cashflowItems, async () => {
    await db.cashflowItems.where("month").anyOf(months).delete();
    await db.cashflowItems.bulkPut(items);
  });
}

/**
 * Save an 1Money import: the items here, the monthly sums as a synced pref,
 * and drop the skips whose item is gone (e.g. recategorised in 1Money).
 * The items go first, so a view reloading on the pref change finds them.
 */
export async function importCashflow(cf: CashflowImport): Promise<{ droppedSkips: number }> {
  const months = cf.months.map((m) => m.month);
  await replaceCashflowItems(cf.items, months);
  applyCashflowImport(cf);
  const { kept, dropped } = reconcileSkips(loadCashflowSkips(), cf.items, months);
  if (dropped.length > 0) saveCashflowSkips(kept);
  return { droppedSkips: dropped.length };
}
