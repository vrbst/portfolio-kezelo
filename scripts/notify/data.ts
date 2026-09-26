// Builds the same picture the app shows — from the synced snapshot in the
// private repo, the committed price files and live Yahoo quotes — by running
// the app's own pure lib functions in Node.

import type { Instrument, Transaction } from "../../src/lib/model";
import type { PortfolioSnapshot } from "../../src/lib/sync";
import {
  computePortfolio,
  bondImportReminders,
  buildValueSeries,
  computeDayChange,
  type DayChange,
  type PortfolioSummary,
  type PriceMap,
  type ValuePoint,
} from "../../src/lib/portfolio";
import {
  fetchLiveFx,
  fetchLivePrices,
  type HistoryFile,
  type LiveQuote,
  type PriceFile,
} from "../../src/lib/prices";
import {
  computeAlerts,
  bondImportAlerts,
  reminderAlerts,
  DEFAULT_ALERT_CONFIG,
  type Alert,
  type AlertState,
} from "../../src/lib/alerts";
import { upcomingEvents, type UpcomingEvent } from "../../src/lib/events";
import {
  computeGoalProgress,
  goalAlerts,
  type GoalProgress,
} from "../../src/lib/goals";
import {
  loadSavingsGoals,
  savingsGoalAlerts,
  computeSavingsProgress,
  type SavingsProgress,
} from "../../src/lib/savings";
import { applyRemotePrefs } from "../../src/lib/prefs";
import { latestConfig, loadGlideVersions } from "../../src/lib/glidePath";
import {
  glideAlerts,
  glideStateFrom,
  type AllocationState,
} from "../../src/lib/rebalance";
import { toLocalDay } from "../../src/lib/portfolio";
import { githubToken, installLocalStorage, type NotifyEnv } from "./env";

export interface Context {
  at: Date;
  snapshot: PortfolioSnapshot;
  instruments: Instrument[];
  transactions: Transaction[];
  instMap: Map<string, Instrument>;
  prices: PriceMap;
  fx: Record<string, number>;
  priceFile: PriceFile | null;
  history: HistoryFile | null;
  liveQuotes: Record<string, LiveQuote>;
  summary: PortfolioSummary;
  series: ValuePoint[];
  dayChange: DayChange | null;
  /** Active alerts, the ones dismissed in the app left out. */
  alerts: Alert[];
  events: UpcomingEvent[];
  goalProgress: GoalProgress[];
  savings: SavingsProgress[];
  /** Glide path today (null = not set up), from the synced prefs. */
  glide: AllocationState | null;
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} – ${url}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

async function loadSnapshot(env: NotifyEnv): Promise<PortfolioSnapshot> {
  return fetchJson<PortfolioSnapshot>(
    `https://api.github.com/repos/${env.syncRepo}/contents/${env.syncPath}`,
    {
      Authorization: `Bearer ${githubToken()}`,
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "portfolio-notify",
    },
  );
}

const optional = <T>(p: Promise<T>) => p.catch(() => null);

/** Live quotes are best-effort: a Yahoo hiccup must not break a report. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T) {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

/** Accounts deleted on any device (tombstone newer than a re-import). */
function dropDeleted(snap: PortfolioSnapshot) {
  const tomb = snap.deletedAccounts ?? {};
  const removed = new Set(
    snap.accounts
      .filter((a) => {
        const at = tomb[a.id];
        return !!at && !(a.restoredAt && a.restoredAt > at);
      })
      .map((a) => a.id),
  );
  return {
    accounts: snap.accounts.filter((a) => !removed.has(a.id)),
    transactions: snap.transactions.filter((t) => !removed.has(t.accountId)),
  };
}

export async function loadContext(env: NotifyEnv): Promise<Context> {
  const raw = `https://raw.githubusercontent.com/${env.pricesRepo}/main/public`;
  const [snapshot, priceFile, history] = await Promise.all([
    loadSnapshot(env),
    optional(fetchJson<PriceFile>(`${raw}/prices.json`)),
    optional(fetchJson<HistoryFile>(`${raw}/history.json`)),
  ]);

  // Planning prefs (savings goals, forecast settings…) → the lib's storage.
  installLocalStorage();
  applyRemotePrefs(snapshot.prefs);

  const { accounts, transactions } = dropDeleted(snapshot);
  const instruments = snapshot.instruments;
  const instMap = new Map(instruments.map((i) => [i.key, i]));

  const tickerTypes = new Set(["etf", "stock", "fund"]);
  const targets = instruments
    .filter((i) => tickerTypes.has(i.type))
    .map((i) => ({ key: i.key, isin: i.isin ?? i.key, currency: i.currency }));
  const [fxQuotes, priceQuotes] = await Promise.all([
    withTimeout(fetchLiveFx(), 20_000, {} as Record<string, LiveQuote>),
    withTimeout(fetchLivePrices(targets), 30_000, {} as Record<string, LiveQuote>),
  ]);
  const liveQuotes = { ...fxQuotes, ...priceQuotes };

  const prices: PriceMap = new Map();
  for (const [k, e] of Object.entries(priceFile?.prices ?? {}))
    if (typeof e?.price === "number") prices.set(k, e.price);
  for (const [k, q] of Object.entries(priceQuotes)) prices.set(k, q.price);
  const fx: Record<string, number> = { ...(priceFile?.fx ?? {}) };
  for (const [k, q] of Object.entries(fxQuotes)) fx[k] = q.price;

  const at = new Date();
  const summary = computePortfolio(accounts, transactions, instMap, prices, fx);
  const series = buildValueSeries(
    accounts,
    transactions,
    instMap,
    prices,
    fx,
    history,
  );
  const dayChange = computeDayChange(
    series,
    accounts,
    transactions,
    instruments,
    fx,
    history,
    liveQuotes,
  );

  const goals = snapshot.goals ?? [];
  const goalProgress = computeGoalProgress(goals, transactions, instruments, fx);
  const savingsGoals = loadSavingsGoals();
  const alertState: AlertState = snapshot.alertState ?? {};
  const deletedReminders = new Set(snapshot.deletedReminderIds ?? []);
  const glideVersions = loadGlideVersions();
  const glide = glideStateFrom(
    glideVersions,
    summary,
    fx,
    toLocalDay(at.getTime()),
  );
  const alerts = [
    ...glideAlerts(glide, latestConfig(glideVersions)?.checkFrequency ?? "monthly"),
    ...computeAlerts(
      summary,
      { ...DEFAULT_ALERT_CONFIG, idleCashHuf: env.idleCashHuf },
      undefined,
      transactions,
    ),
    ...goalAlerts(goalProgress),
    ...reminderAlerts(
      (snapshot.reminders ?? []).filter((r) => !deletedReminders.has(r.id)),
    ),
    ...savingsGoalAlerts(
      savingsGoals,
      accounts,
      transactions,
      instMap,
      prices,
      fx,
    ),
    ...bondImportAlerts(bondImportReminders(summary, transactions)),
  ].filter((a) => alertState[a.id]?.status !== "dismissed");

  return {
    at,
    snapshot,
    instruments,
    transactions,
    instMap,
    prices,
    fx,
    priceFile,
    history,
    liveQuotes,
    summary,
    series,
    dayChange,
    alerts,
    events: upcomingEvents(summary, at, transactions),
    goalProgress,
    glide,
    savings: computeSavingsProgress(
      savingsGoals,
      accounts,
      transactions,
      instMap,
      prices,
      fx,
    ),
  };
}
