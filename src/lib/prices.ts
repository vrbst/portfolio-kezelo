// Live price + FX loading for the browser.
//  - Live ETF/ETP prices come straight from Yahoo via a CORS Worker proxy
//    (fetchLivePrices), refreshed every few minutes while the app is open.
//  - public/prices.json (written by scripts/fetch-prices.mjs, refreshed by a
//    GitHub Action) is the snapshot fallback for first paint / when live fails.
//  - EUR/HUF is refreshed live from frankfurter.app (CORS-friendly, no key).

import { PREFS_EVENT, touchPref } from "./prefs";
import { toLocalDay, utcDay } from "./day";
import type { Instrument, InstrumentType, Transaction } from "./model";

export interface PriceEntry {
  price: number;
  currency: string;
  symbol?: string;
  label?: string;
  /** Full instrument name (e.g. "Vanguard FTSE All-World UCITS ETF"). */
  name?: string;
}

export interface PriceFile {
  updatedAt?: string;
  fx: Record<string, number>;
  prices: Record<string, PriceEntry>;
}

/** Daily history written by the GitHub Action. Dates are YYYY-MM-DD, ascending. */
export interface HistoryFile {
  updatedAt?: string;
  /** instrument key (ISIN) -> [date, close in instrument currency]. */
  prices: Record<string, [string, number][]>;
  /** 'EUR' -> [date, HUF per 1 EUR]. */
  fx: Record<string, [string, number][]>;
}

/** Load the committed price snapshot (base-path aware for GitHub Pages). */
export async function loadPriceFile(): Promise<PriceFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}prices.json`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as PriceFile;
  } catch {
    return null;
  }
}

/** Load the committed daily-history snapshot, if present. */
export async function loadHistoryFile(): Promise<HistoryFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}history.json`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as HistoryFile;
  } catch {
    return null;
  }
}

/**
 * CORS Worker proxy (host allow-list includes query1.finance.yahoo.com and
 * api.frankfurter.app). Lets the browser read Yahoo quotes, which otherwise
 * block cross-origin requests. Usage: `${PROXY}?url=<encoded target>`.
 */
const PROXY = "https://cold-truth-4d27.vrbst405.workers.dev/";
const proxied = (target: string) =>
  `${PROXY}?url=${encodeURIComponent(target)}`;

// Curated ISIN -> Yahoo symbol for the most liquid, correct-currency listing.
// Trusted over auto-resolution (e.g. WBIT's .SG listing quotes in EUR).
const CURATED_SYMBOLS: Record<string, string> = {
  IE00BK5BQT80: "VWCE.DE",
  GB00BJYDH287: "GB00BJYDH287.SG",
};

// Intraday-curve stand-ins for listings that report no intraday bars. WBIT's
// EUR line (Stuttgart) only has a daily quote, but the ETP holds physical
// bitcoin, so BTC-EUR (traded 24/7) has the same intraday shape. Only the
// curve is borrowed — price and daily % stay the instrument's own.
const INTRADAY_PROXY: Record<string, string> = {
  GB00BJYDH287: "BTC-EUR",
};

// Manual overrides (ISIN/key -> Yahoo symbol), set in Settings when the
// auto-resolved listing is wrong. Synced across devices as a planning pref.
const OVERRIDES_KEY = "portfolio.symbolOverrides";

export function loadSymbolOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveSymbolOverride(isin: string, symbol: string) {
  const map = loadSymbolOverrides();
  const s = symbol.trim();
  if (s) map[isin] = s;
  else delete map[isin];
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  resolvedCache.delete(isin); // re-resolve with the new override next refresh
  touchPref("symbols");
}

// Session cache of resolved symbols (ISIN -> symbol | null) so we hit Yahoo's
// search at most once per ISIN per session.
const resolvedCache = new Map<string, string | null>();

// Overrides pulled from another device must take effect on the next refresh.
if (typeof window !== "undefined") {
  window.addEventListener(PREFS_EVENT, (e) => {
    if ((e as CustomEvent<{ source?: string }>).detail?.source === "remote")
      resolvedCache.clear();
  });
}

