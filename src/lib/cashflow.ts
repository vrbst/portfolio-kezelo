// Household cash flow: monthly income and spending sums imported from an
// 1Money export. Only sums per month and category are stored (a synced pref),
// never single items. Planning reads the averages; nothing here is a forecast.

import { touchPref } from "./prefs";
import { addDaysIso } from "./day";
import type { CashflowImport } from "./parsers/types";
import type { PortfolioSummary } from "./portfolio";

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

/**
 * One income or expense item of the export. Kept ONLY on the device that
 * imported it (see cashflowItems.ts) — never synced: its note can name people.
 */
export interface CashflowItem {
  /** Stable between parses of the same export; another category → another id. */
  id: string;
  /** "YYYY-MM". */
  month: string;
  /** "YYYY-MM-DD". */
  day: string;
  kind: "income" | "expense";
  category: string;
  /** Whole forints. */
  huf: number;
  account: string;
  note: string;
}

/**
 * An item the user took out of the figures. It IS synced (so every device and
 * the bot subtract it) but holds no note, account or date — just what the
 * subtraction needs.
 */
export interface CashflowSkip {
  id: string;
  month: string;
  kind: "income" | "expense";
  category: string;
  huf: number;
}

export interface CashflowSettings {
  /** Categories that aren't living costs or earnings (e.g. investing booked as an expense). */
  excluded: string[];
  /** The monthly "upload the new export" to-do (and the bot's message). */
  remind: boolean;
  /**
   * First month ("YYYY-MM") the averages count, for a new life stage (e.g. the
   * loan is paid off): earlier months stay in the charts but not in the averages.
   */
  since?: string;
  /** Emergency reserve: this many months of spending (1–36); unset = no reserve. */
  reserveMonths?: number;
  /** The accounts whose cash is the reserve, in the order they fill it. */
  reserveAccounts?: string[];
  /**
   * Securities (instrument keys) that are the reserve — e.g. a fixed-rate
   * government bond. Counted first; cash only fills what they leave missing.
   */
  reserveHoldings?: string[];
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

const SKIPS_KEY = "pf-cashflow-skips";

const isSkip = (s: unknown): s is CashflowSkip =>
  !!s &&
  typeof s === "object" &&
  typeof (s as CashflowSkip).id === "string" &&
  /^\d{4}-\d{2}$/.test((s as CashflowSkip).month) &&
  ((s as CashflowSkip).kind === "income" || (s as CashflowSkip).kind === "expense") &&
  typeof (s as CashflowSkip).category === "string" &&
  Number.isFinite((s as CashflowSkip).huf);

export function loadCashflowSkips(): CashflowSkip[] {
  try {
    const raw = localStorage.getItem(SKIPS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isSkip) : [];
  } catch {
    return [];
  }
}

export function saveCashflowSkips(skips: CashflowSkip[]) {
  try {
    const byId = new Map(skips.map((s) => [s.id, s]));
    const json = JSON.stringify([...byId.values()].sort((a, b) => a.month.localeCompare(b.month) || a.id.localeCompare(b.id)));
    if (localStorage.getItem(SKIPS_KEY) === json) return;
    localStorage.setItem(SKIPS_KEY, json);
    touchPref("cashflowSkips");
  } catch {
    /* ignore */
  }
}

/**
 * The months with the skipped items taken out of their category and the month
 * sums. The input is not changed; a category emptied by it disappears.
 */
export function applySkips(months: CashflowMonth[], skips: CashflowSkip[]): CashflowMonth[] {
  if (skips.length === 0) return months;
  const byMonth = new Map<string, CashflowSkip[]>();
  for (const s of skips) byMonth.set(s.month, [...(byMonth.get(s.month) ?? []), s]);
  return months.map((m) => {
    const mine = byMonth.get(m.month);
    if (!mine) return m;
    const incomeBy = { ...m.incomeBy };
    const expenseBy = { ...m.expenseBy };
    for (const s of mine) {
      const by = s.kind === "income" ? incomeBy : expenseBy;
      if (!(s.category in by)) continue;
      const left = Math.max(0, by[s.category] - s.huf);
      // Under a forint is rounding dust of the month sum, not a category.
      if (left >= 1) by[s.category] = left;
      else delete by[s.category];
    }
    const sum = (by: Record<string, number>) => Object.values(by).reduce((a, b) => a + b, 0);
    return { ...m, incomeBy, expenseBy, income: sum(incomeBy), expense: sum(expenseBy) };
  });
}

/**
 * After an import: a skip stays only if its item is still in the new export
 * (a recategorised item has a new id). Skips of months the import doesn't
 * cover are left alone.
 */
export function reconcileSkips(
  skips: CashflowSkip[],
  items: { id: string; month: string }[],
  importedMonths: string[],
): { kept: CashflowSkip[]; dropped: CashflowSkip[] } {
  const ids = new Set(items.map((i) => i.id));
  const covered = new Set(importedMonths);
  const kept: CashflowSkip[] = [];
  const dropped: CashflowSkip[] = [];
  for (const s of skips) (!covered.has(s.month) || ids.has(s.id) ? kept : dropped).push(s);
  return { kept, dropped };
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
      since: validMonth(v?.since),
      reserveMonths: validReserveMonths(v?.reserveMonths),
      reserveAccounts: stringList(v?.reserveAccounts),
      reserveHoldings: stringList(v?.reserveHoldings),
    };
  } catch {
    return { excluded: [], remind: true };
  }
}

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

