// ---------------------------------------------------------------------------
// Pure analytics: turn raw transactions into holdings, balances and P/L.
// ---------------------------------------------------------------------------

import type {
  Account,
  AccountKind,
  BondTerms,
  Currency,
  Instrument,
  Transaction,
} from "./model";

/** Current price lookup, in the instrument's own currency. */
export type PriceMap = Map<string, number>;

export interface HoldingView {
  instrumentKey: string;
  instrument?: Instrument;
  quantity: number;
  /** Cost basis remaining (avg-cost method), instrument currency. */
  costBasisCcy: number;
  avgCost: number;
  currency: Currency;
  /** Current price (instrument ccy), if known. */
  currentPrice?: number;
  /** Market value in instrument currency. */
  marketValueCcy?: number;
  /** Market value converted to HUF. */
  marketValueHuf?: number;
  /** Cost basis converted to HUF (par/face proxy for bonds). */
  costBasisHuf: number;
  unrealizedPlHuf?: number;
  /** Fixed-rate bond valued at par because its series terms are missing. */
  bondNeedsData?: boolean;
}

export interface CashByCurrency {
  [currency: string]: number;
}

export interface AccountSummary {
  account: Account;
  holdings: HoldingView[];
  cash: CashByCurrency;
  /**
   * Σ EXTERNAL deposits − withdrawals (HUF). Internal transfers between the
   * user's own accounts are excluded, so summing this across accounts gives the
   * true external capital without double counting.
   */
  netDepositedHuf: number;
  /** Internal transfers received from the user's other accounts (HUF). */
  transfersInHuf: number;
  /** Internal transfers sent to the user's other accounts (HUF). */
  transfersOutHuf: number;
  /**
   * Capital committed to THIS account = external net + net internal transfers
   * in. The right denominator for a single account's return (a TBSZ funded by
   * transfers from the cash hub still shows a sensible % on its own holdings).
   */
  capitalBasisHuf: number;
  holdingsValueHuf: number;
  cashValueHuf: number;
  totalValueHuf: number;
  costBasisHuf: number;
  unrealizedPlHuf: number;
  realizedPlHuf: number;
  interestHuf: number;
  feesHuf: number;
  taxHuf: number;
}

export interface PortfolioSummary {
  accounts: AccountSummary[];
  totalValueHuf: number;
  holdingsValueHuf: number;
  cashValueHuf: number;
  netDepositedHuf: number;
  costBasisHuf: number;
  unrealizedPlHuf: number;
  realizedPlHuf: number;
  interestHuf: number;
  totalPlHuf: number;
  /** total P/L as a fraction of net deposited. */
  totalReturnPct: number;
  /**
   * Non-HUF currencies held (position or cash) with no known FX rate — those
   * amounts are valued at 1 HUF/unit, so the UI must warn instead of showing
   * silently absurd totals.
   */
  missingFxCcys: string[];
}

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);

const DEFAULT_BOND_SALE_COST = 0.01; // FixMÁP early-sale cost (1% of par)

/**
 * Parse a bond date to LOCAL midnight ms. Coupon boundaries are date-only, so
 * everything must compare at day granularity in one timezone — mixing UTC-parsed
 * dates with a local `now` would slip boundaries by the UTC offset (and wrongly
 * accrue a whole period on the coupon day).
 */
