import { txDay, localDayMs } from "./day";
import type { FetchError } from "./fundamentals";

export const OUTLOOK_PATH = "market/outlook.json";

export const OUTLOOK_ALERT_DAYS = 3;
/** Older analyst views say little about the next year: they are dropped. */
export const VIEW_MAX_AGE_DAYS = 365;
/** From this age on the app shows a view greyed out. */
export const VIEW_STALE_DAYS = 183;

export const ASSET_CLASSES = ["equity", "equity_fund", "bond_fund", "crypto", "commodity", "other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export interface OutlookProfile {
  assetClass: AssetClass;
  /** Crypto/commodity products: what they hold, e.g. "BTC". */
  underlying?: string;
  /** Where the issuer publishes its analyst consensus, if it does. */
  consensusUrl?: string;
  source: "rule" | "ai" | "manual";
  checkedAt: string;
}

export interface TargetRange {
  min: number;
  avg: number;
  max: number;
  count?: number;
}

export interface Estimate {
  year: number;
  eps?: number;
  dps?: number;
  netIncome?: number;
}

export interface Consensus {
  source: "yahoo" | "issuer";
  url?: string;
  /** Local day the figures are as of. */
  asOf: string;
  currency: string;
  target: TargetRange;
  /** Only the most recent estimates (the issuer's "latest" column). */
  recent?: TargetRange;
  ratings?: { buy: number; hold: number; sell: number };
  estimates?: Estimate[];
}

export interface ImpliedBand {
  underlying: string;
  horizonDays: number;
  expiry: string;
  spot: number;
  forward: number;
  p10: number;
  p50: number;
  p90: number;
  /** Market-implied probability that the price ends above today's spot. */
  probUp: number;
  asOf: string;
}

export interface AnalystView {
  house: string;
  kind: "target" | "annualReturn";
  /** A price target in `unit` currency, or an annual return as a fraction. */
  value: number;
  unit: string;
  horizon?: string;
  publishedAt: string;
  url: string;
  note?: string;
}

export interface Outlook {
  consensus?: Consensus[];
  implied?: ImpliedBand[];
  views?: AnalystView[];
}

