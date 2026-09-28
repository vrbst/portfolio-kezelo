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
  toLocalDay,
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
  couponId,
  couponOwner,
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
  /**
   * The monthly reminder never suggests an assigned instrument that matures
   * within this many days of today's buy (default
   * {@link DEFAULT_MIN_DAYS_TO_MATURITY}) — nor one maturing after the target
   * date. With none left the advice is to hold cash until the date.
   */
  minDaysToMaturity?: number;
  createdAt: string;
  /**
   * Cash set aside for the goal (entered by hand): it counts toward the goal
   * from its date until the target date, like a buy of the goal's instrument.
   * A matured instrument's payout and coupons in the hold-cash window count
   * on their own (see goalCash) — they are not entered here.
   */
  reserves?: CashReserve[];
  /**
   * Specific future bond coupons earmarked for the goal (see couponId:
   * `<instrumentKey>@<schedule day>`). Each is the goal's alone — it counts in
   * the projection until it arrives, then as the goal's cash — and no other
   * goal can pick it or claim it via includeCoupons.
   */
  couponIds?: string[];
  /**
   * YYYY-MM-DD: the monthly setting aside (cash or the goal's instrument)
   * starts in this effective month. Before it no monthly saving is asked; the
   * gap is spread over the months from this one to the target date. Missing =
   * from now.
   */
  saveFrom?: string;
}

/** Cash set aside for a savings goal. */
export interface CashReserve {
  id: string;
  amountHuf: number;
  /** YYYY-MM-DD — it counts from this day. */
  date: string;
  /** The account the cash sits on; missing = a bank account / elsewhere. */
  accountId?: string;
  note?: string;
  /**
   * Buys of the goal's instrument already answered (see reserveConflicts):
   * "used the reserve" (it was lowered) or "separate money". Never re-asked.
   */
  settledBuyIds?: string[];
}

export const DEFAULT_MIN_DAYS_TO_MATURITY = 30;

const DAY_MS = 86_400_000;

/** Maturity day (YYYY-MM-DD) of a bond / T-bill, undefined if it has none. */
function maturityDay(inst: Instrument | undefined): string | undefined {
  const m = inst?.bond?.maturity ?? inst?.maturity;
  // A stored ISO timestamp (UTC) is read back as the LOCAL day — slicing it
  // would give the day before for a local-midnight maturity.
  const ms = dayMsOf(m);
  return Number.isFinite(ms) ? toLocalDay(ms) : undefined;
}

/**
 * Can a buy of `inst` today still serve the goal? Not if it matures within N
 * days of the buy (too short to be worth it, or already gone) or after the
 * target date (it would have to be sold early). No maturity (e.g. an ETF): yes.
 */
export function suitableForGoalBuy(
  inst: Instrument | undefined,
  goal: SavingsGoal,
  today: string,
): boolean {
  const mat = maturityDay(inst);
  if (!mat) return true;
  const n = Math.max(0, goal.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY);
  const earliest = toLocalDay(Date.parse(`${today}T12:00:00`) + n * DAY_MS);
  return mat > earliest && mat <= goal.targetDate.slice(0, 10);
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
  /**
   * Coupons still to arrive on/before the target date that count: the picked
   * ones (couponIds) + with includeCoupons every coupon no goal picked (HUF).
   */
  couponsHuf: number;
  /** Of couponsHuf, the goal's picked coupons still to arrive. */
  pickedCouponsHuf: number;
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
   * The monthly saving once it runs: = monthlyNeededHuf, or — before a later
   * saving start (savingStartsOn) — the gap spread over the months from it.
   */
  plannedMonthlyHuf: number;
  /** YYYY-MM-DD: the saving start, while it is in a later month (else undefined). */
  savingStartsOn?: string;
  /**
   * How much of an arrived bond coupon the goal can still take (includeCoupons):
   * its actual shortfall on the target date (= gapHuf) — this month's own buys
   * into the goal shrink it too. See incomeFlow.ts.
   */
  couponRoomHuf: number;
  /**
   * NET HUF put into the goal this effective month (buys − sells of its
   * instruments) — what already counts against this month's quota. 0 for
   * goals without assigned instruments.
   */
  thisMonthNetHuf: number;
  /** Cash set aside by hand that counts today (see SavingsGoal.reserves). */
  reservedHuf: number;
  /** Money counted automatically: matured payouts + hold-window coupons. */
  autoCashHuf: number;
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
  /** Names of the assigned instruments a buy can still go into (for display). */
  instrumentNames: string;
  /**
   * No assigned instrument can take a buy any more (each matures within N days
   * or after the target date): the advice is to hold the money in cash until
   * the target date, so no buy reminder is raised.
   */
  holdCash: boolean;
  /** The goal's N (see SavingsGoal.minDaysToMaturity). */
  minDays: number;
  /**
   * What this month's SAVING still owes the goal: the quota not yet bought.
   * This month's buys cover the goal's coupon share first (that money already
   * arrived — it is not part of the monthly saving), the rest counts against
   * the quota. The monthly plan, the goal card and the reminder all use it;
   * missingHuf = planHuf + the coupon share not yet reinvested.
   */
  planHuf: number;
  /**
   * The instrument this month's buy should go into: of the buyable ones, the
   * one maturing latest by the target date (an undated one if none is dated).
   * Undefined when the money is to be held in cash.
   */
  buyKey?: string;
  /** Account of the goal's latest reserve with one (where the cash is kept). */
  reserveAccountId?: string;
}

