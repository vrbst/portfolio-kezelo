// "target" mode ("Célelérés"): a fixed allocation's rebalancing band around a
// target that moves. Every day the required weight is computed: the weight
// today from which the money that will come in (the glide path's monthly
// amount, the free coupons; a redemption marked "reinvest" stays in its
// bucket) and a fixed yearly return on the growing part (planReturn) carry
// the bucket exactly to its final weight by its end date — for a growing
// bucket (equities) the LEAST such weight: no more risk than the goal needs;
// the bonds and cash hold the rest. The band is that weight ± targetBandPp; outside it the band rule restores the required weight
// — buying a bucket after a fall, selling it after a rally, like any
// rebalancing.
//
// The required weight hardly moves with the prices (it depends on the dates
// and the inflows), so leaving the band is the market's doing. Following the
// plan, tomorrow's required weight is today's projected one: the target moves
// along a path (the corridor) and arrives at the final weight on the end
// date, where the band is final ± band.
// Memoryless: the same holdings on the same day give the same result,
// whenever the version was saved.

import type { Instrument } from "./model";
import type { Goal } from "./goals";
import type { SavingsProgress } from "./savings";
import { BOND_TYPES, type Cashflow } from "./bonds";
import {
  isCashKey,
  isTargetMode,
  latestConfig,
  planReturnOf,
  targetBandOf,
  type GlideConfig,
  type TargetBucketLive,
  type TargetLive,
} from "./glidePath";
import {
  allocationState,
  applyShock,
  type AllocationState,
  type Position,
} from "./rebalance";
import { projectGlide } from "./glideProjection";

/** What the projection needs besides the configuration and the holdings. */
export interface TargetInputs {
  instruments: Map<string, Instrument>;
  /** Future bond coupons and redemptions (futureBondCashflows). */
  cashflows: Cashflow[];
  savings: SavingsProgress[];
  dcaGoals: Goal[];
  /** The monthly budget ("havi keret"). */
  budgetHuf: number;
}

const STEPS = 40;

