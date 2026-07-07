// Full local backup to a downloadable JSON file. Unlike the sync snapshot,
// this keeps the raw statement rows too (full fidelity). Secrets (sync token,
// AI key) are NEVER part of the backup — only data and planning preferences.

import { usePortfolio } from "./store";
import { collectPrefs, type SyncedPrefs } from "./prefs";
import type { Account, Instrument, Transaction } from "./model";
import type { AlertState, Reminder } from "./alerts";
import type { Goal } from "./goals";

export interface BackupFile {
  kind: "portfolio-backup";
  version: 1;
  exportedAt: string;
  accounts: Account[];
  instruments: Instrument[];
  /** Full transactions, including the raw statement rows. */
  transactions: Transaction[];
  alertState: AlertState;
  goals: Goal[];
  deletedGoalIds: string[];
  reminders: Reminder[];
  deletedReminderIds: string[];
  /** Planning preferences (target allocation, forecast settings). */
  prefs?: SyncedPrefs;
  /** Last known FX rates (HUF per unit) — convenience, re-fetched anyway. */
  fx: Record<string, number>;
}

export function buildBackup(): BackupFile {
  const s = usePortfolio.getState();
  return {
    kind: "portfolio-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: s.accounts,
    instruments: s.instruments,
    transactions: s.transactions,
    alertState: s.alertState,
    goals: s.goals,
    deletedGoalIds: s.deletedGoalIds,
    reminders: s.reminders,
    deletedReminderIds: s.deletedReminderIds,
    prefs: collectPrefs(),
    fx: s.fx,
  };
}

/** Serialize the full state and hand it to the browser as a download. */
export function downloadBackup() {
  const backup = buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `portfolio-mentes-${backup.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