/** A live quote plus the context for "today's move" displays. */
export interface LiveQuote {
  price: number;
  /** Previous session's close — the base of the daily change. */
  prevClose?: number;
  /** Today's intraday prices (5-minute bars), oldest first. */
  intraday?: number[];
  /** The previous session's 5-minute bars — the "yesterday" half of the chart. */
  prevDay?: number[];
  /** Bar times (epoch ms) for `intraday` / `prevDay`, index-aligned. */
  intradayT?: number[];
  prevDayT?: number[];
  /** Regular trading session of the listing's exchange (epoch ms). */
  session?: { start: number; end: number };
  /** Exchange display name (e.g. "XETRA"). */
  exchange?: string;
  /** The security's long name (e.g. "Vanguard FTSE All-World UCITS ETF…"). */
  name?: string;
  /** Symbol the intraday curve was borrowed from (see INTRADAY_PROXY). */
  intradayFrom?: string;
  /**
   * When the listing itself last traded (epoch ms) — never the borrowed
   * intraday curve's time. On a weekend it is Friday's close, so `price` vs
   * `prevClose` is Friday's move, not today's.
   */
  marketTime?: number;
  quoteType?: string;
}

/**
 * Did the quote trade on `now`'s local calendar day? Without a known trade
 * time (e.g. the frankfurter fallback) it counts as today's. Lets a notifier
 * tell today's move from the last session's move replayed on a weekend, a
 * holiday or before the open.
 */
export function quotedToday(q: LiveQuote | undefined, now: Date): boolean {
  if (!q) return false;
  return q.marketTime == null || toLocalDay(q.marketTime) === toLocalDay(now);
}

const WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

/**
 * When the quote did not trade today: the day its move (price vs previous
 * close) belongs to — "péntek", or a date when it is older than a week — so
 * it is never shown as today's change. Undefined when it is today's move.
 */
export function lastSessionLabel(q: LiveQuote | undefined, now: Date): string | undefined {
  if (!q || q.marketTime == null || quotedToday(q, now)) return undefined;
  const t = new Date(q.marketTime);
  const days = (now.getTime() - q.marketTime) / 86_400_000;
  return days < 7 ? WEEKDAYS[t.getDay()] : toLocalDay(q.marketTime);
}

/** Is the quote's market in its regular session at `now`? Without a known
 * session (e.g. the frankfurter fallback) it counts as trading. */
export function isTrading(q: LiveQuote | undefined, now: number): boolean {
  return !q?.session || (now >= q.session.start && now < q.session.end);
}

/**
 * Does the "today" curve show the session running right now? False when the
 * market is closed (evening, weekend: the curve is the last finished day) and
 * also right after the open, before the first bar of the new session arrives —
 * then the latest bars are still the previous trading day's.
 */
export function isCurveLive(q: LiveQuote | undefined, now: number): boolean {
  if (!isTrading(q, now)) return false;
  const last = q?.intradayT?.at(-1);
  return !q?.session || last == null || last >= q.session.start;
}

/** Width of a Yahoo intraday bar (the chart is fetched at 5-minute bars). */
const BAR_MS = 5 * 60 * 1000;

/**
 * When the listing really last traded (epoch ms). Yahoo's regularMarketTime
 * is not always the last trade: for a currency pair it is the current time
 * even on a weekend, when the last bar is Friday's — which made Friday's
 * EUR/HUF move read as today's. The listing's own bars are the evidence:
 * the trade time is never later than the end of the last bar.
 */
export function lastTradeTime(
  marketTime: number | undefined,
  lastBarStart: number | undefined,
): number | undefined {
  if (lastBarStart == null) return marketTime;
  const barEnd = lastBarStart + BAR_MS;
  return marketTime == null ? barEnd : Math.min(marketTime, barEnd);
}

const NY_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

/** Is the FX market open at `t`? It trades from Sunday 17:00 to Friday
 * 17:00 New York time (Budapest: Sunday 23:00 to Friday 23:00). */
export function fxMarketOpen(t: number): boolean {
  const parts = NY_TIME.formatToParts(new Date(t));
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return hour >= 17;
  if (weekday === "Fri") return hour < 17;
  return true;
}

/** Bars of a trading week are continuous; a longer gap is the weekend. */
const FX_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Is a currency pair's market time a real tick from a session that has no
 * bars yet? After the Sunday-evening reopen Yahoo's price already moves while
 * the latest 5-minute bars are still Friday's — capping the time by the last
 * bar (lastTradeTime) would label Monday's live rate as Friday's move. On the
 * weekend itself the market is closed, and the cap still applies.
 */
