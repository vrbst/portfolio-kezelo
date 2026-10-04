// Expected bucket weights from the money that will actually come in — the
// "várható arány" lines next to the glide path. Month by month from today:
//   • free bond coupons and redemptions (futureBondCashflows) — a coupon a
//     goal picked or claims (includeCoupons, up to its room) and the
//     redemption of a goal's own instrument before its date stay with the
//     goal, like in the income split (incomeFlow.ts);
//   • the glide path's monthly amount (budget.ts), recomputed every month —
//     a medium-term goal stops taking its share after its date;
//   • DCA goals buying an instrument that sits in a bucket (monthly
//     equivalent, straight into that bucket).
// The routed money goes towards the FINAL weights (water-filling, buying
// only), so the line shows the earliest the final allocation is reached from
// the inflows alone. Bonds and cash stay flat (face / nominal); the rest of a
// bucket grows at `annualReturn` (0 = inflows only). Pure — a projection, not
// a promise, and it never touches the band, the alerts or the suggestions.

import type { Instrument } from "./model";
import type { Goal } from "./goals";
import type { SavingsProgress } from "./savings";
import type { GlideConfig } from "./glidePath";
import { isCashKey } from "./glidePath";
import { BOND_TYPES, type Cashflow } from "./bonds";
import { checkDays, waterFill, type AllocationState } from "./rebalance";
import { glideMonthlyHuf, dcaMonthlyHuf } from "./budget";
import { claimsCoupon, couponOwner, splitAmongGoals } from "./incomeClaims";

/** A bucket counts as arrived within this distance of its final weight. */
export const REACH_TOLERANCE = 0.005;

export interface ProjectionInput {
  cfg: GlideConfig;
  /** Today's allocation (reserved goal cash already left out). */
  state: AllocationState;
  instruments: Map<string, Instrument>;
  /** Future bond coupons and redemptions (futureBondCashflows). */
  cashflows: Cashflow[];
  /** Medium-term goals' progress (claims, monthly saving). */
  savings: SavingsProgress[];
  dcaGoals: Goal[];
  /** The monthly budget ("havi keret"). */
  budgetHuf: number;
  /** Yearly return of the non-bond, non-cash part (0.06 = 6%). */
  annualReturn: number;
  /** YYYY-MM-DD. */
  today: string;
  /** Last day simulated (YYYY-MM-DD). */
  until: string;
}

export interface ProjectionPoint {
  /** First day of a month (YYYY-MM-DD). */
  day: string;
  /** Bucket id → expected weight (0..1). */
  weights: Record<string, number>;
}

export interface GlideProjection {
  points: ProjectionPoint[];
  /** First month every bucket is at its final weight (± REACH_TOLERANCE). */
  reachedOn?: string;
  /** The money the projection routes into the buckets, as it comes in. */
  inflows: ProjectedInflow[];
}

/** One routed inflow: a free coupon, a redemption or the monthly amount. */
export interface ProjectedInflow {
  /** YYYY-MM-DD (the coupon / redemption date, or the month start). */
  day: string;
  kind: "coupon" | "maturity" | "monthly";
  /** The part routed to the buckets (after any goal took its share). */
  amountHuf: number;
  instrumentKey?: string;
}

/** Monthly saving the medium-term goals still take on `day` (a month start). */
export function savingsHufOn(savings: SavingsProgress[], day: string): number {
  return savings.reduce((s, p) => {
    if (p.reached || p.daysLeft <= 0) return s;
    if (day > p.goal.targetDate.slice(0, 10)) return s;
    if (p.savingStartsOn && day < p.savingStartsOn.slice(0, 10)) return s;
    return s + p.plannedMonthlyHuf;
  }, 0);
}

