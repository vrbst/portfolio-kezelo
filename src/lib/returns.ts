// ---------------------------------------------------------------------------
// Performance metrics: simple return, money-weighted XIRR and time-weighted
// TWR. Grew out of portfolio.ts, which re-exports everything here.
// ---------------------------------------------------------------------------

import type { Account, Instrument, Transaction } from "./model";
import {
  computePortfolio,
  isInternalTransfer,
  toHuf,
  type PriceMap,
} from "./portfolio";
import { buildValueSeries, type ValueHistory } from "./series";

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
