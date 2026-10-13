import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSyncedPrefs, syncedPrefKeys } from "./prefs";

// "Delete all data" must take the synced planning prefs with it (they hold
// goal names and amounts) but leave settings that aren't data.

let store: Map<string, string>;
let events: string[];

beforeEach(() => {
  store = new Map();
  events = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", {
    dispatchEvent: (e: CustomEvent<{ source: string }>) => events.push(e.detail.source),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clearSyncedPrefs", () => {
  it("covers the pref kinds, value and stamp each", () => {
    const keys = syncedPrefKeys();
    for (const k of ["pf-savings", "pf-savings-updated", "pf-glidepath", "pf-glidepath-updated", "pf-allocation", "pf-forecast", "pf-income", "portfolio.symbolOverrides"])
      expect(keys).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("removes every synced pref and nothing else", () => {
    for (const k of syncedPrefKeys()) store.set(k, "x");
    const keep = ["pf-skin", "pf-privacy", "pf-privacy-lock", "pf-ai-key", "portfolio.installDismissed"];
    for (const k of keep) store.set(k, "x");
    clearSyncedPrefs();
    for (const k of syncedPrefKeys()) expect(store.has(k), k).toBe(false);
    for (const k of keep) expect(store.get(k), k).toBe("x");
  });

  it("tells open views as a remote change (so nothing is auto-pushed)", () => {
    clearSyncedPrefs();
    expect(events).toEqual(["remote"]);
  });

  it("an unreadable storage doesn't throw", () => {
    vi.stubGlobal("localStorage", {
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => clearSyncedPrefs()).not.toThrow();
  });
});
