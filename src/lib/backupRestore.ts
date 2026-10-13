// Reading a backup file back in (the counterpart of backup.ts). Kept free of
// the store so the store can use it without an import cycle.

import type { BackupFile } from "./backup";
import { validateSnapshot, type PortfolioSnapshot } from "./sync";

/**
 * Read a backup file's text. Throws a readable (Hungarian) error for anything
 * that isn't a usable portfolio backup, before any of it touches the app.
 */
export function parseBackup(text: string): BackupFile {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw new Error("A fájl nem érvényes JSON.");
  }
  const kind = (x as { kind?: unknown } | null)?.kind;
  if (kind !== "portfolio-backup")
    throw new Error("Ez nem portfólió-mentés (a „Teljes mentés fájlba” gombbal készült JSON kell).");
  // Same shape / version checks as the cloud snapshot, worded for a file.
  validateSnapshot(x, "mentés-fájl");
  return x as BackupFile;
}

/** The backup as a sync snapshot — the form the merge into local state takes. */
export function backupToSnapshot(b: BackupFile): PortfolioSnapshot {
  return {
    version: 1,
    exportedAt: b.exportedAt,
    accounts: b.accounts,
    instruments: b.instruments,
    transactions: b.transactions,
    alertState: b.alertState,
    goals: b.goals,
    deletedGoalIds: b.deletedGoalIds,
    deletedAccounts: b.deletedAccounts,
    reminders: b.reminders,
    deletedReminderIds: b.deletedReminderIds,
    deletedAlertIds: b.deletedAlertIds,
    prefs: b.prefs,
  };
}