/**
 * This month's state of EVERY savings goal (see savingsMonthlyStatus for the
 * reminder subset). The required amount is the goal's monthly-needed saving
 * (gap ÷ months left), recomputed live — not a snapshot. A buy counts if it is
 * an assigned instrument OR the SAME TYPE as an assigned one, so a fresh DKJ
 * series (new ISIN) counts without re-assigning it. The month boundary follows
 * the DCA-goal rule (a buy on the month's last working day counts toward the
 * next month). A goal with no instrument (or none still buyable) holds cash.
 */
export function savingsMonthStates(
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
    .filter(
      (t) =>
        isBondCoupon(t, instruments) &&
        inEffectiveMonth(t, eff) &&
        // A picked coupon is its goal's cash already — not shared out.
        !couponOwner(goals, t.instrumentKey, toLocalDay(dayMsOf(t.date))),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const t of monthCoupons) {
    const day = t.date.slice(0, 10);
    const shares = splitAmongGoals(
      incomeHuf(t, fx),
      [...progressByGoal.values()]
        // A hold-window coupon counts for the goal on its own — nothing to
        // reinvest or set aside for it.
        .filter((p) => claimsCoupon(p, day) && !inHoldWindow(p.goal, day, instruments))
        .map((p) => ({ goalId: p.goal.id, capHuf: room.get(p.goal.id) ?? 0 })),
    );
    for (const [id, x] of shares) {
      couponShares.set(id, (couponShares.get(id) ?? 0) + x);
      room.set(id, (room.get(id) ?? 0) - x);
    }
  }
  const out: SavingsMonthlyStatus[] = [];
  for (const g of goals) {
    // Buys of the goal's instruments + cash set aside for it this month.
    const boughtHuf =
      netThisEffectiveMonth(g, transactions, instruments, fx, now) + reservedThisMonth(g, now);
    const p = progressByGoal.get(g.id);
    const baseNeededHuf = !p || p.reached ? 0 : Math.max(0, p.monthlyNeededHuf);
    // Coupons received THIS effective month — if the goal earmarks coupons
    // (includeCoupons), the user is expected to reinvest them into the goal's
    // instrument, so they add to what must be bought this month.
    // Only the goal's SHARE of them (see income.ts): none once the goal is
    // past its date or needs nothing more, split with other claiming goals.
    const couponHuf = couponShares.get(g.id) ?? 0;
    const neededHuf = baseNeededHuf + couponHuf;
    const today = toLocalDay(now.getTime());
    const buyable = g.instrumentKeys.filter((k) =>
      suitableForGoalBuy(instruments.get(k), g, today),
    );
    const holdCash = buyable.length === 0;
    const dated = buyable
      .map((k) => ({ k, m: maturityDay(instruments.get(k)) }))
      .filter((x): x is { k: string; m: string } => !!x.m)
      .sort((a, b) => b.m.localeCompare(a.m));
    const buyKey = holdCash ? undefined : (dated[0]?.k ?? buyable[0]);
    const planHuf = Math.max(
      0,
      baseNeededHuf - Math.max(0, boughtHuf - couponHuf),
    );
    // Met once this month's purchases (or, with nothing left to buy, the cash
    // set aside) reach (1 − tolerance) × needed, so rounding / FX drift
    // doesn't leave it a few hundred Ft "short".
    const done =
      neededHuf <= 0 ||
      boughtHuf >= neededHuf * (1 - GOAL_TOLERANCE);
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
      instrumentNames: buyable
        .map((k) => instruments.get(k)?.name ?? k)
        .join(", "),
      holdCash,
      minDays: Math.max(0, g.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY),
      planHuf,
      buyKey,
      reserveAccountId: [...(g.reserves ?? [])]
        .filter((r) => r.accountId && r.amountHuf > 0)
        .sort((a, b) => b.date.localeCompare(a.date))[0]?.accountId,
    });
  }
  return out;
}

