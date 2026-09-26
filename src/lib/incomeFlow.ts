// Incoming money from the ledger — bond coupons, cash interest, dividends and
// redemptions — and its automatic split with goal priority: goals that claim
// it (see incomeClaims.ts) first, up to their room; the rest along the glide
// path (planCashflow, towards the configured flow target). Events are handled
// in date order and build on each other: a goal's share shrinks its room for
// the next event, and the glide path's suggested buys shift the state the
// next event is routed on.
//
// "Még el nem osztott": events from the tracking start on, minus the ones
// marked as distributed (or saved as a plan). Both live in a synced pref.

import type { Account, Instrument, Transaction } from "./model";
import type { SavingsProgress } from "./savings";
import { touchPref } from "./prefs";
import { isActive, type GlideConfig } from "./glidePath";
import type { Alert } from "./alerts";
import { formatMoney } from "./format";
import {
  applyTrades,
  planCashflow,
  suggestionText,
  type AllocationState,
  type FlowTargets,
  type RebalancePlan,
} from "./rebalance";
import {
  claimsCoupon,
  incomeHuf,
  isBondCoupon,
  splitAmongGoals,
} from "./incomeClaims";

export type IncomeKind = "coupon" | "interest" | "dividend" | "redemption";

export const INCOME_KIND_LABEL: Record<IncomeKind, string> = {
  coupon: "kupon",
  interest: "kamat",
  dividend: "osztalék",
  redemption: "lejárat",
};

export interface IncomeEvent {
  /** The ledger transaction's id. */
  id: string;
  /** YYYY-MM-DD. */
  day: string;
  kind: IncomeKind;
  instrumentKey?: string;
  instrumentName?: string;
  accountId: string;
  /** Broker / provider of the account (e.g. "allamkincstar", "lightyear"). */
  provider: string;
  currency: string;
  /** Amount in `currency` (net of tax). */
  amount: number;
  amountHuf: number;
}

export interface IncomeAllocation {
  event: IncomeEvent;
  /** Goal shares, largest first. */
  goals: { goalId: string; name: string; huf: number }[];
  /** A goal's own instrument matured: the money is that goal's payout. */
  payoutOf?: string[];
  /** What is left for the glide path. */
  glideHuf: number;
  /** The glide path's suggestions for glideHuf (null: off or nothing left). */
  plan: (RebalancePlan & { flow: FlowTargets }) | null;
}

/** Ledger income from `since` (YYYY-MM-DD) on, oldest first. Deposits are not income here. */
export function incomeEvents(
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  accounts: Account[],
  fx: Record<string, number>,
  since: string,
): IncomeEvent[] {
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const out: IncomeEvent[] = [];
  for (const t of txs) {
    if (t.internal) continue;
    if (t.type !== "interest" && t.type !== "dividend" && t.type !== "redemption")
      continue;
    const day = t.date.slice(0, 10);
    if (day < since) continue;
    const amountHuf = incomeHuf(t, fx);
    if (!(amountHuf > 0)) continue;
    const kind: IncomeKind =
      t.type === "interest"
        ? isBondCoupon(t, instruments)
          ? "coupon"
          : "interest"
        : t.type;
    out.push({
      id: t.id,
      day,
      kind,
      instrumentKey: t.instrumentKey,
      instrumentName: t.instrumentKey
        ? (instruments.get(t.instrumentKey)?.name ?? t.instrumentKey)
        : undefined,
      accountId: t.accountId,
      provider: accById.get(t.accountId)?.provider ?? "",
      currency: t.currency,
      amount: Math.abs(t.netAmount ?? t.grossAmount ?? 0),
      amountHuf,
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

/**
 * Split each event (oldest first): the claiming goals' shares, then the
 * glide path's routing of the rest. A redemption of an instrument assigned to
 * a goal still ahead is that goal's payout and is not split.
 */
export function allocateIncome(
  events: IncomeEvent[],
  progress: SavingsProgress[],
  glide: GlideConfig | undefined,
  state: AllocationState | null,
): IncomeAllocation[] {
  const room = new Map(progress.map((p) => [p.goal.id, p.couponRoomHuf]));
  let cur = state;
  const out: IncomeAllocation[] = [];
  for (const event of [...events].sort((a, b) => a.day.localeCompare(b.day))) {
    if (event.kind === "redemption" && event.instrumentKey) {
      const owners = progress.filter(
        (p) =>
          p.goal.instrumentKeys.includes(event.instrumentKey!) &&
          event.day <= p.goal.targetDate.slice(0, 10),
      );
      if (owners.length) {
        out.push({
          event,
          goals: [],
          payoutOf: owners.map((p) => p.goal.name),
          glideHuf: 0,
          plan: null,
        });
        continue;
      }
    }
    const claimants =
      event.kind === "coupon"
        ? progress
            .filter((p) => claimsCoupon({ ...p, couponRoomHuf: room.get(p.goal.id) ?? 0 }, event.day))
            .map((p) => ({ goalId: p.goal.id, capHuf: room.get(p.goal.id) ?? 0 }))
        : [];
    const shares = splitAmongGoals(event.amountHuf, claimants);
    const goals = [...shares]
      .map(([goalId, huf]) => ({
        goalId,
        name: progress.find((p) => p.goal.id === goalId)?.goal.name ?? goalId,
        huf,
      }))
      .sort((a, b) => b.huf - a.huf);
    for (const g of goals) room.set(g.goalId, (room.get(g.goalId) ?? 0) - g.huf);
    const glideHuf = Math.max(0, event.amountHuf - goals.reduce((s, g) => s + g.huf, 0));
    let plan: IncomeAllocation["plan"] = null;
    if (glideHuf > 0 && isActive(glide) && cur) {
      plan = planCashflow(glide, cur, glideHuf);
      cur = applyTrades(cur, plan.suggestions);
    }
    out.push({ event, goals, glideHuf, plan });
  }
  return out;
}

// ---- Tracking state (synced pref) -----------------------------------------

export interface IncomeState {
  /** Tracking start (YYYY-MM-DD): older income is never listed. */
  since: string;
  /** Event ids marked as distributed (or saved as a plan). */
  allocated: string[];
}

const STORE_KEY = "pf-income";

/** How far back the tracking reaches when it is first switched on. */
export const INCOME_LOOKBACK_DAYS = 30;

export function loadIncomeState(): IncomeState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<IncomeState>) : null;
    return v && typeof v.since === "string"
      ? { since: v.since, allocated: Array.isArray(v.allocated) ? v.allocated : [] }
      : null;
  } catch {
    return null;
  }
}

function saveIncomeState(s: IncomeState) {
  try {
    const json = JSON.stringify(s);
    if (localStorage.getItem(STORE_KEY) === json) return;
    localStorage.setItem(STORE_KEY, json);
    touchPref("income");
  } catch {
    /* ignore */
  }
}

/** Two devices' states: the earlier start, every id either marked. */
export function mergeIncomeState(
  a: IncomeState | null | undefined,
  b: IncomeState | null | undefined,
): IncomeState | null {
  if (!a?.since) return b?.since ? b : null;
  if (!b?.since) return a;
  return {
    since: a.since < b.since ? a.since : b.since,
    allocated: [...new Set([...a.allocated, ...b.allocated])].sort(),
  };
}

/** The state, switching tracking on (today − lookback) the first time. */
export function ensureIncomeState(today: string): IncomeState {
  const cur = loadIncomeState();
  if (cur) return cur;
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - INCOME_LOOKBACK_DAYS);
  const since = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const s = { since, allocated: [] };
  saveIncomeState(s);
  return s;
}

