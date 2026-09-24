// ---------------------------------------------------------------------------
// Realized income per year and the FX effect on the portfolio. Grew out of portfolio.ts, which re-exports everything here.
// ---------------------------------------------------------------------------

import type { Account, Currency, Instrument, Transaction } from "./model";
import {
  buildFxHistory,
  histFxRate,
  isInternalTransfer,
  toHuf,
  type PortfolioSummary,
} from "./portfolio";

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