/**
 * The reminder subset of {@link savingsMonthStates}: goals that opted in
 * (monthlyReminder) and have ≥1 assigned instrument.
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
  const on = new Set(
    goals
      .filter((g) => g.monthlyReminder && g.instrumentKeys.length > 0)
      .map((g) => g.id),
  );
  return savingsMonthStates(
    goals,
    accounts,
    transactions,
    instruments,
    prices,
    fx,
    now,
  ).filter((s) => on.has(s.goalId));
}

/** The "hold it in cash" advice line for a goal with nothing left to buy. */
export function holdCashAdvice(s: SavingsMonthlyStatus): string {
  const why =
    `a hozzárendelt eszközök a vétel után ${s.minDays} napon belül vagy a céldátum után járnak le`;
  if (s.missingHuf > 0)
    return `${s.monthLabel}: tartsd készpénzben a céldátumig — ${formatMoney(s.missingHuf)} (${why}).`;
  if (s.boughtHuf >= 1)
    return `${s.monthLabel}: e havi rész félretéve (${formatMoney(s.boughtHuf)}) ✓ — a pénz készpénzben várja a céldátumot.`;
  return `${s.monthLabel}: nincs vételi teendő — ${why}, a pénz készpénzben várja a céldátumot.`;
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
      // The same split as the monthly plan: the saving's part + the coupon
      // share not yet reinvested (missing = plan + that).
      const couponLeft = s.missingHuf - s.planHuf;
      const couponNote =
        couponLeft > 1
          ? ` Ebből ${formatMoney(s.planHuf)} a havi megtakarításból (Havi terv), ${formatMoney(couponLeft)} a beérkezett kamat újrabefektetése.`
          : "";
      if (s.holdCash)
        return {
          id: `savings-goal:${s.goalId}:${curKey}`,
          severity: "medium" as const,
          title: `Havi félretétel – ${s.name}`,
          detail: `${s.monthLabel}: ${formatMoney(s.boughtHuf)} / ${formatMoney(s.neededHuf)} — még ${formatMoney(s.missingHuf)}-ot tegyél félre készpénzben, és rögzítsd a célnál (a hozzárendelt eszközök a vétel után ${s.minDays} napon belül vagy a céldátum után járnak le).`,
          to: "/goals",
          actionLabel: "Célok",
        };
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
 * Account id → cash set aside on it for goals still ahead: not free cash, so
 * the glide path doesn't suggest investing it and it raises no idle-cash
 * alert. Past a goal's date its reserves no longer hold the cash. With the
 * ledger (`txs`), the credited coupons a goal picked (couponIds) are held
 * on their account too.
 */
export function reservedCashByAccount(
  goals: SavingsGoal[],
  day: string,
  txs: Transaction[] = [],
  fx: Record<string, number> = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (acc: string, huf: number) => out.set(acc, (out.get(acc) ?? 0) + huf);
  const ahead = goals.filter((g) => g.targetDate.slice(0, 10) >= day);
  for (const g of ahead)
    for (const r of reservesOn(g, day)) if (r.accountId) add(r.accountId, r.amountHuf);
  if (ahead.some((g) => g.couponIds?.length))
    for (const t of txs) {
      if (t.type !== "interest" || t.internal) continue;
      const d = toLocalDay(dayMsOf(t.date));
      if (d <= day && couponOwner(ahead, t.instrumentKey, d)) add(t.accountId, incomeHuf(t, fx));
    }
  return out;
}

/**
 * An account's cash per currency minus the part set aside (HUF first, then
 * the other currencies at today's rate). Native amounts.
 */
export function freeCashOf(
  cash: Record<string, number>,
  reservedHuf: number,
  fx: Record<string, number>,
): Record<string, number> {
  const out = { ...cash };
  let left = Math.max(0, reservedHuf);
  const ccys = Object.keys(out).sort((a, b) => (a === "HUF" ? -1 : b === "HUF" ? 1 : 0));
  for (const ccy of ccys) {
    if (left <= 0) break;
    const rate = ccy === "HUF" ? 1 : (fx[ccy] ?? 0);
    if (!(rate > 0) || out[ccy] <= 0) continue;
    const take = Math.min(out[ccy] * rate, left);
    out[ccy] -= take / rate;
    left -= take;
  }
  return out;
}

/** The goal's reserves counting on `day`: dated by then and by the target date. */
function reservesOn(goal: SavingsGoal, day: string): CashReserve[] {
  const target = goal.targetDate.slice(0, 10);
  return (goal.reserves ?? []).filter((r) => r.date <= day && r.date <= target && r.amountHuf > 0);
}

const sumHuf = (rs: CashReserve[]) => rs.reduce((a, r) => a + r.amountHuf, 0);

/** Of those, the ones set aside in the effective month of `now`. */
function reservedThisMonth(goal: SavingsGoal, now: Date): number {
  const eff = effectiveMonth(now);
  return sumHuf(
    reservesOn(goal, toLocalDay(now.getTime())).filter((r) =>
      inEffectiveMonth({ date: `${r.date}T12:00:00` } as Transaction, eff),
    ),
  );
}

/** A coupon on `day` falls in the goal's hold-cash window (it counts on its own). */
function inHoldWindow(
  goal: SavingsGoal,
  day: string,
  instruments: Map<string, Instrument>,
): boolean {
  if (!goal.includeCoupons) return false;
  const from = holdCashFrom(goal, instruments);
  return !!from && day >= from && day <= goal.targetDate.slice(0, 10);
}

/**
 * First day of the goal's "hold cash" window: from then on none of its
 * instruments can still be bought for it (each matures within minDays, or
 * after the target date), so money for the goal waits in cash. Undefined when
 * an instrument without a maturity (e.g. an ETF) keeps it buyable for good.
 */
function holdCashFrom(
  goal: SavingsGoal,
  instruments: Map<string, Instrument>,
): string | undefined {
  const created = goal.createdAt.slice(0, 10);
  const target = goal.targetDate.slice(0, 10);
  const n = Math.max(0, goal.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY);
  let last = "";
  for (const k of goal.instrumentKeys) {
    const mat = maturityDay(instruments.get(k));
    if (!mat) return undefined;
    if (mat > target) continue; // never buyable for the goal
    // Buyable while mat > today + n days → not any more from mat − n.
    const stop = toLocalDay(dayMsOf(mat) - n * DAY_MS);
    if (stop > last) last = stop;
  }
  return last > created ? last : created;
}

/**
 * Money that is already the goal's although it is not in a security:
 *  - the payout of its instruments that matured by the target date (the DKJ
 *    bought for the goal pays its face into the account — still the goal's),
 *  - bond coupons credited inside its hold-cash window (includeCoupons): there
 *    is nothing to reinvest them in, so they wait in cash like the payout,
 *  - the coupons it picked (couponIds), once credited — whole, never split.
 * Without this, the goal "lost" that money the day it arrived: a coupon fell
 * out of the projection, a matured DKJ took the goal to 0 %. Coupons are
 * split among the goals claiming them, like the monthly status does.
 */
function goalCash(
  goals: SavingsGoal[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  fx: Record<string, number>,
): Map<string, { cashHuf: number; coupons: { day: string; huf: number }[] }> {
  const out = new Map<string, { cashHuf: number; coupons: { day: string; huf: number }[] }>(
    goals.map((g) => [g.id, { cashHuf: 0, coupons: [] }]),
  );
  for (const g of goals) {
    const keys = new Set(g.instrumentKeys);
    const created = g.createdAt.slice(0, 10);
    const target = g.targetDate.slice(0, 10);
    for (const t of txs) {
      if (t.type !== "redemption" || !t.instrumentKey || !keys.has(t.instrumentKey)) continue;
      const day = toLocalDay(dayMsOf(t.date));
      if (day >= created && day <= target) out.get(g.id)!.cashHuf += incomeHuf(t, fx);
    }
  }
  const windows = goals
    .filter((g) => g.includeCoupons)
    .map((g) => ({ g, from: holdCashFrom(g, instruments), to: g.targetDate.slice(0, 10) }))
    .filter((w): w is { g: SavingsGoal; from: string; to: string } => !!w.from);
  const used = new Map<string, number>();
  const coupons = txs
    .filter((t) => isBondCoupon(t, instruments))
    .map((t) => ({ t, day: toLocalDay(dayMsOf(t.date)) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  for (const { t, day } of coupons) {
    const owner = couponOwner(goals, t.instrumentKey, day);
    if (owner) {
      out.get(owner.id)!.cashHuf += incomeHuf(t, fx);
      continue;
    }
    const claim = windows.filter((w) => day >= w.from && day <= w.to);
    if (claim.length === 0) continue;
    const shares = splitAmongGoals(
      incomeHuf(t, fx),
      claim.map((w) => ({
        goalId: w.g.id,
        capHuf: Math.max(0, w.g.targetHuf - (used.get(w.g.id) ?? 0)),
      })),
    );
    for (const [id, huf] of shares) {
      used.set(id, (used.get(id) ?? 0) + huf);
      const o = out.get(id)!;
      o.cashHuf += huf;
      o.coupons.push({ day, huf });
    }
  }
  return out;
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
  const cashByGoal = goalCash(goals, txs, instruments, fx);
  const pickedAll = new Set(goals.flatMap((g) => g.couponIds ?? []));
  const idOf = (c: (typeof coupons)[number]) =>
    c.instrumentKey ? couponId(c.instrumentKey, c.date) : "";
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
    // Plus the money already the goal's in cash (a matured instrument's
    // payout, coupons credited in the hold-cash window) — see goalCash.
    const cash = cashByGoal.get(goal.id)!;
    // …and the cash set aside by hand (this month's part counts as this
    // month's saving, like a buy — see assignedStart).
    const reservedHuf = sumHuf(reservesOn(goal, toLocalDay(nowMs)));
    const reservedNowMonth = reservedThisMonth(goal, now);
    const assignedValueHuf =
      assignedValue(summaryNow, future ? summaryAt(dateMs) : summaryNow, keys, targetMs) +
      cash.cashHuf +
      reservedHuf;
    const assignedAtDate = assignedValueHuf;

    // Coupons still ahead by the date: the ones this goal picked, plus — if it
    // earmarks every coupon — those no goal picked.
    const picked = new Set(goal.couponIds ?? []);
    const byDate = coupons.filter((c) => parseDateMs(c.date) <= (future ? dateMs : nowMs));
    const pickedCouponsHuf = byDate
      .filter((c) => picked.has(idOf(c)))
      .reduce((s, c) => s + c.amountHuf, 0);
    const couponsHuf =
      pickedCouponsHuf +
      (goal.includeCoupons
        ? byDate.filter((c) => !pickedAll.has(idOf(c))).reduce((s, c) => s + c.amountHuf, 0)
        : 0);

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
    let assignedStart = assignedValueHuf - reservedNowMonth;
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
      assignedStart =
        assignedValue(nowStart, atStart, keys, targetMs) + cash.cashHuf + reservedHuf - reservedNowMonth;
    }
    // Coupons credited THIS effective month were still ahead at its start —
    // counting them as projected there keeps a just-arrived coupon from also
    // swelling the gap that is spread over the months (the monthly status
    // adds the goal's share of them on top, as money to reinvest). Those in
    // the hold-cash window are already in the goal's cash (assignedStart).
    const holdFrom = goal.includeCoupons ? holdCashFrom(goal, instruments) : undefined;
    const creditedThisMonth = goal.includeCoupons
      ? txs
          .filter(
            (t) =>
              isBondCoupon(t, instruments) &&
              inEffectiveMonth(t, eff) &&
              t.date.slice(0, 10) <= goal.targetDate &&
              !(holdFrom && toLocalDay(dayMsOf(t.date)) >= holdFrom) &&
              // A picked coupon is its goal's cash (assignedStart) already.
              !couponOwner(goals, t.instrumentKey, toLocalDay(dayMsOf(t.date))),
          )
          .reduce((s, t) => s + incomeHuf(t, fx), 0)
      : 0;
    // This month's hold-window coupons, still to be distributed: the room for
    // them is the shortfall WITHOUT them (they are counted in the cash above).
    const holdThisMonth = cash.coupons
      .filter((c) => inEffectiveMonth({ date: `${c.day}T12:00:00` } as Transaction, eff))
      .reduce((s, c) => s + c.huf, 0);
    const gapAtMonthStart = Math.max(
      0,
      targetHuf - (assignedStart + couponsHuf + creditedThisMonth),
    );
    // Room for newly arrived coupons: the actual shortfall, this month's own
    // buys into the goal included (hold-window coupons being distributed
    // don't shrink their own room).
    const couponRoomHuf = gapHuf + holdThisMonth;
    const monthsLeft = future ? paydaysUntil(now, dateMs) + 1 : 0;
    // A later saving start (saveFrom): nothing is asked before its effective
    // month; then the gap is spread over the months from it to the date.
    const fromMs = goal.saveFrom ? parseDateMs(goal.saveFrom) : NaN;
    const fromEff = Number.isFinite(fromMs) ? effectiveMonth(new Date(fromMs)) : undefined;
    const notYet =
      future &&
      !!fromEff &&
      fromEff.year * 12 + fromEff.month0 > eff.year * 12 + eff.month0;
    const monthlyNeededHuf = notYet
      ? 0
      : monthsLeft > 0
        ? gapAtMonthStart / monthsLeft
        : gapHuf;
    const plannedMonthlyHuf = notYet
      ? gapHuf / (paydaysUntil(new Date(fromMs), dateMs) + 1)
      : monthlyNeededHuf;

    return {
      goal,
      assignedValueHuf,
      couponsHuf,
      pickedCouponsHuf,
      projectedHuf,
      targetHuf,
      progressPct: targetHuf > 0 ? assignedValueHuf / targetHuf : 0,
      projectedPct: targetHuf > 0 ? projectedHuf / targetHuf : 0,
      gapHuf,
      monthsLeft,
      daysLeft,
      monthlyNeededHuf,
      plannedMonthlyHuf,
      savingStartsOn: notYet ? goal.saveFrom!.slice(0, 10) : undefined,
      couponRoomHuf,
      thisMonthNetHuf: netThisEffectiveMonth(goal, txs, instruments, fx, now) + reservedNowMonth,
      reservedHuf,
      autoCashHuf: cash.cashHuf,
      monthAdjective: `${effectiveMonthLabel(now).split(" ").pop()}i`,
      reached: gapHuf <= 0,
    };
  });
}

/** One scheduled future coupon payment (the accounts holding the bond summed). */
export interface CouponOption {
  /** See couponId. */
  id: string;
  /** YYYY-MM-DD schedule day. */
  day: string;
  name: string;
  amountHuf: number;
}

/**
 * The future bond coupons (not yet credited) a goal can pick, one per bond +
 * schedule day, soonest first.
 */
export function futureCouponOptions(
  summary: PortfolioSummary,
  txs: Transaction[],
  now: Date = new Date(),
): CouponOption[] {
  const byId = new Map<string, CouponOption>();
  for (const c of futureBondCashflows(summary, now, txs)) {
    if (c.kind !== "coupon" || !c.instrumentKey) continue;
    const id = couponId(c.instrumentKey, c.date);
    const o = byId.get(id);
    if (o) o.amountHuf += c.amountHuf;
    else
      byId.set(id, {
        id,
        day: c.date,
        name: c.title.replace(/ — kamat$/, ""),
        amountHuf: c.amountHuf,
      });
  }
  return [...byId.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name),
  );
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

// ---- Possible double counting: a buy paid from a reserve -------------------

/** A buy of the goal's instrument that may have been paid from a reserve. */
export interface ReserveConflict {
  goalId: string;
  goalName: string;
  reserveId: string;
  /** What is still set aside in that reserve. */
  reserveHuf: number;
  buyTxId: string;
  /** YYYY-MM-DD. */
  buyDay: string;
  buyHuf: number;
  accountId: string;
}

/**
 * Buys of a goal's instrument on the account of one of its reserves, after
 * that reserve's date (and by the target date) that nobody answered yet: the
 * money may have come from the reserve — then it would count twice (as the
 * bought security AND as set-aside cash). Each buy pairs with the latest
 * earlier reserve on its account. Nothing is lowered automatically.
 */
export function reserveConflicts(
  goals: SavingsGoal[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  fx: Record<string, number>,
): ReserveConflict[] {
  const out: ReserveConflict[] = [];
  const fxHistory = buildFxHistory(txs);
  for (const g of goals) {
    const reserves = (g.reserves ?? []).filter((r) => r.accountId && r.amountHuf > 0);
    if (reserves.length === 0) continue;
    const settled = new Set((g.reserves ?? []).flatMap((r) => r.settledBuyIds ?? []));
    const isTrade = goalTradeMatcher(g, instruments);
    const target = g.targetDate.slice(0, 10);
    for (const t of txs) {
      if (t.type !== "buy" || !isTrade(t) || settled.has(t.id)) continue;
      const day = toLocalDay(dayMsOf(t.date));
      if (day > target) continue;
      const r = reserves
        .filter((x) => x.accountId === t.accountId && x.date < day)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!r) continue;
      out.push({
        goalId: g.id,
        goalName: g.name,
        reserveId: r.id,
        reserveHuf: r.amountHuf,
        buyTxId: t.id,
        buyDay: day,
        buyHuf: tradeHufAtCost(t, fxHistory, fx),
        accountId: t.accountId,
      });
    }
  }
  return out;
}

/**
 * Answer a conflict: `used` = the buy was paid from the reserve, so lower it
 * by the buy (not below 0); otherwise it was separate money. Either way the
 * buy is remembered and not asked about again.
 */
export function settleReserveConflict(
  goal: SavingsGoal,
  c: ReserveConflict,
  used: boolean,
): SavingsGoal {
  return {
    ...goal,
    reserves: (goal.reserves ?? []).map((r) =>
      r.id !== c.reserveId
        ? r
        : {
            ...r,
            amountHuf: used ? Math.max(0, Math.round(r.amountHuf - c.buyHuf)) : r.amountHuf,
            settledBuyIds: [...new Set([...(r.settledBuyIds ?? []), c.buyTxId])],
          },
    ),
  };
}

/** One alert per unanswered conflict (see reserveConflicts). */
export function reserveConflictAlerts(conflicts: ReserveConflict[]): Alert[] {
  return conflicts.map((c) => ({
    id: `reserve-conflict:${c.goalId}:${c.buyTxId}`,
    severity: "medium" as const,
    title: `Lehetséges kettős számolás – ${c.goalName}`,
    detail: `Vétel ${formatMoney(c.buyHuf)} (${c.buyDay}), félretétel ${formatMoney(c.reserveHuf)} ugyanazon a számlán — felhasználtad a félretett pénzt? A célkártyán egy gombbal csökkentheted.`,
    to: "/goals",
    actionLabel: "Célok",
  }));
}
