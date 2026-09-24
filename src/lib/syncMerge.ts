// Pure merge rules for the cross-device sync snapshot (union by id, local
// wins on conflicts, tombstones for deletions). Grew out of store.ts.

import { db } from "./db";
import type { Account, Transaction } from "./model";
import { type PortfolioSnapshot } from "./sync";
import { mergePrefs } from "./prefs";

export function unionById<T>(
  base: T[] | undefined,
  over: T[] | undefined,
  keyOf: (x: T) => string,
): T[] {
  const m = new Map<string, T>();
  for (const x of base ?? []) m.set(keyOf(x), x);
  for (const x of over ?? []) m.set(keyOf(x), x);
  return [...m.values()];
}

/** Union two tombstone maps, keeping the latest deletion time per id. */
export function mergeTombstones(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...(a ?? {}) };
  for (const [id, at] of Object.entries(b ?? {})) {
    if (!out[id] || at > out[id]) out[id] = at;
  }
  return out;
}

/** Deleted = tombstoned, and not re-imported after the deletion. */
export function isAccountDeleted(
  a: Account,
  tombstones: Record<string, string>,
) {
  const at = tombstones[a.id];
  return !!at && !(a.restoredAt && a.restoredAt > at);
}

/** Drop deleted accounts and every transaction that belongs to them. */
export function dropDeletedAccounts(
  accounts: Account[],
  transactions: Transaction[],
  tombstones: Record<string, string>,
): { accounts: Account[]; transactions: Transaction[]; removedIds: string[] } {
  const removedIds = Object.keys(tombstones).filter((id) => {
    const acc = accounts.find((a) => a.id === id);
    return !acc || isAccountDeleted(acc, tombstones);
  });
  if (removedIds.length === 0) return { accounts, transactions, removedIds };
  const removed = new Set(removedIds);
  return {
    accounts: accounts.filter((a) => !removed.has(a.id)),
    transactions: transactions.filter((t) => !removed.has(t.accountId)),
    removedIds,
  };
}

/** Remove deleted accounts' rows from IndexedDB (bulkPut never deletes). */
export async function purgeAccountsFromDb(ids: string[]) {
  if (ids.length === 0) return;
  await Promise.all([
    db.accounts.bulkDelete(ids),
    db.transactions.where("accountId").anyOf(ids).delete(),
  ]);
}

/**
 * Union two snapshots, preferring LOCAL on per-item conflicts. Used when
 * pushing: we must never drop the OTHER device's data (goals, txs…), but this
 * device's own edits — the change that triggered the push — should win.
 */
export function unionSnapshots(
  remote: PortfolioSnapshot,
  local: PortfolioSnapshot,
): PortfolioSnapshot {
  const deletedGoalIds = [
    ...new Set([
      ...(remote.deletedGoalIds ?? []),
      ...(local.deletedGoalIds ?? []),
    ]),
  ];
  const deleted = new Set(deletedGoalIds);
  const deletedReminderIds = [
    ...new Set([
      ...(remote.deletedReminderIds ?? []),
      ...(local.deletedReminderIds ?? []),
    ]),
  ];
  const deletedRem = new Set(deletedReminderIds);
  const deletedAccounts = mergeTombstones(
    remote.deletedAccounts,
    local.deletedAccounts,
  );
  // Drop tombstoned accounts with their transactions, so a delete is never re-added.
  const { accounts, transactions } = dropDeletedAccounts(
    unionById(remote.accounts, local.accounts, (a) => a.id),
    unionById(remote.transactions, local.transactions, (t) => t.id),
    deletedAccounts,
  );
  return {
    version: 1,
    exportedAt: local.exportedAt,
    accounts,
    instruments: unionById(remote.instruments, local.instruments, (i) => i.key),
    transactions,
    deletedAccounts,
    alertState: { ...(remote.alertState ?? {}), ...(local.alertState ?? {}) },
    // Drop any goal a tombstone marks deleted, so a delete is never re-added.
    goals: unionById(remote.goals, local.goals, (g) => g.id).filter(
      (g) => !deleted.has(g.id),
    ),
    deletedGoalIds,
    reminders: unionById(remote.reminders, local.reminders, (r) => r.id).filter(
      (r) => !deletedRem.has(r.id),
    ),
    deletedReminderIds,
    // Per-field newest wins; local wins timestamp ties (it triggered the push).
    prefs: mergePrefs(remote.prefs, local.prefs),
  };
}
