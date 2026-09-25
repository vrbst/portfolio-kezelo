import type { Transaction } from "./model";
import type { PortfolioSummary } from "./portfolio";
import { isInternalTransfer, toHuf, couponAmountHuf } from "./portfolio";
import { touchPref } from "./prefs";

// ---------------------------------------------------------------------------
// Forecast engine — a transparent, deterministic projection of net worth.
//
// Three legs, simulated month by month:
//   • growth pot  — ETF/equity/fund + cash-in-securities, compounded at an
//     assumed annual return (three scenarios). Recurring monthly savings land
//     here (DCA into growth assets), optionally raised every year.
//   • bond leg    — the CURRENT bond holdings. Each bond's value moves linearly
//     from its present value ("carry") to its FACE value at maturity, so the
//     remaining accretion yield (e.g. a discount T-bill's discount→par gain)
//     is earned smoothly instead of in one step. Coupons are booked as income
//     when paid; at maturity the face value is credited to the target pot.
//   • side pot    — proceeds when they are not routed into growth: rolled into
//     new bonds at a fixed rate, or kept as idle cash.
//
// Planned, dated expenses and an optional recurring withdrawal phase are
// subtracted when they fall due (side pot first, then growth). When that
// liquid part goes below zero the plan is not coverable without selling bonds
// early — reported as a shortfall.
//
// The bond schedule and expenses are identical across scenarios; only the
// growth return differs. This is a projection, not a promise.
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
/** Whole calendar months from `fromMs`'s month to the YYYY-MM(-DD) `key`. */
export function monthsUntil(key: string, from: Date = new Date()): number {
  const m = key.match(/^(\d{4})-(\d{2})/);
  if (!m) return NaN;
  return (+m[1] - from.getFullYear()) * 12 + (+m[2] - 1 - from.getMonth());
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
  /** Detected typical monthly saving (HUF) — mean of the recent window. */
  monthlyHuf: number;
  /** How many completed months fed the mean (one-offs excluded). */
  monthsUsed: number;
  /** Every past net external inflow by month (ascending). */
  months: MonthlyInflow[];
  /** Months flagged as one-off lump sums (excluded from the mean). */
  oneOffs: MonthlyInflow[];
}