export function isFreshFxTick(
  marketTime: number | undefined,
  lastBarStart: number | undefined,
): boolean {
  return (
    marketTime != null &&
    lastBarStart != null &&
    marketTime - (lastBarStart + BAR_MS) > FX_GAP_MS &&
    fxMarketOpen(marketTime)
  );
}

interface YahooQuote extends LiveQuote {
  currency?: string;
}

async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    // 5-minute bars for the last two sessions: the same call carries the
    // price, the previous close, the intraday curves and the session window.
    const res = await fetch(
      proxied(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol,
        )}?range=2d&interval=5m`,
      ),
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: {
          meta?: {
            regularMarketPrice?: number;
            /** Last trade of the listing, epoch seconds. */
            regularMarketTime?: number;
            currency?: string;
            previousClose?: number;
            chartPreviousClose?: number;
            fullExchangeName?: string;
            /** "CURRENCY" for a currency pair (e.g. EURHUF=X). */
            instrumentType?: string;
            /** Exchange UTC offset, seconds — to split bars by local day. */
            gmtoffset?: number;
            longName?: string;
            shortName?: string;
            currentTradingPeriod?: {
              regular?: { start?: number; end?: number };
            };
          };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const r = data?.chart?.result?.[0];
    const meta = r?.meta;
    const p = meta?.regularMarketPrice;
    if (typeof p !== "number" || p <= 0) return null;
    const prev = meta?.previousClose ?? meta?.chartPreviousClose;
    // Group the bars by the exchange's local calendar day; the last group is
    // the latest session (today, or the last one before the open), the one
    // before it the previous session.
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const stamps = r?.timestamp ?? [];
    const offset = meta?.gmtoffset ?? 0;
    const days: { c: number[]; t: number[] }[] = [];
    let lastDay: number | null = null;
    closes.forEach((c, i) => {
      if (typeof c !== "number" || c <= 0) return;
      const day = Math.floor(((stamps[i] ?? 0) + offset) / 86_400);
      if (day !== lastDay) days.push({ c: [], t: [] });
      lastDay = day;
      days[days.length - 1].c.push(c);
      days[days.length - 1].t.push((stamps[i] ?? 0) * 1000);
    });
    const rawTime =
      typeof meta?.regularMarketTime === "number" && meta.regularMarketTime > 0
        ? meta.regularMarketTime * 1000
        : undefined;
    const lastBar = days.at(-1)?.t.at(-1);
    // A currency pair just reopened (Sunday evening, Monday before the first
    // bar): the live price is the new session's, all the bars are the
    // previous one's, and its last bar is the close today's move starts from.
    const reopened =
      meta?.instrumentType === "CURRENCY" && isFreshFxTick(rawTime, lastBar);
    const today = reopened ? undefined : days.at(-1);
    const before = reopened
      ? days.at(-1)
      : days.length >= 2
        ? days[days.length - 2]
        : undefined;
    const intraday = today?.c ?? [];
    const prevDay = before?.c ?? [];
    const reg = meta?.currentTradingPeriod?.regular;
    const prevClose = reopened ? before?.c.at(-1) : prev;
    return {
      price: p,
      currency: meta?.currency,
      prevClose:
        typeof prevClose === "number" && prevClose > 0 ? prevClose : undefined,
      intraday: intraday.length >= 2 ? intraday : undefined,
      prevDay: prevDay.length >= 2 ? prevDay : undefined,
      intradayT: intraday.length >= 2 ? today!.t : undefined,
      prevDayT: prevDay.length >= 2 ? before!.t : undefined,
      session:
        reg?.start && reg?.end
          ? { start: reg.start * 1000, end: reg.end * 1000 }
          : undefined,
      exchange: meta?.fullExchangeName,
      name: meta?.longName ?? meta?.shortName,
      marketTime: reopened ? rawTime : lastTradeTime(rawTime, lastBar),
      quoteType: meta?.instrumentType,
    };
  } catch {
    return null;
  }
}

/** Best Yahoo symbol for an ISIN via Yahoo's search endpoint, or null. */
async function searchYahooSymbol(isin: string): Promise<string | null> {
  try {
    const res = await fetch(
      proxied(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
          isin,
        )}&quotesCount=8&newsCount=0`,
      ),
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      quotes?: { symbol?: string; quoteType?: string }[];
    };
    const quotes = data?.quotes ?? [];
    const pick =
      quotes.find(
        (q) =>
          q.symbol &&
          (q.quoteType === "ETF" ||
            q.quoteType === "EQUITY" ||
            q.quoteType === "MUTUALFUND"),
      ) ?? quotes.find((q) => q.symbol);
    return pick?.symbol ?? null;
  } catch {
    return null;
  }
}

