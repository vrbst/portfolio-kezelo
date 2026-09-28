// Hungarian working-day calendar: weekends, public holidays (Mt. 102. §,
// Easter-bound ones computed) and the yearly decree's swapped days (a rest
// day moved to a Saturday that becomes a working day). The one definition
// the month boundary (goals.ts effectiveMonth) and the month-end reminder use.

/** Easter Sunday (Gregorian, anonymous algorithm) as [month0, day]. */
export function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month - 1, day];
}

/** Fixed-date public holidays, "MM-DD". */
const FIXED = new Set(["01-01", "03-15", "05-01", "08-20", "10-23", "11-01", "12-25", "12-26"]);

/**
 * Swapped days from the yearly NGM decree: "rest" = a weekday off, "work" =
 * a Saturday worked instead. Add each new year's decree here; a year missing
 * from the table falls back to weekends + public holidays.
 */
export const SWAPPED_DAYS: Record<string, "rest" | "work"> = {
  // 2024
  "2024-08-19": "rest",
  "2024-08-03": "work",
  "2024-12-24": "rest",
  "2024-12-07": "work",
  "2024-12-27": "rest",
  "2024-12-14": "work",
  // 2025
  "2025-05-02": "rest",
  "2025-05-17": "work",
  "2025-10-24": "rest",
  "2025-10-18": "work",
  "2025-12-24": "rest",
  "2025-12-13": "work",
  // 2026
  "2026-01-02": "rest",
  "2026-01-10": "work",
  "2026-08-21": "rest",
  "2026-08-08": "work",
  "2026-12-24": "rest",
  "2026-12-12": "work",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;

/** Public holiday (Easter-bound ones included), regardless of the weekday. */
export function isPublicHoliday(year: number, month0: number, day: number): boolean {
  if (FIXED.has(`${pad(month0 + 1)}-${pad(day)}`)) return true;
  const [em, ed] = easterSunday(year);
  const easter = Date.UTC(year, em, ed);
  const diff = Math.round((Date.UTC(year, month0, day) - easter) / 86_400_000);
  // Nagypéntek, húsvéthétfő, pünkösdhétfő.
  return diff === -2 || diff === 1 || diff === 50;
}

/** A working day in Hungary (local calendar day of `d`). */
export function isWorkday(d: Date): boolean {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const swap = SWAPPED_DAYS[ymd(y, m, day)];
  if (swap) return swap === "work";
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !isPublicHoliday(y, m, day);
}

/** Day-of-month of the month's last working day. */
export function lastWorkdayOfMonth(year: number, month0: number): number {
  let day = new Date(year, month0 + 1, 0).getDate();
  while (day > 1 && !isWorkday(new Date(year, month0, day, 12))) day--;
  return day;
}

/** `d` is its month's last working day. */
export function isLastWorkdayOfMonth(d: Date): boolean {
  return d.getDate() === lastWorkdayOfMonth(d.getFullYear(), d.getMonth());
}
