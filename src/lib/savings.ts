// Medium-term savings goals backed by specific instruments (typically discount
// T-bills / DKJ bought for a dated goal). Each goal has a target amount and
// date, a set of assigned instruments whose value counts toward it, and an
// optional switch to let incoming bond coupons (up to the date) count too.
// Shows progress and the monthly saving still needed to reach the goal.
// Synced across devices via the cloud snapshot (see prefs.ts).

import type { Account, Instrument, Transaction } from "./model";
import {
  computePortfolio,
  consolidatedHoldings,
  futureBondCashflows,
  toHuf,
  type PortfolioSummary,
  type PriceMap,
} from "./portfolio";
import { effectiveMonth, effectiveMonthLabel } from "./goals";
import type { Alert } from "./alerts";
import { touchPref } from "./prefs";

export interface SavingsGoal {
  id: string;
  name: string;
  /** Target amount in HUF. */
  targetHuf: number;
  /** Target date (ISO YYYY-MM-DD). */
  targetDate: string;
  /** Instruments whose current value counts toward the goal (e.g. DKJ series). */
  instrumentKeys: string[];
  /** If true, future bond coupons arriving on/before the date count too. */
  includeCoupons: boolean;
  /**
   * If true (only meaningful with assigned instruments), raise a monthly alert
   * until an assigned instrument is bought in the current month — the "did I do
   * this month's purchase?" nudge. Uses the same month-boundary rule as the DCA
   * goals (a buy on the last working day counts toward the next month).
   */
  monthlyReminder?: boolean;
  createdAt: string;
}

const STORE_KEY = "pf-savings";

export function loadSavingsGoals(): SavingsGoal[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavingsGoal[]) : [];
  } catch {
    return [];
  }
}

export function saveSavingsGoals(goals: SavingsGoal[]) {
  try {
    const json = JSON.stringify(goals);
    if (localStorage.getItem(STORE_KEY) === json) return;
    localStorage.setItem(STORE_KEY, json);
    touchPref("savings");
  } catch {
    /* ignore */
  }
}

export interface SavingsProgress {
  goal: SavingsGoal;
  /** Value of the assigned instruments today (HUF). */
  assignedValueHuf: number;
  /** Coupons arriving on/before the target date, if includeCoupons (HUF). */
  couponsHuf: number;
  /**
   * Projected value on the target date: assigned instruments accreted to that
   * date (a DKJ grows toward par) plus the counted coupons.
   */
  projectedHuf: number;
  targetHuf: number;
  /** assignedValueHuf / target — how full the jar is today (0..1+). */
  progressPct: number;
  /** projectedHuf / target — expected fill on the target date. */
  projectedPct: number;
  /** Shortfall on the target date (0 if already covered). */
  gapHuf: number;
  /** Whole months from today to the target date (≥ 0). */
  monthsLeft: number;
  daysLeft: number;
  /** Monthly saving needed to close the gap by the date. */
  monthlyNeededHuf: number;
  /** The projection already covers the target. */
  reached: boolean;
}

export interface SavingsMonthlyStatus {
  goalId: string;
  name: string;
  /** Human label of the current effective month (e.g. "2026. július"). */
  monthLabel: string;
  /** HUF bought this effective month toward the goal (assigned key OR type). */
  boughtHuf: number;
  /** True once anything counting toward the goal was bought this month. */
  done: boolean;
  /** Assigned instrument names (for display). */
  instrumentNames: string;
}

/**
 * Per-goal "did I do this month's purchase?" status for goals that opted in
 * (monthlyReminder) and have ≥1 assigned instrument. A buy counts if it is one
 * of the assigned instruments OR the SAME TYPE as an assigned one — so a fresh
 * DKJ series (new ISIN) bought this month still counts without re-assigning it.
 * The month boundary follows the DCA-goal rule (a buy on the month's last
 * working day counts toward the next month), so the two always agree.
 */
export function savingsMonthlyStatus(
  goals: SavingsGoal[],
  transactions: Transaction[],
  instruments: Map<string, Instrument>,
  fx: Record<string, number>,
  now: Date = new Date(),
): SavingsMonthlyStatus[] {
  const eff = effectiveMonth(now);
  const monthLabel = effectiveMonthLabel(now);
  const out: SavingsMonthlyStatus[] = [];
  for (const g of goals) {
    if (!g.monthlyReminder || g.instrumentKeys.length === 0) continue;
    const keys = new Set(g.instrumentKeys);
    const types = new Set(
      g.instrumentKeys
        .map((k) => instruments.get(k)?.type)
        .filter((t): t is Instrument["type"] => !!t),
    );
    let boughtHuf = 0;
    for (const t of transactions) {
      if (t.type !== "buy" || !t.instrumentKey) continue;
      const inst = instruments.get(t.instrumentKey);
      const match = keys.has(t.instrumentKey) || (inst && types.has(inst.type));
      if (!match) continue;
      const d = new Date(t.date);
      if (Number.isNaN(d.getTime())) continue;
      const em = effectiveMonth(d);
      if (em.year !== eff.year || em.month0 !== eff.month0) continue;
      boughtHuf += toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      );
    }
    out.push({
      goalId: g.id,
      name: g.name,
      monthLabel,
      boughtHuf,
      done: boughtHuf > 0,
      instrumentNames: g.instrumentKeys
        .map((k) => instruments.get(k)?.name ?? k)
        .join(", "),
    });
  }
  return out;
}

