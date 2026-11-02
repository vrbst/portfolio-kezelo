// Refill goals ("Visszapótlás"): money taken out of the portfolio — on a set
// day, from a set holding or account — that the monthly saving then puts back
// (after the dated goals). This module is the dependency-light part: the data model, loading,
// matching the withdrawal to the imported sale, and the PLANNED sales that the
// coupon schedule (bonds.ts) and the forecast take into account before the
// sale shows up in the ledger. It must not import the portfolio maths (bonds.ts
// imports it). The rest — progress, the monthly part, alerts, saving — is in
// refill.ts.

import type { Transaction } from "./model";
import { addDaysIso, txDay } from "./day";
import type { PlannedExpense } from "./forecast";

export type RefillSource =
  /** A security sold for the money (a FixMÁP series, an ETF…). */
  | { kind: "holding"; instrumentKey: string; accountId?: string }
  /** Cash taken off an account. */
  | { kind: "cash"; accountId: string };

export type RefillTarget =
  /** Along the glide path, like any incoming money (the default). */
  | { kind: "glide" }
  /** Back into what it came from (if it can still be bought). */
  | { kind: "source" }
  | { kind: "instrument"; instrumentKey: string };

export type RefillPace =
  /** First in the monthly plan with the whole remainder (the default). */
  | { kind: "asap" }
  /** Spread evenly over this many months from the withdrawal. */
  | { kind: "months"; months: number }
  /** A fixed monthly amount. */
  | { kind: "monthly"; huf: number };

export interface RefillWithdrawal {
  /** YYYY-MM-DD: when the money is (to be) taken out. May be in the future. */
  day: string;
  source: RefillSource;
  /** Cash taken out (in hand) — what the refill puts back by default. */
  amountHuf: number;
  /**
   * A bond source: the FACE to sell on the day for that cash (face + accrued −
   * the early-redemption cost, see bondSaleForCash), worked out when saved.
   * Missing (not a bond, or unknown terms): the cash amount is the units sold.
   */
  faceHuf?: number;
  /**
   * What the sale costs on top (FixMÁP: 1% of the face), as worked out when
   * saved. Refilled too only with includeCost.
   */
  costHuf?: number;
}

export interface RefillGoal {
  id: string;
  name: string;
  createdAt: string;
  withdrawal: RefillWithdrawal;
  target: RefillTarget;
  pace: RefillPace;
  /** Put back the sale cost too (the portfolio's whole value drop), not only the cash. */
  includeCost?: boolean;
  /** YYYY-MM-DD: closed (refilled, or given up). Kept, but out of every calculation. */
  closedAt?: string;
}

export const REFILL_KEY = "pf-refill";

/** A sale this many days before the set day still counts as the withdrawal. */
export const REFILL_MATCH_DAYS = 14;

function valid(g: unknown): g is RefillGoal {
  const r = g as RefillGoal;
  return (
    !!r &&
    typeof r.id === "string" &&
    !!r.withdrawal &&
    typeof r.withdrawal.day === "string" &&
    !!r.withdrawal.source &&
    Number.isFinite(r.withdrawal.amountHuf)
  );
}

export function loadRefills(): RefillGoal[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REFILL_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid) : [];
  } catch {
    return [];
  }
}

/** The amount to put back: the cash taken out, plus the sale cost with includeCost. */
export function refillAmountHuf(g: RefillGoal): number {
  return g.withdrawal.amountHuf + (g.includeCost ? (g.withdrawal.costHuf ?? 0) : 0);
}

export function activeRefills(goals: RefillGoal[]): RefillGoal[] {
  return goals.filter((g) => !g.closedAt);
}

export function loadActiveRefills(): RefillGoal[] {
  return activeRefills(loadRefills());
}

/**
 * The imported sale that carried out the withdrawal: the first sell of the
 * source holding from {@link REFILL_MATCH_DAYS} days before the set day on.
 * Each sale belongs to one goal at most (the earliest-dated goal first).
 * Cash withdrawals are not matched (the set day decides).
 */