/** Smallest x in [lo, hi] with f(x) ≥ goal for an increasing f (clamped). */
function solveUp(f: (x: number) => number, goal: number, lo: number, hi: number): number {
  if (f(lo) >= goal) return lo;
  if (f(hi) <= goal) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < STEPS; i++) {
    const m = (a + b) / 2;
    if (f(m) < goal) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/**
 * Within this of the final weight the projection counts as arrived (it
 * approaches the final weight from one side and need not hit it exactly).
 */
const REACH_EPS = 1e-4;

/**
 * The managed positions with `x` (fraction of the managed total) moved into
 * bucket `id` from the other buckets, pro rata to their values (x < 0: out
 * of it into the others). Values only — the projection needs nothing else.
 */
function shifted(state: AllocationState, id: string, x: number): Position[] {
  const T = state.totalHuf;
  const own = state.buckets.find((b) => b.bucket.id === id)?.valueHuf ?? 0;
  const others = T - own;
  const move = Math.max(-own, Math.min(others, x * T));
  const scaleOwn = own > 0 ? (own + move) / own : 1;
  const scaleOther = others > 0 ? (others - move) / others : 1;
  const positions: Position[] = state.positions.map((p) => ({
    ...p,
    valueHuf: p.valueHuf * (p.rule.bucketId === id ? scaleOwn : scaleOther),
  }));
  if (own <= 0 && move > 0) {
    // Nothing to scale: the money lands in the bucket's accepting instrument.
    const i = state.positions.findIndex((p) => p.rule.bucketId === id && p.rule.acceptsContributions);
    if (i >= 0) positions[i] = { ...positions[i], valueHuf: move };
  }
  return [...positions, ...state.unassigned];
}

/**
 * The daily check for `cfg` on `day` from `positions` (as positionsFromSummary
 * gives them). Undefined outside "target" mode or with nothing managed.
 */
export function computeTargetLive(
  cfg: GlideConfig,
  positions: Position[],
  day: string,
  inputs: TargetInputs,
): TargetLive | undefined {
  if (!isTargetMode(cfg) || cfg.buckets.length === 0) return undefined;
  const base: GlideConfig = { ...cfg, targetLive: undefined };
  const state0 = allocationState(base, positions, day);
  if (state0.totalHuf <= 0) return undefined;

  const sum = cfg.buckets.reduce((s, b) => s + b.finalWeight, 0);
  const finalOf = (id: string) => {
    const b = cfg.buckets.find((x) => x.id === id)!;
    return sum > 0 ? b.finalWeight / sum : 0;
  };
  const until = cfg.buckets.reduce((m, b) => (b.endDate > m ? b.endDate : m), day);
  const band = targetBandOf(cfg);
  const plan = planReturnOf(cfg);

  /** The monthly projection to the last end date (none when it has passed). */
  const pathOf = (st: AllocationState, r: number) =>
    until <= day || st.totalHuf <= 0
      ? []
      : projectGlide({
          cfg: base,
          state: st,
          instruments: inputs.instruments,
          cashflows: inputs.cashflows,
          savings: inputs.savings,
          dcaGoals: inputs.dcaGoals,
          budgetHuf: inputs.budgetHuf,
          annualReturn: r,
          today: day,
          until,
        }).points;
  /** Each bucket's projected weight on its own end date. */
  const project = (st: AllocationState, r: number): Map<string, number> => {
    const now = new Map(st.buckets.map((b) => [b.bucket.id, b.weight]));
    const points = pathOf(st, r);
    const out = new Map<string, number>();
    for (const b of cfg.buckets) {
      let w = now.get(b.id) ?? 0;
      for (const pt of points) {
        if (pt.day > b.endDate) break;
        w = pt.weights[b.id] ?? w;
      }
      out.set(b.id, w);
    }
    return out;
  };
  const stateOf = (ps: Position[]) => allocationState(base, ps, day);

  const projected = project(state0, plan);
  const projectedZero = project(state0, 0);
  const growthHuf = (id: string) =>
    state0.positions
      .filter((p) => p.rule.bucketId === id && !isFlat(p, inputs))
      .reduce((s, p) => s + p.valueHuf, 0);

  /**
   * Bucket `id`'s lowest weight in state `st` that still arrives. Once a
   * bucket reaches its final weight the routing holds it there, so the
   * projection levels off AT the final weight: a whole range of today's
   * weights lands on it — this is its lower end.
   */
  const minimumIn = (st: AllocationState, id: string): number => {
    const w = st.buckets.find((b) => b.bucket.id === id)?.weight ?? 0;
    // Projected weight of the bucket with x moved into it today.
    const at = (x: number) => project(stateOf(shifted(st, id, x)), plan).get(id) ?? 0;
    return Math.min(1, Math.max(0, w + solveUp(at, finalOf(id) - REACH_EPS, -w, 1 - w)));
  };
  /**
   * The required weights in state `st`: no more risk than the goal needs.
   * A growing bucket (equities…) gets the least that still carries it to its
   * final weight — rising just in time, and above it sold back even when its
   * final weight is lower than where it stands. The flat buckets (bonds,
   * cash) share the rest by their final weights. Without a growing bucket
   * each simply gets its own lowest arriving weight.
   */
  const referenceIn = (st: AllocationState): Map<string, number> => {
    const out = new Map<string, number>();
    const growing = cfg.buckets.filter((b) => isGrowing(b.id, st));
    if (growing.length === 0) {
      for (const b of cfg.buckets) out.set(b.id, minimumIn(st, b.id));
      return out;
    }
    let used = 0;
    for (const b of growing) {
      const r = minimumIn(st, b.id);
      out.set(b.id, r);
      used += r;
    }
    const flat = cfg.buckets.filter((b) => !out.has(b.id));
    const flatFinal = flat.reduce((acc, b) => acc + finalOf(b.id), 0);
    const rest = Math.max(0, 1 - used);
    for (const b of flat)
      out.set(b.id, flatFinal > 0 ? (rest * finalOf(b.id)) / flatFinal : rest / flat.length);
    return out;
  };
  /** Mostly securities with a price (by value; an empty bucket by its instruments). */
  const isGrowing = (id: string, st: AllocationState): boolean => {
    const own = st.positions.filter((p) => p.rule.bucketId === id);
    const total = own.reduce((acc, p) => acc + p.valueHuf, 0);
    if (total > 0) return own.filter((p) => !isFlat(p, inputs)).reduce((acc, p) => acc + p.valueHuf, 0) > total / 2;
    return Object.entries(cfg.instruments).some(
      ([key, r]) => r.bucketId === id && !isCashKey(key) && !BOND_TYPES.has(inputs.instruments.get(key)?.type ?? "etf"),
    );
  };
  const limits = (t: number) => ({ low: Math.max(0, t - band), high: Math.min(1, t + band) });

  const reference = referenceIn(state0);
  // The target ahead: the projection from the required weights — every later
  // day's required weight along it (± the band).
  const refPath = pathOf(stateOf(reweighted(state0, reference)), plan);

  const buckets: Record<string, TargetBucketLive> = {};
  for (const bs of state0.buckets) {
    const id = bs.bucket.id;
    const F = finalOf(id);
    const w = bs.weight;
    const target = reference.get(id) ?? w;
    const { low, high } = limits(target);

    const endDate = cfg.buckets.find((b) => b.id === id)!.endDate;
    const corridor = refPath
      .filter((pt) => pt.day <= endDate)
      .map((pt) => {
        const t = pt.weights[id] ?? 0;
        return { day: pt.day, target: t, ...limits(t) };
      });

    // The lowest return of the growing part that still lands on the final
    // weight. Arriving means reaching the plateau (within REACH_EPS), not F
    // exactly — or a bucket that arrives at the plan return would show a far
    // higher figure. None when even the range's floor arrives (any return
    // does) or its ceiling does not.
    let requiredReturn: number | null = null;
    if (growthHuf(id) > 0 && until > day) {
      const f = (r: number) => project(state0, r).get(id) ?? 0;
      const rLo = -0.5;
      const rHi = 1;
      const goal = F - REACH_EPS;
      if (f(rLo) < goal && f(rHi) >= goal) requiredReturn = solveUp(f, goal, rLo, rHi);
    }

    // The fall (rise) of the bucket's securities that would take it out of
    // its band. The required weight moves a little with the prices too (the
    // inflows weigh more in a smaller portfolio): the edge found at today's,
    // it is re-solved at the shocked state until it settles.
    const shocked = (s: number) =>
      stateOf(applyShock(base, [...state0.positions, ...state0.unassigned], { [id]: s }));
    const weightIn = (st: AllocationState) => st.buckets.find((b) => b.bucket.id === id)?.weight ?? 0;
    const trip = (dir: -1 | 1, max: number): number | null => {
      if (growthHuf(id) <= 0) return null;
      let edge = dir < 0 ? low : high;
      let found: number | null = null;
      for (let round = 0; round < 6; round++) {
        const out = (s: number) => {
          const ws = weightIn(shocked(dir * s));
          return dir < 0 ? ws < edge : ws > edge;
        };
        if (out(0)) return 0;
        if (!out(max)) return found;
        let a = 0;
        let b = max;
        for (let i = 0; i < STEPS; i++) {
          const m = (a + b) / 2;
          if (out(m)) b = m;
          else a = m;
        }
        const settled = found != null && Math.abs(found - b) < 1e-4;
        found = b;
        if (settled) break;
        const lim = limits(referenceIn(shocked(dir * b)).get(id) ?? edge);
        edge = dir < 0 ? lim.low : lim.high;
      }
      return found;
    };

    buckets[id] = {
      target,
      low,
      high,
      projected: projected.get(id) ?? w,
      projectedZero: projectedZero.get(id) ?? w,
      requiredReturn,
      alarmShock: trip(-1, 0.95),
      alarmRise: trip(1, 3),
      corridor,
    };
  }
  return { day, buckets };
}

/**
 * The managed positions with each bucket scaled to `weights` (fractions of
 * the managed total); an empty bucket gets its accepting instrument.
 */
function reweighted(state: AllocationState, weights: Map<string, number>): Position[] {
  const T = state.totalHuf;
  const value = new Map(state.buckets.map((b) => [b.bucket.id, b.valueHuf]));
  const positions: Position[] = state.positions.map((p) => {
    const own = value.get(p.rule.bucketId) ?? 0;
    const want = (weights.get(p.rule.bucketId) ?? 0) * T;
    return { ...p, valueHuf: own > 0 ? (p.valueHuf * want) / own : p.valueHuf };
  });
  for (const [id, w] of weights) {
    if ((value.get(id) ?? 0) > 0 || w <= 0) continue;
    const i = state.positions.findIndex((p) => p.rule.bucketId === id && p.rule.acceptsContributions);
    if (i >= 0) positions[i] = { ...positions[i], valueHuf: w * T };
  }
  return [...positions, ...state.unassigned];
}

/** Bonds and cash keep their value in the projection (as in projectGlide). */
function isFlat(p: Position, inputs: TargetInputs): boolean {
  return isCashKey(p.key) || BOND_TYPES.has(inputs.instruments.get(p.key)?.type ?? "etf");
}

/**
 * `versions` with the newest one's daily check attached (see computeTargetLive)
 * — what the band, the alerts, the bot and the panels measure against. The
 * stored versions stay as saved (edit and save those, never these).
 */
export function liveTargetVersions(
  versions: GlideConfig[],
  positionsOf: (cfg: GlideConfig) => Position[],
  day: string,
  inputs: TargetInputs,
): GlideConfig[] {
  const cfg = latestConfig(versions);
  if (!cfg || !isTargetMode(cfg)) return versions;
  const targetLive = computeTargetLive(cfg, positionsOf(cfg), day, inputs);
  if (!targetLive) return versions;
  return versions.map((v) => (v === cfg ? { ...cfg, targetLive } : v));
}
