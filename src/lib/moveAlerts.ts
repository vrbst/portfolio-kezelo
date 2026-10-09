export const FX_MOVE_KEY = "EUR/HUF";

export const DEFAULT_MOVE_PCT = 1;

const TRADING_DAYS_PER_MONTH = 21;

export function dailyAbsMoves(series: [string, number][] | undefined, days = 250): number[] {
  if (!series) return [];
  const closes = series.slice(-(days + 1)).map(([, v]) => v);
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++)
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.abs(closes[i] / closes[i - 1] - 1));
  return out;
}

export function moveCrosses(absMove: number, pct: number): boolean {
  return Math.floor((absMove * 100 + 1e-9) / pct) >= 1;
}

export function alertDaysPerMonth(moves: number[], pct: number): number | null {
  if (moves.length === 0) return null;
  const hits = moves.filter((m) => moveCrosses(m, pct)).length;
  return (hits / moves.length) * TRADING_DAYS_PER_MONTH;
}

export function typicalMovePct(moves: number[]): number | null {
  if (moves.length === 0) return null;
  const sorted = [...moves].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return median * 100;
}