function parseDayMs(s: string | undefined): number {
  if (!s) return NaN;
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? NaN
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

/** Local-midnight ms -> "YYYY-MM-DD" (avoids the UTC shift of toISOString). */
function toLocalDay(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Elszámolási vágás órája (helyi idő): eddig az aznapi, utána a következő nap.
 * Hét–Csüt 16:00, de pénteken 15:00 (akkor hamarabb frissül az árfolyam).
 */
const BOND_CUTOFF_HOUR = 16;
const BOND_CUTOFF_HOUR_FRIDAY = 15;

/**
 * Az állampapír (el)számolási napja, local-midnight granularitással.
 *  - Hétköznap a vágás ELŐTT: az aznapi nappal számolunk.
 *  - Hétköznap a vágás UTÁN: a következő elszámolási nap (Hét–Csüt → másnap,
 *    Péntek → következő hétfő).
 *  - A vágás órája Hét–Csüt 16:00, pénteken 15:00.
 *  - Hétvégén (Szo/Vas) bármikor: a következő hétfő (a MobilKincstár is így).
 */
function bondValuationMs(ms: number): number {
  const hour = new Date(ms).getHours();
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0); // local midnight
  const day = d.getDay(); // 0 = Vas, 1 = Hét, ... 5 = Pén, 6 = Szo
  const cutoff = day === 5 ? BOND_CUTOFF_HOUR_FRIDAY : BOND_CUTOFF_HOUR;

  if (day === 6) {
    d.setDate(d.getDate() + 2); // Szo → Hét
  } else if (day === 0) {
    d.setDate(d.getDate() + 1); // Vas → Hét
  } else if (hour >= cutoff) {
    // A vágás után előrelépünk a következő elszámolási napra.
    d.setDate(d.getDate() + (day === 5 ? 3 : 1)); // Pén → Hét, egyébként másnap
  }
  // Hétköznap a vágás előtt: marad az aznapi.
  return d.getTime();
}

/**
 * Accrued-interest fraction of par for a fixed-rate bond from its (user-supplied)
 * coupon schedule. Walks the coupon dates forward from `firstCouponDate` by the
 * interval to the latest boundary on/before `now`, then accrues linearly.
 * Before the first coupon it accrues from the issue date (the first period may be
 * irregular). Returns undefined when there is not enough data (→ value at par).
 */
function fixedBondAccrued(
  bond: BondTerms | undefined,
  nowMs: number,
): number | undefined {
  const rate = bond?.couponRate;
  if (!rate || rate <= 0) return undefined;
  const interval =
    bond?.couponIntervalMonths && bond.couponIntervalMonths > 0
      ? bond.couponIntervalMonths
      : 12;
  const first = parseDayMs(bond?.firstCouponDate);
  const issue = parseDayMs(bond?.issueDate);

  // Accrual stops at maturity: a matured-but-not-yet-redeemed bond must not
  // keep growing phantom interest until the redemption is imported.
  const matMs = parseDayMs(bond?.maturity);
  if (Number.isFinite(matMs) && nowMs > matMs) nowMs = matMs;

  let anchorMs: number;
  if (Number.isFinite(first) && nowMs >= first) {
    let cur = first;
    for (let i = 0; i < 600 && Number.isFinite(cur); i++) {
      const next = addMonths(cur, interval);
      if (!Number.isFinite(next) || next > nowMs) break;
      cur = next;
    }
    anchorMs = cur;
  } else if (Number.isFinite(issue)) {
    anchorMs = issue; // first coupon not due yet — accrue from issuance
  } else if (Number.isFinite(first)) {
    anchorMs = first;
  } else {
    return undefined;
  }

  const days = (nowMs - anchorMs) / 86_400_000;
  return days > 0 ? (rate * days) / 365 : 0;
}

/**
 * Expected coupon payment (HUF) for the coupon falling on `couponDateIso`. Uses
 * the ACTUAL period length (period start → coupon date) / 365, so the first
 * coupon after issuance — a possibly short/long stub period — is correct, not a
 * full regular period.
 */
export function couponAmountHuf(
  bond: BondTerms | undefined,
  faceValue: number,
  couponDateIso: string | undefined,
): number | undefined {
  const rate = bond?.couponRate;
  const d = parseDayMs(couponDateIso);
  if (!rate || rate <= 0 || !Number.isFinite(d)) return undefined;
  const interval =
    bond?.couponIntervalMonths && bond.couponIntervalMonths > 0
      ? bond.couponIntervalMonths
      : 12;
  // A regular coupon is a FIXED amount per period (interval/12 of the annual
  // coupon), e.g. an exact quarter — the holder gets the whole period at the
  // coupon date, the accrued paid at purchase squares it up. The SERIES' first
  // coupon is a stub from issuance, prorated by actual days/365.
  const isFirst =
    !!bond?.firstCouponDate &&
    couponDateIso?.slice(0, 10) === bond.firstCouponDate.slice(0, 10);
  if (isFirst) {
    // Exact value if the user supplied it (the stub day-count isn't recoverable
    // to the forint); else estimate from actual days since issuance.
    if (bond?.firstCouponHuf != null && bond.firstCouponHuf > 0)
      return bond.firstCouponHuf;
    const issue = parseDayMs(bond?.issueDate);
    if (Number.isFinite(issue)) {
      // Whole calendar days — round so a DST hour between the two dates doesn't
      // shave a fraction off the count.
      const days = Math.round((d - issue) / 86_400_000);
      if (days <= 0) return undefined;
      return faceValue * rate * (days / 365);
    }
  }
  return faceValue * rate * (interval / 12);
}

/** Next coupon date strictly after `now` from the series terms, or undefined. */
export function nextCouponDate(
  bond: BondTerms | undefined,
  now: Date = new Date(),
): string | undefined {
  const first = parseDayMs(bond?.firstCouponDate);
  if (!Number.isFinite(first)) return undefined;
  const interval =
    bond?.couponIntervalMonths && bond.couponIntervalMonths > 0
      ? bond.couponIntervalMonths
      : 12;
  const nowDay = new Date(now);
  nowDay.setHours(0, 0, 0, 0);
  let cur = first;
  while (cur <= nowDay.getTime()) cur = addMonths(cur, interval);
  const mat = parseDayMs(bond?.maturity);
  if (Number.isFinite(mat) && cur > mat) return undefined; // redeemed by then
  return toLocalDay(cur);
}

export interface Cashflow {
  /** ISO day (YYYY-MM-DD). */
  date: string;
  kind: "coupon" | "maturity";
  title: string;
  /** Expected HUF inflow on that day. */
  amountHuf: number;
  accountId?: string;
}

/**
 * Projected future bond cash inflows from today: every remaining coupon up to
 * maturity, plus the redemption (face value) at maturity. Assumes the current
 * face holding is kept to maturity. Used by the calendar view.
 */
export function futureBondCashflows(
  summary: PortfolioSummary,
  now: Date = new Date(),
): Cashflow[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const nowMs = today.getTime();
  const out: Cashflow[] = [];

  for (const acc of summary.accounts) {
    const accountId = acc.account.id;
    for (const h of acc.holdings) {
      const inst = h.instrument;
      if (!inst || !BOND_TYPES.has(inst.type)) continue;
      const face = h.quantity;
      const bond = inst.bond;
      const matMs = parseDayMs(bond?.maturity ?? inst.maturity);

      // Remaining coupons (fixed-rate bonds with series terms).
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
            const iso = toLocalDay(cur);
            const amt = couponAmountHuf(bond, face, iso);
            if (amt && amt > 0)
              out.push({
                date: iso,
                kind: "coupon",
                title: `${inst.name} — kamat`,
                amountHuf: amt,
                accountId,
              });
          }
          cur = addMonths(cur, interval);
        }
      }

      // Redemption at maturity (face value back).
      if (Number.isFinite(matMs) && matMs > nowMs && face > 0) {
        out.push({
          date: toLocalDay(matMs),
          kind: "maturity",
          title: `${inst.name} — lejárat`,
          amountHuf: face,
          accountId,
        });
      }
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface CashflowMonth {
  /** YYYY-MM. */
  key: string;
  couponHuf: number;
  maturityHuf: number;
  totalHuf: number;
  items: Cashflow[];
}

export interface CashflowForecast {
  months: CashflowMonth[];
  couponHuf: number;
  maturityHuf: number;
  totalHuf: number;
}

/**
 * Rolling forward forecast of bond inflows: every coupon + maturity redemption
 * from today through `months` ahead, bucketed by calendar month. Answers "mennyi
 * pénz jön be és mikor?" with a per-month breakdown and totals.
 */
export function bondCashflowForecast(
  summary: PortfolioSummary,
  now: Date = new Date(),
  months = 12,
): CashflowForecast {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const horizonMs = new Date(
    start.getFullYear(),
    start.getMonth() + months,
    start.getDate(),
  ).getTime();

  const byKey = new Map<string, CashflowMonth>();
  for (const cf of futureBondCashflows(summary, now)) {
    const ms = parseDayMs(cf.date);
    if (!Number.isFinite(ms) || ms > horizonMs) continue;
    const key = cf.date.slice(0, 7);
    let b = byKey.get(key);
    if (!b) {
      b = { key, couponHuf: 0, maturityHuf: 0, totalHuf: 0, items: [] };
      byKey.set(key, b);
    }
    if (cf.kind === "coupon") b.couponHuf += cf.amountHuf;
    else b.maturityHuf += cf.amountHuf;
    b.totalHuf += cf.amountHuf;
    b.items.push(cf);
  }

  const monthsOut = [...byKey.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const couponHuf = monthsOut.reduce((s, b) => s + b.couponHuf, 0);
  const maturityHuf = monthsOut.reduce((s, b) => s + b.maturityHuf, 0);
  return {
    months: monthsOut,
    couponHuf,
    maturityHuf,
    totalHuf: couponHuf + maturityHuf,
  };
}

export interface BondImportReminder {
  kind: "coupon" | "maturity";
  instrumentKey: string;
  name: string;
  accountId?: string;
  /** Nominal event date (ISO day). Actual credit is ~earlyDays earlier. */
  date: string;
  amountHuf?: number;
}

/**
 * Bond events that have (almost certainly) already paid out — the credit lands
 * ~1 day before the nominal date — but for which no matching transaction has
 * been imported yet. Nudges the user to re-import. Covers:
 *  - coupons (no `interest` tx near the latest due coupon), and
 *  - maturity (still holding the bond past maturity, no `redemption` tx).
 * Only recent events count (lookback window) so it never nags about history.
 */
export function bondImportReminders(
  summary: PortfolioSummary,
  transactions: Transaction[],
  now: Date = new Date(),
  opts: {
    earlyDays?: number;
    lookbackDays?: number;
    maturityLookbackDays?: number;
  } = {},
): BondImportReminder[] {
  const earlyDays = opts.earlyDays ?? 1;
  const lookbackDays = opts.lookbackDays ?? 45;
  const maturityLookbackDays = opts.maturityLookbackDays ?? 90;
  const dayMs = 86_400_000;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const lookbackMs = todayMs - lookbackDays * dayMs;
  const matLookbackMs = todayMs - maturityLookbackDays * dayMs;

  // Index imported dates per instrument for a fast "already got it?" test.
  const interestByInst = new Map<string, number[]>();
  const redemptionByInst = new Map<string, number[]>();
  for (const t of transactions) {
    if (!t.instrumentKey) continue;
    const target =
      t.type === "interest"
        ? interestByInst
        : t.type === "redemption"
          ? redemptionByInst
          : null;
    if (!target) continue;
    const ms = parseDayMs(t.date);
    if (!Number.isFinite(ms)) continue;
    const arr = target.get(t.instrumentKey) ?? [];
    arr.push(ms);
    target.set(t.instrumentKey, arr);
  }

  const out: BondImportReminder[] = [];
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const inst = h.instrument;
      if (!inst || !BOND_TYPES.has(inst.type)) continue;
      const bond = inst.bond;
      const matMs = parseDayMs(bond?.maturity ?? inst.maturity);

      // --- Coupon (fixed-rate series with terms) ---
      const first = parseDayMs(bond?.firstCouponDate);
      if (Number.isFinite(first) && bond?.couponRate) {
        const interval =
          bond.couponIntervalMonths && bond.couponIntervalMonths > 0
            ? bond.couponIntervalMonths
            : 12;
        let latest = NaN;
        let cur = first;
        for (let i = 0; i < 600 && Number.isFinite(cur); i++) {
          if (Number.isFinite(matMs) && cur > matMs) break;
          if (cur - earlyDays * dayMs <= todayMs) latest = cur;
          else break;
          cur = addMonths(cur, interval);
        }
        if (Number.isFinite(latest) && latest >= lookbackMs) {
          const interests = interestByInst.get(inst.key) ?? [];
          if (!interests.some((ms) => Math.abs(ms - latest) <= 7 * dayMs)) {
            out.push({
              kind: "coupon",
              instrumentKey: inst.key,
              name: inst.name,
              accountId: acc.account.id,
              date: toLocalDay(latest),
              amountHuf: couponAmountHuf(bond, h.quantity, toLocalDay(latest)),
            });
          }
        }
      }

      // --- Maturity (still holding it past maturity, no redemption imported) ---
      if (
        Number.isFinite(matMs) &&
        matMs - earlyDays * dayMs <= todayMs &&
        matMs >= matLookbackMs &&
        h.quantity > 0
      ) {
        const reds = redemptionByInst.get(inst.key) ?? [];
        if (!reds.some((ms) => Math.abs(ms - matMs) <= 14 * dayMs)) {
          out.push({
            kind: "maturity",
            instrumentKey: inst.key,
            name: inst.name,
            accountId: acc.account.id,
            date: toLocalDay(matMs),
            amountHuf: h.quantity,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Current HUF value of a bond position (face = quantity), more accurate than par:
 *  - Discount T-bill (zero coupon): accretes linearly from the average purchase
 *    price toward par (100%) by maturity. At/after maturity it is par.
 *  - Fixed-rate bond (FixMÁP…): par + accrued coupon from the user-supplied
 *    series terms. Falls back to par (`needsData`) when terms are missing.
 */
function bondMarketValue(
  inst: Instrument | undefined,
  faceQty: number,
  cost: number,
  avgBuyMs: number,
  nowMs: number,
): { value: number; needsData: boolean } {
  const matMs = parseDayMs(inst?.bond?.maturity ?? inst?.maturity);

  if (inst?.type === "tbill") {
    if (!Number.isFinite(matMs) || nowMs >= matMs)
      return { value: faceQty, needsData: false }; // par at/after maturity
    const avgPrice = faceQty > 0 ? cost / faceQty : 1;
    const span = matMs - avgBuyMs;
    const frac = span > 0 ? clamp01((nowMs - avgBuyMs) / span) : 1;
    return {
      value: faceQty * (avgPrice + (1 - avgPrice) * frac),
      needsData: false,
    };
  }

  const accrued = fixedBondAccrued(inst?.bond, nowMs);
  if (accrued == null) return { value: faceQty, needsData: true }; // par fallback
  // Early-sale cost (what you'd actually get if redeeming now); none at maturity.
  const beforeMaturity = !Number.isFinite(matMs) || nowMs < matMs;
  const saleCost = beforeMaturity
    ? (inst?.bond?.saleCostPct ?? DEFAULT_BOND_SALE_COST)
    : 0;
  return { value: faceQty * (1 + accrued - saleCost), needsData: false };
}

/**
 * A deposit/withdrawal that is really a transfer between the user's own
 * Lightyear accounts. Lightyear marks these with an `IT-` reference (Internal
 * Transfer), versus `DT-` for real external deposits. Detected by reference so
 * the stored transaction (and its id) stays untouched — no re-import needed.
 */
export function isInternalTransfer(t: Transaction): boolean {
  return (
    (t.type === "deposit" || t.type === "withdrawal") &&
    /^IT-/i.test((t.reference ?? "").trim())
  );
}

/**
 * Per-account return on the capital committed to it. Undefined for the cash hub
 * (a pass-through with no meaningful return) and when no capital is committed.
 */
export function accountReturn(s: AccountSummary): number | undefined {
  if (s.account.kind === "cash") return undefined;
  if (isEmptyAccount(s)) return undefined;
  if (s.capitalBasisHuf <= 0) return undefined;
  if (s.account.kind === "treasury") {
    // Fixed-rate bond mark-to-market oscillates with the coupon cycle and bakes
    // in a 1% early-redemption fee you won't pay if held to maturity, so it
    // understates the real return. Use the economic result instead: coupons
    // received + realized P&L + the discount T-bills' accretion (they pay no
    // coupon, so their mark-to-market IS their yield).
    const tbillUnrealized = s.holdings
      .filter((h) => h.instrument?.type === "tbill")
      .reduce((sum, h) => sum + (h.unrealizedPlHuf ?? 0), 0);
    return (
      (s.interestHuf + s.realizedPlHuf + tbillUnrealized) / s.capitalBasisHuf
    );
  }
  return (s.totalValueHuf - s.capitalBasisHuf) / s.capitalBasisHuf;
}

/**
 * A fully-emptied account: no holdings and no cash. Its capital flowed out (e.g.
 * sold and transferred elsewhere), so a per-account return is meaningless — the
 * UI shows "üres" instead of a misleading −100%.
 */
export function isEmptyAccount(s: AccountSummary): boolean {
  return s.holdings.length === 0 && Math.abs(s.totalValueHuf) < 1;
}

/**
 * Convert an amount to HUF.
 *  - HUF stays as is.
 *  - other currencies use `fx[ccy]` (units of HUF per 1 unit of ccy).
 */
export function toHuf(
  amount: number,
  ccy: Currency,
  fx: Record<string, number>,
) {
  if (ccy === "HUF") return amount;
  const rate = fx[ccy];
  return rate ? amount * rate : amount; // fall back to raw if rate unknown
}

interface FxPoint {
  date: string;
  rate: number;
}
/** currency -> conversion rates over time (HUF per 1 unit), sorted by date. */
export type FxHistory = Map<string, FxPoint[]>;

/**
 * Historical EUR/HUF (etc.) rates harvested from `conversion` legs. The two legs
 * of a conversion share a reference; the EFFECTIVE rate is |HUF leg gross| /
 * |foreign leg gross|, which embeds the conversion fee — so a purchase valued at
 * this rate carries its share of the FX fee in the cost basis (not just the
 * fee-free quoted `fxRate`).
 */
export function buildFxHistory(txs: Transaction[]): FxHistory {
  // Group the legs of each conversion together (same account + reference).
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.type !== "conversion") continue;
    const ref = (t.reference ?? "").trim();
    const key = `${t.accountId}|${ref || t.date}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const map: FxHistory = new Map();
  for (const legs of groups.values()) {
    // A conversion is a 2-leg pair (HUF + one foreign leg). Reference-less
    // legs fall back to a per-day group key, so two unrelated same-day
    // conversions could merge into one group — that pairing is ambiguous and
    // would yield wrong rates, so skip anything that isn't a clean pair.
    if (legs.length !== 2) continue;
    const hufLeg = legs.find((l) => (l.currency || "HUF") === "HUF");
    const foreign = legs.find((l) => l.currency && l.currency !== "HUF");
    if (!hufLeg || !foreign) continue;
    const hufAbs = Math.abs(hufLeg.grossAmount ?? hufLeg.netAmount ?? 0);
    const foreignAbs = Math.abs(foreign.grossAmount ?? foreign.netAmount ?? 0);
    if (!hufAbs || !foreignAbs) continue;
    const rate = hufAbs / foreignAbs; // effective, fee-inclusive
    if (rate <= 1) continue;
    const arr = map.get(foreign.currency) ?? [];
    arr.push({ date: foreign.date, rate });
    map.set(foreign.currency, arr);
  }
  for (const arr of map.values())
    arr.sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

/** Rate in effect at `date`: the latest conversion on/before it (else nearest). */
export function histFxRate(
  history: FxHistory | undefined,
  ccy: Currency,
  date: string,
  fx: Record<string, number>,
): number {
  if (ccy === "HUF") return 1;
  const arr = history?.get(ccy);
  if (arr && arr.length) {
    let chosen = arr[0];
    for (const p of arr) {
      if (p.date <= date) chosen = p;
      else break;
    }
    return chosen.rate;
  }
  return fx[ccy] ?? 1; // no conversion history — fall back to current rate
}

export function computeAccountSummary(
  account: Account,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  fxHistory?: FxHistory,
  now: Date = new Date(),
): AccountSummary {
  const accountTxs = txs
    .filter((t) => t.accountId === account.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  const history = fxHistory ?? buildFxHistory(txs);
  const nowMs = now.getTime();
  const bondNowMs = bondValuationMs(nowMs); // 15:00 után másnap; hétvégén köv. hétfő

  // ---- Holdings (avg-cost) + realized P/L ----
  // `cost` is the avg-cost basis in the instrument's own currency; `costHuf` is
  // the same basis fixed in HUF at the historical FX paid on each purchase;
  // `costDateMs` is Σ(spend × buy date) for a cost-weighted average buy date.
  const positions = new Map<
    string,
    {
      qty: number;
      cost: number;
      costHuf: number;
      costDateMs: number;
      ccy: Currency;
      realized: number;
    }
  >();
  let realizedPlHuf = 0;
  let interestHuf = 0;
  let feesHuf = 0;
  let taxHuf = 0;
  let transfersInHuf = 0;
  let transfersOutHuf = 0;
  const cash: CashByCurrency = {};

  const addCash = (ccy: Currency, amount: number) => {
    cash[ccy] = (cash[ccy] ?? 0) + amount;
  };

  for (const t of accountTxs) {
    if (t.internal) continue; // mirror entries — excluded from cash / P&L
    const ccy = t.currency || "HUF";

    // Internal transfer between the user's own accounts: it moves cash, but it
    // is NOT external capital, so it never touches netDeposited. Tracked
    // separately so a transfer-funded account still shows a real return.
    if (isInternalTransfer(t)) {
      const amt = Math.abs(t.netAmount ?? t.grossAmount ?? 0);
      // Value the transfer in HUF at the FX of its date, so a foreign-currency
      // transfer never inflates an account's basis above what was deposited.
      const huf = amt * histFxRate(history, ccy, t.date, fx);
      if (t.type === "deposit") {
        addCash(ccy, amt);
        transfersInHuf += huf;
      } else {
        addCash(ccy, -amt);
        transfersOutHuf += huf;
      }
      continue;
    }

    if (t.fee) feesHuf += toHuf(t.fee, ccy, fx);
    if (t.taxAmount) taxHuf += toHuf(t.taxAmount, ccy, fx);

    switch (t.type) {
      case "buy": {
        if (!t.instrumentKey) break;
        const inst = instruments.get(t.instrumentKey);
        const p = positions.get(t.instrumentKey) ?? {
          qty: 0,
          cost: 0,
          costHuf: 0,
          costDateMs: 0,
          ccy: inst?.currency ?? ccy,
          realized: 0,
        };
        const qty = t.quantity ?? 0;
        const spend = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
        p.qty += qty;
        p.cost += spend;
        // Lock the HUF cost at the FX actually paid on the purchase date.
        p.costHuf += spend * histFxRate(history, ccy, t.date, fx);
        p.costDateMs += spend * Date.parse(t.date);
        positions.set(t.instrumentKey, p);
        addCash(ccy, -spend); // money left the cash pocket
        break;
      }
      case "sell":
      case "redemption": {
        if (!t.instrumentKey) break;
        const p = positions.get(t.instrumentKey);
        const qty = t.quantity ?? 0;
        // Incoming money: net of fees is what actually hits the cash pocket.
        const proceeds = Math.abs(t.netAmount ?? t.grossAmount ?? 0);
        if (p && p.qty > 0) {
          const soldFrac = qty > 0 ? Math.min(qty / p.qty, 1) : 1;
          const costOut = p.cost * soldFrac;
          const realized = proceeds - costOut;
          p.realized += realized;
          // HUF realized = proceeds at the sell-date FX minus the HUF basis
          // fixed at purchase — the same convention as computeIncomeByYear, so
          // the dashboard and the yearly income view show the same number.
          const proceedsHuf =
            p.ccy === "HUF"
              ? proceeds
              : proceeds * histFxRate(history, p.ccy, t.date, fx);
          realizedPlHuf += proceedsHuf - p.costHuf * soldFrac;
          p.qty -= qty;
          p.cost -= costOut;
          p.costHuf -= p.costHuf * soldFrac;
          p.costDateMs -= p.costDateMs * soldFrac;
          if (p.qty < 1e-9) {
            p.qty = 0;
            p.cost = 0;
            p.costHuf = 0;
            p.costDateMs = 0;
          }
          positions.set(t.instrumentKey, p);
        }
        addCash(ccy, proceeds);
        break;
      }
      case "interest": {
        const amt = t.netAmount ?? t.grossAmount ?? 0;
        interestHuf += toHuf(amt, ccy, fx);
        addCash(ccy, amt);
        break;
      }
      case "deposit":
        addCash(ccy, Math.abs(t.netAmount ?? t.grossAmount ?? 0));
        break;
      case "withdrawal":
        // Outgoing money: gross is the full debit (incl. fee).
        addCash(ccy, -Math.abs(t.grossAmount ?? t.netAmount ?? 0));
        break;
      case "conversion": {
        // A conversion leg moves money between currency pockets. Gross is the
        // full signed amount moved in this currency (fee is embedded in the
        // spread between the two legs), so using gross keeps the books square.
        const amt = t.grossAmount ?? t.netAmount ?? 0;
        addCash(ccy, amt);
        break;
      }
      case "fee":
        addCash(ccy, -Math.abs(t.netAmount ?? t.fee ?? 0));
        break;
      case "dividend":
        addCash(ccy, Math.abs(t.netAmount ?? t.grossAmount ?? 0));
        break;
      default:
        break;
    }
  }

  // ---- Build holding views ----
  const holdings: HoldingView[] = [];
  let holdingsValueHuf = 0;
  let costBasisHuf = 0;
  let unrealizedPlHuf = 0;

  for (const [key, p] of positions) {
    if (p.qty <= 1e-9) continue;
    const inst = instruments.get(key);
    const ccy = p.ccy;
    const isBond = inst ? BOND_TYPES.has(inst.type) : false;
    const avgCost = p.qty > 0 ? p.cost / p.qty : 0;
    const currentPrice = prices.get(key);

    let marketValueCcy: number | undefined;
    let bondNeedsData = false;
    if (isBond) {
      const avgBuyMs = p.cost > 0 ? p.costDateMs / p.cost : nowMs;
      const bv = bondMarketValue(inst, p.qty, p.cost, avgBuyMs, bondNowMs);
      marketValueCcy = bv.value;
      bondNeedsData = bv.needsData;
    } else if (currentPrice != null) {
      marketValueCcy = p.qty * currentPrice;
    } else {
      marketValueCcy = p.cost; // fall back to cost if no price yet
    }

    const marketValueHuf = toHuf(marketValueCcy, ccy, fx);
    // HUF cost fixed at the FX paid on purchase (bonds are HUF-native already).
    const costBasisHufThis = isBond ? p.cost : p.costHuf;
    const unrealized = marketValueHuf - costBasisHufThis;

    holdingsValueHuf += marketValueHuf;
    costBasisHuf += costBasisHufThis;
    unrealizedPlHuf += unrealized;

    holdings.push({
      instrumentKey: key,
      instrument: inst,
      quantity: p.qty,
      costBasisCcy: p.cost,
      avgCost,
      currency: ccy,
      currentPrice: isBond ? undefined : currentPrice,
      marketValueCcy,
      marketValueHuf,
      costBasisHuf: costBasisHufThis,
      unrealizedPlHuf: unrealized,
      bondNeedsData: bondNeedsData || undefined,
    });
  }

  holdings.sort((a, b) => (b.marketValueHuf ?? 0) - (a.marketValueHuf ?? 0));

  // ---- Net deposited (EXTERNAL money in − out only), HUF ----
  let netDepositedHuf = 0;
  for (const t of accountTxs) {
    if (t.internal) continue;
    if (isInternalTransfer(t)) continue; // internal — not external capital
    if (t.type === "deposit")
      netDepositedHuf += toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      );
    if (t.type === "withdrawal")
      netDepositedHuf -= toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      );
  }

  const cashValueHuf = Object.entries(cash).reduce(
    (sum, [ccy, amt]) => sum + toHuf(amt, ccy, fx),
    0,
  );

  return {
    account,
    holdings,
    cash,
    netDepositedHuf,
    transfersInHuf,
    transfersOutHuf,
    capitalBasisHuf: netDepositedHuf + transfersInHuf - transfersOutHuf,
    holdingsValueHuf,
    cashValueHuf,
    totalValueHuf: holdingsValueHuf + cashValueHuf,
    costBasisHuf,
    unrealizedPlHuf,
    realizedPlHuf,
    interestHuf,
    feesHuf,
    taxHuf,
  };
}

export function computePortfolio(
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  now: Date = new Date(),
): PortfolioSummary {
  const fxHistory = buildFxHistory(txs);
  const summaries = accounts.map((a) =>
    computeAccountSummary(a, txs, instruments, prices, fx, fxHistory, now),
  );

  const sum = (pick: (s: AccountSummary) => number) =>
    summaries.reduce((acc, s) => acc + pick(s), 0);

  const holdingsValueHuf = sum((s) => s.holdingsValueHuf);
  const cashValueHuf = sum((s) => s.cashValueHuf);
  const netDepositedHuf = sum((s) => s.netDepositedHuf);
  const costBasisHuf = sum((s) => s.costBasisHuf);
  const unrealizedPlHuf = sum((s) => s.unrealizedPlHuf);
  const realizedPlHuf = sum((s) => s.realizedPlHuf);
  const interestHuf = sum((s) => s.interestHuf);
  const totalValueHuf = holdingsValueHuf + cashValueHuf;
  const totalPlHuf = totalValueHuf - netDepositedHuf;

  // Currencies valued at the 1 HUF/unit fallback because no rate is known.
  const missingFxCcys = [
    ...new Set(
      summaries.flatMap((s) => [
        ...s.holdings
          .filter((h) => h.currency !== "HUF" && !fx[h.currency])
          .map((h) => h.currency),
        ...Object.entries(s.cash)
          .filter(([c, amt]) => c !== "HUF" && Math.abs(amt) > 1e-6 && !fx[c])
          .map(([c]) => c),
      ]),
    ),
  ];

  return {
    accounts: summaries,
    totalValueHuf,
    holdingsValueHuf,
    cashValueHuf,
    netDepositedHuf,
    costBasisHuf,
    unrealizedPlHuf,
    realizedPlHuf,
    interestHuf,
    totalPlHuf,
    totalReturnPct: netDepositedHuf > 0 ? totalPlHuf / netDepositedHuf : 0,
    missingFxCcys,
  };
}

export interface YearIncome {
  year: number;
  /** Realized P/L from sells/redemptions (cost & proceeds in HUF). */
  realizedPlHuf: number;
  interestHuf: number;
  dividendHuf: number;
  /** Total fees paid (trade + conversion + other). */
  feesHuf: number;
  taxHuf: number;
}

/**
 * Realized income/cost grouped by calendar year: realized P/L (avg-cost, HUF at
 * historical FX), interest, dividends, fees and tax. Internal transfers and
 * sub-ledger mirrors are excluded.
 */
export function computeIncomeByYear(
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  fx: Record<string, number>,
): YearIncome[] {
  const fxHistory = buildFxHistory(txs);
  const byYear = new Map<number, YearIncome>();
  const ensure = (y: number) => {
    let r = byYear.get(y);
    if (!r) {
      r = {
        year: y,
        realizedPlHuf: 0,
        interestHuf: 0,
        dividendHuf: 0,
        feesHuf: 0,
        taxHuf: 0,
      };
      byYear.set(y, r);
    }
    return r;
  };

  for (const account of accounts) {
    const accTxs = txs
      .filter((t) => t.accountId === account.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    const positions = new Map<
      string,
      { qty: number; cost: number; costHuf: number; ccy: Currency }
    >();
    for (const t of accTxs) {
      if (t.internal) continue;
      const ccy = t.currency || "HUF";
      // Local year, not a string prefix: an imported "Jan 1 local midnight"
      // date serialises as Dec 31 23:00 UTC, and slice(0,4) would put it in
      // the previous year.
      const year = new Date(t.date).getFullYear();
      if (!Number.isFinite(year)) continue;
      const yr = ensure(year);
      if (t.fee) yr.feesHuf += toHuf(t.fee, ccy, fx);
      if (t.taxAmount) yr.taxHuf += toHuf(t.taxAmount, ccy, fx);
      if (isInternalTransfer(t)) continue;

      switch (t.type) {
        case "buy": {
          if (!t.instrumentKey) break;
          const inst = instruments.get(t.instrumentKey);
          const p = positions.get(t.instrumentKey) ?? {
            qty: 0,
            cost: 0,
            costHuf: 0,
            ccy: inst?.currency ?? ccy,
          };
          const qty = t.quantity ?? 0;
          const spend = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
          p.qty += qty;
          p.cost += spend;
          p.costHuf += spend * histFxRate(fxHistory, ccy, t.date, fx);
          positions.set(t.instrumentKey, p);
          break;
        }
        case "sell":
        case "redemption": {
          if (!t.instrumentKey) break;
          const p = positions.get(t.instrumentKey);
          const qty = t.quantity ?? 0;
          const proceedsCcy = Math.abs(t.netAmount ?? t.grossAmount ?? 0);
          if (p && p.qty > 0) {
            const soldFrac = qty > 0 ? Math.min(qty / p.qty, 1) : 1;
            const costHufOut = p.costHuf * soldFrac;
            const proceedsHuf =
              p.ccy === "HUF"
                ? proceedsCcy
                : proceedsCcy * histFxRate(fxHistory, p.ccy, t.date, fx);
            yr.realizedPlHuf += proceedsHuf - costHufOut;
            p.qty -= qty;
            p.cost -= p.cost * soldFrac;
            p.costHuf -= costHufOut;
            if (p.qty < 1e-9) {
              p.qty = 0;
              p.cost = 0;
              p.costHuf = 0;
            }
          }
          break;
        }
        case "interest":
          yr.interestHuf += toHuf(t.netAmount ?? t.grossAmount ?? 0, ccy, fx);
          break;
        case "dividend":
          yr.dividendHuf += toHuf(
            Math.abs(t.netAmount ?? t.grossAmount ?? 0),
            ccy,
            fx,
          );
          break;
        default:
          break;
      }
    }
  }
  return [...byYear.values()].sort((a, b) => b.year - a.year);
}

export interface FxImpactResult {
  /** Unrealized P/L from the assets' OWN price move (at today's FX). */
  marketHuf: number;
  /** Unrealized P/L from the currency move since purchase. */
  fxHuf: number;
  /** Total unrealized P/L of the non-HUF holdings (= market + fx). */
  totalHuf: number;
  /** Current HUF value of the non-HUF holdings. */
  valueHuf: number;
}

/**
 * Split the unrealized P/L of foreign-currency holdings into a market and an
 * FX component: market = (value − cost) in the asset's currency at today's
 * rate; fx = the cost revalued from the average purchase rate to today's.
 * The two add up exactly to the holdings' unrealized P/L.
 */
export function fxImpact(summary: PortfolioSummary): FxImpactResult {
  let marketHuf = 0;
  let fxHuf = 0;
  let totalHuf = 0;
  let valueHuf = 0;
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      if (h.currency === "HUF") continue;
      const mvCcy = h.marketValueCcy ?? 0;
      const mvHuf = h.marketValueHuf ?? 0;
      if (mvCcy <= 0 || h.costBasisCcy <= 0 || h.costBasisHuf <= 0) continue;
      const fxNow = mvHuf / mvCcy;
      const avgFx = h.costBasisHuf / h.costBasisCcy;
      marketHuf += (mvCcy - h.costBasisCcy) * fxNow;
      fxHuf += h.costBasisCcy * (fxNow - avgFx);
      totalHuf += mvHuf - h.costBasisHuf;
      valueHuf += mvHuf;
    }
  }
  return { marketHuf, fxHuf, totalHuf, valueHuf };
}

export type AssetClass = "equity" | "crypto" | "bond" | "tbill" | "cash";

const CRYPTO_RE = /btc|bitcoin|crypto|ethereum|wbit|wbtc/i;

/** Coarse asset class for allocation. Crypto ETPs (e.g. WBIT) split off ETFs. */
export function assetClassOf(inst?: Instrument): AssetClass {
  if (!inst) return "cash";
  if (CRYPTO_RE.test(inst.name) || CRYPTO_RE.test(inst.ticker ?? ""))
    return "crypto";
  switch (inst.type) {
    case "gov_bond":
      return "bond";
    case "tbill":
      return "tbill";
    case "cash":
      return "cash";
    default:
      return "equity"; // etf, stock, fund
  }
}

export interface AllocationSlice {
  key: string;
  value: number;
}

/** Portfolio value grouped by asset class (cash lumped across currencies). */
export function allocationByClass(
  summary: PortfolioSummary,
): AllocationSlice[] {
  const m = new Map<string, number>();
  const add = (k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const acc of summary.accounts) {
    for (const h of acc.holdings)
      add(assetClassOf(h.instrument), h.marketValueHuf ?? 0);
    if (acc.cashValueHuf > 0.5) add("cash", acc.cashValueHuf);
  }
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

/** Portfolio value grouped by the asset's underlying currency. */
export function allocationByCurrency(
  summary: PortfolioSummary,
  fx: Record<string, number>,
): AllocationSlice[] {
  const m = new Map<string, number>();
  const add = (k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) add(h.currency, h.marketValueHuf ?? 0);
    for (const [ccy, amt] of Object.entries(acc.cash)) {
      const huf = ccy === "HUF" ? amt : amt * (fx[ccy] ?? 0);
      if (Math.abs(huf) > 0.5) add(ccy, huf);
    }
  }
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .filter((s) => s.value > 0.5)
    .sort((a, b) => b.value - a.value);
}

export interface ConsolidatedHolding {
  instrumentKey: string;
  instrument?: Instrument;
  currency: Currency;
  /** Total units held across every account. */
  quantity: number;
  costBasisCcy: number;
  costBasisHuf: number;
  marketValueCcy?: number;
  marketValueHuf: number;
  unrealizedPlHuf: number;
  /** How many accounts hold this instrument. */
  accountCount: number;
  /** Account kind this instrument lives in (treasury bonds vs TBSZ ETFs). */
  accountKind: AccountKind;
}

// Group order in the consolidated view: Államkincstár first, then TBSZ.
const HOLDING_KIND_ORDER: Record<AccountKind, number> = {
  treasury: 0,
  tbsz: 1,
  regular: 2,
  cash: 3,
};

/**
 * Aggregate holdings by instrument across ALL accounts, so a position split over
 * several accounts (e.g. the same ETF in two TBSZ-ek) shows a single combined
 * total. Sorted by market value, highest first.
 */
export function consolidatedHoldings(
  summary: PortfolioSummary,
): ConsolidatedHolding[] {
  const map = new Map<string, ConsolidatedHolding>();
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const mv = h.marketValueHuf ?? 0;
      const existing = map.get(h.instrumentKey);
      if (existing) {
        existing.quantity += h.quantity;
        existing.costBasisCcy += h.costBasisCcy;
        existing.costBasisHuf += h.costBasisHuf;
        existing.marketValueHuf += mv;
        if (h.marketValueCcy != null)
          existing.marketValueCcy =
            (existing.marketValueCcy ?? 0) + h.marketValueCcy;
        existing.unrealizedPlHuf += h.unrealizedPlHuf ?? 0;
        existing.accountCount += 1;
      } else {
        map.set(h.instrumentKey, {
          instrumentKey: h.instrumentKey,
          instrument: h.instrument,
          currency: h.currency,
          quantity: h.quantity,
          costBasisCcy: h.costBasisCcy,
          costBasisHuf: h.costBasisHuf,
          marketValueCcy: h.marketValueCcy,
          marketValueHuf: mv,
          unrealizedPlHuf: h.unrealizedPlHuf ?? 0,
          accountCount: 1,
          accountKind: acc.account.kind,
        });
      }
    }
  }
  // Államkincstár assets on top, then TBSZ; within each group by value desc.
  return [...map.values()].sort((a, b) => {
    const ka = HOLDING_KIND_ORDER[a.accountKind] ?? 9;
    const kb = HOLDING_KIND_ORDER[b.accountKind] ?? 9;
    if (ka !== kb) return ka - kb;
    return b.marketValueHuf - a.marketValueHuf;
  });
}

export interface ValuePoint {
  /** ISO day (YYYY-MM-DD). */
  date: string;
  /** Total portfolio value in HUF as of that day. */
  value: number;
  /** Cumulative net external capital (befektetett tőke) in HUF. */
  invested: number;
}

/** Daily history series: ascending [YYYY-MM-DD, value] per key. */
export interface ValueHistory {
  prices: Record<string, [string, number][]>;
  fx: Record<string, [string, number][]>;
}

/** Last value in an ascending [date, value][] series on/before `day`. */
function asOf(
  series: [string, number][] | undefined,
  day: string,
): number | undefined {
  if (!series || series.length === 0) return undefined;
  let v: number | undefined;
  for (const [d, x] of series) {
    if (d <= day) v = x;
    else break;
  }
  return v;
}

/**
 * Portfolio value over time, reconstructed from the transactions.
 *  - With `history` (daily ETF closes + EUR/HUF from the GitHub Action) each
 *    sample day is marked to the real market close and FX of that day → a
 *    genuine daily curve, sampled weekly.
 *  - Without history we fall back to the price embedded in the most recent
 *    trade on/before the day and the conversion-rate FX, sampled at trade days.
 * Bonds use their accrued value on the day. The final point uses live prices so
 * it matches the dashboard total.
 */
export function buildValueSeries(
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  history?: ValueHistory | null,
  now: Date = new Date(),
  bridge = true,
): ValuePoint[] {
  if (txs.length === 0) return [];
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
  const fxHistory = buildFxHistory(sorted);
  const hasHistory =
    !!history && Object.values(history.prices).some((s) => s.length > 0);

  // Per-instrument trade-price timeline (instrument currency per unit) — the
  // fallback when no market history is available.
  const priceTimeline = new Map<string, { date: string; price: number }[]>();
  for (const t of sorted) {
    if (
      (t.type === "buy" || t.type === "sell") &&
      t.instrumentKey &&
      t.pricePerUnit
    ) {
      const arr = priceTimeline.get(t.instrumentKey) ?? [];
      arr.push({ date: t.date, price: t.pricePerUnit });
      priceTimeline.set(t.instrumentKey, arr);
    }
  }
  const tradePriceAsOf = (key: string, dayEnd: string): number | undefined => {
    const arr = priceTimeline.get(key);
    if (!arr) return undefined;
    let p: number | undefined;
    for (const x of arr) {
      if (x.date <= dayEnd) p = x.price;
      else break;
    }
    return p;
  };

  // Bridge money in transit between the user's own accounts. A withdrawal from
  // one account is often funded into another a few days later (e.g. treasury →
  // bank → Lightyear), with no shared reference and possibly split across
  // deposits. FIFO-match external outflows to later external inflows within a
  // short window; for the in-transit interval the amount is added back so the
  // chart doesn't show a phantom dip while the money is between accounts.
  const TRANSIT_DAYS = 10;
  const flows = sorted
    .filter(
      (t) =>
        !t.internal && // skip sub-ledger mirror entries (e.g. bond settlements)
        !isInternalTransfer(t) &&
        (t.type === "deposit" || t.type === "withdrawal"),
    )
    .map((t) => {
      const huf = toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      );
      return {
        day: t.date.slice(0, 10),
        amt: t.type === "deposit" ? huf : -huf,
      };
    });
  const pending: { day: string; rem: number }[] = [];
  const bridges: { from: string; to: string; amt: number }[] = [];
  for (const ev of flows) {
    if (ev.amt < 0) {
      pending.push({ day: ev.day, rem: -ev.amt });
      continue;
    }
    let dep = ev.amt;
    while (dep > 1 && pending.length) {
      const o = pending[0];
      const gap = (Date.parse(ev.day) - Date.parse(o.day)) / 86_400_000;
      if (gap > TRANSIT_DAYS) {
        pending.shift(); // too old to be a transfer — treat as real spending
        continue;
      }
      const m = Math.min(dep, o.rem);
      if (o.day < ev.day) bridges.push({ from: o.day, to: ev.day, amt: m });
      o.rem -= m;
      dep -= m;
      if (o.rem < 1) pending.shift();
    }
  }
  const inTransitOn = (day: string) =>
    bridges.reduce((s, b) => (b.from <= day && day < b.to ? s + b.amt : s), 0);

  const todayIso = now.toISOString().slice(0, 10);
  const tradeDays = [...new Set(sorted.map((t) => t.date.slice(0, 10)))];
  // With history, sample at a fixed cadence from the first trade so hovering is
  // smooth: daily for up to ~a year, thinning for longer spans (≤ ~370 points).
  // Trade days are always included so events land exactly on the line.
  const dayset = new Set(tradeDays);
  if (hasHistory) {
    const startMs = Date.parse(tradeDays[0]);
    const endMs = Date.parse(todayIso);
    const spanDays = (endMs - startMs) / 86_400_000;
    const stepDays = spanDays <= 370 ? 1 : Math.ceil(spanDays / 370);
    for (let t = startMs; t <= endMs; t += stepDays * 86_400_000)
      dayset.add(new Date(t).toISOString().slice(0, 10));
  }
  const days = [...dayset].filter((d) => d <= todayIso).sort();

  const points: ValuePoint[] = [];
  for (const day of days) {
    const dayEnd = `${day}T23:59:59.999Z`;
    const txsUpTo = sorted.filter((t) => t.date <= dayEnd);
    const pricesAtD: PriceMap = new Map();
    for (const inst of instruments.values()) {
      const p =
        asOf(history?.prices[inst.key], day) ??
        tradePriceAsOf(inst.key, dayEnd);
      if (p != null) pricesAtD.set(inst.key, p);
    }
    const fxAtD = {
      ...fx,
      EUR:
        asOf(history?.fx["EUR"], day) ??
        histFxRate(fxHistory, "EUR", dayEnd, fx),
    };
    const s = computePortfolio(
      accounts,
      txsUpTo,
      instruments,
      pricesAtD,
      fxAtD,
      new Date(`${day}T12:00:00`),
    );
    const transit = bridge ? inTransitOn(day) : 0;
    points.push({
      date: day,
      value: s.totalValueHuf + transit,
      invested: s.netDepositedHuf + transit,
    });
  }

  // Final point: today, at live prices / FX (matches the dashboard total).
  const live = computePortfolio(accounts, sorted, instruments, prices, fx, now);
  const transitToday = bridge ? inTransitOn(todayIso) : 0;
  const livePoint: ValuePoint = {
    date: todayIso,
    value: live.totalValueHuf + transitToday,
    invested: live.netDepositedHuf + transitToday,
  };
  if (points.length && points[points.length - 1].date === todayIso) {
    points[points.length - 1] = livePoint;
  } else {
    points.push(livePoint);
  }
  return points;
}

export interface ReturnMetrics {
  /** Simple return: (value − net external) / net external. */
  simplePct: number;
  /** Annualized money-weighted return (XIRR), if solvable. */
  xirrPct?: number;
  /** Annualized time-weighted return (TWR), if computable. */
  twrPct?: number;
  /** Cumulative time-weighted return over the whole period. */
  twrCumulativePct?: number;
  /** Days from the first investment to now. */
  days: number;
}

/** Solve XIRR by bisection. flows: {years from t0, amount} (sign: out −, in +). */
function solveXirr(flows: { t: number; amt: number }[]): number | undefined {
  if (flows.length < 2) return undefined;
  const hasPos = flows.some((f) => f.amt > 0);
  const hasNeg = flows.some((f) => f.amt < 0);
  if (!hasPos || !hasNeg) return undefined;
  const npv = (r: number) =>
    flows.reduce((s, f) => s + f.amt / Math.pow(1 + r, f.t), 0);
  // Relative NPV tolerance: an absolute one is scale-dependent (never fires
  // for 1e7+ HUF portfolios). The rate bracket (−99.99%…+10000%) is assumed to
  // contain the root; outside it we return undefined rather than extrapolate.
  const tol = 1e-8 * flows.reduce((s, f) => s + Math.abs(f.amt), 0);
  let lo = -0.9999;
  let hi = 100;
  let flo = npv(lo);
  if (flo * npv(hi) > 0) return undefined; // no sign change in range
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < tol || hi - lo < 1e-10) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Performance metrics for the whole portfolio:
 *  - simple: distorted by deposit timing.
 *  - XIRR: money-weighted — what the user's money earned, annualized.
 *  - TWR: time-weighted — investment performance, deposit timing removed.
 */
export function computeReturns(
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  history?: ValueHistory | null,
  now: Date = new Date(),
): ReturnMetrics {
  // Performance view: bonds valued WITHOUT the early-redemption fee. The fee
  // is a transaction cost paid only on an actual early sell — booking it at
  // purchase would show as an instant "loss" (and bounce back as fake yield at
  // maturity), dragging TWR/XIRR by ~the fee for the whole holding period.
  // The dashboard's conservative "redeemable today" value keeps the fee.
  const perfInstruments = new Map(
    [...instruments].map(([k, i]) => [
      k,
      i.bond ? { ...i, bond: { ...i.bond, saleCostPct: 0 } } : i,
    ]),
  );
  const live = computePortfolio(
    accounts,
    txs,
    perfInstruments,
    prices,
    fx,
    now,
  );
  const value = live.totalValueHuf;
  const invested = live.netDepositedHuf;
  const simplePct = invested > 0 ? (value - invested) / invested : 0;

  // External cash flows (investor view: deposit = money out = negative).
  const flowTxs = txs
    .filter(
      (t) =>
        !t.internal &&
        !isInternalTransfer(t) &&
        (t.type === "deposit" || t.type === "withdrawal"),
    )
    .map((t) => {
      const huf = toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      );
      return { ms: Date.parse(t.date), amt: t.type === "deposit" ? -huf : huf };
    })
    .filter((f) => Number.isFinite(f.ms))
    .sort((a, b) => a.ms - b.ms);

  const nowMs = now.getTime();
  const days =
    flowTxs.length > 0 ? Math.round((nowMs - flowTxs[0].ms) / 86_400_000) : 0;

  let xirrPct: number | undefined;
  if (flowTxs.length > 0) {
    const t0 = flowTxs[0].ms;
    const flows = flowTxs.map((f) => ({
      t: (f.ms - t0) / (365 * 86_400_000),
      amt: f.amt,
    }));
    flows.push({ t: (nowMs - t0) / (365 * 86_400_000), amt: value }); // liquidation
    xirrPct = solveXirr(flows);
  }

  // TWR from the daily (bridge-free) value series: chain daily market returns.
  let twrPct: number | undefined;
  let twrCumulativePct: number | undefined;
  const series = buildValueSeries(
    accounts,
    txs,
    perfInstruments,
    prices,
    fx,
    history,
    now,
    false,
  );
  let factor = 1;
  let started = false;
  let firstMs = nowMs;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    const flow = cur.invested - prev.invested;
    // Daily Modified Dietz: flow weighted at the day's midpoint, so a large
    // deposit on a small base doesn't blow the daily return up.
    const base = prev.value + flow / 2;
    if (base <= 1) continue;
    const r = (cur.value - prev.value - flow) / base;
    if (!Number.isFinite(r)) continue;
    factor *= 1 + r;
    if (!started) {
      started = true;
      firstMs = Date.parse(prev.date);
    }
  }
  if (started) {
    twrCumulativePct = factor - 1;
    const span = (nowMs - firstMs) / (365 * 86_400_000);
    twrPct = span > 0 ? Math.pow(factor, 1 / span) - 1 : twrCumulativePct;
  }

  return { simplePct, xirrPct, twrPct, twrCumulativePct, days };
}