export interface OutlookFile {
  v: 1;
  updatedAt: string;
  profiles: Record<string, OutlookProfile>;
  items: Record<string, Outlook>;
  errors: Record<string, FetchError>;
  notifiedAt?: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => {
  const s = str(v);
  if (!s) return undefined;
  const d = txDay(s);
  return DAY.test(d) && Number.isFinite(localDayMs(d)) ? d : undefined;
};
const httpUrl = (v: unknown) => {
  const s = str(v);
  return s && /^https?:\/\/\S+$/i.test(s) ? s : undefined;
};

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function validateProfile(v: unknown): OutlookProfile | null {
  const o = v as Record<string, unknown> | null;
  const assetClass = ASSET_CLASSES.find((c) => c === o?.assetClass);
  const checkedAt = str(o?.checkedAt);
  const source = (["rule", "ai", "manual"] as const).find((x) => x === o?.source);
  if (!o || !assetClass || !checkedAt || !source) return null;
  return clean({
    assetClass,
    underlying: str(o.underlying)?.toUpperCase(),
    consensusUrl: httpUrl(o.consensusUrl),
    source,
    checkedAt,
  });
}

function targetRange(v: unknown): TargetRange | undefined {
  const o = v as Record<string, unknown> | null;
  const min = num(o?.min);
  const avg = num(o?.avg);
  const max = num(o?.max);
  if (min == null || avg == null || max == null) return undefined;
  if (!(min > 0) || min > avg || avg > max) return undefined;
  const count = num(o?.count);
  return clean({ min, avg, max, count: count != null && count >= 0 ? Math.round(count) : undefined });
}

function ratings(v: unknown): Consensus["ratings"] {
  const o = v as Record<string, unknown> | null;
  const buy = num(o?.buy);
  const hold = num(o?.hold);
  const sell = num(o?.sell);
  if (buy == null || hold == null || sell == null || buy < 0 || hold < 0 || sell < 0) return undefined;
  return { buy, hold, sell };
}

function estimates(v: unknown): Estimate[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((e) => {
    const o = e as Record<string, unknown> | null;
    const year = num(o?.year);
    if (year == null || !Number.isInteger(year)) return [];
    return [clean({ year, eps: num(o?.eps), dps: num(o?.dps), netIncome: num(o?.netIncome) })];
  });
  return out.length ? out : undefined;
}

export function validateConsensus(v: unknown): Consensus | null {
  const o = v as Record<string, unknown> | null;
  const source = (["yahoo", "issuer"] as const).find((x) => x === o?.source);
  const asOf = day(o?.asOf);
  const currency = str(o?.currency)?.toUpperCase();
  const target = targetRange(o?.target);
  if (!o || !source || !asOf || !currency || !target) return null;
  return clean({
    source,
    url: httpUrl(o.url),
    asOf,
    currency,
    target,
    recent: targetRange(o.recent),
    ratings: ratings(o.ratings),
    estimates: estimates(o.estimates),
  });
}

export function validateBand(v: unknown): ImpliedBand | null {
  const o = v as Record<string, unknown> | null;
  const underlying = str(o?.underlying)?.toUpperCase();
  const expiry = day(o?.expiry);
  const asOf = day(o?.asOf);
  const horizonDays = num(o?.horizonDays);
  const spot = num(o?.spot);
  const forward = num(o?.forward);
  const p10 = num(o?.p10);
  const p50 = num(o?.p50);
  const p90 = num(o?.p90);
  const probUp = num(o?.probUp);
  if (!o || !underlying || !expiry || !asOf) return null;
  if (horizonDays == null || spot == null || forward == null || p10 == null || p50 == null || p90 == null) return null;
  if (probUp == null || probUp < 0 || probUp > 1 || !(spot > 0) || !(p10 > 0) || p10 > p50 || p50 > p90) return null;
  return { underlying, horizonDays, expiry, spot, forward, p10, p50, p90, probUp, asOf };
}

/** Whole days between two local days (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((localDayMs(b) - localDayMs(a)) / 86_400_000);
}

export function validateView(v: unknown, now: Date = new Date()): AnalystView | null {
  const o = v as Record<string, unknown> | null;
  const house = str(o?.house);
  const kind = (["target", "annualReturn"] as const).find((x) => x === o?.kind);
  const value = num(o?.value);
  const unit = str(o?.unit);
  const publishedAt = day(o?.publishedAt);
  const url = httpUrl(o?.url);
  // A view without a checkable source and date is just a claim.
  if (!o || !house || !kind || value == null || !unit || !publishedAt || !url) return null;
  if (kind === "target" && !(value > 0)) return null;
  if (kind === "annualReturn" && !(value > -1 && value < 2)) return null;
  const age = (now.getTime() - localDayMs(publishedAt)) / 86_400_000;
  if (age > VIEW_MAX_AGE_DAYS || age < -2) return null;
  return clean({ house, kind, value, unit, horizon: str(o.horizon), publishedAt, url, note: str(o.note) });
}

export function isStaleView(v: AnalystView, now: Date): boolean {
  return (now.getTime() - localDayMs(v.publishedAt)) / 86_400_000 > VIEW_STALE_DAYS;
}

function list<T>(v: unknown, f: (x: unknown) => T | null): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((x) => {
    const r = f(x);
    return r ? [r] : [];
  });
  return out.length ? out : undefined;
}

export function validateOutlook(v: unknown, now: Date = new Date()): Outlook | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const out = clean({
    consensus: list(o.consensus, validateConsensus),
    implied: list(o.implied, validateBand),
    views: list(o.views, (x) => validateView(x, now)),
  });
  return Object.keys(out).length ? out : null;
}

export function validateOutlookFile(v: unknown, now: Date = new Date()): OutlookFile | null {
  const o = v as Record<string, unknown> | null;
  if (!o || o.v !== 1 || !str(o.updatedAt)) return null;
  const profiles: Record<string, OutlookProfile> = {};
  for (const [k, raw] of Object.entries((o.profiles as Record<string, unknown>) ?? {})) {
    const p = validateProfile(raw);
    if (p) profiles[k] = p;
  }
  const items: Record<string, Outlook> = {};
  for (const [k, raw] of Object.entries((o.items as Record<string, unknown>) ?? {})) {
    const it = validateOutlook(raw, now);
    if (it) items[k] = it;
  }
  const errors: Record<string, FetchError> = {};
  for (const [k, raw] of Object.entries((o.errors as Record<string, unknown>) ?? {})) {
    const e = raw as FetchError;
    if (str(e?.since) && typeof e?.message === "string") errors[k] = { since: e.since, message: e.message };
  }
  return clean({ v: 1 as const, updatedAt: o.updatedAt as string, profiles, items, errors, notifiedAt: str(o.notifiedAt) });
}

export function staleOutlookErrors(file: OutlookFile | null, now: Date): [string, FetchError][] {
  const limit = now.getTime() - OUTLOOK_ALERT_DAYS * 86_400_000;
  return Object.entries(file?.errors ?? {}).filter(([, e]) => Date.parse(e.since) <= limit);
}
