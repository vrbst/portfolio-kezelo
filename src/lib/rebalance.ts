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
import type { Alert, PlannedTrade } from "./alerts";
import type { PortfolioSummary } from "./portfolio";
import { toHuf, toLocalDay } from "./portfolio";
import { BOND_TYPES, DEFAULT_BOND_SALE_COST } from "./bonds";
import { formatMoney } from "./format";
import { addDaysIso } from "./day";
import {
  cashKey,
  DEFAULT_QTY_DECIMALS,
  isCashKey,
  isInflowMode,
  type Bucket,
  type CheckFrequency,
  type Cost,
  type CostRule,
  type GlideConfig,
  type InstrumentRule,
  type OutOfBandMode,
} from "./glidePath";
import { loadBrokerFees, type BrokerFees } from "./planPrefs";
import { freeCashOf } from "./savings";
import {
  accountById,
  accountCashHuf,
  accountLabel,
  blockedText,
  feeOf,
  outflowBlocked,
  purchaseVenue,
  upcomingVenueChange,
  type AccountContext,
} from "./accountRules";

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
  const raw = cfg.buckets.map(
    (b) =>
      [b.id, isInflowMode(cfg) ? inflowTarget(cfg, b, day) : pathTarget(b, day)] as const,
  );
  const sum = raw.reduce((s, [, t]) => s + t, 0);
  return new Map(raw.map(([id, t]) => [id, sum > 0 ? t / sum : 0]));
}

/**
 * "inflows" mode: the bucket's target on `day` from the frozen inflow path —
 * linear between its points, the first point's weight before it, and after
 * the last the final weight (when the path arrives) or the last point's.
 * With no frozen path yet (a draft never saved) the final weight.
 */
export function inflowTarget(cfg: GlideConfig, b: Bucket, day: string): number {
  const pts = cfg.inflowPath ?? [];
  if (pts.length === 0) return b.finalWeight;
  const w = (i: number) => pts[i].weights[b.id] ?? b.finalWeight;
  if (day <= pts[0].day) return w(0);
  const last = pts.length - 1;
  if (day >= pts[last].day) return cfg.inflowReached ? b.finalWeight : w(last);
  let i = 0;
  while (pts[i + 1].day < day) i++;
  const s = dayMs(pts[i].day);
  const e = dayMs(pts[i + 1].day);
  return w(i) + (w(i + 1) - w(i)) * ((dayMs(day) - s) / (e - s));
}

/** The weight the inflow path starts from (the actual weight on the save day). */
function inflowStart(cfg: GlideConfig, b: Bucket): number {
  return cfg.inflowPath?.[0]?.weights[b.id] ?? b.finalWeight;
}

/**
 * The bucket as the band sees it. In "inflows" mode the band limit on the
 * side the bucket is heading to is measured from the final weight (a rising
 * bucket running ahead of the inflows is never flagged before final + band),
 * the other from the path — the "final" base set by direction, automatically.
 */
export function bandBucket(cfg: GlideConfig, b: Bucket): Bucket {
  if (!isInflowMode(cfg)) return b;
  const dir = Math.sign(b.finalWeight - inflowStart(cfg, b));
  return {
    ...b,
    upperBase: dir > 0 ? "final" : "path",
    lowerBase: dir < 0 ? "final" : "path",
  };
}

