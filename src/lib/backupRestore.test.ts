import { describe, expect, it } from "vitest";
import { backupToSnapshot, parseBackup } from "./backupRestore";
import type { BackupFile } from "./backup";
import { fixtureSnapshot } from "../test/fixture";

// What the "Teljes mentés" button writes, built from the invented portfolio.
function backup(): BackupFile {
  const s = fixtureSnapshot();
  return {
    kind: "portfolio-backup",
    version: 1,
    exportedAt: "2026-10-13T09:00:00.000Z",
    accounts: s.accounts,
    instruments: s.instruments,
    // The backup keeps the raw statement rows the sync snapshot strips.
    transactions: s.transactions.map((t, i) => (i === 0 ? { ...t, raw: { sor: "eredeti" } } : t)),
    alertState: s.alertState ?? {},
    goals: s.goals ?? [],
    deletedGoalIds: ["g-torolt"],
    deletedAccounts: { "regi-szamla": "2026-09-01T10:00:00.000Z" },
    reminders: s.reminders ?? [],
    deletedReminderIds: [],
    deletedAlertIds: [],
    prefs: s.prefs,
    fx: { EUR: 400 },
  };
}

describe("parseBackup", () => {
  it("accepts a backup file and returns it as is", () => {
    const b = backup();
    const parsed = parseBackup(JSON.stringify(b));
    expect(parsed.transactions).toHaveLength(b.transactions.length);
    expect(parsed.transactions[0].raw).toEqual({ sor: "eredeti" });
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseBackup("<html>")).toThrow(/nem érvényes JSON/);
  });

  it("refuses JSON that is not a portfolio backup (e.g. a sync snapshot)", () => {
    expect(() => parseBackup(JSON.stringify(fixtureSnapshot()))).toThrow(/nem portfólió-mentés/);
    expect(() => parseBackup("null")).toThrow(/nem portfólió-mentés/);
    expect(() => parseBackup('"x"')).toThrow(/nem portfólió-mentés/);
  });

  it("refuses a backup from a newer app version", () => {
    expect(() => parseBackup(JSON.stringify({ ...backup(), version: 2 }))).toThrow(/mentés-fájl újabb app-verzióval/);
  });

  it("refuses a damaged one, naming the file (not the cloud)", () => {
    const noLists = { kind: "portfolio-backup", version: 1 };
    expect(() => parseBackup(JSON.stringify(noLists))).toThrow(/Sérült mentés-fájl: hiányzó listák/);
    const badTx = { ...backup(), transactions: [{ id: 1 }] };
    expect(() => parseBackup(JSON.stringify(badTx))).toThrow(/Sérült mentés-fájl: hibás tranzakció/);
  });
});

describe("backupToSnapshot", () => {
  it("carries everything the merge reads, raw rows included, and nothing else", () => {
    const b = backup();
    const snap = backupToSnapshot(b);
    expect(snap).toMatchObject({
      version: 1,
      exportedAt: b.exportedAt,
      deletedGoalIds: ["g-torolt"],
      deletedAccounts: b.deletedAccounts,
    });
    expect(snap.accounts).toBe(b.accounts);
    expect(snap.transactions[0].raw).toEqual({ sor: "eredeti" });
    expect(snap.prefs).toBe(b.prefs);
    expect(snap).not.toHaveProperty("kind");
    expect(snap).not.toHaveProperty("fx");
  });
});
