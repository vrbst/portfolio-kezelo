import type { Transaction } from "./model";
import type { PortfolioSummary } from "./portfolio";
import { isInternalTransfer, toHuf, couponAmountHuf } from "./portfolio";

// ---------------------------------------------------------------------------
// Forecast engine — a transparent, deterministic projection of net worth.
//
// Three legs, simulated month by month:
//   • growth pot  — ETF/equity/fund + cash-in-securities, compounded at an
//     assumed annual return (three scenarios). Recurring monthly savings land
//     here (DCA into growth assets).
//   • bond leg    — the CURRENT bond holdings, kept at their present accreted
//     value ("carry") until they pay. Coupons are booked as income when paid;
//     at maturity the bond's carry is removed and its FACE value is credited to
//     the target pot. face − carry is exactly the remaining accretion yield
//     (this is how a discount T-bill's discount→par gain is realised), so bond
//     yield is captured without guessing a rate.
//   • cash pot    — proceeds when "reinvest" is OFF; otherwise proceeds flow
//     into the growth pot and compound too ("bent hagyom és VWCE-be teszem").
//
// Planned, dated expenses are subtracted when they fall due (cash first, then
// growth). The bond schedule and expenses are identical across scenarios; only
// the growth rate differs, so we carry three growth/cash pots in one pass.
//
// This is a projection, not a promise: bonds sit flat between now and maturity
// (the accretion is realised in one step at maturity), and returns are an
// assumption. The starting point and the post-maturity totals are exact.
// ---------------------------------------------------------------------------

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

