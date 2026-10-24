// Household cash flow: monthly income and spending sums imported from an
// 1Money export. Only sums per month and category are stored (a synced pref),
// never single items. Planning reads the averages; nothing here is a forecast.

import { touchPref } from "./prefs";
import { addDaysIso } from "./day";
import type { CashflowImport } from "./parsers/types";

export interface CashflowMonth {
  /** "YYYY-MM". */
  month: string;
  /** Whole forints. */
  income: number;
  expense: number;
  incomeBy: Record<string, number>;
  expenseBy: Record<string, number>;
  /** The last day the export it came from covers: before that day's end the month is partial. */
  through: string;
  /** ISO instant of the import — the newer import of a month wins. */
  importedAt: string;
}

export interface CashflowSettings {
  /** Categories that aren't living costs or earnings (e.g. investing booked as an expense). */
  excluded: string[];
  /** The monthly "upload the new export" to-do (and the bot's message). */
  remind: boolean;
}

const MONTHS_KEY = "pf-cashflow";
const SETTINGS_KEY = "pf-cashflow-settings";

const isMonth = (m: unknown): m is CashflowMonth =>
  !!m &&
  typeof m === "object" &&
  /^\d{4}-\d{2}$/.test((m as CashflowMonth).month) &&
  Number.isFinite((m as CashflowMonth).income) &&
  Number.isFinite((m as CashflowMonth).expense);

const byMonth = (a: CashflowMonth, b: CashflowMonth) => a.month.localeCompare(b.month);

export function loadCashflow(): CashflowMonth[] {
  try {
    const raw = localStorage.getItem(MONTHS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isMonth).sort(byMonth) : [];
  } catch {
    return [];
  }
}

export function saveCashflow(months: CashflowMonth[]) {
  try {
    const json = JSON.stringify([...months].sort(byMonth));
    if (localStorage.getItem(MONTHS_KEY) === json) return;
    localStorage.setItem(MONTHS_KEY, json);
    touchPref("cashflow");
  } catch {
    /* ignore */
  }
}

/** Union by month; of two copies of a month the later import wins. */
export function mergeCashflow(a: unknown, b: unknown): CashflowMonth[] {
  const map = new Map<string, CashflowMonth>();
  for (const m of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!isMonth(m)) continue;
    const prev = map.get(m.month);
    if (!prev || (m.importedAt ?? "") >= (prev.importedAt ?? "")) map.set(m.month, m);
  }
  return [...map.values()].sort(byMonth);
}

export function loadCashflowSettings(): CashflowSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    const list = Array.isArray(v?.excluded) ? v.excluded : [];
    return {
      excluded: list.filter((x: unknown): x is string => typeof x === "string"),
      remind: v?.remind !== false,
    };
  } catch {
    return { excluded: [], remind: true };
  }
}

export function saveCashflowSettings(s: CashflowSettings) {
  try {
    const json = JSON.stringify({ excluded: [...new Set(s.excluded)].sort(), remind: s.remind });
    if (localStorage.getItem(SETTINGS_KEY) === json) return;
    localStorage.setItem(SETTINGS_KEY, json);
    touchPref("cashflowSettings");
  } catch {
    /* ignore */
  }
}

/** What an import would change: months not stored yet / stored differently. */
export function cashflowChanges(
  stored: CashflowMonth[],
  incoming: CashflowMonth[],
): { added: number; updated: number; same: number } {
  const have = new Map(stored.map((m) => [m.month, m]));
  let added = 0;
  let updated = 0;
  let same = 0;
  for (const m of incoming) {
    const s = have.get(m.month);
    if (!s) added++;
    else if (
      s.income !== m.income ||
      s.expense !== m.expense ||
      s.through !== m.through ||
      JSON.stringify(s.incomeBy) !== JSON.stringify(m.incomeBy) ||
      JSON.stringify(s.expenseBy) !== JSON.stringify(m.expenseBy)
    )
      updated++;
    else same++;
  }
  return { added, updated, same };
}