/**
 * Alerts for the monthly purchase not yet done. The met ones are shown as a
 * green "Rendben" on the Alerts page instead (see savingsMonthlyStatus). The
 * month key in the id resets the alert each month.
 */
export function savingsGoalAlerts(
  goals: SavingsGoal[],
  transactions: Transaction[],
  instruments: Map<string, Instrument>,
  fx: Record<string, number>,
  now: Date = new Date(),
): Alert[] {
  const eff = effectiveMonth(now);
  const curKey = `${eff.year}-${eff.month0}`;
  return savingsMonthlyStatus(goals, transactions, instruments, fx, now)
    .filter((s) => !s.done)
    .map((s) => ({
      id: `savings-goal:${s.goalId}:${curKey}`,
      severity: "medium" as const,
      title: `Havi vásárlás – ${s.name}`,
      detail: `${s.monthLabel}: még nem vettél a célhoz rendelt eszközből (${s.instrumentNames}).`,
      to: "/forecast",
      actionLabel: "Célok",
    }));
}

const MONTH_MS = (365.25 / 12) * 86_400_000;

function parseDateMs(iso: string): number {
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : NaN;
}

/** Sum the value of the given instruments in a summary (across accounts). */
function assignedValue(summary: PortfolioSummary, keys: Set<string>): number {
  let sum = 0;
  for (const h of consolidatedHoldings(summary))
    if (keys.has(h.instrumentKey)) sum += h.marketValueHuf;
  return sum;
}

/**
 * Progress for each goal: assigned value today, the value projected to the
 * target date (bond accretion + optional coupons), and the monthly saving still
 * needed. Recomputes the portfolio at each distinct target date so a DKJ's
 * pull-to-par by the date is reflected.
 */
export function computeSavingsProgress(
  goals: SavingsGoal[],
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  now: Date = new Date(),
): SavingsProgress[] {
  const nowMs = now.getTime();
  const summaryNow = computePortfolio(
    accounts,
    txs,
    instruments,
    prices,
    fx,
    now,
  );
  const coupons = futureBondCashflows(summaryNow, now).filter(
    (c) => c.kind === "coupon",
  );
  const summaryAtCache = new Map<string, PortfolioSummary>();
  const summaryAt = (dateMs: number): PortfolioSummary => {
    const key = String(dateMs);
    let s = summaryAtCache.get(key);
    if (!s) {
      s = computePortfolio(
        accounts,
        txs,
        instruments,
        prices,
        fx,
        new Date(dateMs),
      );
      summaryAtCache.set(key, s);
    }
    return s;
  };

  return goals.map((goal) => {
    const keys = new Set(goal.instrumentKeys);
    const assignedValueHuf = assignedValue(summaryNow, keys);
    const dateMs = parseDateMs(goal.targetDate);
    const future = Number.isFinite(dateMs) && dateMs > nowMs;

    // Assigned instruments accreted to the target date (bonds pull to par).
    const assignedAtDate = future
      ? assignedValue(summaryAt(dateMs), keys)
      : assignedValueHuf;

    const couponsHuf = goal.includeCoupons
      ? coupons
          .filter((c) => parseDateMs(c.date) <= (future ? dateMs : nowMs))
          .reduce((s, c) => s + c.amountHuf, 0)
      : 0;

    const projectedHuf = assignedAtDate + couponsHuf;
    const targetHuf = goal.targetHuf;
    const gapHuf = Math.max(0, targetHuf - projectedHuf);
    const daysLeft = future ? Math.round((dateMs - nowMs) / 86_400_000) : 0;
    const monthsLeft = future
      ? Math.max(1, Math.round((dateMs - nowMs) / MONTH_MS))
      : 0;
    const monthlyNeededHuf = monthsLeft > 0 ? gapHuf / monthsLeft : gapHuf;

    return {
      goal,
      assignedValueHuf,
      couponsHuf,
      projectedHuf,
      targetHuf,
      progressPct: targetHuf > 0 ? assignedValueHuf / targetHuf : 0,
      projectedPct: targetHuf > 0 ? projectedHuf / targetHuf : 0,
      gapHuf,
      monthsLeft,
      daysLeft,
      monthlyNeededHuf,
      reached: gapHuf <= 0,
    };
  });
}
