/** Deterministic 32-bit hash -> short base36 string (for stable ids). */
export function hashId(...parts: (string | number | undefined)[]): string {
  const str = parts.map((p) => (p == null ? "" : String(p))).join("|");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Mix to a positive base36 string.
  return (h >>> 0).toString(36);
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "2026.04.23." (YYYY.MM.DD.) -> ISO date string (midnight local). */
export function parseHuDate(s: string): string {
  const m = String(s)
    .trim()
    .match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  const [, y, mo, da] = m;
  return new Date(Number(y), Number(mo) - 1, Number(da)).toISOString();
}

const isoDay = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Derive a maturity date from a Hungarian security name. Returns a plain
 * local calendar date (YYYY-MM-DD) — a toISOString here would shift the day
 * back in UTC and every string-prefix consumer (calendar, events) with it.
 * (Not a hashId input, so the format is free to be the correct one.)
 *  - "Diszkont Kincstárjegy D260527" -> 2026-05-27
 *  - "Fix Magyar Állampapír 2031/Q1" -> 2031-03-31 (end of quarter, approx)
 */
export function maturityFromName(name: string): string | undefined {
  const disc = name.match(/D(\d{2})(\d{2})(\d{2})/);
  if (disc) {
    const [, yy, mm, dd] = disc;
    return isoDay(2000 + Number(yy), Number(mm), Number(dd));
  }
  const fix = name.match(/(\d{4})\/Q([1-4])/);
  if (fix) {
    const [, yyyy, q] = fix;
    const endMonth = Number(q) * 3; // Q1->3, Q4->12
    const d = new Date(Number(yyyy), endMonth, 0); // day 0 = last day of prev month
    return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return undefined;
}

/** "29/05/2026 06:22:24" (DD/MM/YYYY HH:mm:ss) -> ISO string. */
export function parseDmyDateTime(s: string): string {
  const m = s
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
  const d = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  );
  return d.toISOString();
}