export function matchWithdrawals(
  goals: RefillGoal[],
  transactions: Transaction[],
): Map<string, Transaction> {
  const out = new Map<string, Transaction>();
  const used = new Set<string>();
  const sells = transactions
    .filter((t) => t.type === "sell" && !t.internal && t.instrumentKey)
    .sort((a, b) => txDay(a.date).localeCompare(txDay(b.date)));
  const ordered = [...goals].sort((a, b) => a.withdrawal.day.localeCompare(b.withdrawal.day));
  for (const g of ordered) {
    const src = g.withdrawal.source;
    if (src.kind !== "holding") continue;
    const from = addDaysIso(g.withdrawal.day.slice(0, 10), -REFILL_MATCH_DAYS);
    const t = sells.find(
      (s) =>
        !used.has(s.id) &&
        s.instrumentKey === src.instrumentKey &&
        (!src.accountId || s.accountId === src.accountId) &&
        txDay(s.date) >= from,
    );
    if (t) {
      used.add(t.id);
      out.set(g.id, t);
    }
  }
  return out;
}

/** A sale the ledger doesn't show yet: coupons after `day` are on the smaller face. */
export interface PlannedSale {
  instrumentKey: string;
  accountId?: string;
  /** YYYY-MM-DD. */
  day: string;
  /** Units sold (a bond's face in HUF). */
  quantity: number;
}

/**
 * The withdrawals not yet seen in the ledger, as planned sales of their
 * holding — the set day may be past (the sale just isn't imported yet).
 */
export function plannedSales(
  goals: RefillGoal[],
  transactions: Transaction[],
): PlannedSale[] {
  const active = activeRefills(goals);
  const matched = matchWithdrawals(active, transactions);
  const out: PlannedSale[] = [];
  for (const g of active) {
    const src = g.withdrawal.source;
    if (src.kind !== "holding" || matched.has(g.id) || !(g.withdrawal.amountHuf > 0)) continue;
    out.push({
      instrumentKey: src.instrumentKey,
      accountId: src.accountId,
      day: g.withdrawal.day.slice(0, 10),
      quantity: g.withdrawal.faceHuf ?? g.withdrawal.amountHuf,
    });
  }
  return out;
}

/** The planned sales from the stored goals (none outside a browser / bot run). */
export function storedPlannedSales(transactions: Transaction[]): PlannedSale[] {
  return plannedSales(loadRefills(), transactions);
}

/**
 * How much of a holding's `quantity` a coupon / redemption on `day` is paid
 * on, with the planned sales on or before that day taken off. A sale names its
 * account (the form picks a holding); one without an account applies to every
 * holding of the instrument.
 */
export function quantityAfterSales(
  instrumentKey: string,
  accountId: string,
  quantity: number,
  day: string,
  sales: PlannedSale[],
): number {
  let q = quantity;
  for (const s of sales) {
    if (s.instrumentKey !== instrumentKey) continue;
    if (s.accountId && s.accountId !== accountId) continue;
    // A sale on the coupon day itself: the coupon goes to the new owner.
    if (s.day <= day.slice(0, 10)) q -= s.quantity;
  }
  return Math.max(0, q);
}

/**
 * The withdrawals still ahead (or not imported yet) as planned expenses for
 * the forecast: a bond sale shrinks the bond leg (`bondSale`), anything else
 * is paid from the liquid part. Sold-and-imported ones are in the ledger.
 */
export function refillExpensesWith(
  goals: RefillGoal[],
  transactions: Transaction[],
  isBond: (instrumentKey: string) => boolean,
): PlannedExpense[] {
  const active = activeRefills(goals);
  const matched = matchWithdrawals(active, transactions);
  const out: PlannedExpense[] = [];
  for (const g of active) {
    if (matched.has(g.id)) continue;
    const src = g.withdrawal.source;
    const day = g.withdrawal.day.slice(0, 10);
    out.push({
      id: `refill:${g.id}`,
      date: day,
      amountHuf: g.withdrawal.amountHuf + (g.withdrawal.costHuf ?? 0),
      note: `Kivét: ${g.name}`,
      ...(src.kind === "holding" && isBond(src.instrumentKey)
        ? {
            bondSale: {
              instrumentKey: src.instrumentKey,
              accountId: src.accountId,
              day,
              quantity: g.withdrawal.faceHuf ?? g.withdrawal.amountHuf,
            },
          }
        : {}),
    });
  }
  return out;
}