/** How many recent completed months the recurring saving is averaged over. */
const SAVING_WINDOW = 12;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Infer the recurring monthly saving from history. Net external inflow is
 * bucketed by calendar month. Genuinely large one-off movements (e.g. a 25M
 * lump sum, or a big withdrawal for a purchase) are detected as outliers via
 * the median + MAD of the contribution months and left out.
 *
 * The recurring figure is the MEAN of the last {@link SAVING_WINDOW} completed
 * months — months without any deposit count as 0 — so a habit of paying in
 * every other month reads as half the amount, not the full one, and old
 * history doesn't outweigh the current habit. The current (partial) month is
 * never used.
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
  const done = months.filter((m) => m.month < curKey);

  // Outlier threshold from the positive contribution months (whole history).
  const values = done.filter((m) => m.huf > 0).map((m) => m.huf);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  // A month is a one-off if it towers over the typical amount: beyond 3 scaled
  // MADs, but at least 3× the median (guards the mad≈0 case of steady sums).
  const upper = med + Math.max(3 * 1.4826 * mad, 2 * med);
  const isOneOff = (huf: number) => Math.abs(huf) > upper;

  // The window: the last N completed calendar months, but not before the
  // first ever deposit month (a new user isn't diluted with empty months).
  const firstKey = done[0]?.month;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const window: string[] = [];
  if (firstKey) {
    for (let i = 1; i <= SAVING_WINDOW; i++) {
      const k = monthKey(addMonths(startOfMonth, -i));
      if (k < firstKey) break;
      window.push(k);
    }
  }

  const oneOffs = done.filter((m) => isOneOff(m.huf));
  const kept = window
    .map((k) => byMonth.get(k) ?? 0)
    .filter((huf) => !isOneOff(huf));
  const mean = kept.length ? kept.reduce((s, v) => s + v, 0) / kept.length : 0;

  return {
    monthlyHuf: Math.max(0, Math.round(mean)),
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

/** A recurring monthly withdrawal from a start month on (e.g. retirement). */
export interface WithdrawalPlan {
  enabled: boolean;
  /** YYYY-MM — first month of the withdrawal. */
  start: string;
  /** Monthly amount in today's forint at the start. */
  monthlyHuf: number;
}

export interface ForecastAssumptions {
  /** Annual expected return for growth assets per scenario (fraction, e.g. 0.06). */
  annualReturn: Record<ScenarioKey, number>;
  /** Recurring monthly saving added to growth assets (HUF). */
  monthlySavingHuf: number;
  /** Yearly raise of the monthly saving (fraction), applied every 12 months. */
  savingGrowth?: number;
  /** Where bond coupons + matured principal are reinvested. */
  reinvestTarget: ReinvestTarget;
  /** Annual rate for the "bond" reinvest target (fraction). */
  reinvestBondRate: number;
  /** Horizon length in months. */
  months: number;
  /** Optional withdrawal phase — savings stop when it starts. */
  withdrawal?: WithdrawalPlan;
  /** Yearly indexation of the withdrawal (fraction, usually inflation). */
  withdrawalIndex?: number;
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

export type ForecastEventKind = "maturity" | "expense" | "goal" | "withdrawal";

/** Chart marker colour / legend label per event kind. */
export const EVENT_COLORS: Record<ForecastEventKind, string> = {
  maturity: "#22c55e",
  expense: "#f59e0b",
  goal: "#ec4899",
  withdrawal: "#ef4444",
};

export const EVENT_LABELS: Record<ForecastEventKind, string> = {
  maturity: "Kötvénylejárat",
  expense: "Kiadás",
  goal: "Cél",
  withdrawal: "Kivét indul",
};

/** A notable dated item on the horizon, for chart markers. */
export interface ForecastEvent {
  /** YYYY-MM. */
  month: string;
  kind: ForecastEventKind;
  label: string;
  huf: number;
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
  /** Sum of recurring withdrawals within the horizon (HUF). */
  withdrawalHuf: number;
  /** Maturities, expenses and the withdrawal start, ascending. */
  events: ForecastEvent[];
  /**
   * First month (YYYY-MM) the liquid part (growth + side pot) goes negative,
   * per scenario — i.e. the plan needs bonds sold early or can't be covered.
   * Monte Carlo: the month by which 10 / 50 / 90 % of the paths ran dry.
   */
  shortfall: Record<ScenarioKey, string | null>;
  /** Monte Carlo only: share of paths that ever ran out of liquid money. */
  shortfallProb?: number;
  /** Monte Carlo only: per month, every path's total, ascending. */
  dist?: Float64Array[];
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

/** Shared, scenario-independent part of a projection. */
interface ProjectionPrep {
  months: number;
  startOfMonth: number;
  startValue: number;
  growth0: number;
  /** Month i → YYYY-MM and timestamp. */
  keys: string[];
  ts: number[];
  /** Month i → value of the not-yet-matured bonds (accreting to face). */
  bondValue: number[];
  /** Month i → coupons + matured face paid in that month. */
  bondIncome: number[];
  /** Month i → planned expenses due that month. */
  expense: number[];
  /** Month i → recurring saving added (0 at i=0 and in the withdrawal phase). */
  saving: number[];
  /** Month i → recurring withdrawal taken. */
  withdrawal: number[];
  events: ForecastEvent[];
  couponHuf: number;
  maturityHuf: number;
  expenseHuf: number;
  withdrawalHuf: number;
}

function prepareProjection(
  summary: PortfolioSummary,
  a: ForecastAssumptions,
  expenses: PlannedExpense[],
  now: Date,
): ProjectionPrep {
  const months = a.months;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const nowDayMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  const keys: string[] = [];
  const ts: number[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i <= months; i++) {
    const ms = addMonths(startOfMonth, i);
    ts.push(ms);
    keys.push(monthKey(ms));
    index.set(keys[i], i);
  }
  const zeros = () => new Array<number>(months + 1).fill(0);

  const legs = bondLegs(summary, nowDayMs);
  const bondValue0 = legs.reduce((s, l) => s + l.carry0, 0);
  const startValue = summary.totalValueHuf;
  const growth0 = startValue - bondValue0; // everything that compounds at r

  const bondValue = zeros();
  const bondIncome = zeros();
  const events: ForecastEvent[] = [];
  const maturityByMonth = new Map<number, number>();
  let couponHuf = 0;
  let maturityHuf = 0;
  for (const leg of legs) {
    for (const c of leg.coupons) {
      const i = index.get(monthKey(c.ms));
      if (i == null) continue;
      bondIncome[i] += c.huf;
      couponHuf += c.huf;
    }
    const matures =
      Number.isFinite(leg.maturityMs) && leg.maturityMs > nowDayMs;
    const matIdx = matures ? index.get(monthKey(leg.maturityMs)) : undefined;
    if (matIdx != null) {
      bondIncome[matIdx] += leg.face;
      maturityHuf += leg.face;
      maturityByMonth.set(
        matIdx,
        (maturityByMonth.get(matIdx) ?? 0) + leg.face,
      );
    }
    // Held value per month until the maturity month (then paid out as face).
    const span = matures ? leg.maturityMs - nowDayMs : 0;
    const lastHeld = matIdx != null ? matIdx - 1 : months;
    for (let i = 0; i <= lastHeld; i++) {
      const f =
        span > 0 ? Math.min(1, Math.max(0, (ts[i] - nowDayMs) / span)) : 0;
      bondValue[i] += leg.carry0 + (leg.face - leg.carry0) * f;
    }
  }
  for (const [i, face] of maturityByMonth)
    events.push({
      month: keys[i],
      kind: "maturity",
      label: "Kötvénylejárat",
      huf: face,
    });

  const expense = zeros();
  let expenseHuf = 0;
  for (const e of expenses) {
    const ms = parseDayMs(e.date);
    // Already-past expenses (earlier this month) are in the balance already.
    if (!Number.isFinite(ms) || ms < nowDayMs) continue;
    const i = index.get(monthKey(ms));
    if (i == null) continue;
    expense[i] += e.amountHuf;
    expenseHuf += e.amountHuf;
    const goal = e.id.startsWith("goal:");
    events.push({
      month: keys[i],
      kind: goal ? "goal" : "expense",
      label: e.note || (goal ? "Cél" : "Kiadás"),
      huf: e.amountHuf,
    });
  }

  // Recurring flows: savings until the withdrawal starts, withdrawals after.
  const saving = zeros();
  const withdrawal = zeros();
  let withdrawalHuf = 0;
  const w = a.withdrawal;
  const wStart =
    w?.enabled && w.monthlyHuf > 0 && /^\d{4}-\d{2}/.test(w.start)
      ? Math.max(1, monthsUntil(w.start, now))
      : Infinity;
  const g = a.savingGrowth ?? 0;
  const wIdx = a.withdrawalIndex ?? 0;
  for (let i = 1; i <= months; i++) {
    if (i < wStart) {
      // Raised every 12 months from now: months 1–12 at the base amount.
      saving[i] =
        a.monthlySavingHuf * Math.pow(1 + g, Math.floor((i - 1) / 12));
    } else {
      // Entered in today's forint, indexed yearly from now on.
      withdrawal[i] =
        w!.monthlyHuf * Math.pow(1 + wIdx, Math.floor((i - 1) / 12));
      withdrawalHuf += withdrawal[i];
    }
  }
  if (Number.isFinite(wStart) && wStart <= months)
    events.push({
      month: keys[wStart],
      kind: "withdrawal",
      label: "Rendszeres kivét indul",
      huf: withdrawal[wStart],
    });

  events.sort((x, y) => x.month.localeCompare(y.month));

  return {
    months,
    startOfMonth,
    startValue,
    growth0,
    keys,
    ts,
    bondValue,
    bondIncome,
    expense,
    saving,
    withdrawal,
    events,
    couponHuf,
    maturityHuf,
    expenseHuf,
    withdrawalHuf,
  };
}

/**
 * One path through the cashflow model. `step(i)` returns the growth pot's
 * multiplier for month i (i ≥ 1). Writes the month totals into `out` and
 * returns the first month index with a negative liquid part (−1 if none).
 */
function simulatePath(
  p: ProjectionPrep,
  a: ForecastAssumptions,
  step: (i: number) => number,
  out: Float64Array | number[],
): number {
  const toGrowth = a.reinvestTarget === "growth";
  const sideMonthly =
    a.reinvestTarget === "bond" ? monthlyRate(a.reinvestBondRate) : 0; // "cash" sits idle
  let growth = p.growth0;
  let side = 0;
  let shortfall = -1;
  for (let i = 0; i <= p.months; i++) {
    if (i > 0) {
      growth *= step(i);
      side *= 1 + sideMonthly;
      growth += p.saving[i];
    }
    // Events run at i=0 too: the buckets hold only future-dated items, so a
    // coupon/maturity/expense still due this month lands in the first point.
    if (p.bondIncome[i]) {
      if (toGrowth) growth += p.bondIncome[i];
      else side += p.bondIncome[i];
    }
    // Spending: side pot first, then growth.
    const spend = p.expense[i] + p.withdrawal[i];
    if (spend) {
      const fromSide = Math.min(Math.max(side, 0), spend);
      side -= fromSide;
      growth -= spend - fromSide;
    }
    if (shortfall < 0 && growth + side < -1) shortfall = i;
    out[i] = growth + side + p.bondValue[i];
  }
  return shortfall;
}

function contributedSeries(p: ProjectionPrep, start: number): number[] {
  const out: number[] = [];
  let c = start;
  for (let i = 0; i <= p.months; i++) {
    c += p.saving[i] - p.expense[i] - p.withdrawal[i];
    out.push(c);
  }
  return out;
}

function resultShell(p: ProjectionPrep) {
  return {
    startValueHuf: p.startValue,
    couponHuf: p.couponHuf,
    maturityHuf: p.maturityHuf,
    expenseHuf: p.expenseHuf,
    withdrawalHuf: p.withdrawalHuf,
    events: p.events,
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
  const p = prepareProjection(summary, assumptions, expenses, now);
  const series = {} as Record<ScenarioKey, number[]>;
  const shortfall = {} as Record<ScenarioKey, string | null>;
  for (const s of SCENARIOS) {
    const r = 1 + monthlyRate(assumptions.annualReturn[s]);
    series[s] = new Array<number>(p.months + 1);
    const at = simulatePath(p, assumptions, () => r, series[s]);
    shortfall[s] = at >= 0 ? p.keys[at] : null;
  }
  const contributed = contributedSeries(p, summary.netDepositedHuf);
  const points: ForecastPoint[] = p.keys.map((month, i) => ({
    month,
    ts: p.ts[i],
    pess: series.pess[i],
    real: series.real[i],
    opt: series.opt[i],
    contributed: contributed[i],
  }));
  return { ...resultShell(p), points, shortfall };
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
  const p = prepareProjection(summary, assumptions, expenses, now);
  const months = p.months;
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
      let u: number;
      do {
        u = rand();
      } while (u <= 1e-12);
      const r = Math.sqrt(-2 * Math.log(u));
      const theta = 2 * Math.PI * rand();
      spare = r * Math.sin(theta);
      return r * Math.cos(theta);
    };
  })();
  const step = () =>
    Math.exp(muM - (sigmaM * sigmaM) / 2 + sigmaM * drawNormal());

  // dist[i] = the simulated total across runs for month i.
  const dist: Float64Array[] = Array.from(
    { length: months + 1 },
    () => new Float64Array(runs),
  );
  const path = new Float64Array(months + 1);
  const firstShort = new Array<number>(runs);
  let short = 0;
  for (let run = 0; run < runs; run++) {
    const at = simulatePath(p, assumptions, step, path);
    firstShort[run] = at;
    if (at >= 0) short++;
    for (let i = 0; i <= months; i++) dist[i][run] = path[i];
  }
  for (const d of dist) d.sort();

  const contributed = contributedSeries(p, summary.netDepositedHuf);
  const q = (sorted: Float64Array, x: number) =>
    sorted[Math.min(runs - 1, Math.max(0, Math.round(x * (runs - 1))))];
  const points: ForecastPoint[] = p.keys.map((month, i) => ({
    month,
    ts: p.ts[i],
    pess: q(dist[i], 0.1),
    real: q(dist[i], 0.5),
    opt: q(dist[i], 0.9),
    contributed: contributed[i],
  }));

  // Band "shortfall" months: the month by which 90 / 50 / 10 % of paths are
  // still liquid — i.e. when the p10 / median / p90 path would run dry.
  const shortIdx = firstShort.filter((x) => x >= 0).sort((x, y) => x - y);
  const byShare = (share: number) => {
    const n = Math.ceil(share * runs);
    return n >= 1 && shortIdx.length >= n ? p.keys[shortIdx[n - 1]] : null;
  };
  return {
    ...resultShell(p),
    points,
    shortfall: { pess: byShare(0.1), real: byShare(0.5), opt: byShare(0.9) },
    shortfallProb: short / runs,
    dist,
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
  const factor = (i: number) => Math.pow(1 + annualInflation, i / 12);
  const points = result.points.map((p, i) => {
    const f = factor(i);
    return {
      ...p,
      pess: p.pess / f,
      real: p.real / f,
      opt: p.opt / f,
      contributed: p.contributed / f,
    };
  });
  const dist = result.dist?.map((d, i) => {
    const f = factor(i);
    return d.map((v) => v / f);
  });
  return { ...result, points, dist };
}

// ---------------------------------------------------------------------------
// Target finder
// ---------------------------------------------------------------------------

/** First month (YYYY-MM) a scenario's value reaches `target`, or null. */
export function firstReach(
  result: ForecastResult,
  key: ScenarioKey,
  target: number,
): string | null {
  for (const p of result.points) if (p[key] >= target) return p.month;
  return null;
}

/** Monte Carlo: share of paths at or above `target` in month `i`. */
export function probAtLeast(
  result: ForecastResult,
  i: number,
  target: number,
): number | null {
  const d = result.dist?.[i];
  if (!d || d.length === 0) return null;
  // d is ascending: find the first index ≥ target.
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return (d.length - lo) / d.length;
}

/**
 * The smallest starting monthly saving (HUF) for which `valueAt(saving)`
 * reaches `target`. `valueAt` must grow with the saving (it does: every
 * extra forint compounds). Returns 0 if already reached, null if not even
 * 100M Ft/month would do it.
 */
export function requiredMonthlySaving(
  valueAt: (saving: number) => number,
  target: number,
): number | null {
  if (valueAt(0) >= target) return 0;
  let hi = 100_000;
  while (valueAt(hi) < target) {
    hi *= 2;
    if (hi > 100_000_000) return null;
  }
  let lo = 0;
  for (let k = 0; k < 40 && hi - lo > 100; k++) {
    const mid = (lo + hi) / 2;
    if (valueAt(mid) >= target) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi / 1000) * 1000;
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
// Persistence (localStorage) — planning inputs, synced across devices via the
// cloud snapshot (see prefs.ts).
// ---------------------------------------------------------------------------

const STORE_KEY = "pf-forecast";

export type ForecastEngine = "det" | "mc";

export interface ForecastSettings {
  /** null → use the auto-detected recurring saving. */
  monthlySavingOverride: number | null;
  /** Yearly raise of the monthly saving (fraction). */
  savingGrowth: number;
  annualReturn: Record<ScenarioKey, number>;
  /** Where bond coupons + matured principal are reinvested. */
  reinvestTarget: ReinvestTarget;
  /** Annual rate for the "bond" reinvest target (fraction). */
  reinvestBondRate: number;
  months: number;
  expenses: PlannedExpense[];
  /** Recurring withdrawal phase (indexed with `inflationPct`). */
  withdrawal: WithdrawalPlan;
  /** det = 3 fixed scenarios; mc = Monte Carlo percentile fan. */
  engine: ForecastEngine;
  /** Annual volatility for the Monte Carlo engine (fraction). */
  mcSigma: number;
  /** Annual inflation: real-value view + withdrawal indexation (fraction). */
  inflationPct: number;
  /** Show values deflated to today's forint. */
  realMode: boolean;
  /** Target finder: amount (in the currently shown forint) and optional date. */
  targetHuf: number | null;
  /** YYYY-MM, or "" for "no deadline". */
  targetMonth: string;
}

export const DEFAULT_SETTINGS: ForecastSettings = {
  monthlySavingOverride: null,
  savingGrowth: 0,
  annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 },
  reinvestTarget: "growth",
  reinvestBondRate: 0.06,
  months: 120,
  expenses: [],
  withdrawal: { enabled: false, start: "", monthlyHuf: 0 },
  engine: "det",
  mcSigma: 0.15,
  inflationPct: 0.035,
  realMode: false,
  targetHuf: null,
  targetMonth: "",
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
      withdrawal: {
        ...DEFAULT_SETTINGS.withdrawal,
        ...(parsed.withdrawal ?? {}),
      },
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveForecastSettings(s: ForecastSettings) {
  try {
    const json = JSON.stringify(s);
    // Only stamp a real change — a no-op save must not claim "newer" in sync.
    if (localStorage.getItem(STORE_KEY) === json) return;
    localStorage.setItem(STORE_KEY, json);
    touchPref("forecast");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Forecast snapshots — "előrejelzés vs. valóság". Once a month the page stores
// the deterministic nominal projection for the next months; later months
// compare what was expected with the actual value. Synced like the other
// planning prefs, but merged as a union (see prefs.ts) so two devices never
// wipe each other's history.
// ---------------------------------------------------------------------------

const SNAP_KEY = "pf-forecast-snapshots";
/** How many months ahead each snapshot keeps. */
const SNAP_AHEAD = 24;
/** How many snapshots are kept (oldest dropped). */
const SNAP_KEEP = 36;

export interface ForecastSnapshot {
  /** YYYY-MM the snapshot was taken in. */
  month: string;
  createdAt: string;
  startValueHuf: number;
  /** [YYYY-MM, pess, real, opt] for the following months, nominal HUF. */
  points: [string, number, number, number][];
}

export function loadForecastSnapshots(): ForecastSnapshot[] {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ForecastSnapshot[]) : [];
  } catch {
    return [];
  }
}

/** Union by month (the earlier snapshot of a month wins), ascending, capped. */
export function mergeForecastSnapshots(
  a: ForecastSnapshot[] | null | undefined,
  b: ForecastSnapshot[] | null | undefined,
): ForecastSnapshot[] {
  const byMonth = new Map<string, ForecastSnapshot>();
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    if (!s || typeof s.month !== "string") continue;
    const cur = byMonth.get(s.month);
    if (!cur || s.createdAt < cur.createdAt) byMonth.set(s.month, s);
  }
  return [...byMonth.values()]
    .sort((x, y) => x.month.localeCompare(y.month))
    .slice(-SNAP_KEEP);
}

/**
 * Store this month's snapshot from a NOMINAL deterministic result, unless one
 * already exists for the month. Returns true when a snapshot was added.
 */
export function recordForecastSnapshot(
  nominal: ForecastResult,
  now: Date = new Date(),
): boolean {
  const month = monthKey(now.getTime());
  const existing = loadForecastSnapshots();
  if (existing.some((s) => s.month === month)) return false;
  const snap: ForecastSnapshot = {
    month,
    createdAt: now.toISOString(),
    startValueHuf: Math.round(nominal.startValueHuf),
    points: nominal.points
      .slice(1, SNAP_AHEAD + 1)
      .map((p) => [
        p.month,
        Math.round(p.pess),
        Math.round(p.real),
        Math.round(p.opt),
      ]),
  };
  try {
    localStorage.setItem(
      SNAP_KEY,
      JSON.stringify(mergeForecastSnapshots(existing, [snap])),
    );
    touchPref("forecastSnapshots");
    return true;
  } catch {
    return false;
  }
}
