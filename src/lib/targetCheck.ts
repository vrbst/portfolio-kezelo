// "target" mode ("Célelérés"): no frozen path — every day the question is
// whether the final weights are still reached by each bucket's end date from
// today's holdings, with the money that will come in (the glide path's
// monthly amount, the free coupons; a redemption marked "reinvest" stays in
// its bucket) and a fixed yearly return on the growing part (planReturn).
//
// The answer is turned back into today's weights, so the band machinery
// (status, check period, re-alerts, the band rule's trades) works unchanged:
//   • target — the weight today with which the projection lands exactly on
//     the final weight: the band rule restores to it;
//   • low / high — the weight today with which the projection misses by the
//     tolerance. A bucket is only below (above) its band when BOTH the
//     projection and its actual weight are short of (past) final ∓ tolerance
//     — with aheadMode "projected" the projection alone decides.
// Memoryless: the same holdings on the same day give the same result,
// whenever the version was saved. Near the end date the projection is
// today's weight, so the band becomes simply final ± tolerance.

import type { Instrument } from "./model";
import type { Goal } from "./goals";
import type { SavingsProgress } from "./savings";
import { BOND_TYPES, type Cashflow } from "./bonds";
import {
  isCashKey,
  isTargetMode,
  latestConfig,
  planReturnOf,
  targetTolOf,
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

/** Largest x in [lo, hi] with f(x) ≤ goal for an increasing f (clamped). */
function solveDown(f: (x: number) => number, goal: number, lo: number, hi: number): number {
  if (f(hi) <= goal) return hi;
  if (f(lo) >= goal) return lo;
  let a = lo;
  let b = hi;
  for (let i = 0; i < STEPS; i++) {
    const m = (a + b) / 2;
    if (f(m) <= goal) a = m;
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
  const tol = targetTolOf(cfg);
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

  const buckets: Record<string, TargetBucketLive> = {};
  for (const bs of state0.buckets) {
    const id = bs.bucket.id;
    const F = finalOf(id);
    const w = bs.weight;
    // Projected weight of the bucket with x moved into it today.
    const at = (x: number) => project(stateOf(shifted(state0, id, x)), plan).get(id) ?? 0;
    const lo = -w;
    const hi = 1 - w;
    const weightFor = (goal: number) => Math.min(1, Math.max(0, w + solveUp(at, goal, lo, hi)));
    // Once a bucket reaches its final weight the routing holds it there, so the
    // projection levels off AT the final weight: a whole range of today's
    // weights lands on it. A bucket below its final weight needs the least
    // of them, one above it the most — the two ends that mirror each other
    // (with two buckets their targets add up to 100%).
    const target =
      w <= F
        ? weightFor(F - REACH_EPS)
        : Math.min(1, Math.max(0, w + solveDown(at, F + REACH_EPS, lo, hi)));
    const lowP = weightFor(F - tol);
    const highP = weightFor(F + tol);
    const projectedMode = cfg.aheadMode === "projected";
    const low = projectedMode ? lowP : Math.min(lowP, Math.max(0, F - tol));
    const high = projectedMode ? highP : Math.max(highP, Math.min(1, F + tol));

    // The band ahead: following the low (high) weight's projection, every
    // later day's check lands on the same edge — so the edge of each day is
    // that projection (with the actual-weight rule's floor / ceiling).
    const endDate = cfg.buckets.find((b) => b.id === id)!.endDate;
    const edge = (wt: number) =>
      pathOf(stateOf(shifted(state0, id, wt - w)), plan).filter((pt) => pt.day <= endDate);
    const hiPath = edge(highP);
    const corridor = edge(lowP).map((pt, i) => {
      const l = pt.weights[id] ?? 0;
      const h = hiPath[i]?.weights[id] ?? l;
      return {
        day: pt.day,
        low: projectedMode ? l : Math.min(l, Math.max(0, F - tol)),
        high: projectedMode ? h : Math.max(h, Math.min(1, F + tol)),
      };
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

    // The fall of the bucket's securities that would put it below its band.
    let alarmShock: number | null = null;
    if (growthHuf(id) > 0) {
      const below = (s: number) => {
        const st = stateOf(applyShock(base, [...state0.positions, ...state0.unassigned], { [id]: -s }));
        const ws = st.buckets.find((b) => b.bucket.id === id)?.weight ?? 0;
        const ps = project(st, plan).get(id) ?? 0;
        return projectedMode ? ps < F - tol : ps < F - tol && ws < F - tol;
      };
      if (below(0)) alarmShock = 0;
      else if (below(0.95)) {
        let a = 0;
        let b = 0.95;
        for (let i = 0; i < STEPS; i++) {
          const m = (a + b) / 2;
          if (below(m)) b = m;
          else a = m;
        }
        alarmShock = b;
      }
    }

    buckets[id] = {
      target,
      low,
      high,
      projected: projected.get(id) ?? w,
      projectedZero: projectedZero.get(id) ?? w,
      requiredReturn,
      alarmShock,
      corridor,
    };
  }
  return { day, buckets };
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
