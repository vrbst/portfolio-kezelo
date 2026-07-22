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
import { effectiveMonth, effectiveMonthLabel, GOAL_TOLERANCE } from "./goals";
import type { Alert } from "./alerts";
import { formatMoney } from "./format";
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
  /**
   * Value the assigned instruments contribute to the goal (HUF): face value for
   * bonds maturing by the target date, target-date value otherwise. NOT today's
   * market mark — a goal-backing DKJ is held to maturity.
   */
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
  /**
   * Base monthly amount needed to stay on track — the goal's gap divided by the
   * months left, recomputed live (0 once the goal is already covered).
   */
  baseNeededHuf: number;
  /**
   * Bond coupons received THIS effective month, if includeCoupons — money the
   * user is expected to reinvest into the goal's instrument this month.
   */
  couponHuf: number;
  /** Total to buy this month = baseNeeded + couponHuf. */
  neededHuf: number;
  /** Still missing this month (max 0, needed − bought). */
  missingHuf: number;
  /** True once this month's purchases reach the needed amount (or none needed). */
  done: boolean;
  /** Assigned instrument names (for display). */
  instrumentNames: string;
}

/**
 * Per-goal "did I put in this month's required amount?" status, for goals that
 * opted in (monthlyReminder) and have ≥1 assigned instrument. The required
 * amount is the goal's monthly-needed saving (gap ÷ months left), recomputed
 * live — not a snapshot. A buy counts if it is an assigned instrument OR the
 * SAME TYPE as an assigned one, so a fresh DKJ series (new ISIN) counts without
 * re-assigning it. The month boundary follows the DCA-goal rule (a buy on the
 * month's last working day counts toward the next month).
 */
export function savingsMonthlyStatus(
  goals: SavingsGoal[],
  accounts: Account[],
  transactions: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  now: Date = new Date(),
): SavingsMonthlyStatus[] {
  const eff = effectiveMonth(now);
  const monthLabel = effectiveMonthLabel(now);
  const progressByGoal = new Map(
    computeSavingsProgress(
      goals,
      accounts,
      transactions,
      instruments,
      prices,
      fx,
      now,
    ).map((p) => [p.goal.id, p]),
  );
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
    const baseNeededHuf = Math.max(
      0,
      progressByGoal.get(g.id)?.monthlyNeededHuf ?? 0,
    );
    // Coupons received THIS effective month — if the goal earmarks coupons
    // (includeCoupons), the user is expected to reinvest them into the goal's
    // instrument, so they add to what must be bought this month.
    let couponHuf = 0;
    if (g.includeCoupons) {
      for (const t of transactions) {
        if (t.type !== "interest") continue;
        const d = new Date(t.date);
        if (Number.isNaN(d.getTime())) continue;
        const em = effectiveMonth(d);
        if (em.year !== eff.year || em.month0 !== eff.month0) continue;
        couponHuf += toHuf(
          Math.abs(t.netAmount ?? t.grossAmount ?? 0),
          t.currency,
          fx,
        );
      }
    }
    const neededHuf = baseNeededHuf + couponHuf;
    // Met once this month's purchases reach (1 − tolerance) × needed, so
    // rounding / FX drift doesn't leave it a few hundred Ft "short".
    const done =
      neededHuf <= 0 || boughtHuf >= neededHuf * (1 - GOAL_TOLERANCE);
    out.push({
      goalId: g.id,
      name: g.name,
      monthLabel,
      boughtHuf,
      baseNeededHuf,
      couponHuf,
      neededHuf,
      missingHuf: Math.max(0, neededHuf - boughtHuf),
      done,
      instrumentNames: g.instrumentKeys
        .map((k) => instruments.get(k)?.name ?? k)
        .join(", "),
    });
  }
  return out;
}

/**
 * Alerts for the monthly required amount not yet reached. Met ones show as a
 * green "Rendben" on the Alerts page instead. The month key in the id resets
 * the alert each month.
 */
