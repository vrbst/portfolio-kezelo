// Live price + FX loading for the browser.
//  - Live ETF/ETP prices come straight from Yahoo via a CORS Worker proxy
//    (fetchLivePrices), refreshed every few minutes while the app is open.
//  - public/prices.json (written by scripts/fetch-prices.mjs, refreshed by a
//    GitHub Action) is the snapshot fallback for first paint / when live fails.
//  - EUR/HUF is refreshed live from frankfurter.app (CORS-friendly, no key).

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

// Per-device manual overrides (ISIN/key -> Yahoo symbol), set in Settings when
// the auto-resolved listing is wrong. Stored locally, never synced.
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
}

// Session cache of resolved symbols (ISIN -> symbol | null) so we hit Yahoo's
// search at most once per ISIN per session.
const resolvedCache = new Map<string, string | null>();

interface YahooQuote {
  price: number;
  currency?: string;
}

async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const res = await fetch(
      proxied(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol,
        )}?range=1d&interval=1d`,
      ),
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: {
          meta?: { regularMarketPrice?: number; currency?: string };
        }[];
      };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    const p = meta?.regularMarketPrice;
    return typeof p === "number" && p > 0
      ? { price: p, currency: meta?.currency }
      : null;
  } catch {
    return null;
  }
}

async function fetchYahooPrice(symbol: string): Promise<number | null> {
  const q = await fetchYahooQuote(symbol);
  return q ? q.price : null;
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
export async function fetchLivePrices(
  targets: LivePriceTarget[],
): Promise<Record<string, number>> {
  const overrides = loadSymbolOverrides();
  const results = await Promise.all(
    targets.map(async (t) => {
      const trusted =
        overrides[t.isin] ??
        overrides[t.key] ??
        CURATED_SYMBOLS[t.isin] ??
        CURATED_SYMBOLS[t.key];
      if (trusted) {
        const price = await fetchYahooPrice(trusted);
        return price == null ? null : ([t.key, price] as const);
      }

      let symbol = resolvedCache.get(t.isin);
      if (symbol === undefined) {
        symbol = await searchYahooSymbol(t.isin);
        resolvedCache.set(t.isin, symbol);
      }
      if (!symbol) return null;
      const quote = await fetchYahooQuote(symbol);
      if (!quote) return null;
      if (quote.currency && quote.currency !== t.currency) return null; // wrong listing
      return [t.key, quote.price] as const;
    }),
  );
  const out: Record<string, number> = {};
  for (const r of results) if (r) out[r[0]] = r[1];
  return out;
}

/**
 * Live EUR->HUF. Prefers Yahoo's intraday EURHUF=X (via the Worker), which
 * actually moves through the day; falls back to frankfurter's ECB reference
 * rate (once-daily, business days only) if Yahoo is unavailable.
 */
export async function fetchLiveFx(): Promise<Record<string, number>> {
  const yahoo = await fetchYahooPrice("EURHUF=X");
  if (yahoo != null) return { EUR: yahoo };
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=EUR&to=HUF",
    );
    if (!res.ok) return {};
    const data = (await res.json()) as { rates?: { HUF?: number } };
    return data.rates?.HUF ? { EUR: data.rates.HUF } : {};
  } catch {
    return {};
  }
}