/** `day` + `n` calendar days (YYYY-MM-DD). */
function addDays(day: string, n: number): string {
  return addDaysIso(day, n);
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
  // "inflows" mode: money goes towards the final weights — exactly what the
  // frozen path assumed. Aiming at the path would split it pro rata while on
  // the path, and the allocation would only turn at the path's own pace.
  if (isInflowMode(cfg)) {
    const sum = cfg.buckets.reduce((s, b) => s + b.finalWeight, 0);
    return {
      day,
      ahead: true,
      label: "a végső cél",
      weights: new Map(cfg.buckets.map((b) => [b.id, sum > 0 ? b.finalWeight / sum : 0])),
    };
  }
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
  /**
   * The limit is measured from the final weight (Bucket.upperBase /
   * lowerBase) and is wider than the path band would be.
   */
  highFromFinal?: boolean;
  lowFromFinal?: boolean;
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
 * when working with a whole config. A limit whose base is the final weight
 * (Bucket.upperBase / lowerBase) is final ± the band there, but never
 * narrower than the path band — past the end date the two coincide.
 */
export function bandLimits(
  b: Bucket,
  day: string,
  target: number = pathTarget(b, day),
): BandLimits {
  const half = bandWidth(b, target).effective;
  let low = target - half;
  let high = target + half;
  let lowFromFinal = false;
  let highFromFinal = false;
  if (b.upperBase === "final" || b.lowerBase === "final") {
    const finalHalf = bandWidth(b, b.finalWeight).effective;
    const finalHigh = b.finalWeight + finalHalf;
    const finalLow = b.finalWeight - finalHalf;
    if (b.upperBase === "final" && finalHigh > high + EPS) {
      high = finalHigh;
      highFromFinal = true;
    }
    if (b.lowerBase === "final" && finalLow < low - EPS) {
      low = finalLow;
      lowFromFinal = true;
    }
  }
  return {
    target,
    low: Math.max(0, low),
    high: Math.min(1, high),
    ...(highFromFinal && { highFromFinal }),
    ...(lowFromFinal && { lowFromFinal }),
  };
}

/**
 * Short note on limits measured from the final weight ("felső: végső cél +
 * sáv"), for status texts; empty when both follow the path.
 */
export function bandBaseNote(l: BandLimits): string {
  const parts = [
    l.highFromFinal ? "felső: végső cél + sáv" : "",
    l.lowFromFinal ? "alsó: végső cél − sáv" : "",
  ].filter(Boolean);
  return parts.join(", ");
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
  /** Provider of the account holding it (the largest holding, if several). */
  provider?: string;
  /** That broker's buy / sell cost (see BrokerFees). */
  brokerCost?: CostRule;
  listed?: boolean;
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
  brokerFees: BrokerFees = loadBrokerFees(),
  /** Account id → cash set aside for savings goals (not free cash). */
  reserved?: Map<string, number>,
): Position[] {
  const map = new Map<string, Position>();
  // The broker of a position held at several = where most of it sits.
  const largest = new Map<string, number>();
  const add = (p: Position) => {
    if (p.provider && p.valueHuf > (largest.get(p.key) ?? -Infinity)) {
      largest.set(p.key, p.valueHuf);
      const cur = map.get(p.key);
      if (cur) {
        cur.provider = p.provider;
        cur.brokerCost = p.brokerCost;
      }
    }
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
        ...(inst && LISTED_TYPES.has(inst.type) ? { listed: true } : {}),
        provider: acc.account.provider,
        brokerCost: brokerFees[acc.account.provider],
      });
    }
    const cash = reserved?.get(acc.account.id)
      ? freeCashOf(acc.cash, reserved.get(acc.account.id)!, fx)
      : acc.cash;
    for (const [ccy, amt] of Object.entries(cash)) {
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

const LISTED_TYPES = new Set(["etf", "stock", "fund"]);

/** Early-sale cost of a fixed-rate bond before maturity; T-bills have none. */
function bondSellCost(inst: Instrument | undefined, day: string) {
  if (!inst || inst.type !== "gov_bond") return undefined;
  const maturity = inst.bond?.maturity ?? inst.maturity;
  // An ISO timestamp is stored in UTC — compare its LOCAL day.
  const matDay = maturity?.includes("T")
    ? toLocalDay(Date.parse(maturity))
    : maturity?.slice(0, 10);
  if (matDay && matDay <= day) return 0;
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
    const limits = bandLimits(bandBucket(cfg, bucket), day, targets.get(bucket.id) ?? 0);
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
 * The applicable cost: the glide path's instrument rule → its bucket → (sells)
 * the bond's own early redemption cost → the broker's fee → the global default
 * → none. Cash moves are free. `pos.rule` is absent for an instrument outside
 * the glide path (e.g. a DCA goal's ETF).
 */
export function costFor(
  cfg: GlideConfig | undefined,
  pos: Position & { rule?: InstrumentRule },
  side: "buy" | "sell",
): Cost | undefined {
  return costWithSource(cfg, pos, side).cost;
}

/** costFor, plus whether it is the bond's own early redemption cost. */
function costWithSource(
  cfg: GlideConfig | undefined,
  pos: Position & { rule?: InstrumentRule },
  side: "buy" | "sell",
): { cost: Cost | undefined; redemption: boolean } {
  if (isCashKey(pos.key)) return { cost: undefined, redemption: false };
  const bucket = pos.rule && cfg?.buckets.find((b) => b.id === pos.rule!.bucketId);
  const set = pos.rule?.cost?.[side] ?? bucket?.cost?.[side];
  if (set) return { cost: set, redemption: false };
  if (side === "sell" && pos.bondSellCostPct != null)
    return { cost: { pct: pos.bondSellCostPct }, redemption: true };
  return { cost: pos.brokerCost?.[side] ?? cfg?.defaultCost[side], redemption: false };
}

// ---- Suggestions ------------------------------------------------------------

export type SuggestionStatus = "ok" | "below-min" | "cost-exceeds" | "account-locked";

export interface Suggestion {
  source: "cashflow" | "band";
  bucketId: string;
  bucketName: string;
  instrumentKey?: string;
  instrumentName?: string;
  side: "buy" | "sell" | "redirect" | "transfer";
  /**
   * A redirect that asks for incoming money (an underweight bucket under the
   * "redirect" mode); otherwise a redirect steers money AWAY from the bucket.
   */
  redirectIn?: boolean;
  /** Base currency (HUF), after rounding to whole units. */
  amountHuf: number;
  /** Whole units (bonds: face HUF). Undefined for cash / unknown price. */
  quantity?: number;
  costHuf: number;
  /** The cost is a bond's early redemption cost (not a trading fee). */
  redemptionCost?: boolean;
  /** Currency conversion cost of a buy (money in another currency). */
  fxCostHuf?: number;
  /** The account the trade happens on (account-aware plans). */
  accountId?: string;
  /** Its display name ("Lightyear TBSZ 2026 (LY-…)"). */
  accountLabel?: string;
  /** A buy: its account for new buys changes soon (from → label). */
  venueChange?: { from: string; label: string };
  /** Transfer: money moves between these accounts. */
  fromAccountId?: string;
  fromLabel?: string;
  toAccountId?: string;
  toLabel?: string;
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
/** A fraction as percentage points ("3 %pont"). */
const fmtPp = (v: number) =>
  `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} %pont`;

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
  /** Buy: `rawHuf` is all the money there is — the cost comes out of it. */
  costIncluded = false,
  /** Buy: currency conversion on the way in (fraction of the amount). */
  fxPct = 0,
): Suggestion {
  let target = rawHuf;
  if (costIncluded && side === "buy") {
    // amount + (pct + fx)·amount + fixed = rawHuf
    const c = costFor(cfg, pos, "buy");
    target = Math.max(0, (rawHuf - (c?.fixedHuf ?? 0)) / (1 + (c?.pct ?? 0) + fxPct));
  }
  let amount = target;
  let quantity: number | undefined;
  if (!isCashKey(pos.key) && pos.unitPriceHuf && pos.unitPriceHuf > 0) {
    // Whole units, or — for a fractional instrument — down to its decimals
    // (never more than planned when buying, never more than held when selling).
    const f = 10 ** quantityDecimals(pos.rule);
    const down = (q: number) => Math.floor(q * f + 1e-9) / f;
    quantity = down(target / pos.unitPriceHuf);
    if (side === "sell" && pos.quantity != null)
      quantity = Math.min(quantity, down(pos.quantity));
    amount = quantity * pos.unitPriceHuf;
  }
  const priced = costWithSource(cfg, pos, side);
  const costHuf = estimateCost(priced.cost, amount);
  const fxCostHuf = side === "buy" && fxPct > 0 ? amount * fxPct : undefined;
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
    redemptionCost: priced.redemption || undefined,
    fxCostHuf,
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
    if (s.status !== "ok" || (s.side !== "buy" && s.side !== "sell")) continue;
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
  opts: BuyOptions = {},
): RebalancePlan {
  const ahead = targets?.ahead ? targets : undefined;
  const targetOf = (b: BucketState) =>
    ahead ? (ahead.weights.get(b.bucket.id) ?? 0) : b.target;
  const notes: string[] = [];
  if (!(amountHuf > 0)) return finishPlan(state, [], notes);
  const accepting = (id: string) =>
    state.positions.filter(
      (p) =>
        p.rule.bucketId === id &&
        p.rule.acceptsContributions &&
        (opts.canBuy?.(p.key) ?? true),
    );
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
          cfg.buyCostMode !== "extra",
          opts.fxPct?.(s.pos.key) ?? 0,
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
  opts: BuyOptions = {},
): RebalancePlan & { flow: FlowTargets } {
  const flow = flowTargets(cfg, state.day);
  return { ...routeCashflow(cfg, state, amountHuf, "cashflow", flow, opts), flow };
}

/** Where new money may go (account-aware callers; omitted = anywhere). */
export interface BuyOptions {
  /** False: the instrument can't be bought now (its account takes no deposits). */
  canBuy?: (key: string) => boolean;
  /** Currency conversion on the way in, per instrument (fraction). */
  fxPct?: (key: string) => number;
}

/**
 * The band rule (secondary tool), only for buckets outside their band. Each
 * bucket is handled by its mode for that side (see {@link outOfBandMode}):
 *  - "path" / "band": trade back to the aim / to the band edge;
 *  - "redirect": no trade — steer incoming money (away from an overweight
 *    bucket, into an underweight one) until it is back in its band; only past
 *    the bucket's force threshold does it trade, and then just to the edge.
 * Above: sell the excess from sellable instruments; whatever can't (or isn't
 * worth it) becomes a "redirect future contributions" suggestion. Below: buy
 * back up, funded first by those sale proceeds, then by `cashAvailableHuf`
 * (outside cash), then by selling buckets over their aim (largest excess
 * first, sellable instruments only; never a bucket held above its band by
 * the "redirect" mode). Every trade is rounded to whole units and checked
 * against the minimum size and the cost/benefit threshold; trades that fail
 * are listed but not suggested, and the buys are scaled down to what the
 * suggested sells fund.
 *
 * The whole step uses ONE target per bucket, the aim: the cash-flow routing's
 * target (look-ahead, see flowTargets) clamped into today's band. The restore
 * therefore lands inside the band, and the leftover sale proceeds follow the
 * same aim — so the plan never buys back what it has just sold. A final
 * netting pass still folds a sell and a buy of one instrument into the
 * difference (rounding could otherwise leave such a pair).
 */
export function bandRule(
  cfg: GlideConfig,
  state: AllocationState,
  cashAvailableHuf = 0,
  /** Accounts, limits and accounts for new buys (omitted: not account-aware). */
  accounts?: AccountContext,
): RebalancePlan {
  const notes: string[] = [];
  const T = state.totalHuf;
  const cash = Math.max(0, cashAvailableHuf);
  const out = state.buckets.filter((b) => b.status === "below" || b.status === "above");
  if (out.length === 0) {
    notes.push("Minden csoport a sávon belül — nincs teendő.");
    return finishPlan(state, [], notes);
  }
  const aims = bandAims(cfg, state);
  const aim = (b: BucketState) => aims.weights.get(b.bucket.id) ?? b.target;
  /** Weight to trade back to; null = the "redirect" mode doesn't trade. */
  const goal = (b: BucketState): number | null => {
    const side = b.status === "below" ? "below" : "above";
    const edge = side === "below" ? b.low : b.high;
    const mode = outOfBandMode(cfg, b.bucket, side);
    if (mode === "path") return aim(b);
    if (mode === "band") return edge;
    const force = side === "below" ? b.bucket.belowForcePp : b.bucket.aboveForcePp;
    return force != null && bandDeviation(b) > force + EPS ? edge : null;
  };
  const sellable = (id: string) =>
    state.positions.filter((p) => p.rule.bucketId === id && p.rule.sellable && p.valueHuf > 0);
  const accepting = (id: string) =>
    state.positions.filter((p) => p.rule.bucketId === id && p.rule.acceptsContributions);
  const force = (b: BucketState) =>
    b.status === "below" ? b.bucket.belowForcePp : b.bucket.aboveForcePp;
  const forceNote = (b: BucketState) => {
    const x = force(b);
    return x != null ? ` Kereskedés csak ${fmtPp(x)} túllépés fölött (most ${fmtPp(bandDeviation(b))}).` : "";
  };

  const sells: Suggestion[] = [];
  const redirects: Suggestion[] = [];
  const soldFrom = new Map<string, number>();
  const redirect = (b: BucketState, amount: number, why: string, into = false) =>
    redirects.push({
      source: "band",
      bucketId: b.bucket.id,
      bucketName: b.bucket.name,
      side: "redirect",
      redirectIn: into || undefined,
      amountHuf: amount,
      costHuf: 0,
      status: "ok",
      reason: why,
    });
  /** New money that must go to the OTHER buckets to bring `value` down to `w`. */
  const awayTo = (value: number, w: number) => (w > 0 ? value / w - T : 0);

  // 1) Above the band: sell the excess down to the goal.
  for (const b of state.buckets.filter((x) => x.status === "above")) {
    const g = goal(b);
    if (g == null) {
      redirect(b, Math.max(0, awayTo(b.valueHuf, b.high)),
        `Sáv fölött, eladás nélkül — a következő befizetések menjenek a többi csoportba, amíg vissza nem ér a sávba.${forceNote(b)}`);
      continue;
    }
    const excess = b.valueHuf - g * T;
    let sold = 0;
    for (const s of splitSell(sellable(b.bucket.id), excess)) {
      const t = makeTrade(cfg, s.pos, b.bucket.name, "sell", s.amount, "band",
        "A sáv fölött — eladás a cél felé.");
      sells.push(t);
      if (t.status === "ok") sold += t.amountHuf;
    }
    soldFrom.set(b.bucket.id, sold);
    const rest = awayTo(b.valueHuf - sold, g);
    if (excess - sold >= Math.max(1, cfg.minTradeHuf) && rest >= 1)
      redirect(b, rest,
        sold > 0
          ? "A többlet egy része nem adható el (tiltott vagy nem éri meg) — a következő befizetések menjenek máshová."
          : "A sáv fölött, de eladás nem javasolt — a következő befizetések menjenek máshová, amíg vissza nem ér.");
  }
  const proceeds = () =>
    sells.filter((s) => s.status === "ok").reduce((a, s) => a + s.amountHuf - s.costHuf, 0);

  // 2) Below the band: buy up to the goal. The managed total after the trades
  //    is T + (outside cash used); sells and buys inside it just move money.
  //    A "redirect" bucket only asks for the incoming money instead.
  const allBelow = state.buckets.filter((x) => x.status === "below");
  const below: (BucketState & { goal: number })[] = [];
  for (const b of allBelow) {
    const g = goal(b);
    if (g != null) below.push({ ...b, goal: g });
    else if (b.low < 1)
      redirect(b, Math.max(0, (b.low * T - b.valueHuf) / (1 - b.low)),
        `Sáv alatt, eladás nélkül — a következő befizetések ide menjenek, amíg vissza nem ér a sávba.${forceNote(b)}`,
        true);
  }
  let buys: Suggestion[] = [];
  let cashUse = 0;
  if (below.length) {
    const G = below.reduce((s, b) => s + b.goal, 0);
    const V = below.reduce((s, b) => s + b.valueHuf, 0);
    const need = (cu: number) => G * (T + cu) - V; // Σ buys for outside cash cu
    let P = proceeds();
    if (need(0) > P) {
      cashUse = G < 1 ? Math.min(cash, (G * T - V - P) / (1 - G)) : cash;
      cashUse = Math.max(0, cashUse);
      // 3) Still short: sell from buckets over their aim — not from one the
      //    "redirect" mode keeps from selling.
      let short = need(cashUse) - cashUse - P;
      if (short > 1) {
        const belowIds = new Set(allBelow.map((b) => b.bucket.id));
        const donors = state.buckets
          .filter((b) => !belowIds.has(b.bucket.id))
          .filter((b) => b.status !== "above" || goal(b) != null)
          .map((b) => ({
            b,
            excess: b.valueHuf - (soldFrom.get(b.bucket.id) ?? 0) - aim(b) * (T + cashUse),
          }))
          .filter((d) => d.excess > 1)
          .sort((a, c) => c.excess - a.excess);
        for (const d of donors) {
          if (short <= 1) break;
          const already = new Set(sells.map((s) => s.instrumentKey));
          const cands = sellable(d.b.bucket.id).filter((p) => !already.has(p.key));
          for (const s of splitSell(cands, Math.min(short, d.excess))) {
            const t = makeTrade(cfg, s.pos, d.b.bucket.name, "sell", s.amount, "band",
              "A célhoz képest felülsúlyozott — eladás a sáv alatti csoport finanszírozására.");
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
      const x = (b.goal * (T + cashUse) - b.valueHuf) * scale;
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

  // Sale proceeds the buys don't use are reinvested along the same aim
  // (cash-flow routing on the post-trade state), so selling never leaves
  // money idle.
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
      aims,
    );
    // Change that doesn't buy a single unit is just left as cash.
    routed = plan.suggestions.filter((s) => s.quantity !== 0);
    notes.push(...plan.notes);
  }
  let trades = netTrades(cfg, state, [...sells, ...buys, ...routed]);
  if (accounts) {
    const settled = settleAccounts(cfg, state, trades, cashUse, accounts);
    trades = settled.trades;
    notes.push(...settled.notes);
    // A bucket the account limits keep out of its band: the c) way instead —
    // steer incoming money until it is back.
    for (const b of out) {
      const hit =
        b.status === "above"
          ? settled.blockedSell.has(b.bucket.id)
          : settled.blockedBuy.has(b.bucket.id);
      if (!hit) continue;
      const moved = trades
        .filter((t) => t.status === "ok" && t.bucketId === b.bucket.id)
        .reduce((a, t) => a + (t.side === "buy" ? t.amountHuf : t.side === "sell" ? -t.amountHuf : 0), 0);
      const value = b.valueHuf + moved;
      for (let i = redirects.length - 1; i >= 0; i--)
        if (redirects[i].bucketId === b.bucket.id) redirects.splice(i, 1);
      if (b.status === "above") {
        const amount = awayTo(value, b.high);
        if (amount >= 1)
          redirect(b, amount,
            "A számlakorlát miatt nem adható el — helyette: a következő befizetések menjenek a többi csoportba, amíg vissza nem ér a sávba.");
      } else if (b.low < 1) {
        const amount = (b.low * T - value) / (1 - b.low);
        if (amount >= 1)
          redirect(b, amount,
            "A számlakorlát miatt nem vehető — helyette: a következő befizetések ide menjenek, amíg vissza nem ér a sávba.",
            true);
      }
      notes.push(
        `${b.bucket.name}: a számlakorlát miatt nem hajtható végre — javaslat: állítsd a csoportot „kereskedés nélkül” (c) módra (Célpálya → Kezelés sávon kívül).`,
      );
    }
  }
  return finishPlan(state, [...trades, ...redirects], notes);
}

/**
 * The band rule's single target per bucket: the cash-flow routing's target
 * (look-ahead, see flowTargets) clamped into today's band.
 */
export function bandAims(cfg: GlideConfig, state: AllocationState): FlowTargets {
  // "inflows" mode: nothing between today's path and the final weight is ever
  // traded — the aim is the current weight pulled onto that stretch. A fall
  // behind the path is restored to the path (the rest of the turn is left to
  // the inflows), a run past the final weight back to the final weight.
  if (isInflowMode(cfg)) {
    const sum = cfg.buckets.reduce((s, b) => s + b.finalWeight, 0);
    return {
      day: state.day,
      ahead: false,
      label: "a mai pályacél",
      weights: new Map(
        state.buckets.map((b) => {
          const f = sum > 0 ? b.bucket.finalWeight / sum : 0;
          const onStretch = Math.min(Math.max(b.target, f), Math.max(Math.min(b.target, f), b.weight));
          return [b.bucket.id, Math.min(b.high, Math.max(b.low, onStretch))];
        }),
      ),
    };
  }
  const flow = flowTargets(cfg, state.day);
  const weights = new Map(
    state.buckets.map((b) => {
      const t = flow.ahead ? (flow.weights.get(b.bucket.id) ?? b.target) : b.target;
      return [b.bucket.id, Math.min(b.high, Math.max(b.low, t))];
    }),
  );
  return { ...flow, weights };
}

/** How the band rule handles `b` on `side` of its band (see Bucket.aboveMode). */
export function outOfBandMode(
  cfg: GlideConfig,
  b: Bucket,
  side: "above" | "below",
): OutOfBandMode {
  return (side === "above" ? b.aboveMode : b.belowMode) ?? cfg.restoreTo;
}

/**
 * One trade per instrument: several trades of the same instrument in one
 * plan fold into a single one — a sell and a buy into the difference —
 * re-rounded and re-priced (too small to be worth a ticket → listed, not
 * suggested).
 */
function netTrades(
  cfg: GlideConfig,
  state: AllocationState,
  trades: Suggestion[],
): Suggestion[] {
  const live = (s: Suggestion) =>
    s.status === "ok" && (s.side === "buy" || s.side === "sell") && !!s.instrumentKey;
  const count = new Map<string, number>();
  for (const s of trades)
    if (live(s)) count.set(s.instrumentKey!, (count.get(s.instrumentKey!) ?? 0) + 1);
  const mixed = new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
  if (mixed.size === 0) return trades;
  const out: Suggestion[] = [];
  const done = new Set<string>();
  for (const s of trades) {
    const key = s.instrumentKey!;
    if (!live(s) || !mixed.has(key)) {
      out.push(s);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const same = trades.filter((t) => live(t) && t.instrumentKey === key);
    const net = same.reduce((a, t) => a + (t.side === "buy" ? t.amountHuf : -t.amountHuf), 0);
    if (Math.abs(net) < 1) continue;
    const side = net > 0 ? "buy" : "sell";
    const first = same.find((t) => t.side === side)!;
    const pos = state.positions.find((p) => p.key === key)!;
    const netted = same.some((t) => t.side !== side);
    out.push(
      makeTrade(cfg, pos, first.bucketName, side, Math.abs(net), "band",
        netted
          ? `${first.reason} (Nettósítva: az eladás és a visszavásárlás különbözete.)`
          : first.reason),
    );
  }
  return out;
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
 * held that day (the path then starts from the final weight). A weight once
 * frozen is kept — later saves don't re-derive it from revised price history;
 * changing the snapshot date (or the start mode) clears it, so only then is it
 * resolved again.
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
      if (b.start.mode !== "snapshot" || b.start.resolvedWeight != null) return b;
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
  brokerFees: BrokerFees = loadBrokerFees(),
  /** Cash set aside for savings goals, per account (not free cash). */
  reserved?: Map<string, number>,
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
    positionsFromSummary(summary, fx, cfg.bondsAtFace, day, brokerFees, reserved),
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

// ---- Accounts: where each trade happens, what money may move ----------------

/** Does `accountId` hold `key` (so money inside it may buy more of it)? */
function heldIn(ctx: AccountContext, accountId: string, key: string): boolean {
  return (ctx.holdings.get(key) ?? []).some((h) => h.accountId === accountId);
}

/** The account label, or "ismeretlen számla". */
function labelOf(ctx: AccountContext, id: string | undefined): string {
  const a = accountById(ctx, id);
  return a ? accountLabel(a) : "ismeretlen számla";
}

/**
 * Conversion rate when money in `from` currency buys something in `to`
 * currency: the fxPct of the broker on the foreign-currency side.
 */
function conversionPct(
  ctx: AccountContext,
  from: { ccy: string; provider?: string },
  to: { ccy: string; provider?: string },
): number {
  if (from.ccy === to.ccy) return 0;
  const provider = from.ccy !== "HUF" ? from.provider : to.provider;
  return feeOf(ctx, provider)?.fxPct ?? 0;
}

function lockedText(ctx: AccountContext, id: string): string {
  const l = ctx.limits[id];
  return `${labelOf(ctx, id)}: a pénz ${l?.noOutflowUntil}-ig nem hagyhatja el a számlát${l?.noOutflowNote ? ` (${l.noOutflowNote})` : ""}`;
}

/**
 * Routing options for incoming money arriving on `sourceId` (undefined: from
 * outside, e.g. the monthly saving): an instrument is buyable when the money
 * can reach its account for new buys — or, for money on an account it may not
 * leave, when that account holds it (reinvested inside).
 */
export function incomingBuyOptions(
  ctx: AccountContext,
  sourceId?: string,
  sourceCcy = "HUF",
): BuyOptions {
  const src = accountById(ctx, sourceId);
  const locked = !!sourceId && outflowBlocked(ctx.limits, sourceId, ctx.day);
  // Money already on an account holding the instrument stays there.
  const placeOf = (k: string) =>
    sourceId && heldIn(ctx, sourceId, k)
      ? { internal: true as const, provider: src?.provider }
      : { internal: false as const, venue: purchaseVenue(ctx, k) };
  return {
    canBuy: (k) => {
      const p = placeOf(k);
      if (p.internal) return true;
      if (locked) return false;
      return !p.venue.depositBlocked;
    },
    fxPct: (k) => {
      const p = placeOf(k);
      const ccy = ctx.currency.get(k) ?? "HUF";
      return conversionPct(
        ctx,
        { ccy: sourceCcy, provider: src?.provider },
        { ccy, provider: p.internal ? p.provider : p.venue.provider },
      );
    },
  };
}

/**
 * Put incoming money's buys on their accounts: on the source account when it
 * holds the instrument (or the money may not leave it), else on the
 * instrument's account for new buys — with one transfer per destination when
 * the money arrived on another account.
 */
export function placeIncoming(
  plan: RebalancePlan,
  ctx: AccountContext,
  sourceId?: string,
): RebalancePlan {
  const flows = new Map<string, { to?: string; label: string; amount: number }>();
  const suggestions = plan.suggestions.map((s) => {
    if (s.side !== "buy" || !s.instrumentKey) return s;
    if (sourceId && heldIn(ctx, sourceId, s.instrumentKey)) return { ...s, accountId: sourceId, accountLabel: labelOf(ctx, sourceId) };
    const v = purchaseVenue(ctx, s.instrumentKey);
    const out = {
      ...s,
      accountId: v.account?.id,
      accountLabel: v.label,
      venueChange: upcomingVenueChange(ctx, s.instrumentKey),
    };
    if (sourceId && s.status === "ok" && v.account?.id !== sourceId) {
      const key = v.account?.id ?? v.label;
      const f = flows.get(key) ?? { to: v.account?.id, label: v.label, amount: 0 };
      f.amount += s.amountHuf + s.costHuf + (s.fxCostHuf ?? 0);
      flows.set(key, f);
    }
    return out;
  });
  const fee = sourceId
    ? (feeOf(ctx, accountById(ctx, sourceId)?.provider)?.transferFixedHuf ?? 0)
    : 0;
  const transfers: Suggestion[] = [...flows.values()].map((f) => ({
    source: "cashflow",
    bucketId: "",
    bucketName: "",
    side: "transfer",
    amountHuf: f.amount,
    costHuf: fee,
    status: "ok",
    reason: "A beérkezett pénz a vételi számlára.",
    fromAccountId: sourceId,
    fromLabel: labelOf(ctx, sourceId),
    toAccountId: f.to,
    toLabel: f.label,
  }));
  return { ...plan, suggestions: [...transfers, ...suggestions] };
}

interface Pool {
  accountId?: string;
  provider?: string;
  ccy: string;
  locked: boolean;
  /** Money left (HUF). */
  left: number;
  /** Of which sale proceeds (the rest is outside cash). */
  proceeds: number;
}

interface SellLeg {
  sell: Suggestion;
  accountId?: string;
  quantity?: number;
  amount: number;
}

/**
 * Account-level settlement of a band-rule plan: sells are taken from
 * accounts (those without an outflow limit first), buys are placed on the
 * instrument's account for new buys — or, for money on an account it may not
 * leave, inside that account when it holds the instrument — and funded from
 * the same account, then the same broker, then any other account the money
 * may leave. Money that can't reach any buy un-does its sale (the sale is
 * listed as blocked); buys without money shrink. Transfers between accounts
 * are listed with their fee and currency conversion.
 */
function settleAccounts(
  cfg: GlideConfig,
  state: AllocationState,
  trades: Suggestion[],
  cashUse: number,
  ctx: AccountContext,
): { trades: Suggestion[]; notes: string[]; blockedSell: Set<string>; blockedBuy: Set<string> } {
  const notes: string[] = [];
  const blockedSell = new Set<string>();
  const blockedBuy = new Set<string>();
  const posOf = (key: string) => state.positions.find((p) => p.key === key)!;
  const ccyOf = (key: string) => ctx.currency.get(key) ?? "HUF";

  // 1) Sells → legs per account; proceeds into that account's pool.
  const pools = new Map<string, Pool>();
  const poolOf = (id: string | undefined, ccy: string): Pool => {
    const k = id ?? "?";
    let p = pools.get(k);
    if (!p) {
      p = {
        accountId: id,
        provider: accountById(ctx, id)?.provider,
        ccy,
        locked: !!id && outflowBlocked(ctx.limits, id, ctx.day),
        left: 0,
        proceeds: 0,
      };
      pools.set(k, p);
    }
    return p;
  };
  const legs: SellLeg[] = [];
  for (const s of trades) {
    if (s.side !== "sell" || s.status !== "ok" || !s.instrumentKey) continue;
    const hold = [...(ctx.holdings.get(s.instrumentKey) ?? [])].sort(
      (a, b) =>
        Number(outflowBlocked(ctx.limits, a.accountId, ctx.day)) -
          Number(outflowBlocked(ctx.limits, b.accountId, ctx.day)) || b.valueHuf - a.valueHuf,
    );
    const unit = s.quantity && s.quantity > 0 ? s.amountHuf / s.quantity : undefined;
    let qLeft = s.quantity;
    let aLeft = s.amountHuf;
    for (const h of hold) {
      if (aLeft <= EPS) break;
      const q = qLeft != null && unit ? Math.min(qLeft, h.quantity) : undefined;
      const amount = q != null && unit ? q * unit : Math.min(aLeft, h.valueHuf);
      if (amount <= EPS) continue;
      legs.push({ sell: s, accountId: h.accountId, quantity: q, amount });
      if (qLeft != null && q != null) qLeft -= q;
      aLeft -= amount;
    }
    if (aLeft > 1) legs.push({ sell: s, amount: aLeft, quantity: qLeft });
  }
  for (const l of legs) {
    const net = l.amount - (l.sell.costHuf * l.amount) / l.sell.amountHuf;
    const p = poolOf(l.accountId, ccyOf(l.sell.instrumentKey!));
    p.left += net;
    p.proceeds += net;
  }
  // Outside cash, spread over the accounts holding cash.
  if (cashUse > 0) {
    const cashHuf = ctx.accounts
      .map((a) => ({ a, huf: Math.max(0, accountCashHuf(ctx, a.id)) }))
      .filter((x) => x.huf > 0);
    const sum = cashHuf.reduce((s, x) => s + x.huf, 0);
    for (const x of cashHuf) poolOf(x.a.id, "HUF").left += (cashUse * x.huf) / sum;
  }

  // 2) Buys: place and fund.
  type Flow = { from: Pool; to?: string; toLabel: string; amount: number; fx: number };
  const flows: Flow[] = [];
  const out: Suggestion[] = [];
  for (const s of trades) {
    if (s.side === "sell" && s.status === "ok") continue; // → the legs
    if (s.side !== "buy" || s.status !== "ok" || !s.instrumentKey) {
      out.push(s);
      continue;
    }
    const key = s.instrumentKey;
    const buyCcy = ccyOf(key);
    let need = s.amountHuf + s.costHuf;
    const parts: { accountId?: string; label: string; money: number; fx: number }[] = [];
    const draw = (p: Pool, toId: string | undefined, toLabel: string, toProvider: string | undefined) => {
      if (need <= EPS || p.left <= EPS) return;
      const pct = conversionPct(ctx, { ccy: p.ccy, provider: p.provider }, { ccy: buyCcy, provider: toProvider });
      const take = Math.min(p.left, need * (1 + pct));
      // A crumb (e.g. the 1 Ft left on an account) would become a separate
      // sub-minimum ticket — skip it unless it covers the whole rest.
      if (take < cfg.minTradeHuf && take < need * (1 + pct) - EPS) return;
      const covered = take / (1 + pct);
      p.left -= take;
      need -= covered;
      const cross = p.accountId !== toId;
      const part = parts.find((x) => x.accountId === toId);
      if (part) {
        part.money += covered;
        if (!cross) part.fx += take - covered;
      } else parts.push({ accountId: toId, label: toLabel, money: covered, fx: cross ? 0 : take - covered });
      if (cross) flows.push({ from: p, to: toId, toLabel, amount: take, fx: take - covered });
    };
    // a) Money that may not leave its account buys inside it.
    for (const p of pools.values())
      if (p.locked && p.accountId && heldIn(ctx, p.accountId, key))
        draw(p, p.accountId, labelOf(ctx, p.accountId), p.provider);
    // b) The account for new buys, funded same account → same broker → others.
    const v = purchaseVenue(ctx, key);
    const vid = v.account?.id;
    const ordered = [...pools.values()]
      .filter((p) => !p.locked || p.accountId === vid)
      .filter((p) => !v.depositBlocked || p.accountId === vid)
      .sort(
        (a, b) =>
          Number(b.accountId === vid) - Number(a.accountId === vid) ||
          Number(b.provider === v.provider) - Number(a.provider === v.provider),
      );
    for (const p of ordered) draw(p, vid, v.label, v.provider);

    const funded = s.amountHuf + s.costHuf - need;
    // A shortfall is the limits' doing only when money is actually held
    // back: left on an account it may not leave, or barred by the venue's
    // deposit ban. A small gap from the conversion or rounding is not.
    const heldBack = [...pools.values()].some((p) => !ordered.includes(p) && p.left > 1);
    const limited = need > 1 && (heldBack || v.depositBlocked);
    if (need > 1 && funded < 1 && !limited) continue; // no money for it at all
    if (need > 1 && funded < 1) {
      blockedBuy.add(s.bucketId);
      out.push({
        ...s,
        accountId: vid,
        accountLabel: v.label,
        status: "account-locked",
        reason: v.depositBlocked
          ? `${blockedText(v)} — nem javasolt oda vétel.`
          : "Nincs pénz, amely erre a számlára juthatna (számlakorlát).",
      });
      continue;
    }
    for (const part of parts) {
      const t =
        need > 1 || parts.length > 1
          ? makeTrade(cfg, posOf(key), s.bucketName, "buy", part.money, "band", s.reason, true)
          : { ...s };
      out.push({
        ...t,
        accountId: part.accountId,
        accountLabel: part.label,
        fxCostHuf: part.fx >= 1 ? part.fx : undefined,
        venueChange: part.label === v.label ? upcomingVenueChange(ctx, key) : undefined,
      });
    }
    if (limited) {
      blockedBuy.add(s.bucketId);
      notes.push(
        `${s.instrumentName ?? key}: a vétel csak részben finanszírozható a számlakorlátok miatt.`,
      );
    }
  }

  // 3) Sale proceeds no buy could use: the sale isn't worth doing — undo it
  //    (from the legs of that account), and say why.
  const unusedBy = new Map<string, number>();
  for (const [k, p] of pools) {
    const unused = Math.min(p.left, p.proceeds);
    if (unused > Math.max(1, cfg.minTradeHuf / 10)) unusedBy.set(k, unused);
  }
  const sellOut: Suggestion[] = [];
  const bySell = new Map<Suggestion, SellLeg[]>();
  for (const l of legs) bySell.set(l.sell, [...(bySell.get(l.sell) ?? []), l]);
  for (const [s, ls] of bySell) {
    const pos = posOf(s.instrumentKey!);
    for (const l of ls) {
      const k = l.accountId ?? "?";
      const cut = unusedBy.get(k) ?? 0;
      const netRatio = 1 - s.costHuf / s.amountHuf;
      const cutGross = Math.min(l.amount, cut / Math.max(EPS, netRatio));
      if (cut > 0) unusedBy.set(k, Math.max(0, cut - cutGross * netRatio));
      const keep = l.amount - cutGross;
      const label = labelOf(ctx, l.accountId);
      const locked = !!l.accountId && outflowBlocked(ctx.limits, l.accountId, ctx.day);
      if (cutGross > 1) {
        blockedSell.add(s.bucketId);
        sellOut.push({
          ...s,
          amountHuf: cutGross,
          quantity: l.quantity != null && pos.unitPriceHuf ? cutGross / pos.unitPriceHuf : undefined,
          costHuf: 0,
          accountId: l.accountId,
          accountLabel: label,
          status: "account-locked",
          reason: locked
            ? `A számlakorlát miatt nem hajtható végre — ${lockedText(ctx, l.accountId!)}, és ott nincs mit venni belőle.`
            : "A bevétel nem fektethető be (a vételi számlák nem fogadnak befizetést).",
        });
      }
      if (keep > 1) {
        const t =
          cutGross > 1 || ls.length > 1
            ? makeTrade(cfg, pos, s.bucketName, "sell", keep, "band", s.reason)
            : { ...s };
        sellOut.push({ ...t, accountId: l.accountId, accountLabel: label });
      }
    }
  }

  // 4) Transfers, one per account pair.
  const pairs = new Map<string, Suggestion>();
  for (const f of flows) {
    const key = `${f.from.accountId ?? "?"}>${f.to ?? f.toLabel}`;
    const cur =
      pairs.get(key) ??
      ({
        source: "band",
        bucketId: "",
        bucketName: "",
        side: "transfer",
        amountHuf: 0,
        costHuf: feeOf(ctx, f.from.provider)?.transferFixedHuf ?? 0,
        fxCostHuf: 0,
        status: "ok",
        reason: "Az eladás bevétele a vételi számlára.",
        fromAccountId: f.from.accountId,
        fromLabel: labelOf(ctx, f.from.accountId),
        toAccountId: f.to,
        toLabel: f.toLabel,
      } satisfies Suggestion);
    cur.amountHuf += f.amount;
    cur.fxCostHuf = (cur.fxCostHuf ?? 0) + f.fx;
    pairs.set(key, cur);
  }
  // (Undone sales only freed money that never flowed anywhere.)
  const transfers = [...pairs.values()].filter((t) => t.amountHuf >= 1);
  for (const t of transfers) if ((t.fxCostHuf ?? 0) < 1) delete t.fxCostHuf;
  return {
    trades: [...sellOut, ...transfers, ...out],
    notes,
    blockedSell,
    blockedBuy,
  };
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

const SIDE_LABEL = { buy: "Vétel", sell: "Eladás", redirect: "Átirányítás", transfer: "Utalás" } as const;

/** "Vétel: VWCE 3 db (≈ 30 000 Ft) → Lightyear TBSZ 2026" — one step as plain text (alerts, Telegram). */
export function suggestionText(s: Suggestion): string {
  if (s.side === "redirect" && s.redirectIn)
    return `${s.bucketName}: a következő ${formatMoney(s.amountHuf)} befizetés ide menjen`;
  if (s.side === "transfer") {
    const fx = s.fxCostHuf && s.fxCostHuf >= 1 ? `, váltás ≈ ${formatMoney(s.fxCostHuf)}` : "";
    const fee = s.costHuf >= 1 ? `, díj ${formatMoney(s.costHuf)}` : "";
    return `Utalás: ${s.fromLabel ?? "?"} → ${s.toLabel ?? "?"} (≈ ${formatMoney(s.amountHuf)}${fee}${fx})`;
  }
  if (s.side === "redirect")
    return `${s.bucketName}: a következő ${formatMoney(s.amountHuf)} befizetés menjen más csoportba`;
  const qty =
    s.quantity != null && s.quantity !== s.amountHuf ? ` ${formatQuantity(s.quantity)} db` : "";
  const at =
    (s.accountLabel ? `${s.side === "buy" ? " → " : " · "}${s.accountLabel}` : "") +
    (s.side === "buy" && s.venueChange ? ` · ${s.venueChange.from}-tól: ${s.venueChange.label}` : "");
  return `${SIDE_LABEL[s.side]}: ${s.instrumentName ?? s.bucketName}${qty} (≈ ${formatMoney(s.amountHuf)})${at}`;
}

/** Totals of a plan's suggested steps — what it moves and what it costs. */
export interface PlanSummary {
  sellHuf: number;
  buyHuf: number;
  transferHuf: number;
  /** Trading fees (buy / sell). */
  tradeCostHuf: number;
  /** Bonds' early redemption cost. */
  redemptionCostHuf: number;
  /** Currency conversion (on buys and transfers). */
  fxCostHuf: number;
  /** Fixed transfer fees. */
  transferCostHuf: number;
  totalCostHuf: number;
  transfers: Suggestion[];
  /** Steps the account limits block. */
  blocked: Suggestion[];
}

export function planSummary(plan: RebalancePlan): PlanSummary {
  const ok = plan.suggestions.filter((s) => s.status === "ok");
  const sum = (xs: Suggestion[], f: (s: Suggestion) => number) => xs.reduce((a, s) => a + f(s), 0);
  const trades = ok.filter((s) => s.side === "buy" || s.side === "sell");
  const transfers = ok.filter((s) => s.side === "transfer");
  const out = {
    sellHuf: sum(ok.filter((s) => s.side === "sell"), (s) => s.amountHuf),
    buyHuf: sum(ok.filter((s) => s.side === "buy"), (s) => s.amountHuf),
    transferHuf: sum(transfers, (s) => s.amountHuf),
    tradeCostHuf: sum(trades, (s) => (s.redemptionCost ? 0 : s.costHuf)),
    redemptionCostHuf: sum(trades, (s) => (s.redemptionCost ? s.costHuf : 0)),
    fxCostHuf: sum([...trades, ...transfers], (s) => s.fxCostHuf ?? 0),
    transferCostHuf: sum(transfers, (s) => s.costHuf),
    totalCostHuf: 0,
    transfers,
    blocked: plan.suggestions.filter((s) => s.status === "account-locked"),
  };
  out.totalCostHuf = out.tradeCostHuf + out.redemptionCostHuf + out.fxCostHuf + out.transferCostHuf;
  return out;
}

/** A suggested step as a planned trade (saved reminders). */
export function plannedTrade(s: Suggestion): PlannedTrade {
  return {
    side: s.side,
    redirectIn: s.redirectIn,
    bucketName: s.bucketName,
    instrumentKey: s.instrumentKey,
    instrumentName: s.instrumentName,
    amountHuf: Math.round(s.amountHuf),
    quantity: s.quantity,
    costHuf: s.costHuf ? Math.round(s.costHuf) : undefined,
    accountLabel:
      s.side === "transfer" ? `${s.fromLabel ?? "?"} → ${s.toLabel ?? "?"}` : s.accountLabel,
  };
}

/** Alert id prefix of a deepening re-alert ("…:n2", "…:n3"). */
export function isDeepGlideAlert(a: Alert): boolean {
  return /^glide:.*:n\d+$/.test(a.id);
}

/** Bucket id of a glide alert id ("glide:<bucket>:<status>:<period>[:nN]"). */
export function glideAlertBucket(id: string): string | undefined {
  return /^glide:([^:]+):/.exec(id)?.[1];
}

/**
 * Whether a stored glide alert really resolved: its bucket is still in the
 * plan and back in its band (no active glide alert for it). A deepening
 * re-alert or a new check period re-keys the alert while the drift persists,
 * and a plan edit can replace the bucket ids — none of these is "fulfilled".
 */
export function glideRecordFulfilled(
  id: string,
  active: Alert[],
  cfg: GlideConfig | undefined,
): boolean {
  const bucket = glideAlertBucket(id);
  if (!bucket) return true;
  if (!cfg?.buckets.some((b) => b.id === bucket)) return false;
  return !active.some((a) => glideAlertBucket(a.id) === bucket);
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
  /** Account-aware steps in the re-alert text (see bandRule). */
  accounts?: AccountContext,
): Alert[] {
  if (!state || !cfg || state.totalHuf <= 0) return [];
  return [...unassignedAlerts(state), ...bandAlerts(state, cfg, signals, accounts)];
}

export function unassignedAlerts(state: AllocationState): Alert[] {
  const loose = state.unassigned
    .filter((p) => p.listed && p.valueHuf >= 1)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (loose.length === 0) return [];
  const names = loose.map((p) => p.name).join(", ");
  return [
    {
      id: `glide-unassigned:${loose.map((p) => p.key).join(",")}`,
      severity: "medium",
      title: `Célpálya – csoporton kívül: ${names}`,
      detail: `${names} egyik célpálya-csoportban sincs benne, így kimarad a súlyokból és a javaslatokból. A Célpálya kártyán eszközosztály szerint besorolhatod.`,
      to: "/goals",
      actionLabel: "Célpálya",
    },
  ];
}

function bandAlerts(
  state: AllocationState,
  cfg: GlideConfig,
  signals: GlideSignals,
  accounts?: AccountContext,
): Alert[] {
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
      const ok = bandRule(cfg, state, freeCashHuf(state), accounts).suggestions.filter(
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
