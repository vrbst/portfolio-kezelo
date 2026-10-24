// Timeline of one medium-term savings goal: what is planned (monthly savings,
// coupons, cash set aside, maturities, the target) and how the goal's value
// is expected to grow from the start day to the target date — plus the past
// value, sampled at month ends. Pure functions; the dialog only draws them.

import type { Account, Instrument, Transaction } from "./model";
import {
  consolidatedHoldings,
  toLocalDay,
  type PortfolioSummary,
  type PriceMap,
} from "./portfolio";
import { validCouponIds } from "./incomeClaims";
import { txDay } from "./day";
import {
  computeSavingsProgress,
  maturityDay,
  savingMonthDays,
  type CouponOption,
  type SavingsGoal,
  type SavingsProgress,
} from "./savings";

export type ScheduleKind = "saving" | "coupon" | "maturity" | "reserve" | "target";

export interface ScheduleRow {
  day: string;
  kind: ScheduleKind;
  label: string;
  /** HUF of the step. For a maturity it is the face value (info only). */
  huf: number;
  /** Already happened / already counted in the value today. */
  done: boolean;
  /** Whether the step adds to the expected value (a maturity does not: its face is counted already). */
  adds: boolean;
  /** Expected value of the goal after this row (HUF). */
  cumulativeHuf: number;
}

export interface PathPoint {
  day: string;
  valueHuf: number;
}

export interface GoalSchedule {
  startDay: string;
  endDay: string;
  rows: ScheduleRow[];
  /** Expected value, a step line from today to the target date. */
  path: PathPoint[];
}

/** First day the goal's timeline shows: its creation, or a later saving start. */
export function goalStartDay(goal: SavingsGoal): string {
  const created = txDay(goal.createdAt);
  const from = goal.saveFrom?.slice(0, 10);
  return from && from > created ? from : created;
}

/**
 * The planned steps of a goal and the expected-value path. `planHuf` is this
 * month's remaining quota (savingsMonthStates), `coupons` the future coupons
 * (futureCouponOptions), `goals` all goals (to leave out coupons another goal
 * took).
 */
