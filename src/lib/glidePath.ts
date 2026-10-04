// Glide-path allocation: user-defined asset buckets whose target weight moves
// along a path (start weight → final weight between two dates), with a
// tolerance band around it. This module holds the data model, persistence
// (versioned, synced as a planning pref) and validation. The maths — path
// target, band limits, cash-flow routing, band rule — lives in rebalance.ts.
//
// Every save appends a new dated VERSION instead of overwriting, so the path
// that was in force on any past day can be reconstructed (the history chart
// uses the version valid on each sample day).

import type { Instrument } from "./model";
import { assetClassOf, type AssetClass } from "./holdings";
import type { AllocationSettings } from "./allocation";
import { includedClasses } from "./allocation";
import { assetClassLabel } from "./labels";
import { touchPref } from "./prefs";

export type Interpolation = "linear" | "step-quarter" | "step-year";

/** A trading / redemption cost: a percentage of the amount and/or a flat fee. */
export interface Cost {
  /** Fraction of the traded amount (0.001 = 0,1%). */
  pct?: number;
  /** Flat fee per transaction in HUF. */
  fixedHuf?: number;
}

/** Cost of buying (transaction cost) and of selling (redemption cost). */
export interface CostRule {
  buy?: Cost;
  sell?: Cost;
}

/** Fields shared by both band kinds. */
interface BandCommon {
  /**
   * Minimum half-width (fraction: 0.02 = ±2 percentage points). The band is
   * never narrower than this — a relative band around a small target would
   * otherwise be so tight that a volatile asset keeps leaving it. Default 0.
   */
  minPp?: number;
}

export type BandSpec =
  /** Absolute: target ± `pp` (fraction: 0.05 = ±5 percentage points). */
  | ({ kind: "abs"; pp: number } & BandCommon)
  /**
   * Relative: ± `pct` of a base weight (0.2 = ±20%). The base is the day's
   * path target (default) or the bucket's final weight.
   */
  | ({ kind: "rel"; pct: number; base?: "path" | "final" } & BandCommon);

export type StartSpec =
  /**
   * The actual weight on `date`, computed on the first save and frozen in
   * `resolvedWeight`; a new date (a new start object) resolves it again.
   */
  | { mode: "snapshot"; date: string; resolvedWeight?: number }
  | { mode: "manual"; weight: number };

export interface Bucket {
  id: string;
  name: string;
  /** Final target weight, 0..1. The buckets' final weights sum to 1. */
  finalWeight: number;
  start: StartSpec;
  /** Path start / end (YYYY-MM-DD). After `endDate` the final weight applies. */
  startDate: string;
  endDate: string;
  interpolation: Interpolation;
  band: BandSpec;
  /** Bucket-level cost; overrides the global default. */
  cost?: CostRule;
  /**
   * Re-alert step for this bucket (fraction: 0.005 = 0.5 pp); overrides the
   * global `realertStepPp` — a small bucket needs a finer step.
   */
  realertStepPp?: number;
  /**
   * How the band rule handles the bucket above its band. Missing = the
   * version's `restoreTo` (older versions: "path").
   */
  aboveMode?: OutOfBandMode;
  /** Same below the band. */
  belowMode?: OutOfBandMode;
  /**
   * "redirect" mode: trade anyway — only to the band edge — once the distance
   * beyond the band exceeds this (fraction: 0.03 = 3 pp). Missing = never.
   */
  aboveForcePp?: number;
  belowForcePp?: number;
  /**
   * What the band's upper limit is measured from: the day's path target
   * ("path", the original behaviour) or the final weight ("final": final
   * weight + band, so a bucket running ahead of a rising path gets no alert
   * or redirect until it passes that). It only ever widens the band. Missing
   * = "path". The cash-flow routing still aims at the path either way.
   */
  upperBase?: BandLimitBase;
  /** Same for the lower limit (final weight − band, for a falling path). */
  lowerBase?: BandLimitBase;
}

export type BandLimitBase = "path" | "final";

/**
 * Handling of an out-of-band bucket: trade back to the path target, trade
 * only to the band edge, or don't trade — steer incoming money instead.
 */
export type OutOfBandMode = "path" | "band" | "redirect";

