// ---------------------------------------------------------------------------
// Expected returns derived from the Kilátások (market/outlook.json), for the
// forecast's "Kilátások alapján" mode. Pure: it reads nothing and saves
// nothing — the forecast engine stays as it is and only gets other numbers
// (effectiveForecastSettings). With no usable data the result is exactly the
// manual numbers.
//
// What is believed, and how much:
//  • Long-term return expectations (Vanguard, J.P. Morgan … for an index fund)
//    are made for this horizon: their mean is taken as the "real" scenario.
//  • 12-month price targets are not: they say little about years 2–10 and run
//    optimistic, so they only pull the manual number a bit towards them
//    (time-weighted, half-trusted).
//  • The option market's implied volatility is not a view but a measure of
//    uncertainty: it feeds the Monte Carlo σ of crypto products.
// ---------------------------------------------------------------------------

import type { Currency, Instrument } from "./model";
import { BOND_TYPES } from "./bonds";
import { assetClassOf, consolidatedHoldings } from "./holdings";
import { daysBetween, isStaleConsensus, isStaleView } from "./outlook";
import type {
  AnalystView,
  AssetClass as OutlookClass,
  Consensus,
  ImpliedBand,
  Outlook,
  OutlookFile,
  OutlookProfile,
} from "./outlook";
import type { PortfolioSummary } from "./portfolio";
import { toLocalDay } from "./day";

export interface ReturnTriple {
  pess: number;
  real: number;
  opt: number;
}

export interface ManualReturns {
  annualReturn: ReturnTriple;
  mcSigma: number;
  months: number;
  inflationPct: number;
}

/** One growth asset, as the estimate needs it. */
export interface GrowthHolding {
  key: string;
  name: string;
  instrument?: Instrument;
  currency: Currency;
  valueHuf: number;
  /** Price in the instrument's currency, if known. */
  price?: number;
}

export interface ReturnSource {
  label: string;
  detail: string;
  asOf?: string;
  url?: string;
  stale: boolean;
}

export type ReturnBasis = "views" | "targets" | "manual";

export interface AssetEstimate {
  key: string;
  name: string;
  cls: OutlookClass;
  /** Share of the securities' value (0–1). */
  weight: number;
  scenarios: ReturnTriple;
  sigma: number;
  basis: ReturnBasis;
  /** What the purchasing-power correction added to the real scenario (percentage points). */
  fxAdjPp: number;
  sources: ReturnSource[];
}

export interface OutlookReturnEstimate {
  scenarios: ReturnTriple;
  sigma: number;
  assets: AssetEstimate[];
  /** Share of the securities' value that has outlook data (0–1). */
  coveredShare: number;
  /** Cash as a share of the growth pot (securities + cash). */
  cashShare: number;
  warnings: string[];
  /** False when nothing had data: the numbers are the manual ones. */
  usable: boolean;
}

// ---- assumptions (documented constants) -----------------------------------

/** How much of a 12-month target's pull over the manual number is believed. */
export const TARGET_HAIRCUT = 0.5;
/** A target's implied move is clipped to this range before it is used. */
export const TARGET_CLIP: [number, number] = [-0.5, 1.0];
/** Long-term return expectations shorter than this are not "long-term". */
export const MIN_VIEW_YEARS = 5;
/** Price targets with a horizon outside this many months are left out. */
export const TARGET_MONTHS: [number, number] = [6, 18];
/** A median instead of a mean from this many houses on. */
export const MEDIAN_FROM = 3;

/** Long-run inflation by currency, for the purchasing-power correction of foreign-currency returns. */
export const INFLATION_BY_CURRENCY: Record<string, number> = { USD: 0.025, EUR: 0.02 };

/** Annual volatility when nothing better is known. The manual σ stands for a diversified equity fund. */
export const SIGMA = { equity: 0.28, bond_fund: 0.06, commodity: 0.16, crypto: 0.6 };

/** Correlations between different assets. */
export const RHO = { sameClass: 0.7, sameCrypto: 0.8, crypto: 0.3, defensive: 0.2 };

const Z90 = 1.2815515655446004;

// ---- small helpers ---------------------------------------------------------

const isIso = (s: string) => /^[A-Z]{3}$/.test(s);

/** The class the outlook looks at an instrument as: its profile's, else a rule. */
export function outlookClassOf(inst: Instrument | undefined, profile?: OutlookProfile): OutlookClass {
  if (profile) return profile.assetClass;
  if (assetClassOf(inst) === "crypto") return "crypto";
  return inst?.type === "stock" ? "equity" : "equity_fund";
}

