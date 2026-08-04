// ---------------------------------------------------------------------------
// Bond math: coupon schedules, accrued interest, projected cashflows and the
// redeemable value of a bond position. Grew out of portfolio.ts, which
// re-exports everything here — both import paths work.
// ---------------------------------------------------------------------------

import type { BondTerms, Instrument, Transaction } from "./model";
import type { PortfolioSummary } from "./portfolio";

export const BOND_TYPES = new Set(["gov_bond", "tbill"]);

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
export function bondValuationMs(ms: number): number {
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

/** A credited coupon may be booked a day or two off the schedule date. */
const COUPON_CREDITED_DAYS = 7;

/**
 * Local calendar day of a stored transaction timestamp. The importers store an
 * ISO instant built from local midnight, so east of UTC its UTC day is the day
 * before — slicing the string (what parseDayMs does for bare bond dates) would
 * be off by one. Bond schedule dates are bare YYYY-MM-DD and go the other path.
 */
function txDayMs(s: string | undefined): number {
  if (!s) return NaN;
  if (!s.includes("T")) return parseDayMs(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? NaN
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** instrument key → local days on which an `interest` payment was booked. */
function creditedCouponDays(
  transactions: Transaction[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const t of transactions) {
    if (t.type !== "interest" || !t.instrumentKey) continue;
    const ms = txDayMs(t.date);
    if (!Number.isFinite(ms)) continue;
    out.set(t.instrumentKey, [...(out.get(t.instrumentKey) ?? []), ms]);
  }
  return out;
}

/**
 * Projected future bond cash inflows from today: every remaining coupon up to
 * maturity, plus the redemption (face value) at maturity. Assumes the current
 * face holding is kept to maturity. Used by the calendar view.
 *
 * `transactions` (optional) drops coupons that have ALREADY been credited. The
 * Államkincstár books a coupon on its nominal date but pays out a day earlier,
 * so on the eve of a coupon the money is already in the account (and often
 * reinvested) while the schedule still calls it "future" — counting both would
 * double it in the savings-goal projection and the cashflow forecast.
 */
export function futureBondCashflows(
  summary: PortfolioSummary,
  now: Date = new Date(),
  transactions: Transaction[] = [],
): Cashflow[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const nowMs = today.getTime();
  const credited = creditedCouponDays(transactions);
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
            const paidDays = credited.get(inst.key);
            const alreadyPaid = paidDays?.some(
              (ms) => Math.abs(ms - cur) <= COUPON_CREDITED_DAYS * 86_400_000,
            );
            const iso = toLocalDay(cur);
            const amt = couponAmountHuf(bond, face, iso);
            if (!alreadyPaid && amt && amt > 0)
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
  /** Drops coupons already credited (see futureBondCashflows). */
  transactions: Transaction[] = [],
): CashflowForecast {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const horizonMs = new Date(
    start.getFullYear(),
    start.getMonth() + months,
    start.getDate(),
  ).getTime();

  const byKey = new Map<string, CashflowMonth>();
  for (const cf of futureBondCashflows(summary, now, transactions)) {
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
export function bondMarketValue(
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
