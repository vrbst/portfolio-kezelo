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
  computeSavingsProgress,
  loadSavingsGoals,
  savingsGoalAlerts,
  type SavingsGoal,
  type SavingsProgress,
} from "./savings";
import {
  allocateIncome,
  ensureIncomeState,
  incomeEvents,
  loadIncomeState,
  pendingIncome,
  type IncomeAllocation,
} from "./incomeFlow";
import {
  computeGoalProgress,
  goalAlerts,
  type Goal,
  type GoalProgress,
} from "./goals";
import { monthlyBudgetHuf } from "./forecast";
import {
  budgetBreakdown,
  couponClaimingGoals,
  dcaMonthlyHuf,
  savingsMonthlyHuf,
  type BudgetBreakdown,
} from "./budget";
import { loadAllocationSettings } from "./allocation";
import {
  latestConfig,
  loadGlideVersions,
  migrateIfNeeded,
  type GlideConfig,
} from "./glidePath";
import {
  checkDays,
  glideAlerts,
  glideStateFrom,
  updateGlideSignals,
  type GlideSignals,
  positionsFromSummary,
  weightHistory,
  type AllocationState,
  type WeightPoint,
} from "./rebalance";
import { summariesOnDays, summaryOnDay, toLocalDay } from "./portfolio";
import type { Position, PositionsAt } from "./rebalance";
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
    glide: AllocationState | null,
    glideCfg: GlideConfig | undefined,
    glideSignals: GlideSignals,
  ) => [
    ...computeAlerts(summary, config, undefined, transactions),
    ...glideAlerts(glide, glideCfg, glideSignals),
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
  const glideVersions = useGlideVersions();
  const glide = useGlideState(glideVersions);
  const glideCfg = latestConfig(glideVersions);
  const glideSignals = useGlideSignals(glide, glideCfg);
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
    glide,
    glideCfg,
    glideSignals,
  );
}

const cachedSignalUpdate = sharedMemo(updateGlideSignals);

/**
 * The glide-path re-alert state advanced to the current weights (pure, in
 * render), persisted by an effect when it changed — so a deepening move shows
 * its alert at once, and the stored baseline follows.
 */
export function useGlideSignals(
  glide: AllocationState | null,
  cfg: GlideConfig | undefined,
): GlideSignals {
  const stored = usePortfolio((s) => s.glideSignals);
  const loaded = usePortfolio((s) => s.loaded);
  const setSignals = usePortfolio((s) => s.setGlideSignals);
  const next = cachedSignalUpdate(stored, glide, cfg);
  useEffect(() => {
    // Before the store has loaded, "no state" would wipe the saved baseline.
    if (loaded && glide && next.changed) setSignals(next.signals);
  }, [loaded, glide, next, setSignals]);
  return next.signals;
}

/**
 * Glide-path configuration versions (a synced pref in localStorage), reloaded
 * on every pref change — a local save or a sync pull. On first use it seeds
 * the glide path from the old per-asset-class target allocation (once, and
 * only while no version exists anywhere).
 */
export function useGlideVersions(): GlideConfig[] {
  const [versions, setVersions] = useState<GlideConfig[]>(loadGlideVersions);
  const loaded = usePortfolio((s) => s.loaded);
  const instruments = usePortfolio((s) => s.instruments);
  const summary = usePortfolioSummary();
  useEffect(() => {
    const on = () => setVersions(loadGlideVersions());
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, []);
  useEffect(() => {
    if (!loaded || instruments.length === 0) return;
    const cash = [
      ...new Set(summary.accounts.flatMap((a) => Object.keys(a.cash))),
    ];
    // Saving fires PREFS_EVENT, which reloads `versions` above.
    migrateIfNeeded(
      loadAllocationSettings,
      instruments,
      cash,
      toLocalDay(Date.now()),
    );
  }, [loaded, instruments, summary]);
  return versions;
}

const cachedGlideState = sharedMemo(glideStateFrom);

/** Today's bucket weights, targets, bands and statuses (null = no glide path). */
export function useGlideState(versions: GlideConfig[]): AllocationState | null {
  const summary = usePortfolioSummary();
  const fx = usePortfolio((s) => s.fx);
  const day = useToday();
  return cachedGlideState(versions, summary, fx, day);
}

const cachedWeightHistory = sharedMemo(
  (
    versions: GlideConfig[],
    accounts: Account[],
    transactions: Transaction[],
    instruments: Instrument[],
    fx: Record<string, number>,
    history: HistoryFile | null | undefined,
    summary: PortfolioSummary,
  ): WeightPoint[] => {
    if (!versions.length || !transactions.length) return [];
    const today = toLocalDay(Date.now());
    const first = transactions.reduce(
      (m, t) => (t.date < m ? t.date : m),
      transactions[0].date,
    );
    // Month starts across the whole ledger history, then today at live prices.
    const days = checkDays("monthly", first.slice(0, 10), today).filter(
      (d) => d < today,
    );
    const samples = new Map(
      summariesOnDays(
        accounts,
        transactions,
        new Map(instruments.map((i) => [i.key, i])),
        fx,
        history,
        days,
      ).map((s) => [s.day, s]),
    );
    return weightHistory(versions, [...days, today], (day, atFace) => {
      const s = samples.get(day);
      return s
        ? positionsFromSummary(s.summary, s.fx, atFace, day)
        : positionsFromSummary(summary, fx, atFace, day);
    });
  },
);

/** Monthly bucket-weight history with each day's path target and band. */
export function useGlideHistory(versions: GlideConfig[]): WeightPoint[] {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);
  const history = usePortfolio((s) => s.historyFile);
  const summary = usePortfolioSummary();
  return cachedWeightHistory(
    versions,
    accounts,
    transactions,
    instruments,
    fx,
    history,
    summary,
  );
}