/** Per-instrument settings. Keyed by instrument key or a cash key (cashKey). */
export interface InstrumentRule {
  bucketId: string;
  /** May be sold to rebalance (e.g. off for a bond held to maturity). */
  sellable: boolean;
  /** May receive new money (contributions, coupons, dividends). */
  acceptsContributions: boolean;
  /** Instrument-level cost; overrides the bucket and the global default. */
  cost?: CostRule;
  /**
   * The broker trades fractional units of it: suggestions are not rounded
   * to whole units but down to `qtyDecimals` decimals. Default off.
   */
  fractional?: boolean;
  /** Decimals of a fractional quantity (0–8). Default 4. */
  qtyDecimals?: number;
}

/** Default decimals of a fractional quantity. */
export const DEFAULT_QTY_DECIMALS = 4;

export type CheckFrequency = "monthly" | "quarterly";

/**
 * The glide path's own share of the monthly budget ("havi keret") — the
 * default amount the Teendők panel routes, and the "Célpálya" slice of the
 * budget bar, so it doesn't collide with the DCA and medium-term goals.
 */
export type MonthlyAmount =
  /** A fixed HUF amount. */
  | { kind: "fixed"; huf: number }
  /** A fraction of the monthly budget (0.2 = 20%). */
  | { kind: "pct"; pct: number }
  /** Whatever the DCA and medium-term goals leave free (never below 0). */
  | { kind: "remainder" };

/**
 * Which path target the cash-flow routing aims at. The path keeps moving, so
 * money routed to today's target can land in a bucket whose weight is about
 * to fall; looking ahead avoids that. Band, status and alerts always measure
 * against today's target.
 */
export type FlowTarget =
  /** Today's path target (the original behaviour). */
  | { kind: "today" }
  /** The path target on the next check day. */
  | { kind: "nextCheck" }
  /** The path target `days` days ahead. */
  | { kind: "days"; days: number };

/** Longest look-ahead for the `days` flow target. */
export const MAX_FLOW_DAYS = 3650;

/** One dated version of the whole glide-path configuration. */
export interface GlideConfig {
  id: string;
  /** Day (YYYY-MM-DD) from which this version is in force. */
  validFrom: string;
  /** When it was saved (ISO) — breaks ties between same-day versions. */
  savedAt: string;
  buckets: Bucket[];
  /**
   * Bucket membership + flags. An instrument sits in at most one bucket (it's a
   * map key); instruments not listed are outside the managed allocation.
   */
  instruments: Record<string, InstrumentRule>;
  checkFrequency: CheckFrequency;
  /** Trades below this HUF amount are not suggested. */
  minTradeHuf: number;
  /** Bring an out-of-band bucket back to the path target or just to the band edge. */
  restoreTo: "path" | "band";
  /**
   * Cost/benefit threshold: a trade is not suggested when its estimated cost
   * exceeds this fraction of the deviation it corrects (0.01 = 1%).
   */
  maxCostRatio: number;
  /** Value government bonds / T-bills at face (nominal) instead of market. */
  bondsAtFace: boolean;
  defaultCost: CostRule;
  /**
   * Re-alert when an out-of-band bucket's distance from the band edge has
   * grown by at least this much since the last alert (fraction: 0.02 = 2 pp),
   * even within the check period and even if the last alert was dismissed.
   * 0 = off. A bucket may override it.
   */
  realertStepPp: number;
  /** Send deepening re-alerts during the bot's quiet hours too. */
  deepAlertsInQuietHours: boolean;
  /**
   * The glide path's monthly amount. Missing on versions saved before it
   * existed: then the whole monthly budget is used (the earlier behaviour),
   * which collides with the other goals — the UI says so.
   */
  monthlyAmount?: MonthlyAmount;
  /**
   * The path target the cash-flow routing aims at (incoming money and the
   * band rule's leftover). Missing on older versions = today's target.
   */
  flowTarget?: FlowTarget;
  /**
   * Buy costs of routed money (incoming money, the band rule's leftover):
   * "included" = taken out of the amount, so buy + cost is exactly the money
   * there is; "extra" = paid on top of it. Missing = "included".
   */
  buyCostMode?: BuyCostMode;
  /**
   * Where the path comes from: the buckets' own dates ("calendar", the
   * original behaviour) or the expected inflows ("inflows": the path the
   * coming contributions and coupons alone would draw, frozen on save in
   * `inflowPath`). Missing = "calendar".
   */
  pathMode?: PathMode;
  /**
   * "inflows" mode: monthly expected weights from the inflows at 0% return,
   * computed on save (freezeInflowPath). The first point is the actual weight
   * on the save day.
   */
  inflowPath?: InflowPoint[];
  /** The inflow path arrives at the final weights within its horizon. */
  inflowReached?: boolean;
  /**
   * Created automatically from the old target allocation (migrateIfNeeded),
   * not saved by the user. Dropped as soon as a user-saved version exists —
   * see dropSeeded.
   */
  seeded?: true;
}

