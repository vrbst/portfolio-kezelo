import { formatNumber } from "./format";
import type { AnalystView, AssetClass, ImpliedBand, TargetRange } from "./outlook";

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  equity: "egyedi részvény",
  equity_fund: "részvény-ETF/alap",
  bond_fund: "kötvény-ETF/alap",
  crypto: "kripto-ETP",
  commodity: "nyersanyag",
  other: "egyéb",
};

export const PROFILE_SOURCE_LABEL = { rule: "szabály", ai: "AI", manual: "kézi" } as const;

/** How far the average target is from the price (0.12 = 12% above); null when they are not comparable. */
export function upside(target: TargetRange, price: number | undefined, targetCurrency: string, priceCurrency: string): number | null {
  if (price == null || !(price > 0)) return null;
  if (targetCurrency.toUpperCase() !== priceCurrency.toUpperCase()) return null;
  return target.avg / price - 1;
}

/** Positions (0–1) on one shared scale of the range, its average and the price. */
export function rangeScale(
  target: TargetRange,
  price: number | undefined,
  sameCurrency: boolean,
): { avg: number; price: number | null } {
  const lo = Math.min(target.min, sameCurrency && price != null ? price : Infinity);
  const hi = Math.max(target.max, sameCurrency && price != null ? price : -Infinity);
  const at = (x: number) => (hi > lo ? (x - lo) / (hi - lo) : 0.5);
  return { avg: at(target.avg), price: sameCurrency && price != null ? at(price) : null };
}

/** The band as changes against today's spot (−0.2 = 20% lower). */
export function bandChanges(b: ImpliedBand): { p10: number; p50: number; p90: number } {
  return { p10: b.p10 / b.spot - 1, p50: b.p50 / b.spot - 1, p90: b.p90 / b.spot - 1 };
}

export const horizonMonths = (days: number) => Math.max(1, Math.round(days / 30.44));

export function viewText(v: AnalystView): string {
  if (v.kind !== "annualReturn") return `${formatNumber(v.value, 0)} ${v.unit}`;
  const pct = `${formatNumber(v.value * 100, 1)}%/év`;
  // A currency as the unit says what the return is in (e.g. USD for a global index).
  return /^[A-Z]{3}$/.test(v.unit) ? `${pct} (${v.unit})` : pct;
}