/** Today as a local YYYY-MM-DD, fixed for the component's lifetime. */
export function useToday(): string {
  const [today] = useState(() => toLocalDay(Date.now()));
  return today;
}

const cachedPositionsAt = sharedMemo(
  (
    accounts: Account[],
    transactions: Transaction[],
    instruments: Instrument[],
    fx: Record<string, number>,
    history: HistoryFile | null | undefined,
    summary: PortfolioSummary,
    today: string,
  ): PositionsAt => {
    // Each past-day lookup marks a whole portfolio, and the editor re-resolves
    // snapshot starts on every keystroke — so memoise per (day, bonds at face).
    const cache = new Map<string, Position[]>();
    const instMap = new Map(instruments.map((i) => [i.key, i]));
    return (day, atFace) => {
      const key = `${day}|${atFace}`;
      let p = cache.get(key);
      if (!p) {
        if (day >= today) p = positionsFromSummary(summary, fx, atFace, today);
        else {
          const s = summaryOnDay(accounts, transactions, instMap, fx, history, day);
          p = positionsFromSummary(s.summary, s.fx, atFace, day);
        }
        cache.set(key, p);
      }
      return p;
    };
  },
);

/** Positions on any day (today = live prices), for snapshot starts / history. */
export function usePositionsAt(): PositionsAt {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);
  const history = usePortfolio((s) => s.historyFile);
  const summary = usePortfolioSummary();
  const today = useToday();
  return cachedPositionsAt(accounts, transactions, instruments, fx, history, summary, today);
}

/** Bumps on every pref change (local save or sync pull). */
function usePrefsVersion(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((v) => v + 1);
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, []);
  return n;
}

const cachedBudget = sharedMemo(
  (
    savingsGoals: SavingsGoal[],
    accounts: Account[],
    transactions: Transaction[],
    instruments: Instrument[],
    prices: PriceMap,
    fx: Record<string, number>,
    dcaGoals: Goal[],
    glide: GlideConfig | undefined,
    prefsVersion: number,
  ) => {
    void prefsVersion; // the budget override is a pref: recompute on change
    const savings = computeSavingsProgress(
      savingsGoals,
      accounts,
      transactions,
      new Map(instruments.map((i) => [i.key, i])),
      prices,
      fx,
    );
    return {
      breakdown: budgetBreakdown({
        budgetHuf: monthlyBudgetHuf(transactions, fx),
        dcaHuf: dcaMonthlyHuf(dcaGoals),
        savingsHuf: savingsMonthlyHuf(savings),
        glide,
      }),
      couponGoals: couponClaimingGoals(savings),
      savings,
    };
  },
);

/**
 * The monthly budget split between the goals (budget bar, Teendők). Uses the
 * newest glide-path version, like the Teendők panel.
 */
export function useMonthlyBudget(): {
  breakdown: BudgetBreakdown;
  couponGoals: string[];
  /** Medium-term goals' progress (shared with the incoming-money split). */
  savings: SavingsProgress[];
  glide: GlideConfig | undefined;
} {
  const savingsGoals = useSavingsGoals();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const dcaGoals = usePortfolio((s) => s.goals);
  const glide = latestConfig(useGlideVersions());
  const prefsVersion = usePrefsVersion();
  return {
    ...cachedBudget(
      savingsGoals,
      accounts,
      transactions,
      instruments,
      prices,
      fx,
      dcaGoals,
      glide,
      prefsVersion,
    ),
    glide,
  };
}

const cachedIncome = sharedMemo(
  (
    transactions: Transaction[],
    instruments: Instrument[],
    accounts: Account[],
    fx: Record<string, number>,
    savings: SavingsProgress[],
    glide: GlideConfig | undefined,
    state: AllocationState | null,
    prefsVersion: number,
  ) => {
    void prefsVersion; // the tracking state is a pref
    const st = loadIncomeState();
    const events = st
      ? incomeEvents(
          transactions,
          new Map(instruments.map((i) => [i.key, i])),
          accounts,
          fx,
          st.since,
        )
      : [];
    return {
      since: st?.since ?? null,
      allocations: allocateIncome(pendingIncome(events, st), savings, glide, state),
    };
  },
);

/**
 * Incoming money not yet distributed (coupons, interest, dividends,
 * redemptions), each split goal-first then along the glide path. Switches
 * the tracking on (with its look-back) the first time the store has loaded.
 */
export function useIncomeQueue(): {
  since: string | null;
  allocations: IncomeAllocation[];
} {
  const loaded = usePortfolio((s) => s.loaded);
  const today = useToday();
  useEffect(() => {
    if (loaded) ensureIncomeState(today);
  }, [loaded, today]);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const accounts = usePortfolio((s) => s.accounts);
  const fx = usePortfolio((s) => s.fx);
  const { savings, glide } = useMonthlyBudget();
  const versions = useGlideVersions();
  const state = useGlideState(versions);
  const prefsVersion = usePrefsVersion();
  return cachedIncome(
    transactions,
    instruments,
    accounts,
    fx,
    savings,
    glide,
    state,
    prefsVersion,
  );
}
