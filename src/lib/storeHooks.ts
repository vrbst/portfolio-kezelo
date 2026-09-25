// Memoised selector hooks over the portfolio store (shared across all
// consumers). Grew out of store.ts, which re-exports everything here.

import { useEffect, useState } from "react";
import type { Account, Instrument, Transaction } from "./model";
import {
  computePortfolio,
  bondImportReminders,
  buildValueSeries,
  computeDayChange,
  type DayChange,
  type PortfolioSummary,
  type PriceMap,
  type ValuePoint,
} from "./portfolio";
import { type HistoryFile } from "./prices";
import {
  computeAlerts,
  bondImportAlerts,
  reminderAlerts,
  type Alert,
  type Reminder,
} from "./alerts";
import { PREFS_EVENT } from "./prefs";
import {
  loadSavingsGoals,
  savingsGoalAlerts,
  type SavingsGoal,
} from "./savings";
import { computeGoalProgress, goalAlerts, type GoalProgress } from "./goals";
import { usePortfolio } from "./store";

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

const cachedValueSeries = sharedMemo(
  (
    accounts: Account[],
    transactions: Transaction[],
    instruments: Instrument[],
    prices: PriceMap,
    fx: Record<string, number>,
    history: HistoryFile | null | undefined,
  ) =>
    buildValueSeries(
      accounts,
      transactions,
      new Map(instruments.map((i) => [i.key, i])),
      prices,
      fx,
      history,
    ),
);

/** Shared daily value/invested series (dashboard chart, sparklines, day delta).
 * Memoised across consumers so the sidebar and dashboard compute it once. */
export function useValueSeries(): ValuePoint[] {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const history = usePortfolio((s) => s.historyFile);
  return cachedValueSeries(
    accounts,
    transactions,
    instruments,
    prices,
    fx,
    history,
  );
}

export type { DayChange } from "./series";

/** Memoised {@link computeDayChange} (the dashboard's "ma" delta). */
const cachedDayChange = sharedMemo(computeDayChange);

export function useDayChange(): DayChange | null {
  const series = useValueSeries();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);
  const history = usePortfolio((s) => s.historyFile);
  const liveQuotes = usePortfolio((s) => s.liveQuotes);
  return cachedDayChange(
    series,
    accounts,
    transactions,
    instruments,
    fx,
    history,
    liveQuotes,
  );
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
    ...computeAlerts(summary, config, undefined, transactions),
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
