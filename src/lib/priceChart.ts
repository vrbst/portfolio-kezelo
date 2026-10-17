import type { LiveQuote } from "./prices";

const BAR_MS = 5 * 60_000;

export interface ChartRow {
  /** Sequential slot: yesterday's bars, then today's session (padded). */
  i: number;
  t: number;
  prev?: number;
  today?: number;
}

/**
 * The two-session chart's rows (shared by the price dialog and the Telegram
 * image): yesterday's bars, then today's, padded to the end of the session (or
 * to as long as yesterday was) so the time axis shows how far into the day we
 * are. `split` = index of today's first row; `ticks` = round-hour slots, thinned
 * to ~8 labels.
 */
export function buildChartRows(quote: LiveQuote): { rows: ChartRow[]; split: number; ticks: number[] } {
  const rows: ChartRow[] = [];
  const prev = quote.prevDay ?? [];
  const prevT = quote.prevDayT ?? [];
  prev.forEach((c, k) => rows.push({ i: rows.length, t: prevT[k], prev: c }));
  const split = rows.length;
  const today = quote.intraday ?? [];
  const todayT = quote.intradayT ?? [];
  today.forEach((c, k) => rows.push({ i: rows.length, t: todayT[k], today: c }));
  // A borrowed 24/7 curve doesn't follow the listing's session.
  const session = quote.intradayFrom ? undefined : (quote.chartSession ?? quote.session);
  const start = todayT[0];
  const full = session
    ? Math.round((session.end - (start ?? session.start)) / BAR_MS)
    : Math.max(prev.length, 1);
  for (let k = today.length; k < full && start != null; k++)
    rows.push({ i: rows.length, t: start + k * BAR_MS });
  const hourly = rows.filter((r) => r.t && new Date(r.t).getMinutes() === 0);
  const step = Math.max(1, Math.ceil(hourly.length / 8));
  const ticks = hourly.filter((_, k) => k % step === 0).map((r) => r.i);
  return { rows, split, ticks };
}