export interface LivePriceTarget {
  /** instrument.key — what the returned price map is keyed by. */
  key: string;
  /** ISIN used to resolve a symbol (falls back to key). */
  isin: string;
  /** Currency the position is held in; auto-resolved quotes must match it. */
  currency: string;
}

/**
 * Live prices for arbitrary held securities. For each target it resolves a Yahoo
 * symbol (manual override > curated > Yahoo ISIN search, cached per session),
 * fetches the quote and returns instrument key -> price. An AUTO-resolved quote
 * is accepted only when its currency matches the held currency, so a foreign
 * listing never reports a wrong-currency number; override/curated are trusted.
 * Failed/unresolved targets are omitted, so callers keep the snapshot fallback.
 */
interface ResolvedSymbol {
  symbol: string;
  /** Override/curated symbols are trusted; auto-resolved ones need a currency check. */
  trusted: boolean;
}

/** Resolve a target's Yahoo symbol: override > curated > Yahoo ISIN search. */
async function resolveSymbol(
  t: LivePriceTarget,
  overrides: Record<string, string>,
): Promise<ResolvedSymbol | null> {
  const trusted =
    overrides[t.isin] ??
    overrides[t.key] ??
    CURATED_SYMBOLS[t.isin] ??
    CURATED_SYMBOLS[t.key];
  if (trusted) return { symbol: trusted, trusted: true };
  let symbol = resolvedCache.get(t.isin);
  if (symbol === undefined) {
    symbol = await searchYahooSymbol(t.isin);
    resolvedCache.set(t.isin, symbol);
  }
  return symbol ? { symbol, trusted: false } : null;
}

export async function fetchLivePrices(
  targets: LivePriceTarget[],
): Promise<Record<string, LiveQuote>> {
  const overrides = loadSymbolOverrides();
  const results = await Promise.all(
    targets.map(async (t) => {
      const r = await resolveSymbol(t, overrides);
      if (!r) return null;
      const quote = await fetchYahooQuote(r.symbol);
      if (!quote) return null;
      // An auto-resolved listing in the wrong currency is rejected.
      if (!r.trusted && quote.currency && quote.currency !== t.currency)
        return null;
      const { currency: _currency, ...live } = quote;
      const proxy = INTRADAY_PROXY[t.isin] ?? INTRADAY_PROXY[t.key];
      if (!live.intraday && proxy) {
        const p = await fetchYahooQuote(proxy);
        if (p?.intraday) {
          live.intraday = p.intraday;
          live.prevDay = p.prevDay;
          live.intradayT = p.intradayT;
          live.prevDayT = p.prevDayT;
          live.intradayFrom = proxy;
        }
      }
      return [t.key, live] as const;
    }),
  );
  const out: Record<string, LiveQuote> = {};
  for (const r of results) if (r) out[r[0]] = r[1];
  return out;
}

