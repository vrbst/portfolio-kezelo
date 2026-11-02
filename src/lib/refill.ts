// Refill goals ("Visszapótlás"): money taken out of the portfolio — on a set
// day, from a set holding or account — that the monthly saving puts back
// right after the dated goals, instead of the usual split (DCA, glide path);
// see refillStore.ts for the data model and the planned sales the coupon
// schedule uses.
//
// Progress: the buys from the withdrawal on, at what they cost (the gross
// amount at the trade-day rate, like the DCA goals), into what the goal
// refills — along the glide path every instrument that takes contributions,
// or the source / a chosen instrument. A buy another goal already counts (a
// dated goal's assigned instrument, a DCA goal's monthly share) is not counted
// twice. Several refill goals take the buys in the order of their withdrawal.
// Pure: the Célok page, the monthly plan, the leftover and the bot all read it.

import type { Account, Instrument, Transaction } from "./model";
import type { PortfolioSummary, PriceMap } from "./portfolio";
import { buildFxHistory, futureBondCashflows, histFxRate } from "./portfolio";
import { bondSaleForCash, BOND_TYPES } from "./bonds";
import { effectiveMonth, effectiveMonthKey, monthLabel, type Goal } from "./goals";
import { isActive, type GlideConfig } from "./glidePath";
import { computeSavingsProgress, type SavingsGoal } from "./savings";
import type { PlannedExpense } from "./forecast";
import type { Alert } from "./alerts";
import { formatMoney } from "./format";
import { touchPref } from "./prefs";
import { toLocalDay, txDay } from "./day";
import { tbszStatus } from "./tbsz";
import { outflowBlocked, type AccountLimits } from "./accountRules";
import {
  activeRefills,
  matchWithdrawals,
  plannedSales,
  refillAmountHuf,
  refillExpensesWith,
  REFILL_KEY,
  type PlannedSale,
  type RefillGoal,
  type RefillWithdrawal,
} from "./refillStore";

export * from "./refillStore";

/** Below this much left the refill counts as done (rounding, FX drift). */
export const REFILL_DONE_HUF = 1000;

export function saveRefills(goals: RefillGoal[]) {
  try {
    const json = JSON.stringify(goals);
    if (localStorage.getItem(REFILL_KEY) === json) return;
    localStorage.setItem(REFILL_KEY, json);
    touchPref("refill");
  } catch {
    /* ignore */
  }
}

export type RefillStatus =
  /** The set day is still ahead. */
  | "planned"
  /** The day is past but the sale isn't in the ledger yet (import it). */
  | "awaiting"
  | "refilling"
  | "done";

export interface RefillProgress {
  goal: RefillGoal;
  status: RefillStatus;
  /** The imported sale (holding source), once there. */
  sale?: Transaction;
  /** The day the money left: the sale's day, else the set day. */
  withdrawnDay: string;
  amountHuf: number;
  refilledHuf: number;
  remainingHuf: number;
  /** refilled / amount (0..1). */
  ratio: number;
  /** Put back in the current effective month. */
  thisMonthHuf: number;
  /** This month's part still owed (0 while planned or done). */
  needHuf: number;
  /** Months left for a "months" pace (the current one included). */
  monthsLeft?: number;
  /** The instrument the plan buys; undefined = along the glide path. */
  buyKey?: string;
  viaGlide: boolean;
  /** "a célpálya szerint" / an instrument's name. */
  targetLabel: string;
  sourceLabel: string;
  /** The "source" target can't be bought any more: the glide path takes it. */
  sourceUnbuyable?: boolean;
}

export interface RefillInput {
  goals: RefillGoal[];
  transactions: Transaction[];
  instruments: Map<string, Instrument>;
  fx: Record<string, number>;
  glide?: GlideConfig;
  /** DCA goals: their monthly share of a matching buy is theirs. */
  dcaGoals?: Goal[];
  /** Active dated goals: buys of their assigned instruments are theirs. */
  savingsGoals?: SavingsGoal[];
  accounts?: Account[];
  now?: Date;
}

export function sourceLabel(g: RefillGoal, instruments: Map<string, Instrument>, accounts: Account[] = []): string {
  const s = g.withdrawal.source;
  if (s.kind === "holding") return instruments.get(s.instrumentKey)?.name ?? s.instrumentKey;
  return accounts.find((a) => a.id === s.accountId)?.name ?? "készpénz";
}

