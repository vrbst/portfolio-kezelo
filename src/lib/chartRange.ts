import { addDaysIso, toLocalDay } from "./day";

export type RangeKey = "1w" | "2w" | "1m" | "3m" | "6m" | "1y" | "ytd" | "max";

export const RANGES: { key: RangeKey; label: string; title: string }[] = [
  { key: "1w", label: "7N", title: "Utolsó 7 nap" },
  { key: "2w", label: "14N", title: "Utolsó 14 nap" },
  { key: "1m", label: "1H", title: "Utolsó 1 hónap" },
  { key: "3m", label: "3H", title: "Utolsó 3 hónap" },
  { key: "6m", label: "6H", title: "Utolsó 6 hónap" },
  { key: "1y", label: "1É", title: "Utolsó 1 év" },
  { key: "ytd", label: "Idei", title: "Az év eleje óta" },
  { key: "max", label: "Max", title: "A teljes időszak" },
];

const RANGE_DAYS: Record<Exclude<RangeKey, "ytd" | "max">, number> = {
  "1w": 7,
  "2w": 14,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
};

export function rangeCutoff(key: RangeKey, now = new Date()): string | null {
  if (key === "max") return null;
  if (key === "ytd") return `${now.getFullYear()}-01-01`;
  return addDaysIso(toLocalDay(now), -RANGE_DAYS[key]);
}

function firstIndexOnOrAfter(series: { date: string }[], day: string): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function rangeAvailability(
  series: { date: string }[],
  now = new Date(),
): Record<RangeKey, boolean> {
  const out = {} as Record<RangeKey, boolean>;
  for (const { key } of RANGES) {
    const cutoff = rangeCutoff(key, now);
    out[key] = cutoff
      ? series.length - firstIndexOnOrAfter(series, cutoff) >= 2
      : series.length >= 2;
  }
  return out;
}

export function effectiveRange(
  wanted: RangeKey,
  avail: Record<RangeKey, boolean>,
): RangeKey {
  if (avail[wanted]) return wanted;
  const from = RANGES.findIndex((r) => r.key === wanted);
  return RANGES.slice(from + 1).find((r) => avail[r.key])?.key ?? "max";
}

export function sliceRange<T extends { date: string }>(
  series: T[],
  key: RangeKey,
  now = new Date(),
): T[] {
  const cutoff = rangeCutoff(key, now);
  return cutoff ? series.slice(firstIndexOnOrAfter(series, cutoff)) : series;
}

export function profitBase(
  series: { value: number; invested: number }[],
  key: RangeKey,
): number {
  const first = series[0];
  return key === "max" || !first ? 0 : first.value - first.invested;
}

export type ChartMode = "value" | "profit";

const CHART_MODE_KEY = "pf-value-chart-mode";

export function loadChartMode(): ChartMode {
  try {
    return localStorage.getItem(CHART_MODE_KEY) === "value" ? "value" : "profit";
  } catch {
    return "profit";
  }
}

export function saveChartMode(mode: ChartMode) {
  try {
    localStorage.setItem(CHART_MODE_KEY, mode);
  } catch {
    return;
  }
}
