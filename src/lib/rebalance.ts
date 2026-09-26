// Glide-path maths: the path target and band of each bucket on a day, the
// actual bucket weights, and the two rebalancing tools —
//  1. cash-flow routing (primary): new money goes to the buckets furthest
//     below their path, so the portfolio drifts back without selling;
//  2. the band rule (secondary): only for a bucket outside its band — buy it
//     back up (from cash first, then by selling overweight buckets) or sell it
//     down / redirect future money.
// Everything here is pure: the caller passes positions (see
// positionsFromSummary) and the configuration. Nothing is ever executed — the
// output is a list of suggestions.

import type { Instrument } from "./model";
import type { Alert } from "./alerts";
import type { PortfolioSummary } from "./portfolio";
import { toHuf } from "./portfolio";
import { BOND_TYPES, DEFAULT_BOND_SALE_COST } from "./bonds";
import { formatMoney } from "./format";
import {
  cashKey,
  DEFAULT_QTY_DECIMALS,
  isCashKey,
  type Bucket,
  type CheckFrequency,
  type Cost,
  type GlideConfig,
  type InstrumentRule,
} from "./glidePath";

// ---- Dates ------------------------------------------------------------------

/** YYYY-MM-DD → UTC ms (calendar arithmetic without time-zone drift). */
function dayMs(day: string): number {
  return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** First day of the quarter (months = 3) or year (months = 12) holding `day`. */
function periodStart(day: string, months: 3 | 12): string {
  const y = +day.slice(0, 4);
  const m0 = +day.slice(5, 7) - 1;
  const start = months === 12 ? 0 : Math.floor(m0 / 3) * 3;
  return `${y}-${pad2(start + 1)}-01`;
}

/**
 * Check dates between `from` and `to` (inclusive): the first day of every
 * month / quarter. Used to sample the history chart and to schedule checks.
 */
export function checkDays(
  freq: CheckFrequency,
  from: string,
  to: string,
): string[] {
  const step = freq === "monthly" ? 1 : 3;
  let y = +from.slice(0, 4);
  let m0 = +from.slice(5, 7) - 1;
  if (freq === "quarterly") m0 = Math.floor(m0 / 3) * 3;
  const out: string[] = [];
  for (;;) {
    const d = `${y}-${pad2(m0 + 1)}-01`;
    if (d > to) break;
    if (d >= from) out.push(d);
    m0 += step;
    if (m0 > 11) {
      m0 -= 12;
      y += 1;
    }
  }
  return out;
}

// ---- Path target & band -----------------------------------------------------

/** The bucket's weight at the path start (snapshot falls back to the final). */
export function startWeight(b: Bucket): number {
  return b.start.mode === "manual"
    ? b.start.weight
    : (b.start.resolvedWeight ?? b.finalWeight);
}

function linearAt(b: Bucket, day: string): number {
  const s = dayMs(b.startDate);
  const e = dayMs(b.endDate);
  const d = dayMs(day);
  const w0 = startWeight(b);
  if (d <= s) return w0;
  if (d >= e) return b.finalWeight;
  return w0 + (b.finalWeight - w0) * ((d - s) / (e - s));
}

/**
 * The raw path target of one bucket on `day`: the start weight up to the path
 * start, the final weight from the end date on. In between it is linear, or —
 * for a stepped path — held at the linear value of the current quarter's /
 * year's first day, jumping at each boundary (and to the final on the end date).
 */
export function pathTarget(b: Bucket, day: string): number {
  if (day >= b.endDate) return b.finalWeight;
  if (day <= b.startDate) return startWeight(b);
  if (b.interpolation === "linear") return linearAt(b, day);
  const anchor = periodStart(day, b.interpolation === "step-quarter" ? 3 : 12);
  return linearAt(b, anchor < b.startDate ? b.startDate : anchor);
}

/**
 * Path targets of every bucket on `day`, normalised to sum to 100%. Buckets
 * with different dates or step types can momentarily add up to more or less
 * than 100% — normalising keeps the targets a proper allocation.
 */
export function pathTargets(cfg: GlideConfig, day: string): Map<string, number> {
  const raw = cfg.buckets.map((b) => [b.id, pathTarget(b, day)] as const);
  const sum = raw.reduce((s, [, t]) => s + t, 0);
  return new Map(raw.map(([id, t]) => [id, sum > 0 ? t / sum : 0]));
}

/** `day` + `n` calendar days (YYYY-MM-DD). */
function addDays(day: string, n: number): string {
  return new Date(dayMs(day) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The day whose path target the cash-flow routing aims at (see FlowTarget):
 * today, the next check day strictly after today, or N days ahead. Past a
 * bucket's end date its path target is simply the final weight.
 */
export function flowTargetDay(cfg: GlideConfig, day: string): string {
  const ft = cfg.flowTarget;
  if (!ft || ft.kind === "today") return day;
  if (ft.kind === "days")
    // An invalid N (being typed, rejected on save) falls back to today.
    return Number.isFinite(ft.days) ? addDays(day, Math.max(0, Math.floor(ft.days))) : day;
  return checkDays(cfg.checkFrequency, addDays(day, 1), addDays(day, 400))[0] ?? day;
}

export interface FlowTargets {
  /** The day the targets are taken from. */
  day: string;
  /** Looks ahead of today (anything but the "today" mode). */
  ahead: boolean;
  /** "a mai pályacél", "a 2027-01-01-i pályacél" or "a végső cél". */
  label: string;
  /** Bucket id → target weight (normalised like pathTargets). */
  weights: Map<string, number>;
}

/** The cash-flow routing's targets on `day` under the configured FlowTarget. */
export function flowTargets(cfg: GlideConfig, day: string): FlowTargets {
  const target = flowTargetDay(cfg, day);
  const ahead = target > day;
  const final = cfg.buckets.length > 0 && cfg.buckets.every((b) => target >= b.endDate);
  return {
    day: target,
    ahead,
    label: !ahead
      ? "a mai pályacél"
      : final
        ? "a végső cél"
        : `a ${target}-i pályacél`,
    weights: pathTargets(cfg, target),
  };
}

export interface BandLimits {
  target: number;
  low: number;
  high: number;
}

export interface BandWidth {
  /** Half-width from the band setting alone (abs pp, or pct × base). */
  computed: number;
  /** What applies: max(computed, the bucket's minimum band). */
  effective: number;
  /** The minimum band is what sets the width. */
  minApplied: boolean;
}

/**
 * Half-width of the band around `target`: absolute `pp`, or relative
 * `pct` × base (the day's path target, or the bucket's final weight), never
 * narrower than the bucket's minimum band.
 */
export function bandWidth(b: Bucket, target: number): BandWidth {
  const computed =
    b.band.kind === "abs"
      ? b.band.pp
      : (b.band.base === "final" ? b.finalWeight : target) * b.band.pct;
  const min = b.band.minPp ?? 0;
  return {
    computed,
    effective: Math.max(computed, min),
    minApplied: min > computed,
  };
}

/**
 * Band around the path target (see {@link bandWidth}), clipped to 0..100%.
 * `target` defaults to the bucket's raw path target; pass the normalised one
 * when working with a whole config.
 */
export function bandLimits(
  b: Bucket,
  day: string,
  target: number = pathTarget(b, day),
): BandLimits {
  const half = bandWidth(b, target).effective;
  return {
    target,
    low: Math.max(0, target - half),
    high: Math.min(1, target + half),
  };
}

// ---- Positions & weights ----------------------------------------------------

/** A held instrument or cash balance, valued in the base currency (HUF). */
export interface Position {
  /** Instrument key, or a cash key (`cash:HUF`). */
  key: string;
  name: string;
  valueHuf: number;
  /** Units held (bonds: face HUF). Undefined for cash. */
  quantity?: number;
  /** Value of one unit in HUF, for turning amounts into quantities. */
  unitPriceHuf?: number;
  /** Bonds: early-redemption cost fraction (the instrument-level default). */
  bondSellCostPct?: number;
}

/**
 * Positions consolidated across accounts, plus one cash position per currency.
 * With `bondsAtFace`, bonds and T-bills count at face value (1 HUF per unit),
 * the way the old target allocation did.
 */
export function positionsFromSummary(
  summary: PortfolioSummary,
  fx: Record<string, number>,
  bondsAtFace: boolean,
  day: string,
): Position[] {
  const map = new Map<string, Position>();
  const add = (p: Position) => {
    const cur = map.get(p.key);
    if (!cur) {
      map.set(p.key, { ...p });
      return;
    }
    cur.valueHuf += p.valueHuf;
    if (p.quantity != null) cur.quantity = (cur.quantity ?? 0) + p.quantity;
    if (cur.quantity && cur.quantity > 0 && cur.unitPriceHuf == null)
      cur.unitPriceHuf = p.unitPriceHuf;
  };
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      if (h.quantity <= 0) continue;
      const inst = h.instrument;
      const isBond = inst ? BOND_TYPES.has(inst.type) : false;
      const value =
        isBond && bondsAtFace ? h.quantity : (h.marketValueHuf ?? 0);
      add({
        key: h.instrumentKey,
        name: inst?.name ?? h.instrumentKey,
        valueHuf: value,
        quantity: h.quantity,
        unitPriceHuf:
          isBond && bondsAtFace
            ? 1
            : h.quantity > 0 && h.marketValueHuf
              ? h.marketValueHuf / h.quantity
              : undefined,
        bondSellCostPct: bondSellCost(inst, day),
      });
    }
    for (const [ccy, amt] of Object.entries(acc.cash)) {
      if (Math.abs(amt) < 1e-9) continue;
      add({
        key: cashKey(ccy),
        name: `Készpénz ${ccy}`,
        valueHuf: toHuf(amt, ccy, fx),
      });
    }
  }
  // Keep the unit price consistent with the merged value.
  for (const p of map.values())
    if (p.quantity && p.quantity > 0 && p.unitPriceHuf != null && !isCashKey(p.key))
      p.unitPriceHuf = p.valueHuf / p.quantity;
  return [...map.values()];
}

/** Early-sale cost of a fixed-rate bond before maturity; T-bills have none. */
function bondSellCost(inst: Instrument | undefined, day: string) {
  if (!inst || inst.type !== "gov_bond") return undefined;
  const maturity = inst.bond?.maturity ?? inst.maturity;
  if (maturity && maturity.slice(0, 10) <= day) return 0;
  return inst.bond?.saleCostPct ?? DEFAULT_BOND_SALE_COST;
}

export type BandStatus = "below" | "within" | "above" | "empty";

export interface BucketState extends BandLimits {
  bucket: Bucket;
  valueHuf: number;
  /** Share of the managed total, 0..1. */
  weight: number;
  status: BandStatus;
}

export interface ManagedPosition extends Position {
  rule: InstrumentRule;
}

export interface AllocationState {
  day: string;
  /** Combined value of every position assigned to a bucket. */
  totalHuf: number;
  buckets: BucketState[];
  /** Assigned positions (instruments assigned but not held appear at 0). */
  positions: ManagedPosition[];
  /** Held positions outside every bucket (e.g. unassigned cash). */
  unassigned: Position[];
}

const EPS = 1e-9;

function statusOf(weight: number, l: BandLimits, total: number): BandStatus {
  if (total <= 0) return "empty";
  if (weight < l.low - EPS) return "below";
  if (weight > l.high + EPS) return "above";
  return "within";
}

/**
 * Bucket values, weights, path targets, bands and statuses on `day`. Weights
 * are over the managed total only; with nothing managed (or all zero) every
 * bucket is "empty" at weight 0 — never a division by zero.
 */
export function allocationState(
  cfg: GlideConfig,
  positions: Position[],
  day: string,
): AllocationState {
  const targets = pathTargets(cfg, day);
  const managed: ManagedPosition[] = [];
  const unassigned: Position[] = [];
  for (const p of positions) {
    const rule = cfg.instruments[p.key];
    if (rule) managed.push({ ...p, rule });
    else unassigned.push(p);
  }
  // Assigned but not held: still a buy candidate (value 0, price unknown).
  const held = new Set(positions.map((p) => p.key));
  for (const [key, rule] of Object.entries(cfg.instruments))
    if (!held.has(key)) managed.push({ key, name: key, valueHuf: 0, rule });

  const valueOf = new Map<string, number>();
  for (const p of managed)
    valueOf.set(p.rule.bucketId, (valueOf.get(p.rule.bucketId) ?? 0) + p.valueHuf);
  const totalHuf = cfg.buckets.reduce((s, b) => s + (valueOf.get(b.id) ?? 0), 0);

  const buckets = cfg.buckets.map((bucket) => {
    const valueHuf = valueOf.get(bucket.id) ?? 0;
    const weight = totalHuf > 0 ? valueHuf / totalHuf : 0;
    const limits = bandLimits(bucket, day, targets.get(bucket.id) ?? 0);
    return {
      bucket,
      valueHuf,
      weight,
      ...limits,
      status: statusOf(weight, limits, totalHuf),
    };
  });
  return { day, totalHuf, buckets, positions: managed, unassigned };
}

/** Actual bucket weights (bucket id → 0..1). */
export function currentWeights(
  cfg: GlideConfig,
  positions: Position[],
  day: string,
): Map<string, number> {
  return new Map(
    allocationState(cfg, positions, day).buckets.map((b) => [b.bucket.id, b.weight]),
  );
}

// ---- Costs ------------------------------------------------------------------

export function estimateCost(c: Cost | undefined, amountHuf: number): number {
  if (!c || amountHuf <= 0) return 0;
  return amountHuf * (c.pct ?? 0) + (c.fixedHuf ?? 0);
}

/**
 * The applicable cost: instrument rule → bucket → (sells) the bond's own early
 * redemption cost → global default. Cash moves are free.
 */
export function costFor(
  cfg: GlideConfig,
  pos: ManagedPosition,
  side: "buy" | "sell",
): Cost | undefined {
  if (isCashKey(pos.key)) return undefined;
  const bucket = cfg.buckets.find((b) => b.id === pos.rule.bucketId);
  return (
    pos.rule.cost?.[side] ??
    bucket?.cost?.[side] ??
    (side === "sell" && pos.bondSellCostPct != null
      ? { pct: pos.bondSellCostPct }
      : undefined) ??
    cfg.defaultCost[side]
  );
}

// ---- Suggestions ------------------------------------------------------------

export type SuggestionStatus = "ok" | "below-min" | "cost-exceeds";

export interface Suggestion {
  source: "cashflow" | "band";
  bucketId: string;
  bucketName: string;
  instrumentKey?: string;
  instrumentName?: string;
  side: "buy" | "sell" | "redirect";
  /** Base currency (HUF), after rounding to whole units. */
  amountHuf: number;
  /** Whole units (bonds: face HUF). Undefined for cash / unknown price. */
  quantity?: number;
  costHuf: number;
  /** "ok" = suggested; otherwise shown as a note, but not suggested. */
  status: SuggestionStatus;
  reason: string;
  /** The bucket's expected weight after all "ok" suggestions of the plan. */
  weightAfter?: number;
}

export interface RebalancePlan {
  suggestions: Suggestion[];
  /** Bucket id → expected weight after the "ok" suggestions. */
  weightsAfter: Record<string, number>;
  /** Outside cash the "ok" suggestions use (net of sale proceeds). */
  cashUsedHuf: number;
  notes: string[];
}

const fmtHuf = (n: number) => formatMoney(n);

/** Decimals a suggested quantity is rounded (down) to: 0 unless fractional. */
export function quantityDecimals(rule: InstrumentRule): number {
  if (!rule.fractional) return 0;
  const d = rule.qtyDecimals ?? DEFAULT_QTY_DECIMALS;
  return Math.min(8, Math.max(0, Math.round(d)));
}

/** A quantity in Hungarian format ("3,6912"), up to 8 decimals. */
export function formatQuantity(q: number): string {
  return q.toLocaleString("hu-HU", { maximumFractionDigits: 8 });
}

/** Round to whole units, price the cost, and decide whether it's worth doing. */
function makeTrade(
  cfg: GlideConfig,
  pos: ManagedPosition,
  bucketName: string,
  side: "buy" | "sell",
  rawHuf: number,
  source: Suggestion["source"],
  reason: string,
): Suggestion {
  let amount = rawHuf;
  let quantity: number | undefined;
  if (!isCashKey(pos.key) && pos.unitPriceHuf && pos.unitPriceHuf > 0) {
    // Whole units, or — for a fractional instrument — down to its decimals
    // (never more than planned when buying, never more than held when selling).
    const f = 10 ** quantityDecimals(pos.rule);
    const down = (q: number) => Math.floor(q * f + 1e-9) / f;
    quantity = down(rawHuf / pos.unitPriceHuf);
    if (side === "sell" && pos.quantity != null)
      quantity = Math.min(quantity, down(pos.quantity));
    amount = quantity * pos.unitPriceHuf;
  }
  const costHuf = estimateCost(costFor(cfg, pos, side), amount);
  let status: SuggestionStatus = "ok";
  let why = reason;
  if (quantity === 0) {
    status = "below-min";
    why = `Egy egység ára (${fmtHuf(pos.unitPriceHuf ?? 0)}) több, mint a szükséges ${fmtHuf(rawHuf)}.`;
  } else if (amount < cfg.minTradeHuf) {
    status = "below-min";
    why = `${fmtHuf(amount)} a minimális tranzakcióméret (${fmtHuf(cfg.minTradeHuf)}) alatt.`;
  } else if (costHuf > cfg.maxCostRatio * amount) {
    status = "cost-exceeds";
    why = `A becsült költség (${fmtHuf(costHuf)}) több, mint a korrekció ${(cfg.maxCostRatio * 100).toLocaleString("hu-HU")}%-a — nem éri meg.`;
  }
  return {
    source,
    bucketId: pos.rule.bucketId,
    bucketName,
    instrumentKey: pos.key,
    instrumentName: pos.name,
    side,
    amountHuf: amount,
    quantity,
    costHuf,
    status,
    reason: why,
  };
}

/**
 * Split a bucket's buy across its instruments that accept contributions: in
 * proportion to what is already held (equally when nothing is), then fold
 * slices below the minimum trade into the largest one, so the plan doesn't
 * fragment into tickets too small to place.
 */
function splitBuy(
  candidates: ManagedPosition[],
  amount: number,
  minTradeHuf: number,
): { pos: ManagedPosition; amount: number }[] {
  if (candidates.length === 0 || amount <= 0) return [];
  const held = candidates.reduce((s, p) => s + Math.max(0, p.valueHuf), 0);
  const slices = candidates
    .map((pos) => ({
      pos,
      amount:
        held > 0
          ? (amount * Math.max(0, pos.valueHuf)) / held
          : amount / candidates.length,
    }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  while (slices.length > 1 && slices[slices.length - 1].amount < minTradeHuf) {
    slices[0].amount += slices.pop()!.amount;
  }
  return slices;
}

/** Sell up to `amount` from the bucket's sellable positions, largest first. */
function splitSell(
  candidates: ManagedPosition[],
  amount: number,
): { pos: ManagedPosition; amount: number }[] {
  const out: { pos: ManagedPosition; amount: number }[] = [];
  let left = amount;
  for (const pos of [...candidates].sort((a, b) => b.valueHuf - a.valueHuf)) {
    if (left <= EPS) break;
    const take = Math.min(left, Math.max(0, pos.valueHuf));
    if (take > EPS) out.push({ pos, amount: take });
    left -= take;
  }
  return out;
}

/**
 * Water-filling: give `amount` to the buckets whose weight is furthest BELOW
 * target (measured against the post-contribution total `newTotal`), raising
 * the most underweight first until it meets the next one, and so on — which
 * brings the allocation as close to the path as the money allows. When some
 * buckets can't receive money, the eligible ones may end up above target; the
 * level then keeps going, so the least overweight bucket gets the rest first
 * (never piling more onto a bucket that's already furthest above its path).
 */
export function waterFill(
  items: { id: string; valueHuf: number; target: number }[],
  amount: number,
  newTotal: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (amount <= 0 || items.length === 0 || newTotal <= 0) return out;
  const gaps = items
    .map((i) => ({ ...i, gap: i.target - i.valueHuf / newTotal }))
    .sort((a, b) => b.gap - a.gap);
  // Find the common level λ: Σ_{top k} (gap − λ) · newTotal = amount.
  let lambda = 0;
  let sum = 0;
  for (let k = 0; k < gaps.length; k++) {
    sum += gaps[k].gap;
    lambda = (sum - amount / newTotal) / (k + 1);
    const next = gaps[k + 1]?.gap ?? -Infinity;
    if (lambda >= next) break;
  }
  for (const g of gaps) {
    const x = (g.gap - lambda) * newTotal;
    if (x > EPS) out.set(g.id, x);
  }
  return out;
}

/** Fill in each suggestion's bucket weight after the plan's "ok" trades. */
function finishPlan(
  state: AllocationState,
  suggestions: Suggestion[],
  notes: string[],
): RebalancePlan {
  const value = new Map(state.buckets.map((b) => [b.bucket.id, b.valueHuf]));
  let cashUsed = 0;
  for (const s of suggestions) {
    if (s.status !== "ok" || s.side === "redirect") continue;
    const d = s.side === "buy" ? s.amountHuf : -s.amountHuf;
    value.set(s.bucketId, (value.get(s.bucketId) ?? 0) + d);
    cashUsed += d;
  }
  const total = state.totalHuf + cashUsed;
  const weightsAfter: Record<string, number> = {};
  for (const b of state.buckets)
    weightsAfter[b.bucket.id] = total > 0 ? (value.get(b.bucket.id) ?? 0) / total : 0;
  for (const s of suggestions) s.weightAfter = weightsAfter[s.bucketId];
  return { suggestions, weightsAfter, cashUsedHuf: cashUsed, notes };
}

/**
 * Cash-flow routing (the primary tool): where should `amountHuf` of new money
 * (a coupon, dividend or deposit) go so the buckets end up as close to their
 * path targets as possible — buying only. Only instruments that accept
 * contributions receive money; a bucket slice below the minimum trade is
 * dropped and its money re-routed to the others (unless it's the only one).
 * `targets` (see flowTargets) aims the money at a look-ahead path target
 * instead of today's; omitted = today's, as stored on the state.
 */
export function routeCashflow(
  cfg: GlideConfig,
  state: AllocationState,
  amountHuf: number,
  source: Suggestion["source"] = "cashflow",
  targets?: FlowTargets,
): RebalancePlan {
  const ahead = targets?.ahead ? targets : undefined;
  const targetOf = (b: BucketState) =>
    ahead ? (ahead.weights.get(b.bucket.id) ?? 0) : b.target;
  const notes: string[] = [];
  if (!(amountHuf > 0)) return finishPlan(state, [], notes);
  const accepting = (id: string) =>
    state.positions.filter((p) => p.rule.bucketId === id && p.rule.acceptsContributions);
  let eligible = state.buckets.filter((b) => accepting(b.bucket.id).length > 0);
  for (const b of state.buckets)
    if (!eligible.includes(b) && b.status === "below")
      notes.push(`${b.bucket.name}: sáv alatt, de egyik instrumentuma sem fogad befizetést.`);
  if (eligible.length === 0) {
    notes.push("Nincs befizetést fogadó instrumentum — a pénz nem irányítható.");
    return finishPlan(state, [], notes);
  }

  const newTotal = state.totalHuf + amountHuf;
  let alloc: Map<string, number>;
  for (;;) {
    alloc = waterFill(
      eligible.map((b) => ({ id: b.bucket.id, valueHuf: b.valueHuf, target: targetOf(b) })),
      amountHuf,
      newTotal,
    );
    const small = [...alloc.entries()]
      .filter(([, x]) => x < cfg.minTradeHuf)
      .sort((a, b) => a[1] - b[1]);
    if (small.length === 0 || alloc.size <= 1) break;
    eligible = eligible.filter((b) => b.bucket.id !== small[0][0]);
  }

  // Why a bucket gets money. Measured against the total WITH the new money:
  // a bucket exactly on its path is still short of target × new total.
  const onPath = eligible.every((b) => Math.abs(b.weight - targetOf(b)) < 0.001);
  const to = ahead ? `${ahead.label}hoz` : "a pályához";
  const reason = (b: BucketState) =>
    onPath
      ? ahead
        ? `A portfólió ${ahead.label}nak megfelelő — a bejövő pénz annak arányában oszlik el.`
        : "A pályán van — a bejövő pénz a pályacélok arányában oszlik el."
      : targetOf(b) - b.valueHuf / newTotal > EPS
        ? `${to[0].toUpperCase()}${to.slice(1)} képest alulsúlyozott — a bejövő pénz ide megy.`
        : `Az alulsúlyozott csoportok nem fogadnak pénzt — a maradék ide kerül, ${to} legközelebb.`;

  const suggestions: Suggestion[] = [];
  for (const b of state.buckets) {
    const x = alloc.get(b.bucket.id);
    if (!x) continue;
    for (const s of splitBuy(accepting(b.bucket.id), x, cfg.minTradeHuf))
      suggestions.push(
        makeTrade(
          cfg,
          s.pos,
          b.bucket.name,
          "buy",
          s.amount,
          source,
          reason(b),
        ),
      );
  }
  return finishPlan(state, suggestions, notes);
}

/**
 * Incoming money routed to the configured target (FlowTarget) — what the
 * Teendők panel and the bot use. Returns the targets alongside the plan so
 * the caller can show where it aimed.
 */
export function planCashflow(
  cfg: GlideConfig,
  state: AllocationState,
  amountHuf: number,
): RebalancePlan & { flow: FlowTargets } {
  const flow = flowTargets(cfg, state.day);
  return { ...routeCashflow(cfg, state, amountHuf, "cashflow", flow), flow };
}

/**
 * The band rule (secondary tool), only for buckets outside their band:
 *  - above: sell the excess from sellable instruments; whatever can't (or
 *    isn't worth it) becomes a "redirect future contributions" suggestion;
 *  - below: buy back up, funded first by those sale proceeds, then by
 *    `cashAvailableHuf` (outside cash), then by selling buckets that are over
 *    their path target (largest excess first, sellable instruments only).
 * The restore goal is the path target or just the band edge (`restoreTo`).
 * Every trade is rounded to whole units and checked against the minimum size
 * and the cost/benefit threshold; trades that fail are listed but not
 * suggested, and the buys are scaled down to what the suggested sells fund.
 */
export function bandRule(
  cfg: GlideConfig,
  state: AllocationState,
  cashAvailableHuf = 0,
): RebalancePlan {
  const notes: string[] = [];
  const T = state.totalHuf;
  const cash = Math.max(0, cashAvailableHuf);
  const out = state.buckets.filter((b) => b.status === "below" || b.status === "above");
  if (out.length === 0) {
    notes.push("Minden csoport a sávon belül — nincs teendő.");
    return finishPlan(state, [], notes);
  }
  const goal = (b: BucketState) =>
    cfg.restoreTo === "path" ? b.target : b.status === "below" ? b.low : b.high;
  const sellable = (id: string) =>
    state.positions.filter((p) => p.rule.bucketId === id && p.rule.sellable && p.valueHuf > 0);
  const accepting = (id: string) =>
    state.positions.filter((p) => p.rule.bucketId === id && p.rule.acceptsContributions);

  const sells: Suggestion[] = [];
  const redirects: Suggestion[] = [];
  const soldFrom = new Map<string, number>();
  const redirect = (b: BucketState, amount: number, why: string) =>
    redirects.push({
      source: "band",
      bucketId: b.bucket.id,
      bucketName: b.bucket.name,
      side: "redirect",
      amountHuf: amount,
      costHuf: 0,
      status: "ok",
      reason: why,
    });

  // 1) Above the band: sell the excess down to the goal.
  for (const b of state.buckets.filter((x) => x.status === "above")) {
    const excess = b.valueHuf - goal(b) * T;
    let sold = 0;
    for (const s of splitSell(sellable(b.bucket.id), excess)) {
      const t = makeTrade(cfg, s.pos, b.bucket.name, "sell", s.amount, "band",
        "A sáv fölött — eladás a cél felé.");
      sells.push(t);
      if (t.status === "ok") sold += t.amountHuf;
    }
    soldFrom.set(b.bucket.id, sold);
    if (excess - sold >= Math.max(1, cfg.minTradeHuf))
      redirect(b, excess - sold,
        sold > 0
          ? "A többlet egy része nem adható el (tiltott vagy nem éri meg) — a következő befizetések menjenek máshová."
          : "A sáv fölött, de eladás nem javasolt — a következő befizetések menjenek máshová, amíg vissza nem ér.");
  }
  const proceeds = () =>
    sells.filter((s) => s.status === "ok").reduce((a, s) => a + s.amountHuf - s.costHuf, 0);

  // 2) Below the band: buy up to the goal. The managed total after the trades
  //    is T + (outside cash used); sells and buys inside it just move money.
  const below = state.buckets.filter((x) => x.status === "below");
  let buys: Suggestion[] = [];
  let cashUse = 0;
  if (below.length) {
    const G = below.reduce((s, b) => s + goal(b), 0);
    const V = below.reduce((s, b) => s + b.valueHuf, 0);
    const need = (cu: number) => G * (T + cu) - V; // Σ buys for outside cash cu
    let P = proceeds();
    if (need(0) > P) {
      cashUse = G < 1 ? Math.min(cash, (G * T - V - P) / (1 - G)) : cash;
      cashUse = Math.max(0, cashUse);
      // 3) Still short: sell from buckets over their path target.
      let short = need(cashUse) - cashUse - P;
      if (short > 1) {
        const belowIds = new Set(below.map((b) => b.bucket.id));
        const donors = state.buckets
          .filter((b) => !belowIds.has(b.bucket.id))
          .map((b) => ({
            b,
            excess: b.valueHuf - (soldFrom.get(b.bucket.id) ?? 0) - b.target * (T + cashUse),
          }))
          .filter((d) => d.excess > 1)
          .sort((a, c) => c.excess - a.excess);
        for (const d of donors) {
          if (short <= 1) break;
          const already = new Set(sells.map((s) => s.instrumentKey));
          const cands = sellable(d.b.bucket.id).filter((p) => !already.has(p.key));
          for (const s of splitSell(cands, Math.min(short, d.excess))) {
            const t = makeTrade(cfg, s.pos, d.b.bucket.name, "sell", s.amount, "band",
              "A pályához képest felülsúlyozott — eladás a sáv alatti csoport finanszírozására.");
            sells.push(t);
            if (t.status === "ok") short -= t.amountHuf - t.costHuf;
          }
        }
        P = proceeds();
      }
    }
    const funds = P + cashUse;
    const total = need(cashUse);
    const scale = total > funds && total > 0 ? funds / total : 1;
    // A shortfall the sale costs explain (shown on each sell) plus 1% for
    // rounding is expected — only a real lack of money is worth a note.
    const saleCosts = sells
      .filter((s) => s.status === "ok")
      .reduce((a, s) => a + s.costHuf, 0);
    if (total - funds > saleCosts + 0.01 * total)
      notes.push("Nincs elég pénz és eladható felülsúly — a vételek csak részben állítják vissza a sávot.");

    buys = [];
    for (const b of below) {
      const x = (goal(b) * (T + cashUse) - b.valueHuf) * scale;
      const cands = accepting(b.bucket.id);
      if (cands.length === 0) {
        notes.push(`${b.bucket.name}: sáv alatt, de egyik instrumentuma sem fogad befizetést.`);
        continue;
      }
      for (const s of splitBuy(cands, x, cfg.minTradeHuf))
        buys.push(makeTrade(cfg, s.pos, b.bucket.name, "buy", s.amount, "band",
          "A sáv alatt — vétel a cél felé."));
    }
    // Buys may not spend more than the suggested sells + cash provide.
    const spend = buys.filter((s) => s.status === "ok")
      .reduce((a, s) => a + s.amountHuf + s.costHuf, 0);
    const avail = proceeds() + cashUse;
    if (spend > avail + 1 && spend > 0) {
      const k = Math.max(0, avail) / spend;
      buys = buys.flatMap((s) => {
        if (s.status !== "ok") return [s];
        if (s.amountHuf * k < 1) return [];
        const pos = state.positions.find((p) => p.key === s.instrumentKey)!;
        return [makeTrade(cfg, pos, s.bucketName, "buy", s.amountHuf * k, "band", s.reason)];
      });
      if (k < 0.99)
        notes.push("A javasolt eladások (költség után) nem fedezik a teljes vételt — a vételek arányosan csökkentve.");
    }
    buys = buys.filter((s) => s.amountHuf >= 1 || s.status !== "ok");
  }

  // Sale proceeds the buys don't use are reinvested along the path (cash-flow
  // routing on the post-trade state), so selling never leaves money idle. The
  // restore above aims at TODAY's target; this leftover follows the configured
  // look-ahead target, like incoming money.
  const spent = buys
    .filter((s) => s.status === "ok")
    .reduce((a, s) => a + s.amountHuf + s.costHuf, 0);
  const leftover = Math.min(proceeds(), proceeds() + cashUse - spent);
  let routed: Suggestion[] = [];
  // Rounding change below the minimum trade isn't worth another ticket.
  if (leftover >= Math.max(1, cfg.minTradeHuf)) {
    const plan = routeCashflow(
      cfg,
      applyTrades(state, [...sells, ...buys]),
      leftover,
      "band",
      flowTargets(cfg, state.day),
    );
    // Change that doesn't buy a single unit is just left as cash.
    routed = plan.suggestions.filter((s) => s.quantity !== 0);
    notes.push(...plan.notes);
  }
  return finishPlan(state, [...sells, ...buys, ...routed, ...redirects], notes);
}

/**
 * The state after the "ok" trades (values moved, weights recomputed; buys
 * with new money grow the total). Statuses are re-read against the same band.
 */
export function applyTrades(state: AllocationState, trades: Suggestion[]): AllocationState {
  const delta = new Map<string, number>();
  for (const t of trades) {
    if (t.status !== "ok" || !t.instrumentKey) continue;
    const d = t.side === "buy" ? t.amountHuf : t.side === "sell" ? -t.amountHuf : 0;
    delta.set(t.instrumentKey, (delta.get(t.instrumentKey) ?? 0) + d);
  }
  const positions = state.positions.map((p) => ({
    ...p,
    valueHuf: p.valueHuf + (delta.get(p.key) ?? 0),
  }));
  const bucketDelta = new Map<string, number>();
  for (const p of state.positions)
    bucketDelta.set(p.rule.bucketId, (bucketDelta.get(p.rule.bucketId) ?? 0) + (delta.get(p.key) ?? 0));
  const totalHuf = state.totalHuf + [...bucketDelta.values()].reduce((a, b) => a + b, 0);
  const buckets = state.buckets.map((b) => {
    const valueHuf = b.valueHuf + (bucketDelta.get(b.bucket.id) ?? 0);
    const weight = totalHuf > 0 ? valueHuf / totalHuf : 0;
    return { ...b, valueHuf, weight, status: statusOf(weight, b, totalHuf) };
  });
  return { ...state, totalHuf, buckets, positions };
}

// ---- History & snapshot starts ----------------------------------------------

/** Positions on a day, valued with or without bonds at face. */
export type PositionsAt = (day: string, bondsAtFace: boolean) => Position[];

export interface WeightPoint {
  day: string;
  /** Bucket id → actual weight, path target and band on that day. */
  buckets: Record<string, BandLimits & { weight: number; status: BandStatus }>;
}

/**
 * Actual weights with the path target and band per sample day. Each day uses
 * the configuration version in force then (membership, path and band all come
 * from it); days before the first version use the earliest one, so the actual
 * weights can be traced back through the whole ledger history. Buckets keep
 * their id across versions, which is what links a line through a re-save.
 */
export function weightHistory(
  versions: GlideConfig[],
  days: string[],
  positionsAt: PositionsAt,
): WeightPoint[] {
  const first = [...versions].sort(
    (a, b) => a.validFrom.localeCompare(b.validFrom) || a.savedAt.localeCompare(b.savedAt),
  )[0];
  if (!first) return [];
  const out: WeightPoint[] = [];
  for (const day of days) {
    const cfg = configAtOrFirst(versions, day, first);
    if (cfg.buckets.length === 0) continue;
    const state = allocationState(cfg, positionsAt(day, cfg.bondsAtFace), day);
    if (state.totalHuf <= 0) continue;
    const buckets: WeightPoint["buckets"] = {};
    for (const b of state.buckets)
      buckets[b.bucket.id] = {
        weight: b.weight,
        target: b.target,
        low: b.low,
        high: b.high,
        status: b.status,
      };
    out.push({ day, buckets });
  }
  return out;
}

function configAtOrFirst(
  versions: GlideConfig[],
  day: string,
  first: GlideConfig,
): GlideConfig {
  let best: GlideConfig | undefined;
  for (const v of versions) {
    if (v.validFrom > day) continue;
    if (
      !best ||
      v.validFrom > best.validFrom ||
      (v.validFrom === best.validFrom && v.savedAt > best.savedAt)
    )
      best = v;
  }
  return best ?? first;
}

/**
 * Freeze each snapshot-start bucket's weight: its actual share on the snapshot
 * date, under the membership of `cfg` itself. Left undefined when nothing was
 * held that day (the path then starts from the final weight).
 */
export function resolveSnapshotStarts(
  cfg: GlideConfig,
  positionsAt: PositionsAt,
): GlideConfig {
  const cache = new Map<string, Map<string, number> | null>();
  const weightsOn = (day: string) => {
    if (!cache.has(day)) {
      const s = allocationState(cfg, positionsAt(day, cfg.bondsAtFace), day);
      cache.set(
        day,
        s.totalHuf > 0 ? new Map(s.buckets.map((b) => [b.bucket.id, b.weight])) : null,
      );
    }
    return cache.get(day) ?? null;
  };
  return {
    ...cfg,
    buckets: cfg.buckets.map((b) => {
      if (b.start.mode !== "snapshot") return b;
      const w = weightsOn(b.start.date)?.get(b.id);
      return { ...b, start: { ...b.start, resolvedWeight: w } };
    }),
  };
}

// ---- Simulation, alerts, shared state ---------------------------------------

/**
 * "What if bucket X moved by ±p%": every security position of a shocked
 * bucket is scaled by (1 + shock); cash (in or outside a bucket) and
 * unassigned positions stay as they are. Pure — feed the result back into
 * {@link allocationState} to see the weights and {@link bandRule} for the steps.
 */
export function applyShock(
  cfg: GlideConfig,
  positions: Position[],
  shocks: Record<string, number>,
): Position[] {
  return positions.map((p) => {
    const bucketId = cfg.instruments[p.key]?.bucketId;
    const shock = bucketId ? (shocks[bucketId] ?? 0) : 0;
    if (!shock || isCashKey(p.key)) return p;
    const f = Math.max(0, 1 + shock);
    return {
      ...p,
      valueHuf: p.valueHuf * f,
      unitPriceHuf: p.unitPriceHuf != null ? p.unitPriceHuf * f : undefined,
    };
  });
}

/**
 * Today's allocation state under the newest version (null when the glide path
 * is off) — the one entry point the app, the AI snapshot and the Telegram bot
 * share, so they all see the same weights.
 */
export function glideStateFrom(
  versions: GlideConfig[],
  summary: PortfolioSummary,
  fx: Record<string, number>,
  day: string,
): AllocationState | null {
  let cfg: GlideConfig | undefined;
  for (const v of versions)
    if (
      !cfg ||
      v.validFrom > cfg.validFrom ||
      (v.validFrom === cfg.validFrom && v.savedAt > cfg.savedAt)
    )
      cfg = v;
  if (!cfg || cfg.buckets.length === 0) return null;
  return allocationState(
    cfg,
    positionsFromSummary(summary, fx, cfg.bondsAtFace, day),
    day,
  );
}

/** Check period holding `day`: "2026-09" (monthly) or "2026-Q3" (quarterly). */
export function checkPeriod(freq: CheckFrequency, day: string): string {
  const y = day.slice(0, 4);
  const m = +day.slice(5, 7);
  return freq === "monthly"
    ? `${y}-${pad2(m)}`
    : `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// ---- Out-of-band alerts & deepening re-alerts ------------------------------

/** How far the weight is beyond the band edge (fraction; 0 inside the band). */
export function bandDeviation(b: BandLimits & { weight: number }): number {
  if (b.weight < b.low) return b.low - b.weight;
  if (b.weight > b.high) return b.weight - b.high;
  return 0;
}

/** Stored alert state of one out-of-band bucket (per device / bot). */
export interface GlideSignal {
  status: "below" | "above";
  /** Check period of the last alert ("2026-09" / "2026-Q3"). */
  period: string;
  /** Distance beyond the band edge at the last alert (fraction). */
  deviation: number;
  /** Distance at the alert before the last one (deepening re-alerts only). */
  prevDeviation?: number;
  /** 1 = the period's first alert, 2+ = deepening re-alerts. */
  count: number;
  /** Day of the last alert. */
  day: string;
}

/** Bucket id → signal. A bucket inside its band has no entry. */
export type GlideSignals = Record<string, GlideSignal>;

/**
 * One step of the re-alert state machine — the single rule the app and the
 * Telegram bot both run:
 *  - inside the band (or no data) → no signal: the stored state is cleared;
 *  - first time out, flipped side, or a new check period → "first";
 *  - distance beyond the band grew by ≥ `stepPp` since the LAST alert →
 *    "deeper" (a new alert id, so dismissing the previous one doesn't hide it);
 *  - otherwise nothing new; the baseline stays at the last alert's distance.
 * `stepPp` = 0 turns deepening re-alerts off.
 */
export function nextGlideSignal(
  prev: GlideSignal | undefined,
  cur: { status: BandStatus; deviation: number; period: string; day: string },
  stepPp: number,
): { signal?: GlideSignal; event?: "first" | "deeper" } {
  if (cur.status !== "below" && cur.status !== "above") return {};
  if (!prev || prev.status !== cur.status || prev.period !== cur.period)
    return {
      event: "first",
      signal: {
        status: cur.status,
        period: cur.period,
        deviation: cur.deviation,
        count: 1,
        day: cur.day,
      },
    };
  if (stepPp > 0 && cur.deviation - prev.deviation >= stepPp - EPS)
    return {
      event: "deeper",
      signal: {
        ...prev,
        deviation: cur.deviation,
        prevDeviation: prev.deviation,
        count: prev.count + 1,
        day: cur.day,
      },
    };
  return { signal: prev };
}

/** The re-alert step of a bucket: its own, else the global one. */
export function realertStep(cfg: GlideConfig, b: Bucket): number {
  return b.realertStepPp ?? cfg.realertStepPp ?? 0;
}

/**
 * Advance every bucket's signal to the current state. Buckets inside their
 * band (or gone from the config) drop out. `changed` tells the caller
 * whether there is anything new to persist.
 */
export function updateGlideSignals(
  prev: GlideSignals,
  state: AllocationState | null,
  cfg: GlideConfig | undefined,
): { signals: GlideSignals; changed: boolean } {
  const signals: GlideSignals = {};
  if (state && cfg && state.totalHuf > 0) {
    const period = checkPeriod(cfg.checkFrequency, state.day);
    for (const b of state.buckets) {
      const next = nextGlideSignal(
        prev[b.bucket.id],
        { status: b.status, deviation: bandDeviation(b), period, day: state.day },
        realertStep(cfg, b.bucket),
      );
      if (next.signal) signals[b.bucket.id] = next.signal;
    }
  }
  return { signals, changed: JSON.stringify(signals) !== JSON.stringify(prev) };
}

/** Outside cash (cash balances in no bucket) — the default source of money. */
export function freeCashHuf(state: AllocationState): number {
  return state.unassigned
    .filter((p) => isCashKey(p.key) && p.valueHuf > 0)
    .reduce((s, p) => s + p.valueHuf, 0);
}

const SIDE_LABEL = { buy: "Vétel", sell: "Eladás", redirect: "Átirányítás" } as const;

/** "Vétel: VWCE 3 db (≈ 30 000 Ft)" — one step as plain text (alerts, Telegram). */
export function suggestionText(s: Suggestion): string {
  if (s.side === "redirect")
    return `${s.bucketName}: a következő ${formatMoney(s.amountHuf)} befizetés menjen más csoportba`;
  const qty =
    s.quantity != null && s.quantity !== s.amountHuf ? ` ${formatQuantity(s.quantity)} db` : "";
  return `${SIDE_LABEL[s.side]}: ${s.instrumentName ?? s.bucketName}${qty} (≈ ${formatMoney(s.amountHuf)})`;
}

/** Alert id prefix of a deepening re-alert ("…:n2", "…:n3"). */
export function isDeepGlideAlert(a: Alert): boolean {
  return /^glide:.*:n\d+$/.test(a.id);
}

/**
 * One alert per bucket outside its band, from its signal (see
 * {@link updateGlideSignals}; a bucket without one counts as a first alert).
 * The first alert's id carries the check period, so a dismissed alert comes
 * back at the next check; a deepening re-alert gets a numbered id and says how
 * far the distance grew, with the band rule's updated steps. Deep alerts may
 * bypass the bot's quiet hours (`deepAlertsInQuietHours`).
 */
export function glideAlerts(
  state: AllocationState | null,
  cfg: GlideConfig | undefined,
  signals: GlideSignals = {},
): Alert[] {
  if (!state || !cfg || state.totalHuf <= 0) return [];
  const period = checkPeriod(cfg.checkFrequency, state.day);
  const p = (v: number) =>
    `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`;
  const pp = (v: number) =>
    `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} %pont`;
  const out = state.buckets.filter((b) => b.status === "below" || b.status === "above");
  if (out.length === 0) return [];
  let steps: string | undefined;
  const planText = () => {
    if (steps == null) {
      const ok = bandRule(cfg, state, freeCashHuf(state)).suggestions.filter(
        (s) => s.status === "ok",
      );
      steps = ok.length
        ? ` Frissített javaslat: ${ok.slice(0, 4).map(suggestionText).join("; ")}${ok.length > 4 ? " …" : ""}.`
        : "";
    }
    return steps;
  };
  return out.map((b) => {
    const side = b.status === "below" ? "sáv alatt" : "sáv fölött";
    const base = `glide:${b.bucket.id}:${b.status}:${period}`;
    const sig = signals[b.bucket.id];
    const now = `Tény ${p(b.weight)} · pályacél ${p(b.target)} (sáv ${p(b.low)}–${p(b.high)})`;
    if (sig && sig.status === b.status && sig.period === period && sig.count > 1)
      return {
        id: `${base}:n${sig.count}`,
        severity: "medium" as const,
        title: `Célpálya – ${b.bucket.name}: tovább mélyült (${side})`,
        detail: `Eltérés a sávhatártól: ${pp(sig.prevDeviation ?? 0)} → ${pp(sig.deviation)}. ${now}.${planText()}`,
        to: "/goals",
        actionLabel: "Teendők",
        bypassQuiet: cfg.deepAlertsInQuietHours,
      };
    return {
      id: base,
      severity: "medium" as const,
      title: `Célpálya – ${b.bucket.name}: ${side}`,
      detail: `${now}, eltérés a sávhatártól ${pp(bandDeviation(b))}. A Teendők panel javasolja a lépéseket.`,
      to: "/goals",
      actionLabel: "Teendők",
    };
  });
}
