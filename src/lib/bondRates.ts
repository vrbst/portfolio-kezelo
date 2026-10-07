import type { BondTerms, Instrument } from "./model";
import { addDaysIso, txDay } from "./day";

export interface RetailOffer {
  type: string;
  series: string;
  rateText: string;
  rateMin: number | null;
  rateMax: number | null;
  ehm: number | null;
  maturity: string | null;
  currency: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface InterestPeriod {
  type: string;
  series: string;
  rate: number;
  periodStart: string;
  periodEnd: string;
  paymentDate: string | null;
  maturity: string | null;
  currency: string;
}

export interface DkjAuction {
  auctionDate: string;
  series: string;
  isin: string | null;
  maturity: string | null;
  avgYield: number;
}

export interface BondRatesFile {
  updatedAt?: string;
  retail: RetailOffer[];
  periods: InterestPeriod[];
  dkj: DkjAuction[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function validateBondRatesFile(raw: unknown): BondRatesFile {
  const f = raw as Partial<BondRatesFile> | null;
  if (!f || typeof f !== "object") throw new Error("bond-rates: nem objektum");
  if (!Array.isArray(f.retail) || !Array.isArray(f.periods) || !Array.isArray(f.dkj))
    throw new Error("bond-rates: hiányzó lista");
  const periods = f.periods.filter(
    (p) =>
      p &&
      typeof p.series === "string" &&
      typeof p.type === "string" &&
      typeof p.rate === "number" &&
      DAY.test(p.periodStart ?? "") &&
      DAY.test(p.periodEnd ?? ""),
  );
  const retail = f.retail.filter(
    (r) => r && typeof r.series === "string" && typeof r.type === "string" && typeof r.rateText === "string",
  );
  const dkj = f.dkj.filter(
    (d) => d && typeof d.series === "string" && typeof d.avgYield === "number" && DAY.test(d.auctionDate ?? ""),
  );
  return { updatedAt: f.updatedAt, retail, periods, dkj };
}

export type BondFamily =
  | "FixMÁP"
  | "PMÁP"
  | "PEMÁP"
  | "BMÁP"
  | "MÁP Plusz"
  | "BABA"
  | "EMÁP"
  | "KTV";

const FAMILY_OF_TYPE: Record<string, BondFamily> = {
  FixMÁP: "FixMÁP",
  PMÁP: "PMÁP",
  PEMÁP: "PEMÁP",
  BMÁP: "BMÁP",
  "MÁP Plusz": "MÁP Plusz",
  MÁPP_T: "MÁP Plusz",
  BABA: "BABA",
  EMÁP: "EMÁP",
  KTV: "KTV",
};

export const familyOfType = (type: string): BondFamily | undefined => FAMILY_OF_TYPE[type];

const FAMILY_BY_NAME: [RegExp, BondFamily][] = [
  [/prémium\s+euró|\bpemáp\b/i, "PEMÁP"],
  [/prémium|\bpmáp\b/i, "PMÁP"],
  [/bónusz|\bbmáp\b/i, "BMÁP"],
  [/\bfix|fixmáp/i, "FixMÁP"],
  [/plusz|\bmápp/i, "MÁP Plusz"],
  [/\bbaba/i, "BABA"],
  [/euró|\bemáp\b/i, "EMÁP"],
  [/kamatozó|\bktv\b/i, "KTV"],
];

export function familyOfName(name: string): BondFamily | undefined {
  return FAMILY_BY_NAME.find(([re]) => re.test(name))?.[1];
}

export function seriesOfName(name: string): string | undefined {
  return name.match(/\b([A-Z]?\d{4}\/[A-Z0-9]+(?:_[A-Z]+)?)\b/i)?.[1].toUpperCase();
}

export function dkjSeriesOfName(name: string): string | undefined {
  return name.match(/\b(D\d{6})\b/)?.[1];
}

export function periodFor(inst: Instrument, file: BondRatesFile | null): InterestPeriod | undefined {
  if (!file || inst.type !== "gov_bond") return undefined;
  const series = seriesOfName(inst.name);
  if (!series) return undefined;
  const family = familyOfName(inst.name);
  const hits = file.periods.filter(
    (p) => p.series.toUpperCase() === series && (!family || familyOfType(p.type) === family),
  );
  const families = new Set(hits.map((p) => familyOfType(p.type) ?? p.type));
  if (families.size !== 1) return undefined;
  return hits.sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
}

export function auctionsFor(inst: Instrument, file: BondRatesFile | null): DkjAuction[] {
  if (!file || inst.type !== "tbill") return [];
  const series = dkjSeriesOfName(inst.name);
  return file.dkj
    .filter((a) => (inst.isin && a.isin === inst.isin) || (series && a.series === series))
    .sort((a, b) => b.auctionDate.localeCompare(a.auctionDate));
}

function wholeMonthsBetween(from: string, to: string): number | undefined {
  const months = (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7));
  const dayDiff = Math.abs(+to.slice(8, 10) - +from.slice(8, 10));
  return dayDiff <= 3 ? months : undefined;
}

const SCHEDULE_MONTHS = new Set([1, 3, 6, 12]);

export function fillBondTerms(inst: Instrument, file: BondRatesFile | null): Instrument {
  const p = periodFor(inst, file);
  if (!p) return inst;
  const bond: BondTerms = { ...inst.bond };
  let changed = false;
  if (bond.couponRate == null) {
    bond.couponRate = Math.round(p.rate * 1e4) / 1e6;
    changed = true;
  }
  const months = wholeMonthsBetween(p.periodStart, p.periodEnd);
  if (months && SCHEDULE_MONTHS.has(months)) {
    if (bond.couponIntervalMonths == null) {
      bond.couponIntervalMonths = months;
      changed = true;
    }
    if (bond.firstCouponDate == null) {
      bond.firstCouponDate = p.periodStart;
      changed = true;
    }
  }
  const maturity = bond.maturity == null && p.maturity && p.maturity !== inst.maturity ? p.maturity : undefined;
  if (!changed && !maturity) return inst;
  return { ...inst, ...(maturity ? { maturity } : {}), ...(changed ? { bond } : {}) };
}

export function withBondRates(instruments: Instrument[], file: BondRatesFile | null): Instrument[] {
  return file ? instruments.map((i) => fillBondTerms(i, file)) : instruments;
}

export const maturityOf = (inst: Instrument | undefined): string | undefined => {
  const m = inst?.bond?.maturity ?? inst?.maturity;
  return m ? txDay(m) : undefined;
};

export function buyableOffers(file: BondRatesFile, today: string): RetailOffer[] {
  return file.retail.filter(
    (r) =>
      familyOfType(r.type) !== "BABA" &&
      r.maturity != null &&
      (r.validTo == null || r.validTo >= today),
  );
}

export function latestDkjAuction(file: BondRatesFile, today: string): DkjAuction | undefined {
  const since = addDaysIso(today, -45);
  return [...file.dkj]
    .filter((a) => a.auctionDate <= today && a.auctionDate >= since)
    .sort((a, b) => b.auctionDate.localeCompare(a.auctionDate))[0];
}
