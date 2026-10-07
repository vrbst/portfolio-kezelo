import { describe, expect, it } from "vitest";
import type { PortfolioSnapshot } from "./sync";
import type { Account, Transaction } from "./model";
import { unionSnapshots } from "./syncMerge";
import { mergePrefs, type SyncedPrefs } from "./prefs";

const snap = (over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  version: 1,
  exportedAt: "2026-09-27T10:00:00.000Z",
  accounts: [],
  instruments: [],
  transactions: [],
  ...over,
});

const rec = {
  status: "seen" as const,
  firstSeenAt: "2026-09-01T00:00:00Z",
  title: "x",
  severity: "info" as const,
};

describe("unionSnapshots", () => {
  it("drops alert records of reminders that no longer exist", () => {
    // The cloud still holds the record of a removed reminder; the local copy
    // already pruned it. The union must not bring it back (endless push loop).
    const remote = snap({
      alertState: { "reminder:gone": rec, "reminder:live": rec, other: rec },
      reminders: [{ id: "live" } as never],
    });
    const local = snap({ alertState: { other: rec } });
    const out = unionSnapshots(remote, local);
    expect(Object.keys(out.alertState ?? {}).sort()).toEqual([
      "other",
      "reminder:live",
    ]);
  });

  it("keeps fields a newer app version added", () => {
    const remote = { ...snap(), futureField: [1, 2] } as PortfolioSnapshot;
    const out = unionSnapshots(remote, snap()) as unknown as Record<
      string,
      unknown
    >;
    expect(out.futureField).toEqual([1, 2]);
  });
});

describe("mergePrefs", () => {
  it("keeps pref kinds this build doesn't know", () => {
    const remote = {
      futureKind: { updatedAt: "2026-09-27T10:00:00Z", value: { a: 1 } },
    } as unknown as SyncedPrefs;
    const local: SyncedPrefs = {
      forecast: { updatedAt: "2026-09-27T09:00:00Z", value: {} as never },
    };
    const out = mergePrefs(remote, local) as Record<string, unknown>;
    expect(out.futureKind).toEqual(
      (remote as Record<string, unknown>).futureKind,
    );
    expect(out.forecast).toEqual(local.forecast);
  });
});

describe("alert tombstones", () => {
  it("a tombstoned record is dropped whichever side still holds it", () => {
    const remote = snap({ alertState: { bad: rec, good: rec } });
    const local = snap({ deletedAlertIds: ["bad"] });
    const out = unionSnapshots(remote, local);
    expect(Object.keys(out.alertState ?? {})).toEqual(["good"]);
    expect(out.deletedAlertIds).toEqual(["bad"]);
  });

  it("tombstones from both sides are kept", () => {
    const out = unionSnapshots(
      snap({ deletedAlertIds: ["a"] }),
      snap({ deletedAlertIds: ["b", "a"] }),
    );
    expect(out.deletedAlertIds?.sort()).toEqual(["a", "b"]);
  });
});

describe("unionSnapshots – a re-imported account", () => {
  // Device A deleted the account (tombstone), device B re-imported it
  // (restoredAt) and pushed. Device C still holds its OLD copy of the account
  // (no restoredAt) and has never seen either. When C syncs, its old copy must
  // not undo the re-import — or the account vanishes on every device.
  const old: Account = { id: "a", name: "A", provider: "lightyear", kind: "regular", currency: "HUF" };
  const restored: Account = { ...old, restoredAt: "2026-06-01T00:00:00Z" };
  const tx: Transaction = { id: "t", accountId: "a", date: "2026-01-01T10:00:00Z", type: "deposit", currency: "HUF", netAmount: 1 };
  const cloud = snap({ accounts: [restored], transactions: [tx], deletedAccounts: { a: "2026-03-01T00:00:00Z" } });
  const deviceC = snap({ accounts: [old], transactions: [tx] });

  it("keeps the account and its transactions, whichever side is local", () => {
    for (const out of [unionSnapshots(cloud, deviceC), unionSnapshots(deviceC, cloud)]) {
      expect(out.accounts.map((a) => [a.id, a.restoredAt])).toEqual([["a", "2026-06-01T00:00:00Z"]]);
      expect(out.transactions.map((t) => t.id)).toEqual(["t"]);
    }
  });
});

describe("newsSeen pref", () => {
  it("read marks of two devices are unioned, not overwritten", () => {
    const remote = { newsSeen: { updatedAt: "2026-10-07T10:00:00Z", value: ["a", "b"] } } as unknown as SyncedPrefs;
    const local = { newsSeen: { updatedAt: "2026-10-07T09:00:00Z", value: ["c"] } } as unknown as SyncedPrefs;
    const out = mergePrefs(remote, local) as { newsSeen: { value: string[] } };
    expect(out.newsSeen.value.sort()).toEqual(["a", "b", "c"]);
  });
});