/** Where the plan puts the money: the instrument to buy, or the glide path. */
function targetOf(
  g: RefillGoal,
  instruments: Map<string, Instrument>,
  glide: GlideConfig | undefined,
): { buyKey?: string; viaGlide: boolean; label: string; sourceUnbuyable?: boolean } {
  const glideOn = isActive(glide);
  const t = g.target;
  if (t.kind === "instrument")
    return { buyKey: t.instrumentKey, viaGlide: false, label: instruments.get(t.instrumentKey)?.name ?? t.instrumentKey };
  if (t.kind === "source") {
    const s = g.withdrawal.source;
    if (s.kind === "holding") {
      const inst = instruments.get(s.instrumentKey);
      if (inst && !inst.notBuyable)
        return { buyKey: s.instrumentKey, viaGlide: false, label: inst.name };
      if (glideOn) return { viaGlide: true, label: "a célpálya szerint", sourceUnbuyable: true };
      return { viaGlide: false, label: inst?.name ?? s.instrumentKey, sourceUnbuyable: true };
    }
  }
  if (glideOn) return { viaGlide: true, label: "a célpálya szerint" };
  return { viaGlide: false, label: "bármely vétel" };
}

/** May a buy of `key` count toward the goal? */
function eligible(
  g: RefillGoal,
  key: string,
  target: ReturnType<typeof targetOf>,
  glide: GlideConfig | undefined,
): boolean {
  if (target.buyKey) return key === target.buyKey;
  if (!isActive(glide)) return true;
  const rule = glide.instruments[key];
  if (!rule?.acceptsContributions) return false;
  // "Back to the source" through the glide path: the source's own bucket.
  if (g.target.kind === "source" && g.withdrawal.source.kind === "holding") {
    const bucket = glide.instruments[g.withdrawal.source.instrumentKey]?.bucketId;
    return !bucket || rule.bucketId === bucket;
  }
  return true;
}

function monthIndex(key: string): number {
  return +key.slice(0, 4) * 12 + (+key.slice(5, 7) - 1);
}

