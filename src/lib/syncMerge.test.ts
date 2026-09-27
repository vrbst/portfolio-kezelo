import { describe, expect, it } from "vitest";
import type { PortfolioSnapshot } from "./sync";
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
