// Month-end leftover ("hónap végi maradék"): money left over from a month
// (less was spent) split with the Havi terv's own machinery —
//  1. the closing month's goal parts not yet covered (in the plan order;
//     hold-cash goals as cash set aside);
//  2. optionally, dated goals whose date is within X months (the ones
//     already "running") get everything they still lack, pulled forward —
//     goals further out only get the closing month's part;
//  3. the rest along the glide path (target, fees, accounts, limits) — all of
//     it: the glide path's monthly cap is for the monthly saving, not this.
// Nothing is split twice: what the ledger shows as done is not planned, and a
// recorded (not yet executed) Havi terv for the month is taken off the needs.
// Coupons are not part of it (their goal share goes through "Beérkezett").
// Pure: the Havi terv panel and the Telegram bot (/maradek) both read it.

import type { Account, Instrument, Transaction } from "./model";
import type { Reminder } from "./alerts";
import type { PriceMap } from "./portfolio";
import type { Goal } from "./goals";
import { lastWorkingDayOfMonth, monthLabel } from "./goals";
import {
  computeSavingsProgress,
  savingsMonthStates,
  type SavingsGoal,
} from "./savings";
import {
  buildMonthlyPlan,
  computePlanNeeds,
  orderNeeds,
  planNeeds,
  planTextLines,
  type MonthlyPlan,
  type PlanInput,
  type PlanNeed,
} from "./monthlyPlan";
import type { LeftoverSettings } from "./planPrefs";
import { formatMoney } from "./format";

export interface LeftoverMonth {
  year: number;
  month0: number;
  /** YYYY-MM. */
  key: string;
  /** "2026. szeptember". */
  label: string;
  /** Day-of-month of its last working day (the notification day). */
  lastWorkday: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function monthOf(year: number, month0: number): LeftoverMonth {
  const y = year + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  return {
    year: y,
    month0: m,
    key: `${y}-${pad(m + 1)}`,
    label: monthLabel(y, m),
    lastWorkday: lastWorkingDayOfMonth(y, m),
  };
}

/**
 * The month whose leftover is being split: the calendar month of `now`. On
 * and after its last working day the app already books buys to the next
 * month (see effectiveMonth) — the leftover still belongs to this one.
 */
export function leftoverMonth(now: Date): LeftoverMonth {
  return monthOf(now.getFullYear(), now.getMonth());
}

/** The month after `m`. */
export function nextMonth(m: LeftoverMonth): LeftoverMonth {
  return monthOf(m.year, m.month0 + 1);
}

/**
 * Two reference moments: one inside the closing month's effective month (its
 * quota and what it got), one inside the next (the part to pull forward).
 */
export function leftoverRefs(now: Date): { close: Date; next: Date } {
  const m = leftoverMonth(now);
  const onPayday = now.getDate() >= m.lastWorkday;
  return {
    close: onPayday ? new Date(m.year, m.month0, m.lastWorkday - 1, 12) : now,
    next: onPayday ? now : new Date(m.year, m.month0, m.lastWorkday, 12),
  };
}

// ---- Recorded plans --------------------------------------------------------

export const LEFTOVER_TITLE = "Hónap végi maradék";
const MONTHLY_TITLE = "Havi terv";

/** "Hónap végi maradék – 2026. szeptember (50 000 Ft)". */
export function leftoverTitle(m: LeftoverMonth, amountHuf: number): string {
  return `${LEFTOVER_TITLE} – ${m.label} (${formatMoney(amountHuf)})`;
}

/** The leftover of month `m` already recorded as a plan (the first one). */
export function recordedLeftover(
  reminders: Reminder[],
  m: LeftoverMonth,
): Reminder | undefined {
  return reminders.find((r) => r.title.startsWith(`${LEFTOVER_TITLE} – ${m.label} `));
}

/** HUF a recorded Havi terv of `label` plans for goal `name` (buys + set-asides, costs included). */
export function recordedPlanHuf(reminders: Reminder[], label: string, name: string): number {
  let sum = 0;
  for (const r of reminders) {
    if (!r.title.startsWith(`${MONTHLY_TITLE} – ${label} `)) continue;
    for (const t of r.plan ?? [])
      if ((t.side === "buy" || t.side === "hold") && t.bucketName === name)
        sum += t.amountHuf + (t.costHuf ?? 0);
  }
  return sum;
}

/**
 * What a recorded, not yet executed monthly plan still covers: the planned
 * amount beyond what the ledger shows as done — taken off the need so the
 * same part isn't planned twice.
 */
function lessRecorded(n: PlanNeed, reminders: Reminder[], label: string): PlanNeed {
  const open = Math.max(0, recordedPlanHuf(reminders, label, n.name) - n.doneHuf);
  return open >= 1 ? { ...n, needHuf: Math.max(0, n.needHuf - open) } : n;
}

// ---- Needs -------------------------------------------------------------------

export interface LeftoverNeedsInput {
  savingsGoals: SavingsGoal[];
  dcaGoals: Goal[];
  accounts: Account[];
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PriceMap;
  fx: Record<string, number>;
  order: string[];
  settings: LeftoverSettings;
  /** Recorded plans (Teendők) — a recorded Havi terv is not planned twice. */
  reminders?: Reminder[];
  now?: Date;
}

export interface LeftoverNeeds {
  month: LeftoverMonth;
  /** The closing month's every goal item (done ones too) — its status. */
  closing: PlanNeed[];
  /** What the leftover goes to before the glide path, in order. */
  needs: PlanNeed[];
}

/** Adds `months` calendar months to `d` (clamped to the month's end). */
function addMonths(d: Date, months: number): Date {
  const t = new Date(d.getFullYear(), d.getMonth() + months, 1, 12);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d.getDate(), last));
  return t;
}