export type PathMode = "calendar" | "inflows";

export interface InflowPoint {
  /** YYYY-MM-DD. */
  day: string;
  /** Bucket id → expected weight (0..1). */
  weights: Record<string, number>;
}

/** The path comes from the frozen inflow projection. */
export function isInflowMode(cfg: GlideConfig): boolean {
  return cfg.pathMode === "inflows";
}

export type BuyCostMode = "included" | "extra";

/** Pseudo-instrument key for a cash balance in `ccy` (assignable to a bucket). */
export function cashKey(ccy: string): string {
  return `cash:${ccy}`;
}

export function isCashKey(key: string): boolean {
  return key.startsWith("cash:");
}

/** Currency of a cash key (`cash:EUR` → `EUR`). */
export function cashCurrency(key: string): string {
  return key.slice(5);
}

// ---- Persistence ------------------------------------------------------------

const STORE_KEY = "pf-glidepath";

export function loadGlideVersions(): GlideConfig[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? dropSeeded((parsed as GlideConfig[]).map(normalizeConfig)) : [];
  } catch {
    return [];
  }
}

/**
 * Union by version id, ascending by (validFrom, savedAt). Versions are
 * immutable once saved, so two devices' histories combine without conflict.
 */
export function mergeGlideVersions(
  a: GlideConfig[] | null | undefined,
  b: GlideConfig[] | null | undefined,
): GlideConfig[] {
  const byId = new Map<string, GlideConfig>();
  for (const v of [...(a ?? []), ...(b ?? [])]) {
    if (!v || typeof v.id !== "string" || typeof v.validFrom !== "string")
      continue;
    if (!byId.has(v.id)) byId.set(v.id, v);
  }
  return dropSeeded([...byId.values()].sort(compareVersions));
}

/**
 * A version the app made by itself from the old target allocation: flagged
 * `seeded`, or — made by an older build, before the flag — recognised by its
 * exact shape (asset-class names, a flat one-year path from the version day,
 * ±5 pp absolute bands, no monthly amount, every instrument sellable and
 * accepting money). The user's own saves never look like this.
 */
export function isSeededVersion(v: GlideConfig): boolean {
  if (v.seeded) return true;
  if (v.monthlyAmount || v.pathMode || v.buckets.length === 0) return false;
  const labels = new Set(Object.values(assetClassLabel));
  const yearOn = addYears(v.validFrom, 1);
  return (
    v.buckets.every(
      (b) =>
        labels.has(b.name) &&
        b.start.mode === "manual" &&
        b.start.weight === b.finalWeight &&
        b.startDate === v.validFrom &&
        b.endDate === yearOn &&
        b.interpolation === "linear" &&
        b.band.kind === "abs" &&
        b.band.pp === 0.05 &&
        !b.band.minPp &&
        !b.cost &&
        !b.aboveMode &&
        !b.belowMode &&
        !b.upperBase &&
        !b.lowerBase,
    ) &&
    Object.values(v.instruments).every((r) => r.sellable && r.acceptsContributions && !r.cost)
  );
}

/**
 * Drop the automatic versions once the user has saved one of their own. A
 * device that seeded one before it got the synced path (e.g. an old build
 * started from the PWA cache) would otherwise upload a NEWER version that
 * overrides the real configuration on every device.
 */
export function dropSeeded(versions: GlideConfig[]): GlideConfig[] {
  return versions.some((v) => !isSeededVersion(v))
    ? versions.filter((v) => !isSeededVersion(v))
    : versions;
}

function compareVersions(x: GlideConfig, y: GlideConfig): number {
  return (
    x.validFrom.localeCompare(y.validFrom) || x.savedAt.localeCompare(y.savedAt)
  );
}

/** Append a new version (the caller validates first). */
export function saveGlideVersion(version: GlideConfig) {
  try {
    const merged = mergeGlideVersions(loadGlideVersions(), [version]);
    localStorage.setItem(STORE_KEY, JSON.stringify(merged));
    touchPref("glidePath");
  } catch {
    /* ignore */
  }
}