export function computeRefillProgress(a: RefillInput): RefillProgress[] {
  const now = a.now ?? new Date();
  const today = toLocalDay(now);
  const goals = activeRefills(a.goals);
  const sales = matchWithdrawals(goals, a.transactions);
  const fxHistory = buildFxHistory(a.transactions);
  const buyHuf = (t: Transaction): number => {
    const amt = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
    return t.currency === "HUF" ? amt : amt * histFxRate(fxHistory, t.currency, t.date, a.fx);
  };
  const curKey = effectiveMonthKey(now);
  const eff = effectiveMonth(now);

  // Buys other goals own.
  const savingsKeys = new Set((a.savingsGoals ?? []).filter((g) => !g.closedAt).flatMap((g) => g.instrumentKeys));
  const dcaLeft = new Map<string, number>(); // `${goalId}|${month}` → share left
  const dcaMatches = (goal: Goal, t: Transaction) =>
    goal.instrumentType
      ? a.instruments.get(t.instrumentKey ?? "")?.type === goal.instrumentType
      : t.instrumentKey === goal.instrumentKey;

  const buys = a.transactions
    .filter((t) => t.type === "buy" && !t.internal && t.instrumentKey)
    .sort((x, y) => txDay(x.date).localeCompare(txDay(y.date)));
  const free = new Map<string, number>(); // tx id → HUF not yet claimed
  for (const t of buys) {
    if (savingsKeys.has(t.instrumentKey!)) continue;
    let huf = buyHuf(t);
    const month = effectiveMonthKey(t.date);
    for (const goal of a.dcaGoals ?? []) {
      if (!dcaMatches(goal, t)) continue;
      const k = `${goal.id}|${month}`;
      const left = dcaLeft.get(k) ?? goal.amountHuf / goal.periodMonths;
      const take = Math.min(left, huf);
      dcaLeft.set(k, left - take);
      huf -= take;
    }
    if (huf > 0) free.set(t.id, huf);
  }

  const ordered = [...goals].sort((x, y) => {
    const dx = sales.get(x.id) ? txDay(sales.get(x.id)!.date) : x.withdrawal.day;
    const dy = sales.get(y.id) ? txDay(sales.get(y.id)!.date) : y.withdrawal.day;
    return dx.localeCompare(dy) || x.createdAt.localeCompare(y.createdAt);
  });
  const out = new Map<string, RefillProgress>();
  for (const g of ordered) {
    const sale = sales.get(g.id);
    const withdrawnDay = sale ? txDay(sale.date) : g.withdrawal.day.slice(0, 10);
    const target = targetOf(g, a.instruments, a.glide);
    const amountHuf = refillAmountHuf(g);
    const started = !!sale || withdrawnDay <= today;
    let refilled = 0;
    let thisMonth = 0;
    if (started)
      for (const t of buys) {
        if (refilled >= amountHuf) break;
        if (txDay(t.date) < withdrawnDay) continue;
        const avail = free.get(t.id) ?? 0;
        if (avail <= 0 || !eligible(g, t.instrumentKey!, target, a.glide)) continue;
        const take = Math.min(avail, amountHuf - refilled);
        free.set(t.id, avail - take);
        refilled += take;
        if (effectiveMonthKey(t.date) === curKey) thisMonth += take;
      }
    const remaining = Math.max(0, amountHuf - refilled);
    const done = started && remaining < REFILL_DONE_HUF;
    const status: RefillStatus = !started
      ? "planned"
      : done
        ? "done"
        : g.withdrawal.source.kind === "holding" && !sale
          ? "awaiting"
          : "refilling";

    let needHuf = 0;
    let monthsLeft: number | undefined;
    if (started && !done) {
      const pace = g.pace;
      if (pace.kind === "months") {
        const end = monthIndex(effectiveMonthKey(withdrawnDay)) + Math.max(1, Math.round(pace.months)) - 1;
        monthsLeft = Math.max(1, end - (eff.year * 12 + eff.month0) + 1);
        needHuf = Math.max(0, Math.min(remaining, (remaining + thisMonth) / monthsLeft - thisMonth));
      } else if (pace.kind === "monthly") {
        needHuf = Math.max(0, Math.min(remaining, pace.huf - thisMonth));
      } else {
        needHuf = remaining;
      }
    }
    out.set(g.id, {
      goal: g,
      status,
      sale,
      withdrawnDay,
      amountHuf,
      refilledHuf: refilled,
      remainingHuf: remaining,
      ratio: amountHuf > 0 ? Math.min(1, refilled / amountHuf) : 1,
      thisMonthHuf: thisMonth,
      needHuf,
      monthsLeft,
      buyKey: target.buyKey,
      viaGlide: target.viaGlide,
      targetLabel: target.label,
      sourceLabel: sourceLabel(g, a.instruments, a.accounts),
      sourceUnbuyable: target.sourceUnbuyable,
    });
  }
  // In the goals' own order (the list order the user sees).
  return goals.map((g) => out.get(g.id)!);
}

/**
 * What goes back this month, for display: the month's part — for "as soon as
 * possible" (which asks for the whole remainder) at most the monthly budget.
 */
export function refillMonthHuf(p: RefillProgress, budgetHuf: number): number {
  if (p.goal.pace.kind !== "asap") return p.needHuf;
  return Math.max(0, Math.min(p.needHuf, budgetHuf));
}

/**
 * Months still needed at `monthlyHuf` (the monthly budget for "asap") —
 * undefined when nothing goes in a month. 0 = done.
 */
export function refillMonthsToGo(p: RefillProgress, budgetHuf: number): number | undefined {
  if (p.remainingHuf < REFILL_DONE_HUF) return 0;
  const pace = p.goal.pace;
  const per =
    pace.kind === "monthly"
      ? pace.huf
      : pace.kind === "months"
        ? p.monthsLeft
          ? (p.remainingHuf + p.thisMonthHuf) / p.monthsLeft
          : 0
        : budgetHuf;
  if (!(per > 0)) return undefined;
  return Math.ceil((p.remainingHuf - 1e-6) / per);
}

/** The month the refill ends at its pace ("2027. május"); undefined when it never does. */
export function refillFinishLabel(p: RefillProgress, budgetHuf: number, now: Date = new Date()): string | undefined {
  const n = refillMonthsToGo(p, budgetHuf);
  if (n == null) return undefined;
  const start = p.status === "planned" ? effectiveMonth(new Date(`${p.withdrawnDay}T12:00:00`)) : effectiveMonth(now);
  // This month still counts as one when its part is still owed.
  const m = start.year * 12 + start.month0 + Math.max(0, n - 1);
  return monthLabel(Math.floor(m / 12), m % 12);
}