export function savingsGoalAlerts(
  goals: SavingsGoal[],
  accounts: Account[],
  transactions: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  now: Date = new Date(),
): Alert[] {
  const eff = effectiveMonth(now);
  const curKey = `${eff.year}-${eff.month0}`;
  return savingsMonthlyStatus(
    goals,
    accounts,
    transactions,
    instruments,
    prices,
    fx,
    now,
  )
    .filter((s) => !s.done)
    .map((s) => {
      const couponNote =
        s.couponHuf > 0
          ? ` Ebből ${formatMoney(s.couponHuf)} a most beérkezett kamat újrabefektetése.`
          : "";
      return {
        id: `savings-goal:${s.goalId}:${curKey}`,
        severity: "medium" as const,
        title: `Havi vásárlás – ${s.name}`,
        detail: `${s.monthLabel}: ${formatMoney(s.boughtHuf)} / ${formatMoney(s.neededHuf)} — még ${formatMoney(s.missingHuf)} kell a célhoz rendelt eszközből (${s.instrumentNames}).${couponNote}`,
        to: "/forecast",
        actionLabel: "Célok",
      };
    });
}

const MONTH_MS = (365.25 / 12) * 86_400_000;

function parseDateMs(iso: string): number {
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : NaN;
}

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

/** Local-noon ms for a stored date — bare `YYYY-MM-DD` or a full ISO instant. */
function dayMsOf(s: string | undefined): number {
  if (!s) return NaN;
  if (!s.includes("T")) return parseDateMs(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? NaN
    : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
}

/**
 * Value of the goal's assigned instruments, counted the way the goal actually
 * realises them. A DKJ bought for a dated goal is held to maturity, so today's
 * discounted mark is the wrong number:
 *   - matures on/before the target date → its FACE value; that is the amount
 *     that lands in the account, and it is already locked in,
 *   - matures after the target date → its value ON the target date (a discount
 *     bill has only pulled part-way to par by then).
 * Non-bond instruments keep their target-date market value.
 */
function assignedValue(
  summaryNow: PortfolioSummary,
  summaryAtTarget: PortfolioSummary,
  keys: Set<string>,
  targetMs: number,
): number {
  const atTarget = new Map(
    consolidatedHoldings(summaryAtTarget).map((h) => [h.instrumentKey, h]),
  );
  let sum = 0;
  for (const h of consolidatedHoldings(summaryNow)) {
    if (!keys.has(h.instrumentKey)) continue;
    const inst = h.instrument;
    const matMs = dayMsOf(inst?.bond?.maturity ?? inst?.maturity);
    const maturesByTarget =
      !!inst &&
      BOND_TYPES.has(inst.type) &&
      Number.isFinite(matMs) &&
      Number.isFinite(targetMs) &&
      matMs <= targetMs;
    // Bonds carry their HUF face value as `quantity`.
    sum += maturesByTarget
      ? h.quantity
      : (atTarget.get(h.instrumentKey)?.marketValueHuf ?? h.marketValueHuf);
  }
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
  // Already-credited coupons are excluded: that money is now cash (or already
  // reinvested into an assigned instrument), so counting it as a future inflow
  // too would inflate the projection right before every coupon date.
  const coupons = futureBondCashflows(summaryNow, now, txs).filter(
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
    const dateMs = parseDateMs(goal.targetDate);
    const future = Number.isFinite(dateMs) && dateMs > nowMs;
    const targetMs = future ? dateMs : nowMs;

    // Face value for bonds that mature by the target date, target-date value for
    // everything else — see assignedValue. Today's discounted mark never applies:
    // a DKJ held for a dated goal is realised at par, not sold at market.
    const assignedValueHuf = assignedValue(
      summaryNow,
      future ? summaryAt(dateMs) : summaryNow,
      keys,
      targetMs,
    );
    const assignedAtDate = assignedValueHuf;

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