const validReserveMonths =(n: unknown): number | undefined =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 36 ? n : undefined;

const validMonth = (s: unknown): string | undefined =>
  typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : undefined;

export function saveCashflowSettings(s: CashflowSettings) {
  try {
    const json = JSON.stringify({
      excluded: [...new Set(s.excluded)].sort(),
      remind: s.remind,
      ...(validMonth(s.since) ? { since: s.since } : {}),
      ...(validReserveMonths(s.reserveMonths) ? { reserveMonths: s.reserveMonths } : {}),
      ...(s.reserveAccounts?.length ? { reserveAccounts: [...new Set(s.reserveAccounts)] } : {}),
      ...(s.reserveHoldings?.length ? { reserveHoldings: [...new Set(s.reserveHoldings)] } : {}),
    });
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

/** The months (or their totals) from the start month on — the current life stage. */
export function monthsFrom<T extends { month: string }>(months: T[], since?: string): T[] {
  return since ? months.filter((m) => m.month >= since) : months;
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

/**
 * Average of the last `n` COMPLETE months (a running month would drag it down),
 * none of them before `since` ("YYYY-MM", the start of a new life stage).
 */
export function cashflowAverage(
  totals: CashflowTotals[],
  n = 12,
  since?: string,
): CashflowAverage | undefined {
  const used = totals.filter((t) => t.complete && (!since || t.month >= since)).slice(-n);
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

export interface CashflowSuggestion {
  /** What is left over a month (income − spending), rounded to a thousand HUF. May be ≤ 0. */
  amount: number;
  /** Complete months it is based on. */
  months: number;
  since?: string;
}

/**
 * The monthly saving the 1Money data points to — a suggestion for the Forecast
 * page's "havi megtakarítás", never applied by itself.
 */
export function cashflowSuggestion(
  months: CashflowMonth[],
  settings: Pick<CashflowSettings, "excluded" | "since">,
  n = 12,
): CashflowSuggestion | undefined {
  const avg = cashflowAverage(cashflowTotals(months, settings), n, settings.since);
  if (!avg) return undefined;
  return { amount: Math.round(avg.saving / 1000) * 1000, months: avg.months, since: settings.since };
}

export interface ReserveTarget {
  /** Whole forints: `reserveMonths` × the average monthly spending. */
  target: number;
  monthlyExpense: number;
  /** Complete months the average is based on. */
  months: number;
}

/** The emergency reserve to aim for; undefined when off or without a closed month. */
export function reserveTarget(
  months: CashflowMonth[],
  settings: Pick<CashflowSettings, "excluded" | "since" | "reserveMonths">,
  n = 12,
): ReserveTarget | undefined {
  if (!settings.reserveMonths) return undefined;
  const avg = cashflowAverage(cashflowTotals(months, settings), n, settings.since);
  if (!avg) return undefined;
  return {
    target: Math.round(avg.expense * settings.reserveMonths),
    monthlyExpense: avg.expense,
    months: avg.months,
  };
}

/**
 * How much of the target the chosen accounts hold: cash after what savings
 * goals hold (`goalHeld`), account by account in the given order. An unknown
 * account holds nothing.
 */
export function allocateReserve(
  target: number,
  accountIds: string[],
  cash: Map<string, number>,
  goalHeld: Map<string, number> = new Map(),
): { byAccount: Map<string, number>; held: number } {
  const byAccount = new Map<string, number>();
  let left = target;
  for (const id of accountIds) {
    if (left <= 0) break;
    const free = Math.max(0, (cash.get(id) ?? 0) - (goalHeld.get(id) ?? 0));
    const take = Math.min(free, left);
    if (take <= 0) continue;
    byAccount.set(id, take);
    left -= take;
  }
  return { byAccount, held: target - left };
}

/** The fixed-rate government bond ("Fix Magyar Állampapír" / "FixMÁP"), the usual reserve. */
export const isFixBond = (name: string): boolean => /\bfix\s*m(agyar|[aá]p)/i.test(name);

export interface EmergencyReserve {
  /** Undefined = no reserve set up (or no month to base it on). */
  target?: ReserveTarget;
  /** Cash held on each account, to keep out of the idle-cash alert. */
  byAccount: Map<string, number>;
  /** Market value of the chosen securities (may exceed the target). */
  heldHoldings: number;
  /** Cash taken for what the securities leave missing. */
  heldCash: number;
  held: number;
}

/**
 * The reserve as it stands today: the chosen securities' market value first,
 * then — only for what is still missing — cash on the chosen accounts (after
 * the goals' share).
 */
export function emergencyReserve(
  summary: PortfolioSummary,
  months: CashflowMonth[],
  settings: Pick<CashflowSettings, "excluded" | "since" | "reserveMonths" | "reserveAccounts" | "reserveHoldings">,
  goalHeld?: Map<string, number>,
): EmergencyReserve {
  const target = reserveTarget(months, settings);
  if (!target) return { byAccount: new Map(), heldHoldings: 0, heldCash: 0, held: 0 };
  const chosen = new Set(settings.reserveHoldings ?? []);
  let heldHoldings = 0;
  for (const a of summary.accounts)
    for (const h of a.holdings) if (chosen.has(h.instrumentKey)) heldHoldings += h.marketValueHuf ?? 0;
  const cash = new Map(summary.accounts.map((a) => [a.account.id, a.cashValueHuf]));
  const { byAccount, held: heldCash } = allocateReserve(
    Math.max(0, target.target - heldHoldings),
    settings.reserveAccounts ?? [],
    cash,
    goalHeld,
  );
  return { target, byAccount, heldHoldings, heldCash, held: heldHoldings + heldCash };
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

/** What the AI gets to see of the cash flow: sums only — no category, item or note. */
export interface CashflowAiSummary {
  /** Complete months the averages cover. */
  months: number;
  since?: string;
  /** Monthly averages in whole forints (the regular ones, without the excluded). */
  incomeHuf: number;
  expenseHuf: number;
  savingHuf: number;
  rate?: number;
  /** Saving over income in the last 3 complete months (the trend); undefined with fewer. */
  last3Rate?: number;
  /** Income left out as one-off, monthly average. */
  excludedIncomeHuf: number;
  reserve?: { months: number; targetHuf: number; heldHuf: number };
}

/**
 * The cash flow in a few numbers for the AI context: the 12-month (or
 * since-the-start-month) averages the Pénzáramlás page shows, the trend of the
 * last three months and the emergency reserve. `goalHeld` is the cash savings
 * goals hold (not part of the reserve).
 */
export function cashflowAiSummary(
  rawMonths: CashflowMonth[],
  skips: CashflowSkip[],
  settings: CashflowSettings,
  summary: PortfolioSummary,
  goalHeld?: Map<string, number>,
): CashflowAiSummary | undefined {
  const months = applySkips(rawMonths, skips);
  const totals = cashflowTotals(months, settings);
  const avg = cashflowAverage(totals, 12, settings.since);
  if (!avg) return undefined;
  const last3 = monthsFrom(totals, settings.since).filter((t) => t.complete).slice(-3);
  const income3 = last3.reduce((s, t) => s + t.income, 0);
  const res = settings.reserveMonths ? emergencyReserve(summary, months, settings, goalHeld) : undefined;
  return {
    months: avg.months,
    since: settings.since,
    incomeHuf: avg.income,
    expenseHuf: avg.expense,
    savingHuf: avg.saving,
    rate: avg.rate,
    last3Rate: last3.length === 3 && income3 > 0 ? last3.reduce((s, t) => s + t.saving, 0) / income3 : undefined,
    excludedIncomeHuf: avg.excludedIncome,
    ...(res?.target
      ? { reserve: { months: settings.reserveMonths!, targetHuf: res.target.target, heldHuf: res.held } }
      : {}),
  };
}
