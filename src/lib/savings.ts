// Medium-term savings goals backed by specific instruments (typically discount
// T-bills / DKJ bought for a dated goal). Each goal has a target amount and
// date, a set of assigned instruments whose value counts toward it, and an
// optional switch to let incoming bond coupons (up to the date) count too.
// Shows progress and the monthly saving still needed to reach the goal.
// Synced across devices via the cloud snapshot (see prefs.ts).

import type { Account, Instrument, Transaction } from "./model";
import {
  buildFxHistory,
  computePortfolio,
  consolidatedHoldings,
  futureBondCashflows,
  histFxRate,
  type FxHistory,
  type PortfolioSummary,
  type PriceMap,
} from "./portfolio";

/**
 * HUF a trade actually moved: the gross amount at the trade-day conversion
 * rate, not today's FX on the net. A EUR WBIT buy is 109.65 € × the buy-day
 * rate ≈ 40 003 Ft (what left the account), not 108.65 € × today's rate ≈
 * 39 200. For a sell it is the proceeds. Matches the portfolio cost basis and
 * the DCA-goal progress.
 */
function tradeHufAtCost(
  t: Transaction,
  fxHistory: FxHistory,
  fx: Record<string, number>,
): number {
  const amt = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
  return t.currency === "HUF"
    ? amt
    : amt * histFxRate(fxHistory, t.currency, t.date, fx);
}
import {
  effectiveMonth,
  effectiveMonthLabel,
  GOAL_TOLERANCE,
  lastWorkingDayOfMonth,
} from "./goals";
import type { Alert } from "./alerts";
import { formatMoney } from "./format";
import { touchPref } from "./prefs";
import type { PlannedExpense } from "./forecast";
import {
  claimsCoupon,
  incomeHuf,
  isBondCoupon,
  splitAmongGoals,
} from "./incomeClaims";

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
  /**
   * Months to save in, counted from the start of the current effective month:
   * the current month plus the future pay days up to the date. ≥ 0.
   */
  monthsLeft: number;
  daysLeft: number;
  /**
   * This month's quota: the gap as it stood at the START of the current
   * effective month (this month's buys/sells into the goal left out), spread
   * over monthsLeft. Stable through the month — buying doesn't shrink it to
   * the future months' figure, and selling doesn't hide the shortfall (the
   * monthly status nets buys and sells against it).
   */
  monthlyNeededHuf: number;
  /**
   * How much of an arrived bond coupon the goal can still take (includeCoupons):
   * the shortfall on the target date without the credited coupons and without
   * this month's buys into the goal — so reinvesting a coupon doesn't shrink
   * its own claim. See income.ts.
   */
  couponRoomHuf: number;
  /**
   * NET HUF put into the goal this effective month (buys − sells of its
   * instruments) — what already counts against this month's quota. 0 for
   * goals without assigned instruments.
   */
  thisMonthNetHuf: number;
  /** Adjective of the current effective month, e.g. "szeptemberi". */
  monthAdjective: string;
  /** The projection already covers the target. */
  reached: boolean;
}