export function projectGlide(input: ProjectionInput): GlideProjection {
  const { cfg, state, instruments, savings, today } = input;
  const ids = cfg.buckets.map((b) => b.id);
  const finalSum = cfg.buckets.reduce((s, b) => s + b.finalWeight, 0);
  const final = new Map(
    cfg.buckets.map((b) => [b.id, finalSum > 0 ? b.finalWeight / finalSum : 0]),
  );

  const isFlat = (key: string) =>
    isCashKey(key) || BOND_TYPES.has(instruments.get(key)?.type ?? "etf");
  // Per bucket: the growing part (ETFs, stocks…) and the flat part.
  const growth = new Map<string, number>(ids.map((id) => [id, 0]));
  const flat = new Map<string, number>(ids.map((id) => [id, 0]));
  const add = (id: string, huf: number, part: "growth" | "flat") => {
    const m = part === "growth" ? growth : flat;
    m.set(id, (m.get(id) ?? 0) + huf);
  };
  const posValue = new Map<string, { bucketId: string; value: number }>();
  for (const p of state.positions) {
    const id = p.rule.bucketId;
    if (!growth.has(id)) continue;
    add(id, p.valueHuf, isFlat(p.key) ? "flat" : "growth");
    posValue.set(p.key, { bucketId: id, value: p.valueHuf });
  }
  // Where new money lands in a bucket: its growing part when it has an
  // accepting non-bond instrument. Buckets with no accepting one get nothing.
  const accepting = new Map<string, "growth" | "flat">();
  for (const p of state.positions) {
    if (!p.rule.acceptsContributions || !growth.has(p.rule.bucketId)) continue;
    if (!isFlat(p.key)) accepting.set(p.rule.bucketId, "growth");
    else if (!accepting.has(p.rule.bucketId)) accepting.set(p.rule.bucketId, "flat");
  }
  const valueOf = (id: string) => (growth.get(id) ?? 0) + (flat.get(id) ?? 0);
  const total = () => ids.reduce((s, id) => s + valueOf(id), 0);

  const inflows: ProjectedInflow[] = [];
  const route = (huf: number, at?: Omit<ProjectedInflow, "amountHuf">) => {
    if (!(huf > 0)) return;
    const eligible = ids.filter((id) => accepting.has(id));
    if (eligible.length === 0) return;
    if (at) inflows.push({ ...at, amountHuf: huf });
    const alloc = waterFill(
      eligible.map((id) => ({ id, valueHuf: valueOf(id), target: final.get(id) ?? 0 })),
      huf,
      total() + huf,
    );
    for (const [id, x] of alloc) add(id, x, accepting.get(id)!);
  };

  // DCA goals whose instrument sits in a bucket: monthly equivalent, direct.
  const dca: { bucketId: string; huf: number; part: "growth" | "flat" }[] = [];
  for (const g of input.dcaGoals) {
    let key: string | undefined = g.instrumentKey;
    if (!key && g.instrumentType) {
      // A category goal: the largest bucket instrument of that type.
      key = state.positions
        .filter((p) => instruments.get(p.key)?.type === g.instrumentType)
        .sort((a, b) => b.valueHuf - a.valueHuf)[0]?.key;
    }
    const rule = key ? cfg.instruments[key] : undefined;
    if (!key || !rule || !growth.has(rule.bucketId)) continue;
    dca.push({
      bucketId: rule.bucketId,
      huf: g.amountHuf / g.periodMonths,
      part: isFlat(key) ? "flat" : "growth",
    });
  }
  const dcaHuf = dcaMonthlyHuf(input.dcaGoals);

  const goals = savings.map((p) => p.goal);
  const room = new Map(savings.map((p) => [p.goal.id, p.couponRoomHuf]));
  const matured = new Set<string>();
  const handle = (c: Cashflow) => {
    const key = c.instrumentKey;
    if (c.kind === "maturity") {
      // The bond leaves its bucket (once, even when held on several accounts).
      const pos = key ? posValue.get(key) : undefined;
      if (key && pos && !matured.has(key)) {
        matured.add(key);
        flat.set(pos.bucketId, Math.max(0, (flat.get(pos.bucketId) ?? 0) - pos.value));
      }
      const owned = savings.some(
        (p) => !!key && p.goal.instrumentKeys.includes(key) && c.date <= p.goal.targetDate.slice(0, 10),
      );
      if (!owned) route(c.amountHuf, { day: c.date, kind: "maturity", instrumentKey: key });
      return;
    }
    if (couponOwner(goals, key, c.date)) return;
    const claimants = savings
      .filter((p) => claimsCoupon({ ...p, couponRoomHuf: room.get(p.goal.id) ?? 0 }, c.date))
      .map((p) => ({ goalId: p.goal.id, capHuf: room.get(p.goal.id) ?? 0 }));
    const shares = splitAmongGoals(c.amountHuf, claimants);
    let taken = 0;
    for (const [id, x] of shares) {
      room.set(id, (room.get(id) ?? 0) - x);
      taken += x;
    }
    route(c.amountHuf - taken, { day: c.date, kind: "coupon", instrumentKey: key });
  };

  const monthly = Math.pow(1 + input.annualReturn, 1 / 12);
  const flows = [...input.cashflows].sort((a, b) => a.date.localeCompare(b.date));
  // Which way each bucket has to go to arrive (from today's weight).
  const startTotal = total();
  const rising = new Map(
    ids.map((id) => [id, (startTotal > 0 ? valueOf(id) / startTotal : 0) < (final.get(id) ?? 0)]),
  );
  const arrived = (w: Record<string, number>) =>
    ids.every((id) => {
      const f = final.get(id) ?? 0;
      return rising.get(id) ? w[id] >= f - REACH_TOLERANCE : w[id] <= f + REACH_TOLERANCE;
    });

  const points: ProjectionPoint[] = [];
  let reachedOn: string | undefined;
  let prev = today;
  let i = 0;
  for (const day of checkDays("monthly", today, input.until)) {
    if (day <= today) continue;
    for (const id of ids) growth.set(id, (growth.get(id) ?? 0) * monthly);
    while (i < flows.length && flows[i].date <= day) {
      if (flows[i].date > prev) handle(flows[i]);
      i++;
    }
    // This month's saving (paid on the previous month's last working day).
    for (const d of dca) add(d.bucketId, d.huf, d.part);
    route(glideMonthlyHuf(cfg.monthlyAmount, input.budgetHuf, dcaHuf + savingsHufOn(savings, day)), {
      day,
      kind: "monthly",
    });

    const t = total();
    const weights: Record<string, number> = {};
    for (const id of ids) weights[id] = t > 0 ? valueOf(id) / t : 0;
    points.push({ day, weights });
    if (!reachedOn && t > 0 && arrived(weights)) reachedOn = day;
    prev = day;
  }
  return { points, reachedOn, inflows };
}

/**
 * The "inflows" path frozen into a version on save: the projection at 0%
 * return — the slowest, "only the money moves it" path, so a sideways market
 * never trips the band — preceded by today's actual weights as its first
 * point. Stored on the version (inflowPath), so the band, the alerts and the
 * bot all measure against the same fixed line until the next save.
 */
export function freezeInflowPath(
  input: Omit<ProjectionInput, "annualReturn">,
): Pick<GlideConfig, "inflowPath" | "inflowReached"> {
  const { state, today } = input;
  const now: Record<string, number> = {};
  for (const b of state.buckets) now[b.bucket.id] = b.weight;
  const p = projectGlide({ ...input, annualReturn: 0 });
  // Past the arrival the path is simply the final weight: stop there, so the
  // last point is the arrival month.
  const points = p.reachedOn ? p.points.filter((x) => x.day <= p.reachedOn!) : p.points;
  return {
    inflowPath: [{ day: today, weights: now }, ...points],
    inflowReached: p.reachedOn != null,
  };
}
