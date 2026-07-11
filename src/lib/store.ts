import { create } from "zustand";
import { useEffect, useState } from "react";
import { db, getMeta, setMeta } from "./db";
import type { Account, Instrument, Transaction } from "./model";
import type { ParsedImport } from "./parsers";
import {
  computePortfolio,
  bondImportReminders,
  type PortfolioSummary,
  type PriceMap,
} from "./portfolio";
import {
  loadPriceFile,
  loadHistoryFile,
  fetchLiveFx,
  fetchLivePrices,
  fetchLiveHistory,
  type PriceFile,
  type HistoryFile,
} from "./prices";
import {
  loadSyncConfig,
  saveSyncConfig,
  loadAutoSync,
  saveAutoSync,
  getRemoteSnapshot,
  putRemoteSnapshot,
  type SyncConfig,
  type PortfolioSnapshot,
} from "./sync";
import {
  computeAlerts,
  bondImportAlerts,
  reminderAlerts,
  loadAlertConfig,
  saveIdleCashThreshold,
  saveTbszCheck,
  reconcileAlertState,
  REMINDER_ALERT_PREFIX,
  type Alert,
  type AlertState,
  type AlertConfig,
  type Reminder,
} from "./alerts";
import {
  collectPrefs,
  applyRemotePrefs,
  mergePrefs,
  PREFS_EVENT,
} from "./prefs";
import {
  loadSavingsGoals,
  savingsGoalAlerts,
  type SavingsGoal,
} from "./savings";
import {
  computeGoalProgress,
  goalAlerts,
  type Goal,
  type GoalProgress,
} from "./goals";

interface PortfolioState {
  loaded: boolean;
  accounts: Account[];
  instruments: Instrument[];
  transactions: Transaction[];
  /** instrument key -> current price (instrument ccy). */
  prices: PriceMap;
  /** currency -> HUF per 1 unit. */
  fx: Record<string, number>;
  /** Last loaded committed snapshot (for symbol/currency display). */
  priceFile: PriceFile | null;
  /** Daily price/FX history for the value chart (from public/history.json). */
  historyFile: HistoryFile | null;
  /** Live quotes (Worker→Yahoo): instrument key -> price (instrument ccy). */
  livePrices: Record<string, number>;
  /** ISO timestamp shown in the UI. */
  priceUpdatedAt?: string;
  pricesLoading: boolean;

  /** Alert history (seen / dismissed), synced. Keyed by stable alert id. */
  alertState: AlertState;
  /** Per-device alert config (idle-cash threshold). */
  alertConfig: AlertConfig;
  /** Fold the current active alerts into the synced history (persists if changed). */
  reconcileAlerts: (active: Alert[]) => void;
  dismissAlert: (alert: Alert) => Promise<void>;
  restoreAlert: (id: string) => Promise<void>;
  setIdleCashThreshold: (huf: number) => void;
  setTbszCheckEnabled: (enabled: boolean) => void;

  /** Fixed savings goals (DCA), synced. */
  goals: Goal[];
  /** Ids of deleted goals (tombstones) so a delete survives a sync merge. */
  deletedGoalIds: string[];
  addGoal: (goal: Omit<Goal, "id" | "createdAt">) => Promise<void>;
  updateGoal: (id: string, patch: Partial<Goal>) => Promise<void>;
  removeGoal: (id: string) => Promise<void>;

  /** User-created reminders (to-dos), synced. */
  reminders: Reminder[];
  /** Tombstones so a dismissed reminder never comes back from the cloud. */
  deletedReminderIds: string[];
  addReminder: (r: Omit<Reminder, "id" | "createdAt">) => Promise<void>;
  removeReminder: (id: string) => Promise<void>;

  /** Privacy mode: blur all Ft/EUR amounts and quantities (percentages stay). */
  privacy: boolean;
  togglePrivacy: () => void;

  load: () => Promise<void>;
  importParsed: (parsed: ParsedImport) => Promise<{
    added: number;
    skipped: number;
  }>;
  updateAccount: (id: string, patch: Partial<Account>) => Promise<void>;
  updateInstrument: (key: string, patch: Partial<Instrument>) => Promise<void>;
  setPrices: (prices: PriceMap, fx?: Record<string, number>) => void;
  refreshPrices: () => Promise<void>;
  /** Load committed + live daily history for the value chart (held ETFs). */
  refreshHistory: () => Promise<void>;
  clearAll: () => Promise<void>;