/** Daily close history for one symbol (range like "2y"); ascending [day, close]. */
async function fetchYahooHistory(
  symbol: string,
  range: string,
): Promise<{ series: [string, number][]; currency?: string } | null> {
  try {
    const res = await fetch(
      proxied(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol,
        )}?range=${range}&interval=1d`,
      ),
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: {
          timestamp?: number[];
          meta?: { currency?: string };
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp;
    const close = r?.indicators?.quote?.[0]?.close;
    if (!ts || !close) return null;
    const series: [string, number][] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = close[i];
      if (typeof c !== "number" || c <= 0) continue;
      // Daily bars are stamped inside the trading day, so the UTC day is it.
      const day = utcDay(ts[i] * 1000);
      series.push([day, c]);
    }
    return series.length ? { series, currency: r?.meta?.currency } : null;
  } catch {
    return null;
  }
}

/**
 * Live daily history for the value chart: every held security's close series
 * (resolved like the live price) plus the EUR/HUF series, so a newly bought ETF
 * gets a full chart history without the build-time script knowing about it.
 * Same currency guard as live prices for auto-resolved listings.
 */
export async function fetchLiveHistory(
  targets: LivePriceTarget[],
  range = "5y",
  currencies: string[] = ["EUR"],
): Promise<HistoryFile> {
  const overrides = loadSymbolOverrides();
  const prices: Record<string, [string, number][]> = {};
  const fx: Record<string, [string, number][]> = {};

  await Promise.all([
    ...currencies.map((ccy) =>
      fetchYahooHistory(`${ccy}HUF=X`, range).then((h) => {
        if (h?.series.length) fx[ccy] = h.series;
      }),
    ),
    ...targets.map(async (t) => {
      const r = await resolveSymbol(t, overrides);
      if (!r) return;
      const h = await fetchYahooHistory(r.symbol, range);
      if (!h) return;
      if (!r.trusted && h.currency && h.currency !== t.currency) return;
      prices[t.key] = h.series;
    }),
  ]);

  return { updatedAt: new Date().toISOString(), prices, fx };
}

/**
 * Live HUF rates of the given currencies. Prefers Yahoo's intraday
 * `<CCY>HUF=X` (via the Worker), which actually moves through the day; falls
 * back to frankfurter's ECB reference rate (once-daily, business days only)
 * if Yahoo is unavailable.
 */
export async function fetchLiveFx(
  currencies: string[] = ["EUR"],
): Promise<Record<string, LiveQuote>> {
  const out: Record<string, LiveQuote> = {};
  await Promise.all(
    currencies.map(async (ccy) => {
      const yahoo = await fetchYahooQuote(`${ccy}HUF=X`);
      if (yahoo) {
        const { currency: _currency, quoteType: _quoteType, ...live } = yahoo;
        out[ccy] = live;
        return;
      }
      try {
        const res = await fetch(
          `https://api.frankfurter.app/latest?from=${ccy}&to=HUF`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { rates?: { HUF?: number } };
        if (data.rates?.HUF) out[ccy] = { price: data.rates.HUF };
      } catch {
        /* ignore */
      }
    }),
  );
  return out;
}

export function fxCurrencies(
  instruments: Pick<Instrument, "currency">[],
  transactions: Pick<Transaction, "currency">[] = [],
): string[] {
  const out = new Set<string>(["EUR"]);
  for (const x of [...instruments, ...transactions])
    if (x.currency !== "HUF" && isFxKey(x.currency)) out.add(x.currency);
  return [...out].sort();
}

export function isFxKey(key: string): boolean {
  return /^[A-Z]{3}$/.test(key);
}

const QUOTE_TYPES: Record<string, InstrumentType> = { EQUITY: "stock", ETF: "etf" };

export function refinedInstrumentType(
  inst: Instrument,
  quote: LiveQuote | undefined,
): InstrumentType | undefined {
  if (inst.typeManual || (inst.type !== "etf" && inst.type !== "stock")) return undefined;
  const t = quote?.quoteType ? QUOTE_TYPES[quote.quoteType] : undefined;
  return t && t !== inst.type ? t : undefined;
}

/**
 * Daily FX history: the committed series (ECB fixing) is canonical — the live
 * Yahoo series samples at a different time of day and disagrees with it by up
 * to ~0.5% per day, which permanently perturbs the TWR chain on conversion
 * days. Live data only extends the tail (days after the committed series ends).
 */
/**
 * Merge dated [day, value] series (EUR/HUF rates or per-instrument closes): the
 * committed snapshot is canonical, the live pull only appends days AFTER its last
 * committed day. This keeps the (denser, ECB/build-time) history intact and never
 * lets a sparse or delayed live fetch shorten it — e.g. Yahoo's illiquid .SG
 * listings sometimes return just 1–2 points, which must not clobber a rich
 * committed series (that made a holding's price chart vanish). A key absent from
 * committed is taken wholesale from live (a newly bought ETF the build never saw).
 */
export function mergeDatedSeries(
  committed: Record<string, [string, number][]> | undefined,
  live: Record<string, [string, number][]>,
): Record<string, [string, number][]> {
  const out: Record<string, [string, number][]> = { ...(committed ?? {}) };
  for (const [key, series] of Object.entries(live)) {
    const base = out[key];
    if (!base?.length) {
      out[key] = series;
      continue;
    }
    const lastDay = base[base.length - 1][0];
    const tail = series.filter(([d]) => d > lastDay);
    if (tail.length) out[key] = [...base, ...tail];
  }
  return out;
}