/** The withdrawals still ahead (or not imported yet) as planned forecast expenses. */
export function refillExpenses(
  goals: RefillGoal[],
  transactions: Transaction[],
  instruments: Map<string, Instrument>,
): PlannedExpense[] {
  return refillExpensesWith(goals, transactions, (k) => {
    const t = instruments.get(k)?.type;
    return !!t && BOND_TYPES.has(t);
  });
}

/** Fills in the face and the cost of a bond withdrawal from its cash and day. */
export function withBondFigures(w: RefillWithdrawal, instruments: Map<string, Instrument>): RefillWithdrawal {
  const src = w.source;
  if (src.kind !== "holding") return { ...w, faceHuf: undefined, costHuf: undefined };
  const sale = bondSaleForCash(instruments.get(src.instrumentKey), w.amountHuf, w.day);
  if (!sale) return { ...w, faceHuf: undefined, costHuf: undefined };
  return { ...w, faceHuf: sale.faceHuf, costHuf: Math.round(sale.saleCostHuf) };
}

// ---- What the withdrawal does (the form's preview) --------------------------

export interface RefillGoalEffect {
  goalId: string;
  name: string;
  /** The goal's coupons still to come (picked + includeCoupons), before → after. */
  couponsBeforeHuf: number;
  couponsAfterHuf: number;
  gapBeforeHuf: number;
  gapAfterHuf: number;
  monthlyBeforeHuf: number;
  monthlyAfterHuf: number;
}

export interface RefillImpact {
  /** A bond sale: face to sell, accrued, settlement day. */
  bond?: ReturnType<typeof bondSaleForCash>;
  /** Early-redemption cost (≥ 0). */
  saleCostHuf: number;
  /** Money may not leave the account then (TBSZ lock-in…): its note. */
  blocked?: string;
  /** Breaking a TBSZ: the tax on its whole gain. */
  tbszTaxHuf?: number;
  /** Coupons lost in the next 12 months and up to maturity. */
  lostCoupons12Huf: number;
  lostCouponsTotalHuf: number;
  /** Dated goals whose coupons shrink. */
  goals: RefillGoalEffect[];
  /** The source holding's value now (the most it can give). */
  availableHuf?: number;
}

export interface RefillImpactInput {
  withdrawal: RefillWithdrawal;
  /** The goal being edited (left out of the "before" picture). */
  goalId?: string;
  refills: RefillGoal[];
  summary: PortfolioSummary;
  accounts: Account[];
  transactions: Transaction[];
  instruments: Map<string, Instrument>;
  prices: PriceMap;
  fx: Record<string, number>;
  savingsGoals: SavingsGoal[];
  accountLimits?: AccountLimits;
  now?: Date;
}

