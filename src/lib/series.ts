// ---------------------------------------------------------------------------
// Portfolio value over time: the daily value/invested series behind the
// dashboard chart. Grew out of portfolio.ts, which re-exports everything here.
// ---------------------------------------------------------------------------

import type { Account, Instrument, Transaction } from "./model";
import {
  buildFxHistory,
  computePortfolio,
  histFxRate,
  isInternalTransfer,
  toHuf,
  type PriceMap,
} from "./portfolio";

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
    // Value the holdings at the SAME instant used as the transaction cutoff
    // (end of `day`), not local noon. Bond accrued interest resets on the coupon
    // boundary; a coupon tx is stored at the value date's local midnight (=
    // 22:00Z east of UTC), so it lands in cash as of `dayEnd`. Valuing accrual at
    // local noon of the same UTC day-string would be BEFORE that boundary, so the
    // bond would still carry a full period of accrued interest while the coupon
    // is already in cash → the coupon double-counts for one sample (a phantom
    // spike on the coupon day). Aligning both to `dayEnd` keeps them consistent.
    const s = computePortfolio(
      accounts,
      txsUpTo,
      instruments,
      pricesAtD,
      fxAtD,
      new Date(dayEnd),
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

/**
 * The last `points` values of a single account's value curve — the data behind
 * the account-card sparklines. Bridge is off (inter-account transit only matters
 * for the whole-portfolio curve). Returns [] with fewer than 2 samples.
 */
export function accountValueSpark(
  account: Account,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  history?: ValueHistory | null,
  points = 24,
): number[] {
  const s = buildValueSeries(
    [account],
    txs,
    instruments,
    prices,
    fx,
    history,
    new Date(),
    false,
  );
  return s.length >= 2 ? s.slice(-points).map((p) => p.value) : [];
}
