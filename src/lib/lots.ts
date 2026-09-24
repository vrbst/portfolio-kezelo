// ---------------------------------------------------------------------------
// Purchase lots (FIFO open lots) for ETFs and bonds. Grew out of portfolio.ts, which re-exports everything here.
// ---------------------------------------------------------------------------

import type { Currency, Instrument, Transaction } from "./model";
import { bondMarketValue, bondValuationMs, nextCouponDate } from "./bonds";
import {
  buildFxHistory,
  histFxRate,
  type FxHistory,
  type PriceMap,
} from "./portfolio";

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
  /** Nominal + accrued value of the still-held face today (HUF). */
  currentValueHuf: number;
  /**
   * What redeeming this lot today would actually pay (early-sale cost taken
   * off). Undefined when it equals `currentValueHuf`.
   */
  redeemableValueHuf?: number;
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
 * with its face value, purchase price (% of par), today's value, and the gain
 * since purchase. Redemptions net against buys FIFO per account. Discount
 * T-bills accrete from each lot's own purchase date; fixed bonds add coupon
 * accrual — nominal + accrued, matching the holdings row, with the amount an
 * early redemption would actually pay carried separately.
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
      redeemableValueHuf:
        bv.redeemableValue < bv.value - 0.5 ? bv.redeemableValue : undefined,
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