/** Mark events as distributed — they don't show again (on any device). */
export function markIncomeAllocated(ids: string[]) {
  const cur = loadIncomeState();
  if (!cur) return;
  saveIncomeState(mergeIncomeState(cur, { since: cur.since, allocated: ids })!);
}

/** Events not yet distributed (null state = tracking not switched on: none). */
export function pendingIncome(
  events: IncomeEvent[],
  st: IncomeState | null,
): IncomeEvent[] {
  if (!st) return [];
  const done = new Set(st.allocated);
  return events.filter((e) => e.day >= st.since && !done.has(e.id));
}

// ---- Text (panel, alerts, Telegram) -----------------------------------------

const PROVIDER_LABEL: Record<string, string> = {
  allamkincstar: "Kincstár",
  lightyear: "Lightyear",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/** "Kupon – Fix 2031 · 2026-10-22 · 700 000 Ft (Kincstár, HUF)". */
export function incomeEventTitle(e: IncomeEvent): string {
  const what = INCOME_KIND_LABEL[e.kind];
  const amount =
    e.currency === "HUF"
      ? formatMoney(e.amountHuf)
      : `${formatMoney(e.amount, e.currency)} ≈ ${formatMoney(e.amountHuf)}`;
  return `${what[0].toUpperCase()}${what.slice(1)}${e.instrumentName ? ` – ${e.instrumentName}` : ""} · ${e.day} · ${amount} (${providerLabel(e.provider)}, ${e.currency})`;
}

/** "Babaváró: 550 000 Ft → célpálya: 150 000 Ft → Vétel: VWCE … (≈ 63 369 Ft)". */
export function incomeSplitText(a: IncomeAllocation): string {
  if (a.payoutOf?.length)
    return `${a.payoutOf.join(", ")} kifizetése — a cél saját eszköze járt le, nem kell elosztani.`;
  const parts = a.goals.map((g) => `${g.name}: ${formatMoney(g.huf)}`);
  if (a.glideHuf >= 1) {
    parts.push(`célpálya: ${formatMoney(a.glideHuf)}`);
    const steps = (a.plan?.suggestions ?? []).filter((s) => s.status === "ok");
    if (steps.length) parts.push(steps.map(suggestionText).join("; "));
    else if (a.plan) parts.push("nincs javasolt vétel (a minimum alatt)");
  }
  return parts.join(" → ");
}

export const INCOME_ALERT_PREFIX = "income:";

/** One medium alert per event not yet distributed (the bot sends each once). */
export function incomeAlerts(allocs: IncomeAllocation[]): Alert[] {
  return allocs.map((a) => ({
    id: `${INCOME_ALERT_PREFIX}${a.event.id}`,
    severity: "medium" as const,
    title: `Beérkezett: ${incomeEventTitle(a.event)}`,
    detail: incomeSplitText(a),
    to: "/goals",
    actionLabel: "Teendők",
  }));
}
