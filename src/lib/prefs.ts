// Syncable planning preferences: target allocation + forecast settings.
// Each field carries an updatedAt stamp and merges last-write-wins across
// devices. Secrets (sync token, AI key) live under separate localStorage keys
// and are NEVER part of this.

import { loadAllocationSettings, type AllocationSettings } from "./allocation";
import { loadForecastSettings, type ForecastSettings } from "./forecast";
import { loadSavingsGoals, type SavingsGoal } from "./savings";

export interface StampedPref<T> {
  /** ISO timestamp of the last local edit — newer wins in a sync merge. */
  updatedAt: string;
  value: T;
}

export interface SyncedPrefs {
  /** null value = the user deleted the targets (the delete must sync too). */
  allocation?: StampedPref<AllocationSettings | null>;
  forecast?: StampedPref<ForecastSettings>;
  savings?: StampedPref<SavingsGoal[]>;
}

export type PrefKind = "allocation" | "forecast" | "savings";

const KINDS: PrefKind[] = ["allocation", "forecast", "savings"];

const VALUE_KEY: Record<PrefKind, string> = {
  allocation: "pf-allocation",
  forecast: "pf-forecast",
  savings: "pf-savings",
};
const STAMP_KEY: Record<PrefKind, string> = {
  allocation: "pf-allocation-updated",
  forecast: "pf-forecast-updated",
  savings: "pf-savings-updated",
};

// Loaders read the current local value for the snapshot (no cross-module cycle
// at eval time — these run only inside collectPrefs).
const LOADERS: Record<PrefKind, () => unknown> = {
  allocation: loadAllocationSettings,
  forecast: loadForecastSettings,
  savings: loadSavingsGoals,
};

/** Fired on every pref change; detail.source tells a local edit from a sync pull. */
export const PREFS_EVENT = "pf-prefs-changed";

export type PrefsEventSource = "local" | "remote";

function emit(source: PrefsEventSource) {
  try {
    window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { source } }));
  } catch {
    /* non-browser environment */
  }
}

/** Called by the save functions after a real local change. */
export function touchPref(kind: PrefKind) {
  try {
    localStorage.setItem(STAMP_KEY[kind], new Date().toISOString());
  } catch {
    /* ignore */
  }
  emit("local");
}

function stampOf(kind: PrefKind): string | null {
  try {
    return localStorage.getItem(STAMP_KEY[kind]);
  } catch {
    return null;
  }
}

/** The current local prefs for the sync snapshot (undefined = nothing set). */
export function collectPrefs(): SyncedPrefs | undefined {
  const out: SyncedPrefs = {};
  for (const kind of KINDS) {
    let at = stampOf(kind);
    try {
      // Pre-existing data from before prefs were synced: value without a
      // stamp — stamp it once so it takes part in the merge from now on.
      if (!at && localStorage.getItem(VALUE_KEY[kind]) != null) {
        at = new Date().toISOString();
        localStorage.setItem(STAMP_KEY[kind], at);
      }
    } catch {
      /* ignore */
    }
    if (!at) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as Record<string, StampedPref<unknown>>)[kind] = {
      updatedAt: at,
      value: LOADERS[kind](),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function newer<T>(
  a: StampedPref<T> | undefined,
  b: StampedPref<T> | undefined,
): StampedPref<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  // Tie → b: callers pass the side that should win draws as `over`.
  return a.updatedAt > b.updatedAt ? a : b;
}

/** Per-field last-write-wins merge; `over` wins timestamp ties. */
export function mergePrefs(
  base: SyncedPrefs | undefined,
  over: SyncedPrefs | undefined,
): SyncedPrefs | undefined {
  if (!base) return over;
  if (!over) return base;
  const out = {} as Record<string, StampedPref<unknown>>;
  const b = base as Record<string, StampedPref<unknown>>;
  const o = over as Record<string, StampedPref<unknown>>;
  for (const kind of KINDS) {
    const merged = newer(b[kind], o[kind]);
    if (merged) out[kind] = merged;
  }
  return Object.keys(out).length ? (out as SyncedPrefs) : undefined;
}

/**
 * Write remote prefs that are strictly newer than the local copy into
 * localStorage. Fires PREFS_EVENT (source: "remote") when anything changed,
 * so open pages reload their settings state.
 */
export function applyRemotePrefs(remote: SyncedPrefs | undefined): boolean {
  if (!remote) return false;
  const r = remote as Record<string, StampedPref<unknown>>;
  let changed = false;
  for (const kind of KINDS) {
    const pref = r[kind];
    if (!pref || typeof pref.updatedAt !== "string") continue;
    const local = stampOf(kind);
    if (local && local >= pref.updatedAt) continue;
    try {
      if (pref.value == null) localStorage.removeItem(VALUE_KEY[kind]);
      else localStorage.setItem(VALUE_KEY[kind], JSON.stringify(pref.value));
      localStorage.setItem(STAMP_KEY[kind], pref.updatedAt);
      changed = true;
    } catch {
      /* ignore */
    }
  }
  if (changed) emit("remote");
  return changed;
}