/**
 * The version in force on `day` (YYYY-MM-DD): the latest `validFrom` on or
 * before it, the later save winning a same-day tie. Undefined before the first.
 */
export function configAt(
  versions: GlideConfig[],
  day: string,
): GlideConfig | undefined {
  let best: GlideConfig | undefined;
  for (const v of versions) {
    if (v.validFrom > day) continue;
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/** The newest version regardless of date — the one the settings UI edits. */
export function latestConfig(
  versions: GlideConfig[],
): GlideConfig | undefined {
  let best: GlideConfig | undefined;
  for (const v of versions) if (!best || compareVersions(v, best) > 0) best = v;
  return best;
}

/** A glide path with no buckets is switched off. */
export function isActive(cfg: GlideConfig | undefined): cfg is GlideConfig {
  return !!cfg && cfg.buckets.length > 0;
}

// ---- Validation -------------------------------------------------------------

export interface ValidationIssue {
  message: string;
  bucketId?: string;
  instrumentKey?: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Weight sums may be off by this much (rounding of percentage inputs). */
export const WEIGHT_SUM_TOLERANCE = 0.0001;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validCost(c: Cost | undefined): boolean {
  if (!c) return true;
  const ok = (n: number | undefined) =>
    n == null || (Number.isFinite(n) && n >= 0);
  return ok(c.pct) && ok(c.fixedHuf) && (c.pct ?? 0) < 1;
}

function validCostRule(r: CostRule | undefined): boolean {
  return !r || (validCost(r.buy) && validCost(r.sell));
}

/**
 * Check a configuration before saving. Errors block the save; warnings are
 * informational. `heldKeys` (instrument + cash keys currently held) lets it
 * warn about positions left outside every bucket.
 */
export function validateConfig(
  cfg: GlideConfig,
  heldKeys: string[] = [],
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  // No buckets = the feature is off; nothing to validate.
  if (cfg.buckets.length === 0) return { errors, warnings };

  const pct = (n: number) => `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const inflows = isInflowMode(cfg);

  const finalSum = cfg.buckets.reduce((s, b) => s + b.finalWeight, 0);
  if (Math.abs(finalSum - 1) > WEIGHT_SUM_TOLERANCE)
    errors.push({
      message: `A végső célsúlyok összege ${pct(finalSum)}, 100%-nak kell lennie.`,
    });

  // Manual start weights must also add up when every bucket is manual. With
  // snapshot starts mixed in (resolved from real data) a mismatch is only a
  // warning: the path is normalised to 100%, which shifts the starting points.
  // In inflows mode the start is the actual weight on the save day.
  if (inflows) {
    /* nothing to check */
  } else if (cfg.buckets.every((b) => b.start.mode === "manual")) {
    const startSum = cfg.buckets.reduce(
      (s, b) => s + (b.start.mode === "manual" ? b.start.weight : 0),
      0,
    );
    if (Math.abs(startSum - 1) > WEIGHT_SUM_TOLERANCE)
      errors.push({
        message: `A kezdő súlyok összege ${pct(startSum)}, 100%-nak kell lennie.`,
      });
  } else {
    const starts = cfg.buckets.map((b) =>
      b.start.mode === "manual" ? b.start.weight : b.start.resolvedWeight,
    );
    if (starts.every((w) => w != null && Number.isFinite(w))) {
      const startSum = starts.reduce((s: number, w) => s + (w ?? 0), 0);
      if (Math.abs(startSum - 1) > 0.005)
        warnings.push({
          message: `A kezdő súlyok összege ${pct(startSum)} — a pálya 100%-ra arányosítva indul, így a kezdőpontok eltolódnak. Érdemes minden csoportnál ugyanazt a pillanatképet használni.`,
        });
    }
  }

  const names = new Set<string>();
  for (const b of cfg.buckets) {
    const at = { bucketId: b.id };
    const label = b.name.trim() || "(névtelen)";
    if (!b.name.trim())
      errors.push({ ...at, message: "Minden csoportnak kell név." });
    else if (names.has(b.name.trim().toLowerCase()))
      errors.push({ ...at, message: `Két csoport neve is „${label}”.` });
    names.add(b.name.trim().toLowerCase());

    if (!(b.finalWeight >= 0 && b.finalWeight <= 1))
      errors.push({ ...at, message: `${label}: a célsúly 0–100% között legyen.` });
    if (!inflows) {
      if (b.start.mode === "manual" && !(b.start.weight >= 0 && b.start.weight <= 1))
        errors.push({ ...at, message: `${label}: a kezdő súly 0–100% között legyen.` });
      if (b.start.mode === "snapshot" && !DAY_RE.test(b.start.date))
        errors.push({ ...at, message: `${label}: hiányzik a pillanatkép dátuma.` });

      if (!DAY_RE.test(b.startDate) || !DAY_RE.test(b.endDate))
        errors.push({ ...at, message: `${label}: add meg a pálya kezdő és záró dátumát.` });
      else if (b.startDate >= b.endDate)
        errors.push({ ...at, message: `${label}: a záró dátum a kezdő után legyen.` });
    }

    if (b.band.kind === "abs" && !(b.band.pp > 0 && b.band.pp < 1))
      errors.push({ ...at, message: `${label}: a sáv mérete 0 és 100 százalékpont közé essen.` });
    if (b.band.kind === "rel" && !(b.band.pct > 0 && b.band.pct < 1))
      errors.push({ ...at, message: `${label}: a relatív sáv 0 és 100% közé essen.` });
    if (b.band.minPp != null && !(b.band.minPp >= 0 && b.band.minPp < 0.5))
      errors.push({ ...at, message: `${label}: a minimális sáv 0 és 50 százalékpont közé essen.` });
    if (b.realertStepPp != null && !(b.realertStepPp >= 0 && b.realertStepPp < 1))
      errors.push({ ...at, message: `${label}: az újrajelzési lépcső nem lehet negatív.` });

    if (!validCostRule(b.cost))
      errors.push({ ...at, message: `${label}: a költség nem lehet negatív (és 100% alatt legyen).` });
  }

  const bucketIds = new Set(cfg.buckets.map((b) => b.id));
  for (const [key, rule] of Object.entries(cfg.instruments)) {
    if (!bucketIds.has(rule.bucketId))
      errors.push({
        instrumentKey: key,
        message: `Egy instrumentum nem létező csoporthoz van rendelve (${key}).`,
      });
    if (!validCostRule(rule.cost))
      errors.push({
        instrumentKey: key,
        message: `Érvénytelen instrumentum-költség (${key}).`,
      });
    if (
      rule.qtyDecimals != null &&
      !(Number.isInteger(rule.qtyDecimals) && rule.qtyDecimals >= 0 && rule.qtyDecimals <= 8)
    )
      errors.push({
        instrumentKey: key,
        message: `A tört darab tizedesjegyeinek száma 0 és 8 közötti egész legyen (${key}).`,
      });
  }
  for (const b of cfg.buckets)
    if (!Object.values(cfg.instruments).some((r) => r.bucketId === b.id))
      warnings.push({
        bucketId: b.id,
        message: `${b.name || "(névtelen)"}: nincs hozzárendelt instrumentum.`,
      });

  for (const b of cfg.buckets) {
    const label = b.name || "(névtelen)";
    for (const x of [b.upperBase, b.lowerBase])
      if (x != null && x !== "path" && x !== "final")
        errors.push({
          bucketId: b.id,
          message: `${label}: a sávhatár alapja csak a pályacél vagy a végső cél lehet.`,
        });
    // "final" only ever widens the band: on the wrong side of the path it
    // changes nothing (a stepped or snapshot path may still differ, so only
    // a manual, flat-or-opposite start is flagged).
    if (b.start.mode === "manual") {
      const dir = Math.sign(b.finalWeight - b.start.weight);
      if (b.upperBase === "final" && dir <= 0)
        warnings.push({
          bucketId: b.id,
          message: `${label}: nem emelkedő pálya — a végső célhoz mért felső sávhatárnak nincs hatása.`,
        });
      if (b.lowerBase === "final" && dir >= 0)
        warnings.push({
          bucketId: b.id,
          message: `${label}: nem csökkenő pálya — a végső célhoz mért alsó sávhatárnak nincs hatása.`,
        });
    }
  }

  for (const b of cfg.buckets)
    for (const x of [b.aboveForcePp, b.belowForcePp])
      if (x != null && !(x >= 0 && x < 1))
        errors.push({
          bucketId: b.id,
          message: `${b.name || "(névtelen)"}: a kényszerített kereskedés küszöbe 0 és 100 %pont közötti legyen.`,
        });

  if (!(cfg.minTradeHuf >= 0))
    errors.push({ message: "A minimális tranzakcióméret nem lehet negatív." });
  if (!(cfg.realertStepPp >= 0 && cfg.realertStepPp < 1))
    errors.push({ message: "Az újrajelzési lépcső nem lehet negatív." });
  if (!(cfg.maxCostRatio >= 0))
    errors.push({ message: "A költség/haszon küszöb nem lehet negatív." });
  if (!validCostRule(cfg.defaultCost))
    errors.push({ message: "Érvénytelen alapértelmezett költség." });
  const ma = cfg.monthlyAmount;
  if (ma?.kind === "fixed" && !(Number.isFinite(ma.huf) && ma.huf >= 0))
    errors.push({ message: "A célpálya havi összege nem lehet negatív." });
  if (ma?.kind === "pct" && !(ma.pct >= 0 && ma.pct <= 1))
    errors.push({ message: "A célpálya havi összege a keret 0–100%-a lehet." });
  const ft = cfg.flowTarget;
  if (
    ft?.kind === "days" &&
    !(Number.isInteger(ft.days) && ft.days >= 1 && ft.days <= MAX_FLOW_DAYS)
  )
    errors.push({
      message: `Az elosztás célpontja 1 és ${MAX_FLOW_DAYS} nap közötti egész szám lehet.`,
    });
  if (!ma)
    warnings.push({
      message:
        "Nincs beállítva a célpálya havi összege — a teljes havi keretet használja, ami ütközik a DCA és a középtávú célokkal.",
    });
  if (!DAY_RE.test(cfg.validFrom))
    errors.push({ message: "Add meg, mikortól érvényes a beállítás." });

  if (inflows) {
    if (!Object.values(cfg.instruments).some((r) => r.acceptsContributions))
      errors.push({
        message:
          "A befizetésekből számolt pályához legalább egy instrumentumnak fogadnia kell befizetést.",
      });
    // Only known once the path has been frozen (on save).
    if (cfg.inflowPath?.length && cfg.inflowReached === false)
      warnings.push({
        message:
          "A várható befizetésekből a vetítés végéig sem éri el a végső arányt — a pálya az utolsó vetített ponton áll meg.",
      });
  }

  const unassigned = heldKeys.filter((k) => !cfg.instruments[k]);
  if (unassigned.length)
    warnings.push({
      message: `${unassigned.length} tartott tétel nincs csoportban — ezek kimaradnak a súlyokból.`,
    });

  return { errors, warnings };
}

// ---- Defaults & migration ---------------------------------------------------

/** Global defaults for a fresh configuration. */
export function defaultGlobals(): Omit<
  GlideConfig,
  "id" | "validFrom" | "savedAt" | "buckets" | "instruments"
> {
  return {
    checkFrequency: "monthly",
    minTradeHuf: 10_000,
    restoreTo: "path",
    maxCostRatio: 0.01,
    bondsAtFace: true,
    defaultCost: {},
    realertStepPp: 0.02,
    deepAlertsInQuietHours: false,
  };
}

/** A brand-new configuration (no saved version yet) starts in inflows mode. */
export function newConfigGlobals(): ReturnType<typeof defaultGlobals> & { pathMode: PathMode } {
  return { ...defaultGlobals(), pathMode: "inflows" };
}

/**
 * Fill settings added after a version was saved with their defaults, so old
 * versions keep working unchanged (a missing band minimum is 0, a missing
 * relative base is the path target — exactly the earlier behaviour).
 */
export function normalizeConfig(cfg: GlideConfig): GlideConfig {
  const d = defaultGlobals();
  return {
    ...cfg,
    realertStepPp: cfg.realertStepPp ?? d.realertStepPp,
    deepAlertsInQuietHours: cfg.deepAlertsInQuietHours ?? d.deepAlertsInQuietHours,
  };
}

function addYears(day: string, years: number): string {
  const y = Number(day.slice(0, 4)) + years;
  return `${y}${day.slice(4)}`;
}

/**
 * One-off conversion of the old per-asset-class target allocation into
 * buckets: one bucket per managed class at its old target, a flat path (start
 * = final) and a ±5 pp absolute band. Instruments (and the cash balances, if
 * cash was managed) are assigned by their asset class; everything is sellable
 * and accepts contributions until the user says otherwise.
 */
export function migrateFromAllocation(
  settings: AllocationSettings,
  instruments: Instrument[],
  cashCurrencies: string[],
  today: string,
  makeId: () => string = () => crypto.randomUUID(),
): GlideConfig | null {
  const classes = includedClasses(settings).filter(
    (c) => (settings.targets[c] ?? 0) > 0,
  );
  if (classes.length === 0) return null;
  // Old targets were normalised across the included classes — keep that.
  const sum = classes.reduce((s, c) => s + (settings.targets[c] ?? 0), 0);
  const bucketOf = new Map<AssetClass, string>();
  // Rounded to 0.01 pp for tidy inputs; the last bucket takes the remainder so
  // the weights still sum to exactly 100%.
  let assigned = 0;
  const buckets: Bucket[] = classes.map((c, i) => {
    const id = makeId();
    bucketOf.set(c, id);
    const w =
      i === classes.length - 1
        ? Math.round((1 - assigned) * 1e4) / 1e4
        : Math.round(((settings.targets[c] ?? 0) / sum) * 1e4) / 1e4;
    assigned += w;
    return {
      id,
      name: assetClassLabel[c],
      finalWeight: w,
      start: { mode: "manual", weight: w },
      startDate: today,
      endDate: addYears(today, 1),
      interpolation: "linear",
      band: { kind: "abs", pp: 0.05 },
    };
  });
  const rules: Record<string, InstrumentRule> = {};
  const assign = (key: string, cls: AssetClass) => {
    const bucketId = bucketOf.get(cls);
    if (bucketId)
      rules[key] = { bucketId, sellable: true, acceptsContributions: true };
  };
  for (const inst of instruments) assign(inst.key, assetClassOf(inst));
  for (const ccy of cashCurrencies) assign(cashKey(ccy), "cash");
  return {
    id: makeId(),
    validFrom: today,
    savedAt: new Date().toISOString(),
    buckets,
    instruments: rules,
    ...defaultGlobals(),
    seeded: true,
  };
}

/**
 * Seed the glide path from the old target allocation the first time it's
 * needed. Runs only while no version exists (on this device or synced), so it
 * never overwrites a real configuration. Returns the stored versions.
 */
export function migrateIfNeeded(
  loadOld: () => AllocationSettings | null,
  instruments: Instrument[],
  cashCurrencies: string[],
  today: string,
): GlideConfig[] {
  const versions = loadGlideVersions();
  if (versions.length) return versions;
  const old = loadOld();
  const seeded = old
    ? migrateFromAllocation(old, instruments, cashCurrencies, today)
    : null;
  if (!seeded) return versions;
  saveGlideVersion(seeded);
  return loadGlideVersions();
}
/**
 * How many advanced settings differ from their defaults — shown on the
 * collapsed "Haladó" toggle, so nothing set there goes unnoticed. Settings
 * the path mode makes irrelevant are not counted.
 */
export function countCustomSettings(cfg: GlideConfig, today: string): number {
  const d = defaultGlobals();
  const calendar = !isInflowMode(cfg);
  let n = 0;
  const count = (x: boolean) => {
    if (x) n++;
  };
  for (const b of cfg.buckets) {
    count(calendar && b.interpolation !== "linear");
    count(b.band.kind === "rel");
    count(!!b.band.minPp);
    count(b.realertStepPp != null);
    count(calendar && (b.upperBase === "final" || b.lowerBase === "final"));
    count(b.aboveMode != null || b.belowMode != null);
    count(!!b.cost);
  }
  for (const r of Object.values(cfg.instruments)) {
    count(!!r.cost);
    count(!!r.fractional);
  }
  count(cfg.checkFrequency !== d.checkFrequency);
  count(cfg.minTradeHuf !== d.minTradeHuf);
  count(cfg.restoreTo !== d.restoreTo);
  count(cfg.maxCostRatio !== d.maxCostRatio);
  count(cfg.bondsAtFace !== d.bondsAtFace);
  count(!!(cfg.defaultCost.buy || cfg.defaultCost.sell));
  count(cfg.realertStepPp !== d.realertStepPp);
  count(cfg.deepAlertsInQuietHours !== d.deepAlertsInQuietHours);
  count(cfg.buyCostMode === "extra");
  count(calendar && !!cfg.flowTarget && cfg.flowTarget.kind !== "today");
  count(cfg.validFrom !== today);
  return n;
}

