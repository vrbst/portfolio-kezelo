// Two small synced planning prefs, kept apart from the heavier modules so
// prefs.ts can load them without an import cycle:
//  - broker fees: a buy / sell cost per broker (account provider), used when
//    neither the glide path's bucket rule nor the bond's own redemption cost
//    applies (e.g. a DCA buy of an ETF outside the glide path);
//  - the monthly plan's order: which goal gets the monthly saving first.

import { touchPref } from "./prefs";
import type { CostRule } from "./glidePath";

/** Provider (e.g. "lightyear", "allamkincstar") → its buy / sell cost. */
export type BrokerFees = Record<string, CostRule>;

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