  // ---- Cross-device sync (private GitHub repo) ----
  syncConfig: SyncConfig | null;
  syncing: boolean;
  lastSyncedAt?: string;
  /** Auto-push to the cloud after imports and edits. */
  autoSync: boolean;
  /** Message from the last failed auto-push, if any. */
  syncError?: string;
  setSyncConfig: (config: SyncConfig | null) => void;
  setAutoSync: (enabled: boolean) => void;
  pushToCloud: () => Promise<void>;
  pullFromCloud: () => Promise<{ added: number }>;
  /** On startup: pull automatically if the cloud copy is newer than ours. */
  startupSync: () => Promise<void>;

  instrumentMap: () => Map<string, Instrument>;
  summary: () => PortfolioSummary;
}

const PRIVACY_KEY = "pf-privacy";
function loadPrivacy(): boolean {
  try {
    return localStorage.getItem(PRIVACY_KEY) === "1";
  } catch {
    return false;
  }
}
function savePrivacy(v: boolean) {
  try {
    localStorage.setItem(PRIVACY_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Derive a fallback EUR->HUF rate from the latest conversion legs. */
function deriveFx(txs: Transaction[]): Record<string, number> {
  const fx: Record<string, number> = {};
  const eurLegs = txs
    .filter(
      (t) =>
        t.type === "conversion" &&
        t.currency === "EUR" &&
        typeof t.fxRate === "number" &&
        t.fxRate > 1,
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  if (eurLegs[0]?.fxRate) fx["EUR"] = eurLegs[0].fxRate;
  return fx;
}

/**
 * Layer prices by freshness: committed snapshot < live quotes (later wins).
 * Live fills in fresh intraday values over the committed snapshot.
 */
function buildPriceMap(
  file: PriceFile | null,
  live: Record<string, number>,
): PriceMap {
  const map: PriceMap = new Map();
  if (file) {
    for (const [key, entry] of Object.entries(file.prices)) {
      if (typeof entry?.price === "number") map.set(key, entry.price);
    }
  }
  for (const [key, price] of Object.entries(live)) map.set(key, price);
  return map;
}

/**
 * Daily FX history: the committed series (ECB fixing) is canonical — the live
 * Yahoo series samples at a different time of day and disagrees with it by up
 * to ~0.5% per day, which permanently perturbs the TWR chain on conversion
 * days. Live data only extends the tail (days after the committed series ends).
 */
function mergeFxHistory(
  committed: Record<string, [string, number][]> | undefined,
  live: Record<string, [string, number][]>,
): Record<string, [string, number][]> {
  const out: Record<string, [string, number][]> = { ...(committed ?? {}) };
  for (const [ccy, series] of Object.entries(live)) {
    const base = out[ccy];
    if (!base?.length) {
      out[ccy] = series;
      continue;
    }
    const lastDay = base[base.length - 1][0];
    const tail = series.filter(([d]) => d > lastDay);
    if (tail.length) out[ccy] = [...base, ...tail];
  }
  return out;
}

function buildSnapshot(s: PortfolioState): PortfolioSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: s.accounts,
    instruments: s.instruments,
    // Strip the raw statement rows: nothing reads them, and they multiply the
    // snapshot size (the GitHub contents API stops returning files over 1 MB).
    transactions: s.transactions.map(({ raw: _raw, ...t }) => t),
    alertState: s.alertState,
    goals: s.goals,
    deletedGoalIds: s.deletedGoalIds,
    reminders: s.reminders,
    deletedReminderIds: s.deletedReminderIds,
    // Planning prefs (allocation targets, forecast settings) — read straight
    // from localStorage; the token and the AI key are separate keys, never here.
    prefs: collectPrefs(),
  };
}

function unionById<T>(
  base: T[] | undefined,
  over: T[] | undefined,
  keyOf: (x: T) => string,
): T[] {
  const m = new Map<string, T>();
  for (const x of base ?? []) m.set(keyOf(x), x);
  for (const x of over ?? []) m.set(keyOf(x), x);
  return [...m.values()];
}

/**
 * Union two snapshots, preferring LOCAL on per-item conflicts. Used when
 * pushing: we must never drop the OTHER device's data (goals, txs…), but this
 * device's own edits — the change that triggered the push — should win.
 */
function unionSnapshots(
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
  return {
    version: 1,
    exportedAt: local.exportedAt,
    accounts: unionById(remote.accounts, local.accounts, (a) => a.id),
    instruments: unionById(remote.instruments, local.instruments, (i) => i.key),
    transactions: unionById(
      remote.transactions,
      local.transactions,
      (t) => t.id,
    ),
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

/** Overwrite local state + IndexedDB with a (already merged) snapshot. */
async function applySnapshotLocal(
  set: (partial: Partial<PortfolioState>) => void,
  get: () => PortfolioState,
  snap: PortfolioSnapshot,
) {
  const deletedGoalIds = snap.deletedGoalIds ?? [];
  const deletedReminderIds = snap.deletedReminderIds ?? [];
  await Promise.all([
    db.accounts.bulkPut(snap.accounts),
    db.instruments.bulkPut(snap.instruments),
    db.transactions.bulkPut(snap.transactions),
    setMeta("alertState", snap.alertState ?? {}),
    setMeta("goals", snap.goals ?? []),
    setMeta("deletedGoalIds", deletedGoalIds),
    setMeta("reminders", snap.reminders ?? []),
    setMeta("deletedReminderIds", deletedReminderIds),
  ]);
  // Planning prefs: only a strictly newer remote copy overwrites localStorage.
  applyRemotePrefs(snap.prefs);
  const s = get();
  set({
    accounts: snap.accounts,
    instruments: snap.instruments,
    transactions: snap.transactions,
    alertState: snap.alertState ?? {},
    goals: snap.goals ?? [],
    deletedGoalIds,
    reminders: snap.reminders ?? [],
    deletedReminderIds,
    prices: buildPriceMap(s.priceFile, s.livePrices),
    fx: { ...deriveFx(snap.transactions), ...s.fx },
  });
}

/** Merge a remote snapshot into local state + IndexedDB. Returns # new txs. */
async function mergeSnapshot(
  set: (partial: Partial<PortfolioState>) => void,
  get: () => PortfolioState,
  snap: PortfolioSnapshot,
  sha?: string,
): Promise<number> {
  const s = get();

  const txById = new Map(s.transactions.map((t) => [t.id, t]));
  let added = 0;
  for (const t of snap.transactions ?? []) {
    if (!txById.has(t.id)) {
      txById.set(t.id, t);
      added++;
    }
  }
  const transactions = [...txById.values()];

  // Remote wins so instrument edits (e.g. bond series terms) propagate across
  // devices, mirroring the account-merge policy below.
  const instByKey = new Map(s.instruments.map((i) => [i.key, i]));
  for (const i of snap.instruments ?? []) instByKey.set(i.key, i);
  const instruments = [...instByKey.values()];

  // Accounts: remote wins so TBSZ labels / edits propagate across devices.
  const accById = new Map(s.accounts.map((a) => [a.id, a]));
  for (const a of snap.accounts ?? []) accById.set(a.id, a);
  const accounts = [...accById.values()];

  // Alert history: remote wins per-id (mirrors the account merge).
  const alertState = { ...s.alertState, ...(snap.alertState ?? {}) };
  // Goals: merge by id, remote wins — then drop anything a tombstone (from
  // either device) marks deleted, so a delete propagates instead of bouncing back.
  const deletedGoalIds = [
    ...new Set([...s.deletedGoalIds, ...(snap.deletedGoalIds ?? [])]),
  ];
  const deleted = new Set(deletedGoalIds);
  const goalById = new Map(s.goals.map((g) => [g.id, g]));
  for (const g of snap.goals ?? []) goalById.set(g.id, g);
  const goals = [...goalById.values()].filter((g) => !deleted.has(g.id));

  // Reminders: merge by id, remote wins, tombstones drop dismissed ones.
  const deletedReminderIds = [
    ...new Set([...s.deletedReminderIds, ...(snap.deletedReminderIds ?? [])]),
  ];
  const deletedRem = new Set(deletedReminderIds);
  const remById = new Map(s.reminders.map((r) => [r.id, r]));
  for (const r of snap.reminders ?? []) remById.set(r.id, r);
  const reminders = [...remById.values()].filter((r) => !deletedRem.has(r.id));

  // Planning prefs: only a strictly newer remote copy overwrites localStorage.
  applyRemotePrefs(snap.prefs);

  await Promise.all([
    db.accounts.bulkPut(accounts),
    db.instruments.bulkPut(instruments),
    db.transactions.bulkPut(transactions),
    setMeta("alertState", alertState),
    setMeta("goals", goals),
    setMeta("deletedGoalIds", deletedGoalIds),
    setMeta("reminders", reminders),
    setMeta("deletedReminderIds", deletedReminderIds),
    // Remember the remote version we now reflect, so startupSync can tell
    // whether a later cloud copy is genuinely different.
    ...(sha ? [setMeta("lastPulledSha", sha)] : []),
  ]);

  set({
    accounts,
    instruments,
    transactions,
    alertState,
    goals,
    deletedGoalIds,
    reminders,
    deletedReminderIds,
    prices: buildPriceMap(s.priceFile, s.livePrices),
    fx: { ...deriveFx(transactions), ...s.fx },
  });
  return added;
}

// True once a live FX fetch succeeded this session — see refreshPrices.
let liveFxThisSession = false;

// Debounced background auto-push: coalesces a burst of imports/edits into one
// upload a couple of seconds after the last change.
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoSync(
  set: (partial: Partial<PortfolioState>) => void,
  get: () => PortfolioState,
) {
  const s = get();
  if (!s.syncConfig || !s.autoSync) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null;
    const st = get();
    if (!st.syncConfig || !st.autoSync) return;
    if (st.syncing) {
      scheduleAutoSync(set, get); // a push is in flight — try again shortly
      return;
    }
    try {
      await st.pushToCloud();
    } catch (e) {
      set({ syncError: (e as Error).message });
    }
  }, 2500);
}

export const usePortfolio = create<PortfolioState>((set, get) => ({
  loaded: false,
  accounts: [],
  instruments: [],
  transactions: [],
  prices: new Map(),
  fx: {},
  priceFile: null,
  historyFile: null,
  livePrices: {},
  priceUpdatedAt: undefined,
  pricesLoading: false,
  alertState: {},
  alertConfig: loadAlertConfig(),
  goals: [],
  deletedGoalIds: [],
  reminders: [],
  deletedReminderIds: [],
  privacy: loadPrivacy(),
  togglePrivacy: () => {
    const v = !get().privacy;
    savePrivacy(v);
    set({ privacy: v });
  },
  syncConfig: loadSyncConfig(),
  syncing: false,
  lastSyncedAt: undefined,
  autoSync: loadAutoSync(),
  syncError: undefined,

  load: async () => {
    const [
      accounts,
      instruments,
      transactions,
      savedFx,
      alertState,
      goals,
      deletedGoalIds,
      reminders,
      deletedReminderIds,
    ] = await Promise.all([
      db.accounts.toArray(),
      db.instruments.toArray(),
      db.transactions.toArray(),
      getMeta<Record<string, number>>("fx"),
      getMeta<AlertState>("alertState"),
      getMeta<Goal[]>("goals"),
      getMeta<string[]>("deletedGoalIds"),
      getMeta<Reminder[]>("reminders"),
      getMeta<string[]>("deletedReminderIds"),
    ]);
    // Manual price overrides were removed — drop any value left from older
    // versions so it can never override the automatic price again.
    void db.meta.delete("manualPrices");
    const fx = { ...deriveFx(transactions), ...(savedFx ?? {}) };
    set({
      accounts,
      instruments,
      transactions,
      fx,
      alertState: alertState ?? {},
      goals: goals ?? [],
      deletedGoalIds: deletedGoalIds ?? [],
      reminders: reminders ?? [],
      deletedReminderIds: deletedReminderIds ?? [],
      loaded: true,
    });
    // Pull live prices in the background (non-blocking).
    void get().refreshPrices();
  },

  importParsed: async (parsed) => {
    const state = get();
    const existingTxIds = new Set(state.transactions.map((t) => t.id));

    const newTxs = parsed.transactions.filter((t) => !existingTxIds.has(t.id));
    const skipped = parsed.transactions.length - newTxs.length;

    // Merge accounts (keep user edits like TBSZ year already set).
    const accountById = new Map(state.accounts.map((a) => [a.id, a]));
    for (const a of parsed.accounts) {
      const existing = accountById.get(a.id);
      accountById.set(a.id, existing ? { ...a, ...existing } : a);
    }
    const accounts = [...accountById.values()];

    const instrumentByKey = new Map(state.instruments.map((i) => [i.key, i]));
    for (const i of parsed.instruments) {
      if (!instrumentByKey.has(i.key)) instrumentByKey.set(i.key, i);
    }
    const instruments = [...instrumentByKey.values()];

    const transactions = [...state.transactions, ...newTxs];
    const fx = { ...deriveFx(transactions), ...state.fx };

    await Promise.all([
      db.accounts.bulkPut(accounts),
      db.instruments.bulkPut(instruments),
      db.transactions.bulkPut(newTxs),
    ]);

    set({ accounts, instruments, transactions, fx });
    if (newTxs.length > 0) scheduleAutoSync(set, get);
    return { added: newTxs.length, skipped };
  },

  updateAccount: async (id, patch) => {
    const accounts = get().accounts.map((a) =>
      a.id === id ? { ...a, ...patch } : a,
    );
    const updated = accounts.find((a) => a.id === id);
    if (updated) await db.accounts.put(updated);
    set({ accounts });
    scheduleAutoSync(set, get);
  },

  updateInstrument: async (key, patch) => {
    const instruments = get().instruments.map((i) =>
      i.key === key ? { ...i, ...patch } : i,
    );
    const updated = instruments.find((i) => i.key === key);
    if (updated) await db.instruments.put(updated);
    set({ instruments });
    scheduleAutoSync(set, get);
  },

  setPrices: (prices, fx) => {
    set((s) => {
      const nextFx = fx ? { ...s.fx, ...fx } : s.fx;
      if (fx) void setMeta("fx", nextFx);
      return { prices, fx: nextFx };
    });
  },

  refreshPrices: async () => {
    set({ pricesLoading: true });
    // Price every held ETF / stock / fund. Symbols are resolved from the ISIN
    // (manual override > curated > Yahoo search), so a newly bought ETF gets a
    // live price automatically — no per-instrument wiring needed.
    const tickerTypes = new Set(["etf", "stock", "fund"]);
    const targets = get()
      .instruments.filter((i) => tickerTypes.has(i.type))
      .map((i) => ({
        key: i.key,
        isin: i.isin ?? i.key,
        currency: i.currency,
      }));
    // History is owned by refreshHistory (runs once on startup), so the 5-minute
    // price poll never clobbers the live-fetched chart series.
    const [file, liveFx, livePrices] = await Promise.all([
      loadPriceFile(),
      fetchLiveFx(),
      fetchLivePrices(targets),
    ]);
    set((s) => {
      const priceFile = file ?? s.priceFile;
      // Keep the last good live quote for any symbol that failed this round.
      const live = { ...s.livePrices, ...livePrices };
      const prices = buildPriceMap(priceFile, live);
      // Live FX wins. Until the first live success the committed prices.json
      // beats the saved/derived rates; afterwards the session's live rates are
      // fresher than the (hours-old) file, so a failed round must not let the
      // file roll them back.
      if (Object.keys(liveFx).length > 0) liveFxThisSession = true;
      const fileFx = priceFile?.fx ?? {};
      const fx = liveFxThisSession
        ? { ...fileFx, ...s.fx, ...liveFx }
        : { ...s.fx, ...fileFx, ...liveFx };
      void setMeta("fx", fx);
      const gotLive = Object.keys(livePrices).length > 0;
      return {
        priceFile,
        livePrices: live,
        prices,
        fx,
        // Live quote → "now"; otherwise fall back to the snapshot's timestamp.
        priceUpdatedAt: gotLive
          ? new Date().toISOString()
          : (priceFile?.updatedAt ?? s.priceUpdatedAt),
        pricesLoading: false,
      };
    });
  },

  refreshHistory: async () => {
    // Committed snapshot first (instant first paint), then live Yahoo history
    // for every held ETF/stock/fund — merged so a newly bought ETF gets a full
    // chart series the build-time script never knew about.
    const committed = (await loadHistoryFile()) ?? get().historyFile;
    if (committed) set({ historyFile: committed });

    const tickerTypes = new Set(["etf", "stock", "fund"]);
    const targets = get()
      .instruments.filter((i) => tickerTypes.has(i.type))
      .map((i) => ({
        key: i.key,
        isin: i.isin ?? i.key,
        currency: i.currency,
      }));
    if (targets.length === 0) return;

    const live = await fetchLiveHistory(targets);
    set({
      historyFile: {
        updatedAt: live.updatedAt ?? committed?.updatedAt,
        prices: { ...(committed?.prices ?? {}), ...live.prices },
        fx: mergeFxHistory(committed?.fx, live.fx),
      },
    });
  },

  reconcileAlerts: (active) => {
    const { state, changed } = reconcileAlertState(
      get().alertState,
      active,
      new Date().toISOString(),
    );
    if (!changed) return;
    void setMeta("alertState", state);
    set({ alertState: state });
    scheduleAutoSync(set, get);
  },

  dismissAlert: async (alert) => {
    // A reminder's dismiss means "done" → remove it (tombstoned, so it can't
    // come back from the cloud); its history record then reads as fulfilled.
    if (alert.id.startsWith(REMINDER_ALERT_PREFIX)) {
      await get().removeReminder(alert.id.slice(REMINDER_ALERT_PREFIX.length));
      return;
    }
    const now = new Date().toISOString();
    const prev = get().alertState;
    const rec = prev[alert.id];
    const alertState: AlertState = {
      ...prev,
      [alert.id]: {
        status: "dismissed",
        firstSeenAt: rec?.firstSeenAt ?? now,
        dismissedAt: now,
        title: rec?.title ?? alert.title,
        detail: rec?.detail ?? alert.detail,
        severity: rec?.severity ?? alert.severity,
      },
    };
    await setMeta("alertState", alertState);
    set({ alertState });
    scheduleAutoSync(set, get);
  },

  restoreAlert: async (id) => {
    const prev = get().alertState;
    const rec = prev[id];
    if (!rec) return;
    const alertState: AlertState = {
      ...prev,
      [id]: { ...rec, status: "seen", dismissedAt: undefined },
    };
    await setMeta("alertState", alertState);
    set({ alertState });
    scheduleAutoSync(set, get);
  },

  setIdleCashThreshold: (huf) => {
    saveIdleCashThreshold(huf);
    set((s) => ({ alertConfig: { ...s.alertConfig, idleCashHuf: huf } }));
  },

  setTbszCheckEnabled: (enabled) => {
    saveTbszCheck(enabled);
    set((s) => ({ alertConfig: { ...s.alertConfig, tbszCheck: enabled } }));
  },

  addGoal: async (goal) => {
    const newGoal: Goal = {
      ...goal,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const goals = [...get().goals, newGoal];
    await setMeta("goals", goals);
    set({ goals });
    scheduleAutoSync(set, get);
  },

  updateGoal: async (id, patch) => {
    const goals = get().goals.map((g) =>
      g.id === id ? { ...g, ...patch } : g,
    );
    await setMeta("goals", goals);
    set({ goals });
    scheduleAutoSync(set, get);
  },

  removeGoal: async (id) => {
    const goals = get().goals.filter((g) => g.id !== id);
    // Record a tombstone so the sync merge can't re-add it from the cloud copy.
    const deletedGoalIds = [...new Set([...get().deletedGoalIds, id])];
    await Promise.all([
      setMeta("goals", goals),
      setMeta("deletedGoalIds", deletedGoalIds),
    ]);
    set({ goals, deletedGoalIds });
    scheduleAutoSync(set, get);
  },

  addReminder: async (r) => {
    const reminder: Reminder = {
      ...r,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const reminders = [...get().reminders, reminder];
    await setMeta("reminders", reminders);
    set({ reminders });
    scheduleAutoSync(set, get);
  },

  removeReminder: async (id) => {
    const reminders = get().reminders.filter((r) => r.id !== id);
    // Tombstone so the sync merge can't re-add it from the cloud copy.
    const deletedReminderIds = [...new Set([...get().deletedReminderIds, id])];
    await Promise.all([
      setMeta("reminders", reminders),
      setMeta("deletedReminderIds", deletedReminderIds),
    ]);
    set({ reminders, deletedReminderIds });
    scheduleAutoSync(set, get);
  },

  setSyncConfig: (config) => {
    saveSyncConfig(config);
    set({ syncConfig: config });
  },

  setAutoSync: (enabled) => {
    saveAutoSync(enabled);
    set({ autoSync: enabled });
    if (enabled) scheduleAutoSync(set, get);
  },

  pushToCloud: async () => {
    const { syncConfig } = get();
    if (!syncConfig) throw new Error("Nincs beállítva szinkron.");
    set({ syncing: true });
    try {
      // Merge with whatever is on the remote FIRST, so a push never overwrites
      // another device's data (goals, txs…). Local wins on conflicts. A sha
      // conflict (another device pushed between our GET and PUT) is retried
      // with a fresh GET + merge instead of surfacing as an error.
      const pushed = await (async () => {
        for (let attempt = 0; ; attempt++) {
          const existing = await getRemoteSnapshot(syncConfig);
          const local = buildSnapshot(get());
          const snapshot = existing
            ? unionSnapshots(existing.snapshot, local)
            : local;
          try {
            const sha = await putRemoteSnapshot(
              syncConfig,
              snapshot,
              existing?.sha,
            );
            return { snapshot, sha, hadRemote: existing != null };
          } catch (e) {
            const conflict =
              e instanceof Error && /HTTP 409/.test(e.message) && attempt < 2;
            if (!conflict) throw e;
          }
        }
      })();
      // Reflect any remote-only items locally too — but union with the CURRENT
      // state first, so an edit made while the upload was in flight is kept
      // (it goes up with the next auto-push) instead of being reverted.
      if (pushed.hadRemote) {
        await applySnapshotLocal(
          set,
          get,
          unionSnapshots(pushed.snapshot, buildSnapshot(get())),
        );
      }
      // Local now reflects what we wrote to the cloud — record that version.
      await setMeta("lastPulledSha", pushed.sha);
      set({ lastSyncedAt: pushed.snapshot.exportedAt, syncError: undefined });
    } finally {
      set({ syncing: false });
    }
  },

  pullFromCloud: async () => {
    const { syncConfig } = get();
    if (!syncConfig) throw new Error("Nincs beállítva szinkron.");
    set({ syncing: true });
    try {
      const remote = await getRemoteSnapshot(syncConfig);
      if (!remote) return { added: 0 };
      const added = await mergeSnapshot(set, get, remote.snapshot, remote.sha);
      set({ lastSyncedAt: new Date().toISOString() });
      return { added };
    } finally {
      set({ syncing: false });
    }
  },

  startupSync: async () => {
    const { syncConfig } = get();
    if (!syncConfig) return; // not "logged in" to the cloud on this device
    try {
      const remote = await getRemoteSnapshot(syncConfig);
      if (!remote) return;
      const remoteAt = remote.snapshot.exportedAt;
      // Only merge when the cloud copy differs from the version we already
      // reflect. Content (sha) comparison, not timestamps — device clocks can
      // disagree, and exportedAt is the OTHER device's wall clock.
      const lastPulledSha = await getMeta<string>("lastPulledSha");
      if (lastPulledSha && remote.sha === lastPulledSha) {
        // Same cloud version we already reflect — but still (re)apply planning
        // prefs. An app update can ADD a synced pref kind (e.g. savings goals)
        // that an older build silently dropped when it pulled this very sha;
        // applyRemotePrefs is a no-op unless the remote copy is genuinely newer
        // than what's on this device, so this only fills in the missing kind.
        applyRemotePrefs(remote.snapshot.prefs);
        set({ lastSyncedAt: remoteAt });
        return;
      }
      set({ syncing: true });
      await mergeSnapshot(set, get, remote.snapshot, remote.sha);
      set({ lastSyncedAt: remoteAt ?? new Date().toISOString() });
    } catch (e) {
      // Offline / token issues must never block app startup.
      set({ syncError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ syncing: false });
    }
  },

  clearAll: async () => {
    await Promise.all([
      db.accounts.clear(),
      db.instruments.clear(),
      db.transactions.clear(),
      db.prices.clear(),
      db.meta.clear(),
    ]);
    set({
      accounts: [],
      instruments: [],
      transactions: [],
      prices: new Map(),
      fx: {},
      livePrices: {},
      alertState: {},
      goals: [],
      deletedGoalIds: [],
      reminders: [],
      deletedReminderIds: [],
      priceFile: null,
      priceUpdatedAt: undefined,
    });
  },

  instrumentMap: () => new Map(get().instruments.map((i) => [i.key, i])),

  summary: () => {
    const s = get();
    return computePortfolio(
      s.accounts,
      s.transactions,
      s.instrumentMap(),
      s.prices,
      s.fx,
    );
  },
}));

// A local edit to the synced planning prefs (allocation targets, forecast
// settings) happens outside the store — push it like any other data change.
// Remote applies fire the same event with source "remote"; those must NOT
// re-push (they came from the cloud), so only local edits schedule a sync.
if (typeof window !== "undefined") {
  window.addEventListener(PREFS_EVENT, (e) => {
    if ((e as CustomEvent<{ source?: string }>).detail?.source === "local") {
      scheduleAutoSync(usePortfolio.setState, usePortfolio.getState);
    }
  });
}

/**
 * Shared, identity-keyed memo: every component that calls usePortfolioSummary
 * gets the SAME computed object, and computePortfolio runs once per state
 * change instead of once per consuming component (~8× on the dashboard).
 * The store's slices are replaced immutably, so reference equality is a
 * correct staleness check. The stable reference also keeps Zustand happy
 * (no fresh object per render → no re-render loop).
 */
function sharedMemo<A extends readonly unknown[], R>(
  compute: (...deps: A) => R,
): (...deps: A) => R {
  let cache: { deps: A; value: R } | null = null;
  return (...deps: A) => {
    if (cache && cache.deps.every((d, i) => d === deps[i])) return cache.value;
    const value = compute(...deps);
    cache = { deps, value };
    return value;
  };
}

const cachedSummary = sharedMemo(
  (
    accounts: Account[],
    transactions: Transaction[],
    instruments: Instrument[],
    prices: Map<string, number>,
    fx: Record<string, number>,
  ) =>
    computePortfolio(
      accounts,
      transactions,
      new Map(instruments.map((i) => [i.key, i])),
      prices,
      fx,
    ),
);

/** Memoised portfolio summary for components (shared across all consumers). */
export function usePortfolioSummary(): PortfolioSummary {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  return cachedSummary(accounts, transactions, instruments, prices, fx);
}

const cachedGoalProgress = sharedMemo(computeGoalProgress);

/** Progress of each savings goal in its current period. */
export function useGoalProgress(): GoalProgress[] {
  const goals = usePortfolio((s) => s.goals);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);
  return cachedGoalProgress(goals, transactions, instruments, fx);
}

/**
 * Currently-active alerts: rule-based (idle cash, TBSZ, events), one per unmet
 * savings goal, plus coupon-import nudges.
 */
const cachedAlerts = sharedMemo(
  (
    summary: PortfolioSummary,
    config: Parameters<typeof computeAlerts>[1],
    transactions: Transaction[],
    goalProgress: GoalProgress[],
    reminders: Reminder[],
    savingsGoals: SavingsGoal[],
    accounts: Account[],
    instruments: Instrument[],
    prices: PriceMap,
    fx: Record<string, number>,
  ) => [
    ...computeAlerts(summary, config),
    ...goalAlerts(goalProgress),
    ...reminderAlerts(reminders),
    ...savingsGoalAlerts(
      savingsGoals,
      accounts,
      transactions,
      new Map(instruments.map((i) => [i.key, i])),
      prices,
      fx,
    ),
    ...bondImportAlerts(bondImportReminders(summary, transactions)),
  ],
);

/**
 * Savings goals live in localStorage (a synced pref), not the store — expose
 * them reactively so alerts recompute when a goal is added/edited (local) or
 * arrives from another device (remote). Both fire PREFS_EVENT.
 */
export function useSavingsGoals(): SavingsGoal[] {
  const [goals, setGoals] = useState<SavingsGoal[]>(loadSavingsGoals);
  useEffect(() => {
    const on = () => setGoals(loadSavingsGoals());
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, []);
  return goals;
}

export function useActiveAlerts(): Alert[] {
  const summary = usePortfolioSummary();
  const config = usePortfolio((s) => s.alertConfig);
  const transactions = usePortfolio((s) => s.transactions);
  const goalProgress = useGoalProgress();
  const reminders = usePortfolio((s) => s.reminders);
  const savingsGoals = useSavingsGoals();
  const accounts = usePortfolio((s) => s.accounts);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  return cachedAlerts(
    summary,
    config,
    transactions,
    goalProgress,
    reminders,
    savingsGoals,
    accounts,
    instruments,
    prices,
    fx,
  );
}