/** The first number before "év"/"year" in e.g. "10–15 év", "5-10 years" (the conservative end). */
export function parseHorizonYears(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:[–-]\s*\d+(?:[.,]\d+)?\s*)?(?:év|éves|year)/i);
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

/**
 * How many months away a price target's horizon is: "12 hó (2027 októberéig)",
 * "1 év", "2026 vége". Undefined when it cannot be told or is "long term".
 */
export function targetMonths(text: string | undefined, now: Date): number | undefined {
  if (!text || /hosszú|long/i.test(text)) return undefined;
  const months = text.match(/(\d+)\s*(?:hó|hónap|month)/i);
  if (months) return Number(months[1]);
  const years = text.match(/(\d+(?:[.,]\d+)?)\s*(?:év|year)/i);
  if (years) return Math.round(Number(years[1].replace(",", ".")) * 12);
  const end = text.match(/(20\d{2})\s*(?:vége|end)/i);
  if (end) return Math.max(1, Math.round(daysBetween(toLocalDay(now), `${end[1]}-12-31`) / 30.44));
  return undefined;
}

/** A return in a foreign currency, in forint terms: the inflation gap carries over (long-run purchasing power parity). */
export function pppAdjust(r: number, ccy: string, inflationHuf: number): number {
  const foreign = INFLATION_BY_CURRENCY[ccy];
  if (ccy === "HUF" || foreign === undefined) return r;
  return ((1 + r) * (1 + inflationHuf)) / (1 + foreign) - 1;
}

/** σ from an option-implied band: the exact inverse of the lognormal band (implied.ts). */
export function sigmaFromBand(b: ImpliedBand): number | undefined {
  const T = b.horizonDays / 365;
  if (!(T > 0) || !(b.p10 > 0) || !(b.p90 > b.p10)) return undefined;
  return Math.log(b.p90 / b.p10) / (2 * Z90 * Math.sqrt(T));
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const clip = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));

// ---- one asset -------------------------------------------------------------

interface Context {
  manual: ManualReturns;
  now: Date;
}

/** House by house the newest of the longest-horizon long-term return expectations. */
function returnViews(views: AnalystView[] | undefined): AnalystView[] {
  const best = new Map<string, { v: AnalystView; years: number }>();
  for (const v of views ?? []) {
    if (v.kind !== "annualReturn") continue;
    const years = parseHorizonYears(v.horizon);
    if (years !== undefined && years < MIN_VIEW_YEARS) continue;
    const id = v.house.toLowerCase();
    const cur = best.get(id);
    const better =
      !cur || (years ?? 0) > cur.years || ((years ?? 0) === cur.years && v.publishedAt > cur.v.publishedAt);
    if (better) best.set(id, { v, years: years ?? 0 });
  }
  return [...best.values()].map((b) => b.v);
}

function fromViews(h: GrowthHolding, views: AnalystView[], ctx: Context): Pick<AssetEstimate, "scenarios" | "fxAdjPp" | "sources"> {
  const { manual, now } = ctx;
  const adjusted = views.map((v) => pppAdjust(v.value, isIso(v.unit) ? v.unit : h.currency, manual.inflationPct));
  const raw = views.map((v) => v.value);
  const center = (xs: number[]) => (xs.length >= MEDIAN_FROM ? median(xs) : mean(xs));
  const real = center(adjusted);
  // The width of the band is the manual one: houses agreeing on a long-run
  // number is no proof that the outcome is certain.
  const pess = real - Math.max(manual.annualReturn.real - manual.annualReturn.pess, real - Math.min(...adjusted));
  const opt = real + Math.max(manual.annualReturn.opt - manual.annualReturn.real, Math.max(...adjusted) - real);
  return {
    scenarios: { pess, real, opt },
    fxAdjPp: (real - center(raw)) * 100,
    sources: views.map((v) => ({
      label: v.house,
      detail: `${(v.value * 100).toFixed(1).replace(".", ",")}%/év${v.horizon ? `, ${v.horizon}` : ""}${isIso(v.unit) ? ` (${v.unit})` : ""}`,
      asOf: v.publishedAt,
      url: v.url,
      stale: isStaleView(v, now),
    })),
  };
}

/** A share's analyst consensus: the issuer's own if fresh, else the newest; same currency as the price only. */
function pickConsensus(h: GrowthHolding, consensus: Consensus[] | undefined, now: Date): Consensus | undefined {
  const usable = (consensus ?? []).filter(
    (c) => c.currency.toUpperCase() === h.currency.toUpperCase() && !isStaleConsensus(c, now),
  );
  return usable.sort((a, b) => Number(b.source === "issuer") - Number(a.source === "issuer") || b.asOf.localeCompare(a.asOf))[0];
}