export function leftoverNeeds(a: LeftoverNeedsInput): LeftoverNeeds {
  const now = a.now ?? new Date();
  const month = leftoverMonth(now);
  const next = nextMonth(month);
  const refs = leftoverRefs(now);
  const reminders = a.reminders ?? [];

  // 1) The closing month's parts still open.
  const closing = computePlanNeeds({ ...a, now: refs.close });
  const needs = closing
    .map((n) => lessRecorded(n, reminders, month.label))
    .filter((n) => n.needHuf >= 1);

  // 2) Dated goals close to their date: the whole remaining gap, pulled forward.
  if (a.settings.pullForward) {
    const instMap = new Map(a.instruments.map((i) => [i.key, i]));
    const horizon = ymd(addMonths(now, a.settings.pullForwardMonths));
    const nextStart = `${next.key}-01`;
    const goals = a.savingsGoals.filter((g) => {
      const d = g.targetDate.slice(0, 10);
      return d >= nextStart && d <= horizon;
    });
    const progress = new Map(
      computeSavingsProgress(goals, a.accounts, a.transactions, instMap, a.prices, a.fx, refs.next).map(
        (p) => [p.goal.id, p],
      ),
    );
    const ahead = orderNeeds(
      planNeeds(
        savingsMonthStates(goals, a.accounts, a.transactions, instMap, a.prices, a.fx, refs.next),
        new Map(goals.map((g) => [g.id, g.targetDate])),
        [],
        instMap,
      ),
      a.order,
    );
    for (const n of ahead) {
      const p = progress.get(n.key.slice("savings:".length));
      if (!p) continue;
      // A goal close to its date takes everything it still lacks: its whole
      // gap, less what step 1 already gives it and what next month's
      // recorded Havi terv still plans for it.
      const inStep1 = needs.find((x) => x.key === n.key)?.needHuf ?? 0;
      const rest = Math.max(0, p.gapHuf - inStep1);
      const huf = lessRecorded({ ...n, needHuf: rest }, reminders, next.label).needHuf;
      if (huf < 1) continue;
      needs.push({
        ...n,
        key: `ahead:${n.key}`,
        name: `${n.name} (a céldátumig hátralévő rész)`,
        needHuf: huf,
        doneHuf: 0,
        ahead: next.label,
      });
    }
  }
  return { month, closing, needs };
}

/** The leftover plan: the Havi terv's split, the glide path taking all the rest. */
export function buildLeftoverPlan(input: PlanInput): MonthlyPlan {
  const glide = input.glide && { ...input.glide, monthlyAmount: { kind: "remainder" as const } };
  return buildMonthlyPlan({ ...input, glide });
}

// ---- Bot / text --------------------------------------------------------------

/**
 * "/maradek 50000", "50 000", "50.000 Ft", "50e" / "50k" (thousands) → HUF.
 * An error text for anything else (empty, zero, negative, not a number).
 */
export function parseLeftoverAmount(raw: string): { huf: number } | { error: string } {
  const s = raw.trim().toLowerCase().replace(/\s*(ft|huf)\.?$/, "");
  const m = s.match(/^(\d{1,3}(?:[ .\u00a0]\d{3})+|\d+)\s*(e|k|ezer)?$/);
  if (!m)
    return { error: "Adj meg egy pozitív összeget forintban, pl. /maradek 50000 (vagy 50e)." };
  const huf = Number(m[1].replace(/[ .\u00a0]/g, "")) * (m[2] ? 1000 : 1);
  if (!(huf >= 1)) return { error: "Az összegnek nagyobbnak kell lennie 0-nál." };
  if (huf > 1e10) return { error: "Ez túl nagy összeg — ellenőrizd." };
  return { huf };
}

/** The closing month's state: budget, done, the parts still missing. */
export function leftoverStatusLines(ln: LeftoverNeeds, budgetHuf: number): string[] {
  const done = ln.closing.reduce((s, n) => s + n.doneHuf, 0);
  const open = ln.needs.filter((n) => !n.ahead);
  return [
    `Havi keret: ${formatMoney(budgetHuf)} · teljesítve: ${formatMoney(done)}`,
    open.length
      ? `Még hiányzó célrészek: ${open.map((n) => `${n.name} ${formatMoney(n.needHuf)}`).join("; ")}`
      : "Minden e havi célrész teljesítve ✓",
  ];
}

/**
 * The leftover plan as text: only the items that get money (what a goal
 * still lacks after it is the later months' job, not a shortfall).
 */
export function leftoverTextLines(p: MonthlyPlan): string[] {
  const funded = p.lines
    .filter((l) => l.allocatedHuf >= 1)
    .map((l) => ({ ...l, shortHuf: 0 }));
  return planTextLines({ ...p, lines: funded, shortHuf: 0 }).filter(
    (t) => !t.startsWith("Célpálya: a célok után nem marad"),
  );
}

/**
 * The /maradek answer (plain text lines): the amount parsed, then the plan in
 * the Havi terv's words — or the parse error.
 */
export function leftoverReply(
  arg: string,
  ln: LeftoverNeeds,
  plan: (amountHuf: number) => MonthlyPlan,
): { ok: boolean; lines: string[] } {
  const parsed = parseLeftoverAmount(arg);
  if ("error" in parsed) return { ok: false, lines: [parsed.error] };
  const p = plan(parsed.huf);
  return {
    ok: true,
    lines: [`${LEFTOVER_TITLE} – ${ln.month.label}: ${formatMoney(parsed.huf)}`, ...leftoverTextLines(p)],
  };
}
