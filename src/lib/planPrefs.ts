// Two small synced planning prefs, kept apart from the heavier modules so
// prefs.ts can load them without an import cycle:
//  - broker fees: a buy / sell cost per broker (account provider), used when
//    neither the glide path's bucket rule nor the bond's own redemption cost
//    applies (e.g. a DCA buy of an ETF outside the glide path);
//  - the monthly plan's order: which goal gets the monthly saving first;
//  - account limits and the dated "account for new buys" per instrument
//    (see accountRules);
//  - the month-end leftover: its reminder and the pull-forward rule.

import { touchPref } from "./prefs";
import type { CostRule } from "./glidePath";
import type { AccountLimits, PurchaseAccounts } from "./accountRules";

/** A broker's buy / sell cost, plus what moving money through it costs. */
export interface BrokerFee extends CostRule {
  /** Currency conversion (fraction of the converted amount). */
  fxPct?: number;
  /** Fixed fee of sending money out of an account there (HUF). */
  transferFixedHuf?: number;
}

/** Provider (e.g. "lightyear", "allamkincstar") → its fees. */
export type BrokerFees = Record<string, BrokerFee>;

const FEES_KEY = "pf-broker-fees";

export function loadBrokerFees(): BrokerFees {
  try {
    const raw = localStorage.getItem(FEES_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as BrokerFees) : {};
  } catch {
    return {};
  }
}

export function saveBrokerFees(fees: BrokerFees) {
  try {
    const json = JSON.stringify(fees);
    if (localStorage.getItem(FEES_KEY) === json) return;
    localStorage.setItem(FEES_KEY, json);
    touchPref("brokerFees");
  } catch {
    /* ignore */
  }
}

/**
 * Keys of the monthly plan's goal items in the user's order
 * (`savings:<id>`, `dca:<id>`). Goals missing from it follow in the default
 * order; the glide path always comes last (it takes whatever is left).
 */
export type PlanOrder = string[];

const ORDER_KEY = "pf-plan-order";

export function loadPlanOrder(): PlanOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function savePlanOrder(order: PlanOrder) {
  try {
    const json = JSON.stringify(order);
    if (localStorage.getItem(ORDER_KEY) === json) return;
    localStorage.setItem(ORDER_KEY, json);
    touchPref("planOrder");
  } catch {
    /* ignore */
  }
}

function loadObject<T>(key: string): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : {};
    return (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as T;
  } catch {
    return {} as T;
  }
}

function saveObject(
  key: string,
  kind: "accountLimits" | "purchaseAccounts" | "leftover",
  v: unknown,
) {
  try {
    const json = JSON.stringify(v);
    if (localStorage.getItem(key) === json) return;
    localStorage.setItem(key, json);
    touchPref(kind);
  } catch {
    /* ignore */
  }
}

const LIMITS_KEY = "pf-account-limits";
const PURCHASE_KEY = "pf-purchase-accounts";

/** Account id → limits (no outflow until / no deposit from). */
export function loadAccountLimits(): AccountLimits {
  return loadObject<AccountLimits>(LIMITS_KEY);
}

export function saveAccountLimits(v: AccountLimits) {
  saveObject(LIMITS_KEY, "accountLimits", v);
}

/** Instrument key → dated account for new buys. */
export function loadPurchaseAccounts(): PurchaseAccounts {
  return loadObject<PurchaseAccounts>(PURCHASE_KEY);
}

export function savePurchaseAccounts(v: PurchaseAccounts) {
  saveObject(PURCHASE_KEY, "purchaseAccounts", v);
}

/** Month-end leftover ("hónap végi maradék") settings. */
export interface LeftoverSettings {
  /** The bot asks on the month's last working day. */
  notify: boolean;
  /** When to ask ("HH:MM", local time). */
  time: string;
  /** Pull next month's part of dated goals forward. */
  pullForward: boolean;
  /** …only for goals whose date is within this many months. */
  pullForwardMonths: number;
}

export const DEFAULT_LEFTOVER: LeftoverSettings = {
  notify: true,
  time: "17:00",
  pullForward: true,
  pullForwardMonths: 2,
};

const LEFTOVER_KEY = "pf-leftover";

export function loadLeftoverSettings(): LeftoverSettings {
  const v = loadObject<Partial<LeftoverSettings>>(LEFTOVER_KEY);
  const months = Number(v.pullForwardMonths);
  return {
    notify: typeof v.notify === "boolean" ? v.notify : DEFAULT_LEFTOVER.notify,
    time:
      typeof v.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)
        ? v.time
        : DEFAULT_LEFTOVER.time,
    pullForward:
      typeof v.pullForward === "boolean" ? v.pullForward : DEFAULT_LEFTOVER.pullForward,
    pullForwardMonths:
      Number.isFinite(months) && months >= 1
        ? Math.min(24, Math.round(months))
        : DEFAULT_LEFTOVER.pullForwardMonths,
  };
}

export function saveLeftoverSettings(v: LeftoverSettings) {
  saveObject(LEFTOVER_KEY, "leftover", v);
}