/** Next year's dividend over the price, from the consensus estimates. */
function dividendYield(c: Consensus, price: number, now: Date): number {
  const next = (c.estimates ?? [])
    .filter((e) => e.dps != null && e.year >= now.getFullYear())
    .sort((a, b) => a.year - b.year)[0];
  return next?.dps != null && price > 0 ? Math.max(0, next.dps / price) : 0;
}

/** Pull of the manual triple towards a 12-month move `h1`, time-weighted: a = haircut / horizon in years. */
function shrink(manual: ReturnTriple, h1: ReturnTriple, months: number): ReturnTriple {
  const a = TARGET_HAIRCUT / Math.max(1, months / 12);
  const mix = (k: keyof ReturnTriple) => (1 - a) * manual[k] + a * clip(h1[k], TARGET_CLIP);
  return { pess: mix("pess"), real: mix("real"), opt: mix("opt") };
}

function fromTargets(
  h: GrowthHolding,
  cls: OutlookClass,
  item: Outlook | undefined,
  ctx: Context,
): Pick<AssetEstimate, "scenarios" | "fxAdjPp" | "sources"> | undefined {
  const { manual, now } = ctx;
  if (cls === "equity" && h.price && h.price > 0) {
    const c = pickConsensus(h, item?.consensus, now);
    if (!c) return undefined;
    const dy = dividendYield(c, h.price, now);
    const move = (x: number) => x / h.price! - 1 + dy;
    return {
      scenarios: shrink(manual.annualReturn, { pess: move(c.target.min), real: move(c.target.avg), opt: move(c.target.max) }, manual.months),
      fxAdjPp: 0,
      sources: [
        {
          label: c.source === "issuer" ? "Kibocsátói konszenzus" : "Yahoo elemzői célár",
          detail: `átlag ${Math.round(c.target.avg).toLocaleString("hu-HU")} ${c.currency}${c.target.count ? `, ${c.target.count} elemző` : ""}${dy > 0 ? `, osztalék ${(dy * 100).toFixed(1).replace(".", ",")}%` : ""}`,
          asOf: c.asOf,
          url: c.url,
          stale: false,
        },
      ],
    };
  }
  if (cls === "crypto") {
    // Targets are for the coin's dollar price: compare them with the option market's spot.
    const spot = item?.implied?.[0]?.spot;
    if (!spot) return undefined;
    const moves: { v: AnalystView; u: number }[] = [];
    for (const v of item?.views ?? []) {
      if (v.kind !== "target") continue;
      const m = targetMonths(v.horizon, now);
      if (m === undefined || m < TARGET_MONTHS[0] || m > TARGET_MONTHS[1]) continue;
      moves.push({ v, u: Math.pow(Math.max(0.01, v.value / spot), 12 / m) - 1 });
    }
    if (!moves.length) return undefined;
    const us = moves.map((x) => x.u);
    return {
      scenarios: shrink(manual.annualReturn, { pess: Math.min(...us), real: mean(us), opt: Math.max(...us) }, manual.months),
      fxAdjPp: 0,
      sources: moves.map(({ v }) => ({
        label: v.house,
        detail: `célár ${Math.round(v.value).toLocaleString("hu-HU")} ${v.unit}${v.horizon ? `, ${v.horizon}` : ""}`,
        asOf: v.publishedAt,
        url: v.url,
        stale: isStaleView(v, now),
      })),
    };
  }
  return undefined;
}

function sigmaOf(cls: OutlookClass, item: Outlook | undefined, manualSigma: number): number {
  switch (cls) {
    case "crypto": {
      // The longest band is the most reliable read of the volatility.
      const bands = [...(item?.implied ?? [])].sort((a, b) => b.horizonDays - a.horizonDays);
      for (const b of bands) {
        const s = sigmaFromBand(b);
        if (s !== undefined) return s;
      }
      return SIGMA.crypto;
    }
    case "equity":
      return SIGMA.equity;
    case "bond_fund":
      return SIGMA.bond_fund;
    case "commodity":
      return SIGMA.commodity;
    default:
      return manualSigma; // an equity fund, or unknown: what the user set for a diversified equity pot
  }
}