export interface SavingsMonthlyStatus {
  goalId: string;
  name: string;
  /** Human label of the current effective month (e.g. "2026. július"). */
  monthLabel: string;
  /**
   * NET HUF put into the goal this effective month: buys minus sells of the
   * assigned instruments (or the same type). Can be negative if more was sold.
   */
  boughtHuf: number;
  /**
   * This month's quota — the monthly-needed saving computed from the
   * month-start position (see SavingsProgress.monthlyNeededHuf); 0 once the
   * goal is already covered.
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
  // This month's bond coupons, split among the goals that claim them.
  const couponShares = new Map<string, number>();
  const room = new Map(
    [...progressByGoal.values()].map((p) => [p.goal.id, p.couponRoomHuf]),
  );
  const monthCoupons = transactions
    .filter((t) => isBondCoupon(t, instruments) && inEffectiveMonth(t, eff))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const t of monthCoupons) {
    const day = t.date.slice(0, 10);
    const shares = splitAmongGoals(
      incomeHuf(t, fx),
      [...progressByGoal.values()]
        .filter((p) => claimsCoupon(p, day))
        .map((p) => ({ goalId: p.goal.id, capHuf: room.get(p.goal.id) ?? 0 })),
    );
    for (const [id, x] of shares) {
      couponShares.set(id, (couponShares.get(id) ?? 0) + x);
      room.set(id, (room.get(id) ?? 0) - x);
    }
  }
  const out: SavingsMonthlyStatus[] = [];
  for (const g of goals) {
    if (!g.monthlyReminder || g.instrumentKeys.length === 0) continue;
    const boughtHuf = netThisEffectiveMonth(
      g,
      transactions,
      instruments,
      fx,
      now,
    );
    const p = progressByGoal.get(g.id);
    const baseNeededHuf = !p || p.reached ? 0 : Math.max(0, p.monthlyNeededHuf);
    // Coupons received THIS effective month — if the goal earmarks coupons
    // (includeCoupons), the user is expected to reinvest them into the goal's
    // instrument, so they add to what must be bought this month.
    // Only the goal's SHARE of them (see income.ts): none once the goal is
    // past its date or needs nothing more, split with other claiming goals.
    const couponHuf = couponShares.get(g.id) ?? 0;
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
        to: "/goals",
        actionLabel: "Célok",
      };
    });
}

/**
 * How many FUTURE pay days fall on or before the target date.
 *
 * Pay day = the LAST WORKING DAY of a calendar month (the same date that, by
 * the app-wide month rule, already counts toward the NEXT month). Counting
 * calendar month boundaries (the 1st) instead over-counts near a month's end:
 * on 31 Aug (August's last working day, i.e. September's pay day, already
 * received) a 1 Nov target has only the 30 Sep and 30 Oct pay days ahead — 2,
 * not the 3 that Sep 1 / Oct 1 / Nov 1 would suggest. Dividing the remaining
 * days by an average month length is just as wrong the other way: 22 July →
 * 2 November is 103 days ≈ 3.4 "months", yet 4 pay days still arrive.
 *
 * The CURRENT effective month's pay day is already in the past (it is what put
 * the money in the account), so it is added separately — see
 * computeSavingsProgress, which counts the current month in.
 */
function paydaysUntil(now: Date, targetMs: number): number {
  if (!Number.isFinite(targetMs)) return 0;
  const nowMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    12,
  ).getTime();
  let count = 0;
  let y = now.getFullYear();
  let m = now.getMonth();
  // Walk forward month by month; stop at the first pay day past the target.
  for (let guard = 0; guard < 1200; guard++) {
    const pay = new Date(y, m, lastWorkingDayOfMonth(y, m), 12).getTime();
    if (pay > targetMs) break;
    if (pay > nowMs) count++;
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return count;
}

/** Buy/sell of one of the goal's instruments, or the same type as one (so a
 * fresh DKJ series counts without re-assigning it). */
function goalTradeMatcher(
  goal: SavingsGoal,
  instruments: Map<string, Instrument>,
): (t: Transaction) => boolean {
  const keys = new Set(goal.instrumentKeys);
  const types = new Set(
    goal.instrumentKeys
      .map((k) => instruments.get(k)?.type)
      .filter((x): x is Instrument["type"] => !!x),
  );
  return (t) => {
    if ((t.type !== "buy" && t.type !== "sell") || !t.instrumentKey)
      return false;
    const inst = instruments.get(t.instrumentKey);
    return keys.has(t.instrumentKey) || (!!inst && types.has(inst.type));
  };
}

/** The transaction falls in the given effective month (DCA month rule). */
function inEffectiveMonth(
  t: Transaction,
  eff: { year: number; month0: number },
): boolean {
  const d = new Date(t.date);
  if (Number.isNaN(d.getTime())) return false;
  const em = effectiveMonth(d);
  return em.year === eff.year && em.month0 === eff.month0;
}

/**
 * NET HUF put into a goal in the CURRENT effective month: buys minus sells of
 * its instruments (see goalTradeMatcher). A purchase that was partly sold back
 * in the same month only counts with what stayed in. 0 for goals with no
 * assigned instruments.
 */
function netThisEffectiveMonth(
  goal: SavingsGoal,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  fx: Record<string, number>,
  now: Date,
): number {
  if (goal.instrumentKeys.length === 0) return 0;
  const eff = effectiveMonth(now);
  const fxHistory = buildFxHistory(txs);
  const isTrade = goalTradeMatcher(goal, instruments);
  let sum = 0;
  for (const t of txs) {
    if (!isTrade(t) || !inEffectiveMonth(t, eff)) continue;
    const huf = tradeHufAtCost(t, fxHistory, fx);
    sum += t.type === "buy" ? huf : -huf;
  }
  return sum;
}

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

