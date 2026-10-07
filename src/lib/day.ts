// ---------------------------------------------------------------------------
// Calendar-day helpers. The app runs in Budapest (UTC+1/+2), and dates are
// stored either as bare local days ("2026-10-28") or as the ISO instant of
// LOCAL midnight ("2026-10-27T23:00:00.000Z"). `toISOString().slice(0, 10)`
// on such an instant gives the UTC day — the day before — which is the bug
// behind several past fixes (maturities, deposits, filters one day early).
// ESLint bans that pattern outside this file: pick the helper that says which
// day you mean.
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The LOCAL calendar day of an instant, as "YYYY-MM-DD". */
export function toLocalDay(t: number | Date = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today's local calendar day, as "YYYY-MM-DD". */
export const todayLocal = (): string => toLocalDay(Date.now());

/**
 * The UTC calendar day of an instant. Only for values that are UTC by
 * construction: UTC-midnight arithmetic on day strings, or exchange bar
 * timestamps that are always well inside the trading day.
 */
export function utcDay(t: number | Date): string {
  return new Date(t).toISOString().slice(0, 10); // eslint-disable-line no-restricted-syntax
}

/**
 * The local calendar day of a stored date: a transaction's ISO instant
 * ("2026-08-31T22:00:00.000Z" = 1 Sep, local midnight) or a bare day
 * ("2026-09-01", returned as is). Slicing the instant would give the UTC day.
 */
export function txDay(s: string): string {
  if (!s.includes("T")) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : toLocalDay(d);
}

/** "YYYY-MM-DD" + `n` calendar days, independent of the time zone and DST. */
export function addDaysIso(day: string, n: number): string {
  const ms = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
  return utcDay(ms + n * 86_400_000);
}

export function localDayMs(s: string | undefined): number {
  if (!s) return NaN;
  const m = txDay(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? NaN
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