/** Correlation of two different assets by class. */
export function correlation(a: OutlookClass, b: OutlookClass): number {
  if (a === "crypto" && b === "crypto") return RHO.sameCrypto;
  if (a === "crypto" || b === "crypto") return RHO.crypto;
  const defensive = (c: OutlookClass) => c === "bond_fund" || c === "commodity";
  if (defensive(a) || defensive(b)) return a === b ? RHO.sameClass : RHO.defensive;
  return RHO.sameClass;
}

// ---- the whole estimate ----------------------------------------------------

export function outlookReturns(args: {
  holdings: GrowthHolding[];
  cashHuf?: number;
  outlook: OutlookFile | null | undefined;
  manual: ManualReturns;
  now: Date;
}): OutlookReturnEstimate {
  const { outlook, manual, now } = args;
  const held = args.holdings.filter((h) => h.valueHuf > 0 && Number.isFinite(h.valueHuf));
  const total = held.reduce((s, h) => s + h.valueHuf, 0);
  const cash = Math.max(0, args.cashHuf ?? 0);
  const cashShare = total + cash > 0 ? cash / (total + cash) : 0;
  const ctx: Context = { manual, now };

  const assets: AssetEstimate[] = held.map((h) => {
    const profile = outlook?.profiles[h.key];
    const item = outlook?.items[h.key];
    const cls = outlookClassOf(h.instrument, profile);
    const base = { key: h.key, name: h.name, cls, weight: h.valueHuf / total, sigma: sigmaOf(cls, item, manual.mcSigma) };
    const views = returnViews(item?.views);
    if (views.length) return { ...base, basis: "views" as const, ...fromViews(h, views, ctx) };
    const targets = fromTargets(h, cls, item, ctx);
    if (targets) return { ...base, basis: "targets" as const, ...targets };
    return { ...base, basis: "manual" as const, scenarios: manual.annualReturn, fxAdjPp: 0, sources: [] };
  });

  const coveredShare = assets.filter((a) => a.basis !== "manual").reduce((s, a) => s + a.weight, 0);
  if (!assets.length || coveredShare <= 0) {
    return {
      scenarios: manual.annualReturn,
      sigma: manual.mcSigma,
      assets,
      coveredShare: 0,
      cashShare,
      warnings: [outlook ? "A tartott értékpapírokhoz még nincs használható kilátás-adat." : "Nincs kilátás-adat."],
      usable: false,
    };
  }

  const scenarios: ReturnTriple = { pess: 0, real: 0, opt: 0 };
  for (const a of assets) for (const k of ["pess", "real", "opt"] as const) scenarios[k] += a.weight * a.scenarios[k];
  let variance = 0;
  for (const a of assets)
    for (const b of assets) variance += a.weight * b.weight * a.sigma * b.sigma * (a === b ? 1 : correlation(a.cls, b.cls));

  const warnings: string[] = [];
  if (coveredShare < 0.5)
    warnings.push(`Az értékpapírok értékének csak ${Math.round(coveredShare * 100)}%-ára van kilátás-adat; a többire a kézi hozam számít.`);
  if (cashShare > 0.05)
    warnings.push(`A növekedési kassza ${Math.round(cashShare * 100)}%-a készpénz; a motor ezt is ugyanezzel a hozammal számolja.`);
  return { scenarios, sigma: Math.sqrt(variance), assets, coveredShare, cashShare, warnings, usable: true };
}

/** The securities (not bonds, not cash) of the portfolio and the cash beside them. */
export function growthInputs(summary: PortfolioSummary): { holdings: GrowthHolding[]; cashHuf: number } {
  const holdings = consolidatedHoldings(summary)
    .filter((h) => h.instrument && !BOND_TYPES.has(h.instrument.type) && h.instrument.type !== "cash" && h.quantity > 1e-9)
    .map((h) => ({
      key: h.instrumentKey,
      name: h.instrument?.name ?? h.instrumentKey,
      instrument: h.instrument,
      currency: h.currency,
      valueHuf: h.marketValueHuf,
      price: h.currentPrice,
    }));
  return { holdings, cashHuf: summary.cashValueHuf };
}

/**
 * The settings the forecast actually runs with: in "outlook" mode (and with
 * usable data) the derived returns and σ replace the manual ones. Never saved
 * back — the stored settings stay the user's own.
 */
export function effectiveForecastSettings<
  S extends { returnSource?: "manual" | "outlook"; annualReturn: ReturnTriple; mcSigma: number },
>(settings: S, estimate: OutlookReturnEstimate | null | undefined): S {
  if (settings.returnSource !== "outlook" || !estimate?.usable) return settings;
  return { ...settings, annualReturn: estimate.scenarios, mcSigma: estimate.sigma };
}
