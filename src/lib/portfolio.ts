// ---------------------------------------------------------------------------
// Pure analytics: turn raw transactions into holdings, balances and P/L.
// ---------------------------------------------------------------------------

import type {
  Account,
  AccountKind,
  Currency,
  Instrument,
  Transaction,
} from "./model";
import {
  BOND_TYPES,
  bondMarketValue,
  bondValuationMs,
  nextCouponDate,
} from "./bonds";

// Facade: bonds/series/returns grew out of this file — re-export them so every
// existing `from "./portfolio"` import keeps working unchanged.
export * from "./bonds";
export * from "./series";
export * from "./returns";

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

/**
 * Portfolio value grouped by asset class (cash lumped across currencies).
 * With `bondsAtFace`, government bonds & T-bills count at their HUF face value
 * (nominal) instead of the fluctuating accreted/redeemable value — used by the
 * target allocation, where the user thinks in the nominal amount invested.
 */
export function allocationByClass(
  summary: PortfolioSummary,
  bondsAtFace = false,
): AllocationSlice[] {
  const m = new Map<string, number>();
  const add = (k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const isBond = h.instrument ? BOND_TYPES.has(h.instrument.type) : false;
      const value =
        bondsAtFace && isBond ? h.quantity : (h.marketValueHuf ?? 0);
      add(assetClassOf(h.instrument), value);
    }
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

export interface PurchaseLot {
  /** ISO day (YYYY-MM-DD). */
  date: string;
  accountId: string;
  /** Units still held from this purchase (after later sells, FIFO per account). */
  quantity: number;
  /** Units originally bought (before any sell reduced this lot). */
  originalQuantity: number;
  /** Effective unit cost in the instrument's ccy (gross spend / qty, fees in). */
  unitCostCcy: number;
  /** Cost of the STILL-HELD units in the instrument's ccy. */
  costCcy: number;
  /** HUF per 1 unit of ccy on the purchase date (1 for HUF instruments). */
  fxAtBuy: number;
  /** HUF cost of the still-held units, fixed at the FX paid on purchase. */
  costHuf: number;
  /** Value of the still-held units today (current price × qty), HUF. */
  currentValueHuf?: number;
  /** currentValueHuf − costHuf (undefined if no current price). */
  plHuf?: number;
  /** plHuf / costHuf. */
  plPct?: number;
}

export interface PurchaseLotsResult {
  currency: Currency;
  /** Current unit price in ccy (undefined if unknown / bond). */
  currentPrice?: number;
  /** Still-held purchases, oldest first. Fully-sold lots are dropped. */
  lots: PurchaseLot[];
  /** A sell reduced at least one lot (a TBSZ move, or a real disposal). */
  hadSells: boolean;
}

interface OpenLot {
  date: string;
  accountId: string;
  originalQuantity: number;
  remaining: number;
  /** Cost of the ORIGINAL quantity in the instrument's ccy (gross, fees in). */
  costCcy: number;
  /** HUF per 1 unit of ccy on the purchase date (1 for HUF instruments). */
  fxAtBuy: number;
}

/**
 * FIFO-net an instrument's buys against its later sells/redemptions, WITHIN each
 * account (mirroring how computePortfolio tracks positions per account). Returns
 * the still-held lots (oldest first) so their quantities sum to the actual
 * holding — a TBSZ move (sell + rebuy) nets out cleanly. Shared by purchaseLots
 * (ETF, market-price valued) and bondLots (accrued-value valued).
 */
function nettedOpenLots(
  instrumentKey: string,
  txs: Transaction[],
  ccy: Currency,
  history: FxHistory,
  fx: Record<string, number>,
): { lots: OpenLot[]; hadSells: boolean } {
  // Same chronological order computePortfolio uses, so a same-day buy that
  // precedes its matching sell is present when the sell consumes it.
  const relevant = txs
    .filter(
      (t) =>
        t.instrumentKey === instrumentKey &&
        !t.internal &&
        (t.type === "buy" || t.type === "sell" || t.type === "redemption"),
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  const queueByAccount = new Map<string, OpenLot[]>();
  const allLots: OpenLot[] = [];
  let hadSells = false;
  for (const t of relevant) {
    let queue = queueByAccount.get(t.accountId);
    if (!queue) {
      queue = [];
      queueByAccount.set(t.accountId, queue);
    }
    if (t.type === "buy") {
      const qty = t.quantity ?? 0;
      if (qty <= 0) continue;
      const costCcy = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
      const lot: OpenLot = {
        date: t.date.slice(0, 10),
        accountId: t.accountId,
        originalQuantity: qty,
        remaining: qty,
        costCcy,
        fxAtBuy: ccy === "HUF" ? 1 : histFxRate(history, ccy, t.date, fx),
      };
      queue.push(lot);
      allLots.push(lot);
    } else {
      let toSell = t.quantity ?? 0;
      for (const lot of queue) {
        if (toSell <= 1e-9) break;
        const take = Math.min(lot.remaining, toSell);
        if (take > 0) {
          lot.remaining -= take;
          toSell -= take;
          hadSells = true;
        }
      }
    }
  }
  const lots = allLots
    .filter((l) => l.remaining > 1e-9)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { lots, hadSells };
}

/**
 * Per-purchase breakdown for one ETF/stock/fund: each still-held buy with its
 * date, quantity, unit price, the FX paid, and — at today's price — what it's
 * worth now and its return. Answers "how did each of my buys do", which the
 * avg-cost holdings row hides.
 */
export function purchaseLots(
  instrumentKey: string,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  fxHistory?: FxHistory,
): PurchaseLotsResult {
  const inst = instruments.get(instrumentKey);
  const ccy: Currency = inst?.currency ?? "HUF";
  const history = fxHistory ?? buildFxHistory(txs);
  const currentPrice = prices.get(instrumentKey);
  const fxNow = ccy === "HUF" ? 1 : (fx[ccy] ?? 1);

  const { lots: open, hadSells } = nettedOpenLots(
    instrumentKey,
    txs,
    ccy,
    history,
    fx,
  );

  const lots: PurchaseLot[] = open.map((l) => {
    const unitCostCcy = l.costCcy / l.originalQuantity;
    const costCcy = l.remaining * unitCostCcy;
    const costHuf = costCcy * l.fxAtBuy;
    const currentValueHuf =
      currentPrice != null ? l.remaining * currentPrice * fxNow : undefined;
    const plHuf =
      currentValueHuf != null ? currentValueHuf - costHuf : undefined;
    return {
      date: l.date,
      accountId: l.accountId,
      quantity: l.remaining,
      originalQuantity: l.originalQuantity,
      unitCostCcy,
      costCcy,
      fxAtBuy: l.fxAtBuy,
      costHuf,
      currentValueHuf,
      plHuf,
      plPct: plHuf != null && costHuf > 0 ? plHuf / costHuf : undefined,
    };
  });

  return { currency: ccy, currentPrice, lots, hadSells };
}

export interface BondLot {
  /** ISO day (YYYY-MM-DD) of the purchase. */
  date: string;
  accountId: string;
  /** Face value (HUF nominal) still held from this purchase. */
  faceValue: number;
  /** Face originally bought (before any redemption reduced this lot). */
  originalFaceValue: number;
  /** What was paid for the still-held face (HUF). */
  costHuf: number;
  /** Purchase price as a fraction of par (costHuf / faceValue). */
  pricePct: number;
  /** Accreted/redeemable value of the still-held face today (HUF). */
  currentValueHuf: number;
  /** currentValueHuf − costHuf. */
  gainHuf: number;
  /** gainHuf / costHuf. */
  gainPct: number;
}

export interface BondLotsResult {
  lots: BondLot[];
  hadRedemptions: boolean;
  /** Series maturity (ISO day), if known. */
  maturity?: string;
  /** Next coupon date (ISO day) for a fixed-rate series, if any. */
  nextCoupon?: string;
  /** Annual coupon rate (fraction) for a fixed-rate series. */
  couponRate?: number;
  /** True when series terms are missing → lots are valued at par. */
  needsData: boolean;
}

/**
 * Per-purchase breakdown for one bond (gov_bond / tbill): each still-held buy
 * with its face value, purchase price (% of par), the accreted/redeemable value
 * today, and the gain since purchase. Redemptions net against buys FIFO per
 * account. Discount T-bills accrete from each lot's own purchase date; fixed
 * bonds add coupon accrual (redeemable-today value, i.e. minus the early-sale
 * cost before maturity — matching the holdings row).
 */
export function bondLots(
  instrumentKey: string,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  now: Date = new Date(),
): BondLotsResult {
  const inst = instruments.get(instrumentKey);
  const history = buildFxHistory(txs);
  const { lots: open, hadSells } = nettedOpenLots(
    instrumentKey,
    txs,
    "HUF",
    history,
    {},
  );
  const bondNowMs = bondValuationMs(now.getTime());

  let needsData = false;
  const lots: BondLot[] = open.map((l) => {
    const faceValue = l.remaining;
    const costHuf = l.costCcy * (l.remaining / l.originalQuantity);
    const bv = bondMarketValue(
      inst,
      faceValue,
      costHuf,
      Date.parse(l.date),
      bondNowMs,
    );
    if (bv.needsData) needsData = true;
    const gainHuf = bv.value - costHuf;
    return {
      date: l.date,
      accountId: l.accountId,
      faceValue,
      originalFaceValue: l.originalQuantity,
      costHuf,
      pricePct: faceValue > 0 ? costHuf / faceValue : 0,
      currentValueHuf: bv.value,
      gainHuf,
      gainPct: costHuf > 0 ? gainHuf / costHuf : 0,
    };
  });

  return {
    lots,
    hadRedemptions: hadSells,
    maturity: inst?.bond?.maturity ?? inst?.maturity,
    nextCoupon: inst?.bond ? nextCouponDate(inst.bond, now) : undefined,
    couponRate: inst?.bond?.couponRate,
    needsData,
  };
}
