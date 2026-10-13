import { toLocalDay } from "../../../src/lib/day";
import type { ImpliedBand } from "../../../src/lib/outlook";

export const HORIZONS_DAYS = [90, 180, 365];
const YEAR_MS = 365 * 86_400_000;
const DAY_MS = 86_400_000;
const Z90 = 1.2815515655446004;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x >= 0 ? erf : -erf));
}

export interface Expiry {
  expiryMs: number;
}

/** The expiry closest to `horizonDays` from now (only future ones). */
export function pickExpiry<T extends Expiry>(expiries: T[], nowMs: number, horizonDays: number): T | null {
  let best: T | null = null;
  let bestGap = Infinity;
  for (const e of expiries) {
    if (e.expiryMs <= nowMs + DAY_MS) continue;
    const gap = Math.abs((e.expiryMs - nowMs) / DAY_MS - horizonDays);
    if (gap < bestGap) {
      best = e;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The 10/50/90 % band the options market implies, from one expiry's forward and
 * at-the-money implied volatility (annualised, as a fraction): the price at
 * expiry is taken lognormal with the forward as its mean.
 */
export function impliedBand(args: {
  underlying: string;
  spot: number;
  forward: number;
  iv: number;
  expiryMs: number;
  nowMs: number;
}): ImpliedBand | null {
  const { underlying, spot, forward, iv, expiryMs, nowMs } = args;
  const T = (expiryMs - nowMs) / YEAR_MS;
  if (!(spot > 0) || !(forward > 0) || !(iv > 0) || !(T > 0)) return null;
  const sd = iv * Math.sqrt(T);
  const mu = Math.log(forward) - (sd * sd) / 2;
  const probUp = 1 - normCdf((Math.log(spot) - mu) / sd);
  return {
    underlying,
    horizonDays: Math.round(T * 365),
    expiry: toLocalDay(expiryMs),
    spot,
    forward,
    p10: Math.exp(mu - Z90 * sd),
    p50: Math.exp(mu),
    p90: Math.exp(mu + Z90 * sd),
    probUp,
    asOf: toLocalDay(nowMs),
  };
}