// Local date helpers (day-granular, local midnight) — mirror portfolio.ts so a
// UTC offset never slips a coupon/maturity across a month boundary.
function parseDayMs(s: string | undefined): number {
  if (!s) return NaN;
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? NaN : d.getTime();
}
function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}
function toLocalDay(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Recurring-savings detection
// ---------------------------------------------------------------------------

export interface MonthlyInflow {
  /** YYYY-MM. */
  month: string;
  huf: number;
}

export interface RecurringSavings {
  /** Detected typical monthly saving (HUF) — median of the "normal" months. */
  monthlyHuf: number;
  /** How many months fed the median (one-offs excluded). */
  monthsUsed: number;
  /** Every past net external inflow by month (ascending). */
  months: MonthlyInflow[];
  /** Months flagged as one-off lump sums (excluded from the median). */
  oneOffs: MonthlyInflow[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Infer the recurring monthly saving from history. Net external inflow is
 * bucketed by calendar month; genuinely large one-off deposits (e.g. a 25M
 * lump sum in March) are detected as outliers via the median + MAD and excluded
 * so they don't get treated as a monthly habit. The recurring figure is the
 * median of the remaining contribution months. The current (partial) month is
 * shown but never used for the baseline.
 */
export function detectRecurringSavings(
  txs: Transaction[],
  fx: Record<string, number>,
  now: Date = new Date(),
): RecurringSavings {
  const byMonth = new Map<string, number>();
  for (const t of txs) {
    if (t.internal || isInternalTransfer(t)) continue;
    if (t.type !== "deposit" && t.type !== "withdrawal") continue;
    const huf = toHuf(
      Math.abs(t.netAmount ?? t.grossAmount ?? 0),
      t.currency,
      fx,
    );
    const key = t.date.slice(0, 7);
    const signed = t.type === "deposit" ? huf : -huf;
    byMonth.set(key, (byMonth.get(key) ?? 0) + signed);
  }

  const months: MonthlyInflow[] = [...byMonth.entries()]
    .map(([month, huf]) => ({ month, huf }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const curKey = monthKey(now.getTime());
  // Only completed months with a positive net contribution count as evidence.
  const contrib = months.filter((m) => m.month < curKey && m.huf > 0);
  const values = contrib.map((m) => m.huf);

  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  // A month is a one-off if it towers over the typical amount: beyond 3 scaled
  // MADs, but at least 3× the median (guards the mad≈0 case of steady sums).
  const upper = med + Math.max(3 * 1.4826 * mad, 2 * med);

  const kept = contrib.filter((m) => m.huf <= upper);
  const oneOffs = contrib.filter((m) => m.huf > upper);

  return {
    monthlyHuf: Math.round(median(kept.map((m) => m.huf))),
    monthsUsed: kept.length,
    months,
    oneOffs,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type ScenarioKey = "pess" | "real" | "opt";
export const SCENARIOS: ScenarioKey[] = ["pess", "real", "opt"];

export interface PlannedExpense {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  amountHuf: number;
  note?: string;
}

/**
 * Where bond coupons + matured principal flow:
 *  • growth — into the growth assets (e.g. VWCE), compounding at the scenario
 *    return. This is the "bent hagyom és VWCE-be teszem" case.
 *  • bond   — rolled into new bonds at a fixed assumed rate.
 *  • cash   — kept as idle cash (no yield), available for planned expenses.
 */
export type ReinvestTarget = "growth" | "bond" | "cash";

export interface ForecastAssumptions {
  /** Annual expected return for growth assets per scenario (fraction, e.g. 0.06). */
  annualReturn: Record<ScenarioKey, number>;
  /** Recurring monthly saving added to growth assets (HUF). */
  monthlySavingHuf: number;
  /** Where bond coupons + matured principal are reinvested. */
  reinvestTarget: ReinvestTarget;
  /** Annual rate for the "bond" reinvest target (fraction). */
  reinvestBondRate: number;
  /** Horizon length in months. */
  months: number;
}

export interface ForecastPoint {
  /** YYYY-MM. */
  month: string;
  ts: number;
  pess: number;
  real: number;
  opt: number;
  /** Cumulative net external capital (savings in, expenses out) — baseline. */
  contributed: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  /** Value now (t0), all scenarios equal. */
  startValueHuf: number;
  /** Sum of bond coupons within the horizon (HUF). */
  couponHuf: number;
  /** Sum of bond maturities (face) within the horizon (HUF). */
  maturityHuf: number;
  /** Sum of planned expenses within the horizon (HUF). */
  expenseHuf: number;
}

interface BondLeg {
  carry0: number;
  maturityMs: number;
  face: number;
  coupons: { ms: number; huf: number }[];
}

/** Current bond holdings as carry + future coupon/maturity schedule. */
function bondLegs(summary: PortfolioSummary, nowMs: number): BondLeg[] {
  const legs: BondLeg[] = [];
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const inst = h.instrument;
      if (!inst || !BOND_TYPES.has(inst.type)) continue;
      const face = h.quantity;
      const bond = inst.bond;
      const matMs = parseDayMs(bond?.maturity ?? inst.maturity);

      const coupons: { ms: number; huf: number }[] = [];
      const first = parseDayMs(bond?.firstCouponDate);
      if (Number.isFinite(first) && bond?.couponRate) {
        const interval =
          bond.couponIntervalMonths && bond.couponIntervalMonths > 0
            ? bond.couponIntervalMonths
            : 12;
        let cur = first;
        for (let i = 0; i < 600 && Number.isFinite(cur); i++) {
          if (Number.isFinite(matMs) && cur > matMs) break;
          if (cur > nowMs) {
            const huf = couponAmountHuf(bond, face, toLocalDay(cur));
            if (huf && huf > 0) coupons.push({ ms: cur, huf });
          }
          cur = addMonths(cur, interval);
        }
      }

      legs.push({
        carry0: h.marketValueHuf ?? 0,
        maturityMs: matMs,
        face,
        coupons,
      });
    }
  }
  return legs;
}

const monthlyRate = (annual: number) => Math.pow(1 + annual, 1 / 12) - 1;

/** Shared prep for both projection engines: pots + event buckets by month. */
interface ProjectionPrep {
  startOfMonth: number;
  bondValue0: number;
  startValue: number;
  growth0: number;
  couponByMonth: Map<string, number>;
  maturityByMonth: Map<string, { face: number; carry: number }[]>;
  expenseByMonth: Map<string, number>;
  couponHuf: number;
  maturityHuf: number;
  expenseHuf: number;
}

function prepareProjection(
  summary: PortfolioSummary,
  months: number,
  expenses: PlannedExpense[],
  now: Date,
): ProjectionPrep {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const nowDayMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  const legs = bondLegs(summary, nowDayMs);
  const bondValue0 = legs.reduce((s, l) => s + l.carry0, 0);
  const startValue = summary.totalValueHuf;
  const growth0 = startValue - bondValue0; // everything that compounds at r

  // Bucket coupons, maturities and expenses by month key.
  const couponByMonth = new Map<string, number>();
  const maturityByMonth = new Map<string, { face: number; carry: number }[]>();
  let couponHuf = 0;
  let maturityHuf = 0;
  const horizonMs = addMonths(startOfMonth, months + 1);
  for (const leg of legs) {
    for (const c of leg.coupons) {
      if (c.ms >= horizonMs) continue;
      const k = monthKey(c.ms);
      couponByMonth.set(k, (couponByMonth.get(k) ?? 0) + c.huf);
      couponHuf += c.huf;
    }
    if (Number.isFinite(leg.maturityMs) && leg.maturityMs > nowDayMs) {
      const k = monthKey(leg.maturityMs);
      const arr = maturityByMonth.get(k) ?? [];
      arr.push({ face: leg.face, carry: leg.carry0 });
      maturityByMonth.set(k, arr);
      if (leg.maturityMs < horizonMs) maturityHuf += leg.face;
    }
  }

  const expenseByMonth = new Map<string, number>();
  let expenseHuf = 0;
  for (const e of expenses) {
    const ms = parseDayMs(e.date);
    // Already-past expenses (earlier this month) are in the balance already.
    if (!Number.isFinite(ms) || ms < nowDayMs || ms >= horizonMs) continue;
    const k = monthKey(ms);
    expenseByMonth.set(k, (expenseByMonth.get(k) ?? 0) + e.amountHuf);
    expenseHuf += e.amountHuf;
  }

  return {
    startOfMonth,
    bondValue0,
    startValue,
    growth0,
    couponByMonth,
    maturityByMonth,
    expenseByMonth,
    couponHuf,
    maturityHuf,
    expenseHuf,
  };
}

/**
 * Run the month-by-month projection. Returns one series with all three
 * scenarios plus the contributed-capital baseline.
 */
export function projectForecast(
  summary: PortfolioSummary,
  assumptions: ForecastAssumptions,
  expenses: PlannedExpense[],
  now: Date = new Date(),
): ForecastResult {
  const {
    startOfMonth,
    bondValue0,
    startValue,
    growth0,
    couponByMonth,
    maturityByMonth,
    expenseByMonth,
    couponHuf,
    maturityHuf,
    expenseHuf,
  } = prepareProjection(summary, assumptions.months, expenses, now);

  // Per-scenario pots: `growth` compounds at the scenario return; `side` holds
  // reinvested bond proceeds routed away from growth (bonds → fixed rate, cash →
  // idle). Bond carry not yet matured is scenario-independent.
  const growth: Record<ScenarioKey, number> = {
    pess: growth0,
    real: growth0,
    opt: growth0,
  };
  const side: Record<ScenarioKey, number> = { pess: 0, real: 0, opt: 0 };
  let bondRemaining = bondValue0;
  const rMonthly: Record<ScenarioKey, number> = {
    pess: monthlyRate(assumptions.annualReturn.pess),
    real: monthlyRate(assumptions.annualReturn.real),
    opt: monthlyRate(assumptions.annualReturn.opt),
  };
  const toGrowth = assumptions.reinvestTarget === "growth";
  const sideMonthly =
    assumptions.reinvestTarget === "bond"
      ? monthlyRate(assumptions.reinvestBondRate)
      : 0; // "cash" sits idle

  const points: ForecastPoint[] = [];
  let contributed = summary.netDepositedHuf;

  for (let i = 0; i <= assumptions.months; i++) {
    const ms = addMonths(startOfMonth, i);
    const key = monthKey(ms);

    if (i > 0) {
      // 1) compound one month
      for (const s of SCENARIOS) {
        growth[s] *= 1 + rMonthly[s];
        side[s] *= 1 + sideMonthly;
      }
      // 2) recurring savings → growth
      for (const s of SCENARIOS) growth[s] += assumptions.monthlySavingHuf;
      contributed += assumptions.monthlySavingHuf;
    }

    // Events run at i=0 too: the buckets hold only future-dated items, so a
    // coupon/maturity/expense still due this month lands in the first point.
    // 3) bond coupons (income) → growth or side pot
    const coup = couponByMonth.get(key) ?? 0;
    if (coup) {
      for (const s of SCENARIOS) {
        if (toGrowth) growth[s] += coup;
        else side[s] += coup;
      }
    }
    // 4) maturities: release carry, credit face → growth or side pot
    const mats = maturityByMonth.get(key);
    if (mats) {
      for (const m of mats) {
        bondRemaining -= m.carry;
        for (const s of SCENARIOS) {
          if (toGrowth) growth[s] += m.face;
          else side[s] += m.face;
        }
      }
    }
    // 5) planned expenses (side pot first, then growth)
    const exp = expenseByMonth.get(key) ?? 0;
    if (exp) {
      for (const s of SCENARIOS) {
        const fromSide = Math.min(side[s], exp);
        side[s] -= fromSide;
        growth[s] -= exp - fromSide;
      }
      contributed -= exp;
    }

    points.push({
      month: key,
      ts: ms,
      pess: growth.pess + side.pess + bondRemaining,
      real: growth.real + side.real + bondRemaining,
      opt: growth.opt + side.opt + bondRemaining,
      contributed,
    });
  }

  return {
    points,
    startValueHuf: startValue,
    couponHuf,
    maturityHuf,
    expenseHuf,
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo engine — same cashflow model, random monthly growth returns
// ---------------------------------------------------------------------------

export interface MonteCarloOptions {
  /** Annual volatility (σ) of the growth assets, fraction (e.g. 0.15). */
  sigma: number;
  runs?: number;
  seed?: number;
}

/** Deterministic PRNG so re-renders show the same fan (seed → same paths). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monte Carlo projection: the growth pot gets lognormal monthly returns with
 * the "reális" scenario as the expected compound return and `sigma` annual
 * volatility; bonds/coupons/expenses follow the same deterministic cashflow
 * model as projectForecast. The returned pess/real/opt are the per-month
 * 10th / 50th / 90th percentiles across the simulated paths, so the result
 * plugs straight into the existing chart and milestones table.
 */
export function projectMonteCarlo(
  summary: PortfolioSummary,
  assumptions: ForecastAssumptions,
  expenses: PlannedExpense[],
  opts: MonteCarloOptions,
  now: Date = new Date(),
): ForecastResult {
  const prep = prepareProjection(summary, assumptions.months, expenses, now);
  const months = assumptions.months;
  const runs = Math.max(50, opts.runs ?? 500);
  const rand = mulberry32(opts.seed ?? 1337);

  // Lognormal monthly steps: exp(μ + σₘ·z), with μ set so the EXPECTED
  // compound growth equals the "reális" annual return.
  const sigmaM = Math.max(0, opts.sigma) / Math.sqrt(12);
  const muM = Math.log(1 + assumptions.annualReturn.real) / 12;
  const drawNormal = (() => {
    let spare: number | null = null;
    return () => {
      if (spare != null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u = 0;
      do {
        u = rand();
      } while (u <= 1e-12);
      const r = Math.sqrt(-2 * Math.log(u));
      const theta = 2 * Math.PI * rand();
      spare = r * Math.sin(theta);
      return r * Math.cos(theta);
    };
  })();

  const toGrowth = assumptions.reinvestTarget === "growth";
  const sideMonthly =
    assumptions.reinvestTarget === "bond"
      ? monthlyRate(assumptions.reinvestBondRate)
      : 0;

  // totals[i] = the simulated total across runs for month i.
  const totals: Float64Array[] = Array.from(
    { length: months + 1 },
    () => new Float64Array(runs),
  );
  const contributedArr = new Array<number>(months + 1);

  for (let run = 0; run < runs; run++) {
    let growth = prep.growth0;
    let side = 0;
    let bondRemaining = prep.bondValue0;
    let contributed = summary.netDepositedHuf;
    for (let i = 0; i <= months; i++) {
      const key = monthKey(addMonths(prep.startOfMonth, i));
      if (i > 0) {
        growth *= Math.exp(muM - (sigmaM * sigmaM) / 2 + sigmaM * drawNormal());
        side *= 1 + sideMonthly;
        growth += assumptions.monthlySavingHuf;
        contributed += assumptions.monthlySavingHuf;
      }
      const coup = prep.couponByMonth.get(key) ?? 0;
      if (coup) {
        if (toGrowth) growth += coup;
        else side += coup;
      }
      const mats = prep.maturityByMonth.get(key);
      if (mats) {
        for (const m of mats) {
          bondRemaining -= m.carry;
          if (toGrowth) growth += m.face;
          else side += m.face;
        }
      }
      const exp = prep.expenseByMonth.get(key) ?? 0;
      if (exp) {
        const fromSide = Math.min(side, exp);
        side -= fromSide;
        growth -= exp - fromSide;
        contributed -= exp;
      }
      totals[i][run] = growth + side + bondRemaining;
      if (run === 0) contributedArr[i] = contributed;
    }
  }

  const points: ForecastPoint[] = [];
  for (let i = 0; i <= months; i++) {
    const sorted = Float64Array.from(totals[i]).sort();
    const q = (p: number) =>
      sorted[Math.min(runs - 1, Math.max(0, Math.round(p * (runs - 1))))];
    const ms = addMonths(prep.startOfMonth, i);
    points.push({
      month: monthKey(ms),
      ts: ms,
      pess: q(0.1),
      real: q(0.5),
      opt: q(0.9),
      contributed: contributedArr[i],
    });
  }

  return {
    points,
    startValueHuf: prep.startValue,
    couponHuf: prep.couponHuf,
    maturityHuf: prep.maturityHuf,
    expenseHuf: prep.expenseHuf,
  };
}

/**
 * Convert a nominal projection to "today's forint": every month-i value is
 * divided by (1+inflation)^(i/12). The contributed baseline is deflated the
 * same way so the comparison stays apples-to-apples.
 */
export function deflateResult(
  result: ForecastResult,
  annualInflation: number,
): ForecastResult {
  if (!annualInflation) return result;
  const points = result.points.map((p, i) => {
    const f = Math.pow(1 + annualInflation, i / 12);
    return {
      ...p,
      pess: p.pess / f,
      real: p.real / f,
      opt: p.opt / f,
      contributed: p.contributed / f,
    };
  });
  return { ...result, points };
}

// ---------------------------------------------------------------------------
// Milestones (a few landmark years for the table)
// ---------------------------------------------------------------------------

export interface Milestone {
  /** Whole years from now. */
  years: number;
  point: ForecastPoint;
}

export function forecastMilestones(result: ForecastResult): Milestone[] {
  const out: Milestone[] = [];
  for (const years of [1, 3, 5, 10, 15, 20, 30]) {
    const idx = years * 12;
    if (idx < result.points.length)
      out.push({ years, point: result.points[idx] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence (per-device, localStorage) — planning inputs, never synced.
// ---------------------------------------------------------------------------

const STORE_KEY = "pf-forecast";

export type ForecastEngine = "det" | "mc";

export interface ForecastSettings {
  /** null → use the auto-detected recurring saving. */
  monthlySavingOverride: number | null;
  annualReturn: Record<ScenarioKey, number>;
  /** Where bond coupons + matured principal are reinvested. */
  reinvestTarget: ReinvestTarget;
  /** Annual rate for the "bond" reinvest target (fraction). */
  reinvestBondRate: number;
  months: number;
  expenses: PlannedExpense[];
  /** det = 3 fixed scenarios; mc = Monte Carlo percentile fan. */
  engine: ForecastEngine;
  /** Annual volatility for the Monte Carlo engine (fraction). */
  mcSigma: number;
  /** Annual inflation used by the real-value view (fraction). */
  inflationPct: number;
  /** Show values deflated to today's forint. */
  realMode: boolean;
}

export const DEFAULT_SETTINGS: ForecastSettings = {
  monthlySavingOverride: null,
  annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 },
  reinvestTarget: "growth",
  reinvestBondRate: 0.06,
  months: 120,
  expenses: [],
  engine: "det",
  mcSigma: 0.15,
  inflationPct: 0.035,
  realMode: false,
};

export function loadForecastSettings(): ForecastSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ForecastSettings> & {
      reinvestBonds?: boolean; // legacy boolean → target
    };
    const reinvestTarget: ReinvestTarget =
      parsed.reinvestTarget ??
      (parsed.reinvestBonds === false ? "cash" : "growth");
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      reinvestTarget,
      annualReturn: {
        ...DEFAULT_SETTINGS.annualReturn,
        ...(parsed.annualReturn ?? {}),
      },
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveForecastSettings(s: ForecastSettings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
