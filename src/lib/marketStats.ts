import { addDaysIso } from "./day";
import { dailyAbsMoves, typicalMovePct } from "./moveAlerts";

export interface MarketStats {
  low: number;
  high: number;
  last: number;
  fromHigh: number;
  rangePos: number;
  typicalMovePct: number | null;
  sinceDay: string;
}

export function marketStats(
  series: [string, number][] | undefined,
  today: string,
  latest?: number,
): MarketStats | null {
  const since = addDaysIso(today, -365);
  const year: [string, number][] = (series ?? []).filter(([d, v]) => d >= since && d <= today && v > 0);
  if (latest != null && latest > 0) {
    if (year.length && year[year.length - 1][0] === today) year[year.length - 1] = [today, latest];
    else year.push([today, latest]);
  }
  if (year.length < 2) return null;
  const values = year.map(([, v]) => v);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const last = values[values.length - 1];
  return {
    low,
    high,
    last,
    fromHigh: last / high - 1,
    rangePos: high > low ? (last - low) / (high - low) : 1,
    typicalMovePct: typicalMovePct(dailyAbsMoves(year, year.length)),
    sinceDay: year[0][0],
  };
}
