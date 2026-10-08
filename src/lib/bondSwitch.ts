import type { Instrument } from "./model";
import type { HoldingView } from "./portfolio";
import { BOND_TYPES } from "./bonds";
import {
  auctionsFor,
  buyableOffers,
  familyOfName,
  familyOfType,
  fillBondTerms,
  latestDkjAuction,
  maturityOf,
  periodFor,
  type BondFamily,
  type BondRatesFile,
  type DkjAuction,
  type RetailOffer,
} from "./bondRates";

export type BondHolding = Pick<
  HoldingView,
  "instrumentKey" | "instrument" | "quantity" | "marketValueHuf" | "redeemableValueHuf" | "costBasisHuf"
>;

export const MATURING_DAYS = 45;
export const MIN_RATE_GAP_PCT = 0.25;

const FLOATING = new Set<BondFamily>(["PMÁP", "PEMÁP", "BMÁP", "KTV"]);

const dayMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysBetween = (from: string, to: string) =>
  Math.round((dayMs(to) - dayMs(from)) / 86_400_000);

export interface OfferView {
  offer: RetailOffer;
  yieldPct: number;
  floating: boolean;
  years: number;
}

export function offerYieldPct(o: RetailOffer): number | undefined {
  if (o.ehm != null) return o.ehm;
  if (o.rateMin != null && o.rateMax != null) return (o.rateMin + o.rateMax) / 2;
  return o.rateMin ?? o.rateMax ?? undefined;
}

export const isFloatingType = (type: string) => {
  const f = familyOfType(type);
  return !!f && FLOATING.has(f);
};

export function rankedOffers(file: BondRatesFile, today: string, currency = "HUF"): OfferView[] {
  const out: OfferView[] = [];
  for (const offer of buyableOffers(file, today)) {
    const yieldPct = offerYieldPct(offer);
    if (yieldPct == null || offer.currency !== currency || !offer.maturity) continue;
    const days = daysBetween(today, offer.maturity);
    if (days <= 0) continue;
    out.push({ offer, yieldPct, floating: isFloatingType(offer.type), years: days / 365 });
  }
  return out.sort((a, b) => b.yieldPct - a.yieldPct);
}

export type SwitchVerdict =
  | { kind: "maturing"; days: number }
  | {
      kind: "switch";
      to: OfferView;
      gapPct: number;
      saleCostHuf: number;
      breakEvenMonths: number;
      horizonYears: number;
      gainHuf: number;
    }
  | { kind: "keep"; reason: "no-better" | "fee" | "no-rate" | "tbill"; best?: OfferView };

export interface BondAdvice {
  instrumentKey: string;
  instrument: Instrument;
  valueHuf: number;
  maturity?: string;
  daysToMaturity?: number;
  ratePct?: number;
  floating: boolean;
  verdict: SwitchVerdict;
}

function heldRatePct(inst: Instrument, file: BondRatesFile, today: string): number | undefined {
  if (inst.type === "tbill") return auctionsFor(inst, file)[0]?.avgYield;
  const p = periodFor(inst, { ...file, periods: file.periods.filter((x) => x.periodStart <= today) });
  if (p) return p.rate;
  const r = fillBondTerms(inst, file).bond?.couponRate;
  return r != null ? r * 100 : undefined;
}

export function switchGain(
  marketHuf: number,
  proceedsHuf: number,
  faceHuf: number,
  ratePct: number,
  newRatePct: number,
  years: number,
): number {
  const hold = marketHuf + faceHuf * (ratePct / 100) * years;
  const move = proceedsHuf * (1 + (newRatePct / 100) * years);
  return move - hold;
}

export function breakEvenYears(
  marketHuf: number,
  proceedsHuf: number,
  faceHuf: number,
  ratePct: number,
  newRatePct: number,
): number | undefined {
  const perYear = proceedsHuf * (newRatePct / 100) - faceHuf * (ratePct / 100);
  if (perYear <= 0) return undefined;
  return (marketHuf - proceedsHuf) / perYear;
}

export function adviseHolding(h: BondHolding, file: BondRatesFile, today: string): BondAdvice | undefined {
  const inst = h.instrument;
  if (!inst || !BOND_TYPES.has(inst.type) || h.quantity <= 1e-9) return undefined;
  const marketHuf = h.marketValueHuf ?? h.costBasisHuf;
  const proceedsHuf = h.redeemableValueHuf ?? marketHuf;
  const maturity = maturityOf(inst);
  const daysToMaturity = maturity ? daysBetween(today, maturity) : undefined;
  const ratePct = heldRatePct(inst, file, today);
  const family = familyOfName(inst.name);
  const base = {
    instrumentKey: h.instrumentKey,
    instrument: inst,
    valueHuf: marketHuf,
    maturity,
    daysToMaturity,
    ratePct,
    floating: inst.type === "gov_bond" && !!family && FLOATING.has(family),
  };
  if (daysToMaturity != null && daysToMaturity < 0) return undefined;
  if (daysToMaturity != null && daysToMaturity <= MATURING_DAYS)
    return { ...base, verdict: { kind: "maturing", days: daysToMaturity } };

  const offers = rankedOffers(file, today, inst.currency);
  if (inst.type === "tbill") return { ...base, verdict: { kind: "keep", reason: "tbill", best: offers[0] } };
  if (ratePct == null || daysToMaturity == null)
    return { ...base, verdict: { kind: "keep", reason: "no-rate", best: offers[0] } };

  const faceHuf = inst.currency === "HUF" ? h.quantity * (inst.faceValue ?? 1) : marketHuf;
  let best: Extract<SwitchVerdict, { kind: "switch" }> | undefined;
  let feeBlocked = false;
  for (const o of offers) {
    const gapPct = o.yieldPct - ratePct;
    if (gapPct < MIN_RATE_GAP_PCT) continue;
    const horizonYears = Math.min(daysToMaturity / 365, o.years);
    const be = breakEvenYears(marketHuf, proceedsHuf, faceHuf, ratePct, o.yieldPct);
    const gainHuf = switchGain(marketHuf, proceedsHuf, faceHuf, ratePct, o.yieldPct, horizonYears);
    if (be == null || be >= horizonYears || gainHuf <= 0) {
      feeBlocked = true;
      continue;
    }
    if (!best || gainHuf > best.gainHuf)
      best = {
        kind: "switch",
        to: o,
        gapPct,
        saleCostHuf: marketHuf - proceedsHuf,
        breakEvenMonths: be * 12,
        horizonYears,
        gainHuf,
      };
  }
  if (best) return { ...base, verdict: best };
  return { ...base, verdict: { kind: "keep", reason: feeBlocked ? "fee" : "no-better", best: offers[0] } };
}

export function bondAdvice(holdings: BondHolding[], file: BondRatesFile | null, today: string): BondAdvice[] {
  if (!file) return [];
  const out: BondAdvice[] = [];
  for (const h of holdings) {
    const a = adviseHolding(h, file, today);
    if (a) out.push(a);
  }
  const rank = (a: BondAdvice) => (a.verdict.kind === "switch" ? 0 : a.verdict.kind === "maturing" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.valueHuf - a.valueHuf);
}

export interface BondMarket {
  updatedAt?: string;
  offers: OfferView[];
  dkj?: DkjAuction;
}

export function bondMarket(file: BondRatesFile | null, today: string): BondMarket | null {
  if (!file) return null;
  return {
    updatedAt: file.updatedAt,
    offers: rankedOffers(file, today),
    dkj: latestDkjAuction(file, today),
  };
}
