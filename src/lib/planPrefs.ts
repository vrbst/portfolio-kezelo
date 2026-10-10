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
  kind: "accountLimits" | "purchaseAccounts" | "leftover" | "moveAlerts" | "notify",
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
  time: "09:00",
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

export interface MoveAlertSettings {
  portfolioPct?: number;
  positionPct?: number;
  byKey: Record<string, number>;
}

const MOVE_ALERTS_KEY = "pf-move-alerts";

const positivePct = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

export function loadMoveAlertSettings(): MoveAlertSettings {
  const v = loadObject<Partial<MoveAlertSettings>>(MOVE_ALERTS_KEY);
  const byKey: Record<string, number> = {};
  if (v.byKey && typeof v.byKey === "object" && !Array.isArray(v.byKey))
    for (const [k, pct] of Object.entries(v.byKey)) {
      const p = positivePct(pct);
      if (p !== undefined) byKey[k] = p;
    }
  const portfolioPct = positivePct(v.portfolioPct);
  const positionPct = positivePct(v.positionPct);
  return {
    ...(portfolioPct !== undefined ? { portfolioPct } : {}),
    ...(positionPct !== undefined ? { positionPct } : {}),
    byKey,
  };
}

export function saveMoveAlertSettings(v: MoveAlertSettings) {
  saveObject(MOVE_ALERTS_KEY, "moveAlerts", v);
}

/** The Telegram message types that can be switched off one by one. */
export const NOTIFY_KINDS = [
  "alerts",
  "deepGlide",
  "portfolioMove",
  "positionMove",
  "stale",
  "stalePrices",
  "bondNotices",
  "weekly",
  "monthly",
  "yearly",
  "tax",
  "planReminder",
  "goalMilestones",
  "wealthPeak",
  "drawdown",
  "priceAlerts",
  "fundamentals",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** AI jobs: don't run / run, no message (the result stays in the app) / run and message. */
export type AiMode = "off" | "silent" | "notify";
export const AI_MODES: AiMode[] = ["off", "silent", "notify"];

export interface NotifySettings {
  /** Only the switched-off types; a missing one is on. */
  off: Partial<Record<NotifyKind, true>>;
  ai: {
    newsMorning: AiMode;
    newsEvening: AiMode;
    analysis: AiMode;
    /** "Miért mozdult?" — its result is a message only, so on / off. */
    why: "off" | "notify";
  };
  /** Wealth milestone step (HUF) / drawdown step (%); empty → the bot's .env → default. */
  wealthStepHuf?: number;
  drawdownStepPct?: number;
  /** From this hour on Friday the weekly report is due. */
  weeklyHour: number;
  /** From this hour on the 1st the monthly (and the year's first) report is due. */
  monthlyHour: number;
  /** From this day of the month the monthly plan reminder is due. */
  planReminderDay: number;
  /** Quiet hours ("HH:MM", local time) the hub holds normal messages in; null = none. */
  quietHours: { from: string; to: string } | null;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  off: {},
  ai: { newsMorning: "notify", newsEvening: "notify", analysis: "notify", why: "notify" },
  weeklyHour: 18,
  monthlyHour: 8,
  planReminderDay: 10,
  quietHours: { from: "22:00", to: "07:30" },
};

const NOTIFY_KEY = "pf-notify";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const intIn = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function loadNotifySettings(): NotifySettings {
  const v = loadObject<Partial<NotifySettings>>(NOTIFY_KEY);
  const off: NotifySettings["off"] = {};
  if (v.off && typeof v.off === "object" && !Array.isArray(v.off))
    for (const k of NOTIFY_KINDS) if ((v.off as Record<string, unknown>)[k] === true) off[k] = true;
  const ai = (v.ai && typeof v.ai === "object" ? v.ai : {}) as Partial<NotifySettings["ai"]>;
  const mode = (x: unknown, d: AiMode) => (AI_MODES.includes(x as AiMode) ? (x as AiMode) : d);
  const q = v.quietHours as { from?: unknown; to?: unknown } | null | undefined;
  const quietHours =
    q === null
      ? null
      : q && typeof q.from === "string" && typeof q.to === "string" && HHMM.test(q.from) && HHMM.test(q.to)
        ? { from: q.from, to: q.to }
        : DEFAULT_NOTIFY.quietHours;
  const wealth = positivePct(v.wealthStepHuf);
  const drawdown = positivePct(v.drawdownStepPct);
  return {
    off,
    ai: {
      newsMorning: mode(ai.newsMorning, DEFAULT_NOTIFY.ai.newsMorning),
      newsEvening: mode(ai.newsEvening, DEFAULT_NOTIFY.ai.newsEvening),
      analysis: mode(ai.analysis, DEFAULT_NOTIFY.ai.analysis),
      why: ai.why === "off" ? "off" : "notify",
    },
    ...(wealth !== undefined ? { wealthStepHuf: wealth } : {}),
    ...(drawdown !== undefined ? { drawdownStepPct: drawdown } : {}),
    weeklyHour: intIn(v.weeklyHour, 0, 23, DEFAULT_NOTIFY.weeklyHour),
    monthlyHour: intIn(v.monthlyHour, 0, 23, DEFAULT_NOTIFY.monthlyHour),
    planReminderDay: intIn(v.planReminderDay, 1, 28, DEFAULT_NOTIFY.planReminderDay),
    quietHours,
  };
}

export function saveNotifySettings(v: NotifySettings) {
  saveObject(NOTIFY_KEY, "notify", v);
}
