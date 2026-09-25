// Shared calendar model: day items, categories/colours and the per-day
// aggregate used by the month grids, the zoomed month and the day panel.

export const MONTHS = [
  "január",
  "február",
  "március",
  "április",
  "május",
  "június",
  "július",
  "augusztus",
  "szeptember",
  "október",
  "november",
  "december",
];
export const WEEKDAYS = ["H", "K", "Sz", "Cs", "P", "Sz", "V"];
export const WEEKDAY_NAMES = [
  "vasárnap",
  "hétfő",
  "kedd",
  "szerda",
  "csütörtök",
  "péntek",
  "szombat",
];

export type DayCat =
  | "coupon"
  | "maturity"
  | "tbsz"
  | "in"
  | "out"
  /** Savings-goal deadline (marker). */
  | "goal"
  /** Planned expense from the forecast (marker). */
  | "expense"
  /** Planned recurring purchase (DCA) on payday (marker). */
  | "dca";

export interface DayItem {
  title: string;
  /** HUF magnitude (≥0) of a cash flow; the category decides sign/colour.
   *  Undefined = marker (TBSZ milestone, goal deadline, DCA reminder…). */
  amountHuf?: number;
  /** Amount shown for a marker without counting as a flow (e.g. a goal's
   *  target). */
  noteHuf?: number;
  future: boolean;
  tag: string;
  cat: DayCat;
  /** Set for asset buys/sells (instrument key) so same-asset round-trips net. */
  tradeKey?: string;
}

export const CAT_COLOR: Record<DayCat, string> = {
  coupon: "#22d3ee",
  maturity: "#6366f1",
  tbsz: "#fbbf24",
  in: "#34d399",
  out: "#fb7185",
  goal: "#ec4899",
  expense: "#f97316",
  dca: "#a78bfa",
};

export const MARKER_LABEL: Partial<Record<DayCat, string>> = {
  tbsz: "TBSZ mérföldkő",
  goal: "Cél határideje",
  expense: "Betervezett kiadás",
  dca: "Havi vásárlás (fizetésnap)",
};

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (y: number, m0: number, d: number) =>
  `${y}-${pad(m0 + 1)}-${pad(d)}`;

export interface DayAgg {
  inflow: number;
  outflow: number;
  /** The first amountless marker's category, if the day has one. */
  marker?: DayCat;
}

/**
 * Aggregate a day's items into gross in/out. Trades are netted PER INSTRUMENT
 * first, so a same-asset round-trip cancels but a cross-asset rebalance keeps
 * both legs. Income/costs are never washed.
 */
export function dayAggregate(items: DayItem[]): DayAgg {
  const tradeNet = new Map<string, number>();
  let inflow = 0;
  let outflow = 0;
  let marker: DayCat | undefined;
  for (const it of items) {
    if (it.amountHuf == null) {
      marker ??= it.cat;
      continue;
    }
    const signed = it.cat === "out" ? -it.amountHuf : it.amountHuf;
    if (it.tradeKey)
      tradeNet.set(it.tradeKey, (tradeNet.get(it.tradeKey) ?? 0) + signed);
    else if (signed >= 0) inflow += signed;
    else outflow += -signed;
  }
  for (const v of tradeNet.values()) {
    if (v > 0) inflow += v;
    else outflow += -v;
  }
  return { inflow, outflow, marker };
}

/** The day's dominant colour: net in green, net out red, balanced indigo,
 *  an amount-less day its marker's colour. */
export function dayColor(agg: DayAgg): string {
  const gross = agg.inflow + agg.outflow;
  if (gross === 0 && agg.marker) return CAT_COLOR[agg.marker];
  const net = agg.inflow - agg.outflow;
  const tol = gross * 0.05;
  return net > tol ? CAT_COLOR.in : net < -tol ? CAT_COLOR.out : CAT_COLOR.maturity;
}

/** A glossy sphere fill: highlight top-left, the hue, a darker rim. */
export const sphere = (c: string) =>
  `radial-gradient(circle at 35% 28%, color-mix(in srgb, ${c}, white 48%), ${c} 58%, color-mix(in srgb, ${c}, black 22%))`;

// Official security names → the short forms used day to day, for the tight
// chips of the zoomed month.
const NAME_SHORT: [RegExp, string][] = [
  [/Fix Magyar Állampapír/i, "FixMÁP"],
  [/Prémium Magyar Állampapír/i, "PMÁP"],
  [/Bónusz Magyar Állampapír/i, "BMÁP"],
  [/Magyar Állampapír Plusz/i, "MÁP Plusz"],
  [/Diszkont Kincstárjegy/i, "DKJ"],
];
export function shortName(name: string): string {
  let s = name;
  for (const [re, short] of NAME_SHORT) s = s.replace(re, short);
  return s;
}

/** Signed amount text for an item ("+1,2 M", "−40 000"). */
export const itemSign = (it: DayItem) => (it.cat === "out" ? "−" : "+");