    // Quota from the month-start position: replay the portfolio without this
    // effective month's trades into the goal, and spread that gap over the
    // current month + the pay days still ahead.
    const isTrade = goalTradeMatcher(goal, instruments);
    const eff = effectiveMonth(now);
    const startTxs = txs.filter(
      (t) => !(isTrade(t) && inEffectiveMonth(t, eff)),
    );
    let assignedStart = assignedValueHuf;
    if (startTxs.length !== txs.length) {
      const nowStart = computePortfolio(
        accounts,
        startTxs,
        instruments,
        prices,
        fx,
        now,
      );
      const atStart = future
        ? computePortfolio(
            accounts,
            startTxs,
            instruments,
            prices,
            fx,
            new Date(dateMs),
          )
        : nowStart;
      assignedStart = assignedValue(nowStart, atStart, keys, targetMs);
    }
    // Coupons credited THIS effective month were still ahead at its start —
    // counting them as projected there keeps a just-arrived coupon from also
    // swelling the gap that is spread over the months (the monthly status
    // adds the goal's share of them on top, as money to reinvest).
    const creditedThisMonth = goal.includeCoupons
      ? txs
          .filter(
            (t) =>
              isBondCoupon(t, instruments) &&
              inEffectiveMonth(t, eff) &&
              t.date.slice(0, 10) <= goal.targetDate,
          )
          .reduce((s, t) => s + incomeHuf(t, fx), 0)
      : 0;
    const gapAtMonthStart = Math.max(
      0,
      targetHuf - (assignedStart + couponsHuf + creditedThisMonth),
    );
    // Room for newly arrived coupons: the shortfall without them and without
    // this month's own buys into the goal.
    const couponRoomHuf = Math.max(0, targetHuf - (assignedStart + couponsHuf));
    const monthsLeft = future ? paydaysUntil(now, dateMs) + 1 : 0;
    const monthlyNeededHuf =
      monthsLeft > 0 ? gapAtMonthStart / monthsLeft : gapHuf;

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
      couponRoomHuf,
      thisMonthNetHuf: netThisEffectiveMonth(goal, txs, instruments, fx, now),
      monthAdjective: `${effectiveMonthLabel(now).split(" ").pop()}i`,
      reached: gapHuf <= 0,
    };
  });
}

/** Savings goals as planned expenses on their target dates (for projections:
 *  the goal amount leaves the portfolio then). */
export function savingsGoalExpenses(goals: SavingsGoal[]): PlannedExpense[] {
  return goals
    .filter((g) => /^\d{4}-\d{2}-\d{2}/.test(g.targetDate) && g.targetHuf > 0)
    .map((g) => ({
      id: `goal:${g.id}`,
      date: g.targetDate,
      amountHuf: g.targetHuf,
      note: g.name,
    }));
}
