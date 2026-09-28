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
  reservedCashByAccount,
  reserveConflictAlerts,
  reserveConflicts,
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
import {
  loadAccountLimits,
  loadBrokerFees,
  loadPlanOrder,
  loadPurchaseAccounts,
  type BrokerFees,
  type PlanOrder,
} from "./planPrefs";
import {
  accountContext,
  missingVenueAlerts,
  type AccountContext,
  type AccountLimits,
  type PurchaseAccounts,
} from "./accountRules";
import {
  buildMonthlyPlan,
  computePlanNeeds,
  defaultPlanAmount,
  type MonthlyPlan,
  type PlanNeed,
} from "./monthlyPlan";

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
    purchase: PurchaseAccounts,
    day: string,
    accountCtx: AccountContext,
    reserved: Map<string, number>,
  ) => [
    ...computeAlerts(summary, config, undefined, transactions, reserved),
    ...missingVenueAlerts(
      purchase,
      accounts,
      day,
      (k) => instruments.find((i) => i.key === k)?.name ?? k,
    ),
    ...glideAlerts(glide, glideCfg, glideSignals, accountCtx),
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
    // A buy that may have been paid from a goal's set-aside cash.
    ...reserveConflictAlerts(
      reserveConflicts(savingsGoals, transactions, new Map(instruments.map((i) => [i.key, i])), fx),
    ),
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

/**
 * Whether alerts can be trusted yet: "syncing" until this device reflects the
 * cloud copy (stale local data would raise — and record — alerts the other
 * device's settings don't warrant), "offline" when the startup pull failed
 * (shown, marked, but never recorded), "ready" otherwise.
 */
export type AlertsReadiness = "ready" | "syncing" | "offline";

export function useAlertsReadiness(): AlertsReadiness {
  const loaded = usePortfolio((s) => s.loaded);
  const cloudChecked = usePortfolio((s) => s.cloudChecked);
  const syncError = usePortfolio((s) => s.syncError);
  if (!loaded) return "syncing";
  if (cloudChecked) return "ready";
  return syncError ? "offline" : "syncing";
}

const NO_ALERTS: Alert[] = [];

export function useActiveAlerts(): Alert[] {
  const readiness = useAlertsReadiness();
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
  const purchase = usePurchaseAccounts();
  const day = useToday();
  const accountCtx = useAccountContext();
  const reserved = useReservedCash();
  if (readiness === "syncing") return NO_ALERTS;
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
    purchase,
    day,
    accountCtx,
    reserved,
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
  const cloudChecked = usePortfolio((s) => s.cloudChecked);
  const setSignals = usePortfolio((s) => s.setGlideSignals);
  const next = cachedSignalUpdate(stored, glide, cfg);
  useEffect(() => {
    // Before the store has loaded, "no state" would wipe the saved baseline;
    // before the cloud pull, stale weights would move it.
    if (loaded && cloudChecked && glide && next.changed) setSignals(next.signals);
  }, [loaded, cloudChecked, glide, next, setSignals]);
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
  const cloudChecked = usePortfolio((s) => s.cloudChecked);
  const instruments = usePortfolio((s) => s.instruments);
  const summary = usePortfolioSummary();
  useEffect(() => {
    const on = () => setVersions(loadGlideVersions());
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, []);
  useEffect(() => {
    // Not before the cloud copy is in: a device that hasn't pulled the real
    // glide path yet would seed a newer default version that overrides it.
    if (!loaded || !cloudChecked || instruments.length === 0) return;
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
  }, [loaded, cloudChecked, instruments, summary]);
  return versions;
}

const cachedGlideState = sharedMemo(glideStateFrom);

/** Today's bucket weights, targets, bands and statuses (null = no glide path). */
export function useGlideState(versions: GlideConfig[]): AllocationState | null {
  const summary = usePortfolioSummary();
  const fx = usePortfolio((s) => s.fx);
  const day = useToday();
  const fees = useBrokerFees();
  const reserved = useReservedCash();
  return cachedGlideState(versions, summary, fx, day, fees, reserved);
}

const cachedReserved = sharedMemo(reservedCashByAccount);

/** Cash set aside for savings goals, per account (not free cash) — today. */
export function useReservedCash(): Map<string, number> {
  return cachedReserved(useSavingsGoals(), useToday());
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
    accountCtx: AccountContext,
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
      allocations: allocateIncome(pendingIncome(events, st), savings, glide, state, accountCtx),
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
  const accountCtx = useAccountContext();
  return cachedIncome(
    transactions,
    instruments,
    accounts,
    fx,
    savings,
    glide,
    state,
    prefsVersion,
    accountCtx,
  );
}

// ---- Monthly plan ("Havi terv") ---------------------------------------------

/** A synced pref from localStorage, reloaded on every pref change. */
function usePref<T>(load: () => T): T {
  const [v, setV] = useState<T>(load);
  useEffect(() => {
    const on = () => setV(load());
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, [load]);
  return v;
}

/** Buy / sell cost per broker (Beállítások). */
export function useBrokerFees(): BrokerFees {
  return usePref(loadBrokerFees);
}

/** The monthly plan's goal order (user-set; see planPrefs). */
export function usePlanOrder(): PlanOrder {
  return usePref(loadPlanOrder);
}

/** Per-account limits (Számla oldal). */
export function useAccountLimits(): AccountLimits {
  return usePref(loadAccountLimits);
}

/** Dated account for new buys, per instrument (Beállítások). */
export function usePurchaseAccounts(): PurchaseAccounts {
  return usePref(loadPurchaseAccounts);
}

const cachedAccountContext = sharedMemo(
  (
    summary: PortfolioSummary,
    transactions: Transaction[],
    fx: Record<string, number>,
    day: string,
    limits: AccountLimits,
    purchase: PurchaseAccounts,
    fees: BrokerFees,
    reserved: Map<string, number>,
  ) => accountContext({ summary, transactions, fx, day, limits, purchase, fees, reserved }),
);

/** Accounts, their limits and the accounts for new buys — today. */
export function useAccountContext(): AccountContext {
  return cachedAccountContext(
    usePortfolioSummary(),
    usePortfolio((s) => s.transactions),
    usePortfolio((s) => s.fx),
    useToday(),
    useAccountLimits(),
    usePurchaseAccounts(),
    useBrokerFees(),
    useReservedCash(),
  );
}

const cachedPlanNeeds = sharedMemo(
  (
    savingsGoals: SavingsGoal[],
    dcaGoals: Goal[],
    accounts: Account[],
    transactions: Transaction[],
    instruments: Instrument[],
    prices: PriceMap,
    fx: Record<string, number>,
    order: PlanOrder,
    day: string,
  ) => {
    void day; // the month / quota changes with the day
    return computePlanNeeds({
      savingsGoals,
      dcaGoals,
      accounts,
      transactions,
      instruments,
      prices,
      fx,
      order,
    });
  },
);

/** Every goal's claim on this month's saving, in plan order. */
export function usePlanNeeds(): PlanNeed[] {
  return cachedPlanNeeds(
    useSavingsGoals(),
    usePortfolio((s) => s.goals),
    usePortfolio((s) => s.accounts),
    usePortfolio((s) => s.transactions),
    usePortfolio((s) => s.instruments),
    usePortfolio((s) => s.prices),
    usePortfolio((s) => s.fx),
    usePlanOrder(),
    useToday(),
  );
}

const cachedMarketPositions = sharedMemo(
  (summary: PortfolioSummary, fx: Record<string, number>, day: string, fees: BrokerFees) =>
    positionsFromSummary(summary, fx, false, day, fees),
);

/**
 * The monthly plan for `amountHuf` (null = the default: the monthly budget
 * minus what the goals already got this month).
 */
export function useMonthlyPlan(amountHuf: number | null): {
  plan: MonthlyPlan;
  needs: PlanNeed[];
  budgetHuf: number;
  defaultAmount: number;
} {
  const needs = usePlanNeeds();
  const { breakdown } = useMonthlyBudget();
  const versions = useGlideVersions();
  const glide = latestConfig(versions);
  const state = useGlideState(versions);
  const summary = usePortfolioSummary();
  const fx = usePortfolio((s) => s.fx);
  const instruments = usePortfolio((s) => s.instruments);
  const day = useToday();
  const fees = useBrokerFees();
  const positions = cachedMarketPositions(summary, fx, day, fees);
  const instMap = cachedInstMap(instruments);
  const accounts = useAccountContext();
  const defaultAmount = defaultPlanAmount(breakdown.budgetHuf, needs);
  const plan = cachedPlanFor(
    amountHuf ?? defaultAmount,
    needs,
    glide,
    state,
    breakdown.budgetHuf,
    positions,
    instMap,
    accounts,
  );
  return { plan, needs, budgetHuf: breakdown.budgetHuf, defaultAmount };
}

const cachedInstMap = sharedMemo(
  (instruments: Instrument[]) => new Map(instruments.map((i) => [i.key, i])),
);

const cachedPlanFor = sharedMemo(
  (
    amountHuf: number,
    needs: PlanNeed[],
    glide: GlideConfig | undefined,
    state: AllocationState | null,
    budgetHuf: number,
    positions: Position[],
    instruments: Map<string, Instrument>,
    accounts: AccountContext,
  ) =>
    buildMonthlyPlan({
      amountHuf,
      needs,
      glide,
      state,
      budgetHuf,
      positions,
      instruments,
      accounts,
    }),
);
