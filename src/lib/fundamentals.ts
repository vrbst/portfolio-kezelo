export const FUNDAMENTALS_PATH = "market/fundamentals.json";

export const FUNDAMENTALS_ALERT_DAYS = 3;

export interface Weight {
  name: string;
  weight: number;
}

export interface Fundamentals {
  symbol: string;
  fetchedAt: string;
  quoteType?: string;
  currency?: string;
  sector?: string;
  industry?: string;
  country?: string;
  pe?: number;
  forwardPe?: number;
  pb?: number;
  dividendYield?: number;
  marketCap?: number;
  beta?: number;
  nextEarnings?: string;
  totalAssets?: number;
  family?: string;
  sectors?: Weight[];
  topHoldings?: Weight[];
}

export interface FetchError {
  since: string;
  message: string;
}

export interface FundamentalsFile {
  v: 1;
  updatedAt: string;
  items: Record<string, Fundamentals>;
  errors: Record<string, FetchError>;
  notifiedAt?: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

function weights(v: unknown): Weight[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((w) => {
    const name = str((w as Weight)?.name);
    const weight = num((w as Weight)?.weight);
    return name && weight != null ? [{ name, weight }] : [];
  });
  return out.length ? out : undefined;
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function validateFundamentals(v: unknown): Fundamentals | null {
  const o = v as Record<string, unknown> | null;
  const symbol = str(o?.symbol);
  const fetchedAt = str(o?.fetchedAt);
  if (!o || !symbol || !fetchedAt) return null;
  return clean({
    symbol,
    fetchedAt,
    quoteType: str(o.quoteType),
    currency: str(o.currency),
    sector: str(o.sector),
    industry: str(o.industry),
    country: str(o.country),
    pe: num(o.pe),
    forwardPe: num(o.forwardPe),
    pb: num(o.pb),
    dividendYield: num(o.dividendYield),
    marketCap: num(o.marketCap),
    beta: num(o.beta),
    nextEarnings: str(o.nextEarnings),
    totalAssets: num(o.totalAssets),
    family: str(o.family),
    sectors: weights(o.sectors),
    topHoldings: weights(o.topHoldings),
  });
}

export function validateFundamentalsFile(v: unknown): FundamentalsFile | null {
  const o = v as Record<string, unknown> | null;
  if (!o || o.v !== 1 || !str(o.updatedAt)) return null;
  const items: Record<string, Fundamentals> = {};
  for (const [k, raw] of Object.entries((o.items as Record<string, unknown>) ?? {})) {
    const f = validateFundamentals(raw);
    if (f) items[k] = f;
  }
  const errors: Record<string, FetchError> = {};
  for (const [k, raw] of Object.entries((o.errors as Record<string, unknown>) ?? {})) {
    const e = raw as FetchError;
    if (str(e?.since) && typeof e?.message === "string") errors[k] = { since: e.since, message: e.message };
  }
  return clean({ v: 1 as const, updatedAt: o.updatedAt as string, items, errors, notifiedAt: str(o.notifiedAt) });
}

export const SECTOR_LABEL: Record<string, string> = {
  technology: "Technológia",
  financial_services: "Pénzügy",
  healthcare: "Egészségügy",
  industrials: "Ipar",
  consumer_cyclical: "Ciklikus fogyasztás",
  consumer_defensive: "Alapvető fogyasztás",
  communication_services: "Kommunikáció",
  energy: "Energia",
  basic_materials: "Alapanyagok",
  utilities: "Közművek",
  realestate: "Ingatlan",
};

export function sectorKey(sector: string): string {
  const k = sector.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
  if (k === "financial") return "financial_services";
  if (k === "real_estate") return "realestate";
  return k;
}

export const sectorLabel = (key: string) => SECTOR_LABEL[key] ?? key;

/** Which holdings (and how many HUF of each) make up every sector. */
export function sectorContributions(
  holdings: { key: string; valueHuf: number }[],
  file: FundamentalsFile | null,
): { bySector: Map<string, { key: string; valueHuf: number }[]>; coveredHuf: number; totalHuf: number } {
  const bySector = new Map<string, { key: string; valueHuf: number }[]>();
  const add = (sector: string, key: string, valueHuf: number) => {
    const list = bySector.get(sector) ?? [];
    list.push({ key, valueHuf });
    bySector.set(sector, list);
  };
  let covered = 0;
  let total = 0;
  for (const h of holdings) {
    if (h.valueHuf <= 0) continue;
    total += h.valueHuf;
    const f = file?.items[h.key];
    if (f?.sectors?.length) {
      const sum = f.sectors.reduce((s, w) => s + w.weight, 0);
      if (sum <= 0) continue;
      for (const w of f.sectors) add(w.name, h.key, (h.valueHuf * w.weight) / sum);
      covered += h.valueHuf;
    } else if (f?.sector) {
      add(sectorKey(f.sector), h.key, h.valueHuf);
      covered += h.valueHuf;
    }
  }
  return { bySector, coveredHuf: covered, totalHuf: total };
}

export function sectorExposure(
  holdings: { key: string; valueHuf: number }[],
  file: FundamentalsFile | null,
): { sectors: Weight[]; coveredHuf: number; totalHuf: number } {
  const { bySector, coveredHuf, totalHuf } = sectorContributions(holdings, file);
  const sectors = [...bySector]
    .map(([name, items]) => ({
      name,
      weight: coveredHuf > 0 ? items.reduce((s, c) => s + c.valueHuf, 0) / coveredHuf : 0,
    }))
    .sort((a, b) => b.weight - a.weight);
  return { sectors, coveredHuf, totalHuf };
}

export function staleErrors(file: FundamentalsFile | null, now: Date): [string, FetchError][] {
  const limit = now.getTime() - FUNDAMENTALS_ALERT_DAYS * 86_400_000;
  return Object.entries(file?.errors ?? {}).filter(([, e]) => Date.parse(e.since) <= limit);
}