export function refillImpact(a: RefillImpactInput): RefillImpact {
  const now = a.now ?? new Date();
  const w = a.withdrawal;
  const src = w.source;
  const others = a.refills.filter((g) => g.id !== a.goalId);
  const base: PlannedSale[] = plannedSales(others, a.transactions);
  const inst = src.kind === "holding" ? a.instruments.get(src.instrumentKey) : undefined;
  const bond = src.kind === "holding" ? bondSaleForCash(inst, w.amountHuf, w.day) : undefined;
  const sale: PlannedSale | undefined =
    src.kind === "holding" && inst && BOND_TYPES.has(inst.type)
      ? {
          instrumentKey: src.instrumentKey,
          accountId: src.accountId,
          day: w.day.slice(0, 10),
          quantity: bond?.faceHuf ?? w.amountHuf,
        }
      : undefined;
  const after = sale ? [...base, sale] : base;

  const accountId = src.accountId;
  const account = a.summary.accounts.find((x) => x.account.id === accountId);
  const holding =
    src.kind === "holding"
      ? account?.holdings.find((h) => h.instrumentKey === src.instrumentKey) ??
        a.summary.accounts.flatMap((x) => x.holdings).find((h) => h.instrumentKey === src.instrumentKey)
      : undefined;

  let blocked: string | undefined;
  if (accountId && a.accountLimits && outflowBlocked(a.accountLimits, accountId, w.day.slice(0, 10)))
    blocked = a.accountLimits[accountId]?.noOutflowNote || `a számláról ${a.accountLimits[accountId]?.noOutflowUntil}-ig nem vehető ki pénz`;
  let tbszTaxHuf: number | undefined;
  if (account?.account.kind === "tbsz" && account.account.tbszYear) {
    const rate = tbszStatus(account.account.tbszYear, now).taxRate;
    tbszTaxHuf = Math.max(0, account.totalValueHuf - account.capitalBasisHuf) * rate;
  }

  // Coupons lost: the schedule with the sale vs without it.
  const couponsOf = (sales: PlannedSale[]) =>
    futureBondCashflows(a.summary, now, a.transactions, sales).filter((c) => c.kind === "coupon");
  const sum = (xs: { amountHuf: number; date: string }[], until?: string) =>
    xs.filter((c) => !until || c.date <= until).reduce((s, c) => s + c.amountHuf, 0);
  const in12 = toLocalDay(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));
  const cBefore = couponsOf(base);
  const cAfter = couponsOf(after);

  const goals: RefillGoalEffect[] = [];
  if (sale) {
    const active = a.savingsGoals.filter((g) => !g.closedAt);
    const pb = computeSavingsProgress(active, a.accounts, a.transactions, a.instruments, a.prices, a.fx, now, base);
    const pa = computeSavingsProgress(active, a.accounts, a.transactions, a.instruments, a.prices, a.fx, now, after);
    for (const b of pb) {
      const x = pa.find((p) => p.goal.id === b.goal.id);
      if (!x) continue;
      if (Math.abs(b.couponsHuf - x.couponsHuf) < 1 && Math.abs(b.gapHuf - x.gapHuf) < 1) continue;
      goals.push({
        goalId: b.goal.id,
        name: b.goal.name,
        couponsBeforeHuf: b.couponsHuf,
        couponsAfterHuf: x.couponsHuf,
        gapBeforeHuf: b.gapHuf,
        gapAfterHuf: x.gapHuf,
        monthlyBeforeHuf: b.monthlyNeededHuf,
        monthlyAfterHuf: x.monthlyNeededHuf,
      });
    }
  }

  return {
    bond,
    saleCostHuf: bond?.saleCostHuf ?? 0,
    blocked,
    tbszTaxHuf,
    lostCoupons12Huf: Math.max(0, sum(cBefore, in12) - sum(cAfter, in12)),
    lostCouponsTotalHuf: Math.max(0, sum(cBefore) - sum(cAfter)),
    goals,
    availableHuf:
      src.kind === "holding"
        ? holding?.redeemableValueHuf ?? holding?.marketValueHuf
        : account?.cashValueHuf,
  };
}

// ---- Alerts -------------------------------------------------------------------

export function refillAlerts(progress: RefillProgress[], budgetHuf: number, now: Date = new Date()): Alert[] {
  const out: Alert[] = [];
  for (const p of progress) {
    const id = p.goal.id;
    if (p.status === "awaiting")
      out.push({
        id: `refill-import:${id}`,
        severity: "medium",
        title: `Visszapótlás – ${p.goal.name}: nem látom az eladást`,
        detail: `${p.withdrawnDay}-re terveztél kivételt (${p.sourceLabel}, ${formatMoney(p.goal.withdrawal.amountHuf)}), de az eladás még nincs a nyilvántartásban — importáld a kivonatot, vagy állítsd át a dátumot. Addig a kuponokat a kisebb névértékkel számolom.`,
        to: "/goals",
        actionLabel: "Célok",
      });
    if (p.status === "done")
      out.push({
        id: `refill-done:${id}`,
        severity: "info",
        title: `Visszapótlás kész – ${p.goal.name}`,
        detail: `Visszakerült ${formatMoney(p.refilledHuf)}. Lezárhatod a célt; a havi terv újra a szokásos rendben oszt.`,
        to: "/goals",
        actionLabel: "Célok",
      });
    if (p.status === "refilling" && p.needHuf >= 1) {
      const fin = refillFinishLabel(p, budgetHuf, now);
      out.push({
        id: `refill:${id}:${effectiveMonthKey(now)}`,
        severity: "medium",
        title: `Visszapótlás – ${p.goal.name}`,
        detail: `Még ${formatMoney(p.remainingHuf)} van hátra (${formatMoney(p.refilledHuf)} / ${formatMoney(p.amountHuf)}); e hónapban ${formatMoney(refillMonthHuf(p, budgetHuf))} → ${p.targetLabel}${fin ? `, várhatóan ${fin}-ig kész` : ""}.`,
        to: "/goals",
        actionLabel: "Célok",
      });
    }
  }
  return out;
}