/** Store an import: its months replace the stored ones, the rest stays. */
export function applyCashflowImport(cf: CashflowImport) {
  saveCashflow(mergeCashflow(loadCashflow(), cf.months));
}

/** Last day of "YYYY-MM". */
export function monthEnd(month: string): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDaysIso(next, -1);
}

export function prevMonth(month: string): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** The export reaches past the month's end — nothing more will be added to it. */
/** "2026-08" → "aug. 26" / "2026. augusztus". */
export function monthLabel(month: string, long = false): string {
  const d = new Date(+month.slice(0, 4), +month.slice(5, 7) - 1, 1);
  return new Intl.DateTimeFormat(
    "hu-HU",
    long ? { year: "numeric", month: "long" } : { year: "2-digit", month: "short" },
  ).format(d);
}

export const isComplete =(m: CashflowMonth): boolean => m.through >= monthEnd(m.month);

/** Key of an excluded category: a name can be on both sides ("Egyéb"). */
export const excludeKey = (kind: "income" | "expense", name: string): string => `${kind}:${name}`;

export interface CashflowTotals {
  month: string;
  income: number;
  expense: number;
  /** Income left out of `income` (one-off sales, money back from investing): real money, just not regular. */
  excludedIncome: number;
  saving: number;
  /** saving / income; undefined without income. */
  rate?: number;
  complete: boolean;
}

const sumSide = (
  by: Record<string, number>,
  kind: "income" | "expense",
  excluded: Set<string>,
  want: "kept" | "left",
) =>
  Object.entries(by).reduce(
    (s, [k, v]) => ((excluded.has(excludeKey(kind, k)) ? "left" : "kept") === want ? s + v : s),
    0,
  );

/** Month totals without the excluded categories (each excluded on its own side). */
export function cashflowTotals(
  months: CashflowMonth[],
  settings: Pick<CashflowSettings, "excluded"> = { excluded: [] },
): CashflowTotals[] {
  const ex = new Set(settings.excluded);
  return months.map((m) => {
    const income = sumSide(m.incomeBy, "income", ex, "kept");
    const expense = sumSide(m.expenseBy, "expense", ex, "kept");
    return {
      month: m.month,
      income,
      expense,
      excludedIncome: sumSide(m.incomeBy, "income", ex, "left"),
      saving: income - expense,
      rate: income > 0 ? (income - expense) / income : undefined,
      complete: isComplete(m),
    };
  });
}

export interface CashflowAverage {
  /** Complete months the average covers. */
  months: number;
  income: number;
  expense: number;
  /** Average of the income that is left out (see CashflowTotals). */
  excludedIncome: number;
  saving: number;
  rate?: number;
}

/** Average of the last `n` COMPLETE months (a running month would drag it down). */
export function cashflowAverage(totals: CashflowTotals[], n = 12): CashflowAverage | undefined {
  const used = totals.filter((t) => t.complete).slice(-n);
  if (used.length === 0) return undefined;
  const avg = (f: (t: CashflowTotals) => number) => used.reduce((s, t) => s + f(t), 0) / used.length;
  const income = avg((t) => t.income);
  const expense = avg((t) => t.expense);
  return {
    months: used.length,
    income,
    expense,
    excludedIncome: avg((t) => t.excludedIncome),
    saving: income - expense,
    rate: income > 0 ? (income - expense) / income : undefined,
  };
}

/** Every category in the stored months, biggest spending first. */
export function cashflowCategories(months: CashflowMonth[]): { name: string; kind: "income" | "expense"; total: number }[] {
  const sums = new Map<string, { name: string; kind: "income" | "expense"; total: number }>();
  const add = (by: Record<string, number>, kind: "income" | "expense") => {
    for (const [name, v] of Object.entries(by)) {
      const key = `${kind}:${name}`;
      const cur = sums.get(key) ?? { name, kind, total: 0 };
      cur.total += v;
      sums.set(key, cur);
    }
  };
  for (const m of months) {
    add(m.incomeBy, "income");
    add(m.expenseBy, "expense");
  }
  return [...sums.values()].sort((a, b) => b.total - a.total);
}