export function goalSchedule(
  p: SavingsProgress,
  goals: SavingsGoal[],
  coupons: CouponOption[],
  summary: PortfolioSummary,
  instruments: Map<string, Instrument>,
  planHuf: number,
  now: Date = new Date(),
): GoalSchedule {
  const g = p.goal;
  const today = toLocalDay(now);
  const target = g.targetDate.slice(0, 10);
  const startDay = goalStartDay(g);
  const rows: Omit<ScheduleRow, "cumulativeHuf">[] = [];

  // Monthly savings: this month's remaining quota, then the planned figure.
  if (!p.reached && p.daysLeft > 0) {
    const days = savingMonthDays(p, now);
    days.forEach((day, i) => {
      const first = i === 0 && !p.savingStartsOn;
      const huf = first ? planHuf : p.plannedMonthlyHuf;
      if (first && planHuf <= 1) {
        rows.push({
          day,
          kind: "saving",
          label: `${p.monthAdjective} keret`,
          huf: p.monthlyNeededHuf,
          done: true,
          adds: false,
        });
        return;
      }
      rows.push({
        day,
        kind: "saving",
        label: first ? `${p.monthAdjective} félretétel` : "Havi félretétel",
        huf,
        done: false,
        adds: true,
      });
    });
  }

  // Coupons: the goal's picked ones, plus every free one with includeCoupons.
  const mine = new Set(validCouponIds(goals, g));
  const takenByOthers = new Set(goals.flatMap((o) => validCouponIds(goals, o)));
  for (const c of coupons) {
    if (c.day > target) continue;
    const isMine = mine.has(c.id);
    if (!isMine && !(g.includeCoupons && !takenByOthers.has(c.id))) continue;
    rows.push({
      day: c.day,
      kind: "coupon",
      label: `Kupon: ${c.name}`,
      huf: c.amountHuf,
      done: false,
      adds: true,
    });
  }

  // Cash set aside by hand: counted from its date; past ones are in the value today.
  for (const r of g.reserves ?? []) {
    if (r.amountHuf <= 0 || r.date > target) continue;
    rows.push({
      day: r.date,
      kind: "reserve",
      label: r.note ? `Félretett készpénz: ${r.note}` : "Félretett készpénz",
      huf: r.amountHuf,
      done: r.date <= today,
      adds: r.date > today,
    });
  }

  // Maturities of the assigned instruments by the target date (face value is
  // already in the goal's value — a marker, not a step).
  const keys = new Set(g.instrumentKeys);
  for (const h of consolidatedHoldings(summary)) {
    if (!keys.has(h.instrumentKey)) continue;
    const mat = maturityDay(instruments.get(h.instrumentKey) ?? h.instrument);
    if (!mat || mat > target) continue;
    rows.push({
      day: mat,
      kind: "maturity",
      label: `Lejárat: ${h.instrument?.name ?? h.instrumentKey}`,
      huf: h.quantity,
      done: mat <= today,
      adds: false,
    });
  }

  rows.push({
    day: target,
    kind: "target",
    label: "Céldátum",
    huf: g.targetHuf,
    done: target <= today,
    adds: false,
  });

  const order: Record<ScheduleKind, number> = {
    saving: 0,
    coupon: 1,
    reserve: 2,
    maturity: 3,
    target: 4,
  };
  rows.sort((a, b) => a.day.localeCompare(b.day) || order[a.kind] - order[b.kind]);

  let value = p.assignedValueHuf;
  const full: ScheduleRow[] = rows.map((r) => {
    if (r.adds && !r.done) value += r.huf;
    return { ...r, cumulativeHuf: value };
  });

  // Step line from today to the target date — even when the monthly saving
  // starts later: coupons and cash can arrive before that start.
  const path: PathPoint[] = [{ day: today, valueHuf: p.assignedValueHuf }];
  for (const r of full) {
    if (!r.adds || r.done) continue;
    const last = path[path.length - 1];
    const day = r.day < today ? today : r.day;
    if (day === last.day) last.valueHuf = r.cumulativeHuf;
    else path.push({ day, valueHuf: r.cumulativeHuf });
  }
  const last = path[path.length - 1];
  if (last.day < target) path.push({ day: target, valueHuf: last.valueHuf });

  return { startDay, endDay: target, rows: full, path };
}

/** Month-end days from `startDay` to `today` (at most `max`, thinned evenly), then today itself. */
function sampleDays(startDay: string, today: string, max = 36): string[] {
  const days: string[] = [];
  let y = +startDay.slice(0, 4);
  let m = +startDay.slice(5, 7) - 1;
  for (let guard = 0; guard < 600; guard++) {
    const end = toLocalDay(new Date(y, m + 1, 0));
    if (end >= today) break;
    if (end > startDay) days.push(end);
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  const step = Math.ceil(days.length / max) || 1;
  const thinned = days.filter((_, i) => (days.length - 1 - i) % step === 0);
  return [startDay, ...thinned, today].filter((d, i, a) => a.indexOf(d) === i && d <= today);
}

/**
 * What the goal held on past days: the progress recomputed from the
 * transactions up to each sample day (month ends from the start day), with
 * ALL goals — coupons are split among them (see goalCash). Prices and rates
 * are today's, so it shows how the goal was filled, not old marks. The last
 * point is `currentHuf`, the card's own "Most a célra", so the line ends
 * exactly where the card says the goal stands.
 */
export function goalHistory(
  goal: SavingsGoal,
  goals: SavingsGoal[],
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  currentHuf: number,
  now: Date = new Date(),
): PathPoint[] {
  const today = toLocalDay(now);
  const start = goalStartDay(goal);
  if (start >= today) return [];
  return sampleDays(start, today).map((day) => {
    if (day === today) return { day, valueHuf: currentHuf };
    const at = new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 12);
    const upTo = txs.filter((t) => txDay(t.date) <= day);
    const p = computeSavingsProgress(goals, accounts, upTo, instruments, prices, fx, at).find(
      (x) => x.goal.id === goal.id,
    );
    return { day, valueHuf: p?.assignedValueHuf ?? 0 };
  });
}
