// Live price + FX loading for the browser.
//  - Live ETF/ETP prices come straight from Yahoo via a CORS Worker proxy
//    (fetchLivePrices), refreshed every few minutes while the app is open.
//  - public/prices.json (written by scripts/fetch-prices.mjs, refreshed by a
//    GitHub Action) is the snapshot fallback for first paint / when live fails.
//  - EUR/HUF is refreshed live from frankfurter.app (CORS-friendly, no key).

export interface PriceEntry {
  price: number
  currency: string
  symbol?: string
  label?: string
  /** Full instrument name (e.g. "Vanguard FTSE All-World UCITS ETF"). */
  name?: string
}

export interface PriceFile {
  updatedAt?: string
  fx: Record<string, number>
  prices: Record<string, PriceEntry>
}

/** Daily history written by the GitHub Action. Dates are YYYY-MM-DD, ascending. */
export interface HistoryFile {
  updatedAt?: string
  /** instrument key (ISIN) -> [date, close in instrument currency]. */
  prices: Record<string, [string, number][]>
  /** 'EUR' -> [date, HUF per 1 EUR]. */
  fx: Record<string, [string, number][]>
}

/** Load the committed price snapshot (base-path aware for GitHub Pages). */
export async function loadPriceFile(): Promise<PriceFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}prices.json`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as PriceFile
  } catch {
    return null
  }
}

/** Load the committed daily-history snapshot, if present. */
export async function loadHistoryFile(): Promise<HistoryFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}history.json`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as HistoryFile
  } catch {
    return null
  }
}

/**
 * CORS Worker proxy (host allow-list includes query1.finance.yahoo.com and
 * api.frankfurter.app). Lets the browser read Yahoo quotes, which otherwise
 * block cross-origin requests. Usage: `${PROXY}?url=<encoded target>`.
 */
const PROXY = 'https://cold-truth-4d27.vrbst405.workers.dev/'
const proxied = (target: string) => `${PROXY}?url=${encodeURIComponent(target)}`

// instrument.key (ISIN) -> Yahoo symbol for the live intraday quote.
// VWCE.DE is the primary XETRA listing; WBIT trades on Stuttgart (.SG).
const LIVE_SYMBOLS: Record<string, string> = {
  IE00BK5BQT80: 'VWCE.DE',
  GB00BJYDH287: 'GB00BJYDH287.SG',
}

async function fetchYahooPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      proxied(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol,
        )}?range=1d&interval=1d`,
      ),
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number } }[] }
    }
    const p = data?.chart?.result?.[0]?.meta?.regularMarketPrice
    return typeof p === 'number' && p > 0 ? p : null
  } catch {
    return null
  }
}

/**
 * Live ETF/ETP prices via the CORS Worker → Yahoo. Returns instrument key
 * (ISIN) -> price in the instrument's own currency. Failed symbols are omitted,
 * so callers keep the committed-snapshot value as a fallback.
 */
export async function fetchLivePrices(): Promise<Record<string, number>> {
  const results = await Promise.all(
    Object.entries(LIVE_SYMBOLS).map(async ([isin, symbol]) => {
      const price = await fetchYahooPrice(symbol)
      return price == null ? null : ([isin, price] as const)
    }),
  )
  const out: Record<string, number> = {}
  for (const r of results) if (r) out[r[0]] = r[1]
  return out
}

/** Fresh EUR->HUF straight from the ECB via frankfurter.app. */
export async function fetchLiveFx(): Promise<Record<string, number>> {
  try {
    const res = await fetch(
      'https://api.frankfurter.app/latest?from=EUR&to=HUF',
    )
    if (!res.ok) return {}
    const data = (await res.json()) as { rates?: { HUF?: number } }
    return data.rates?.HUF ? { EUR: data.rates.HUF } : {}
  } catch {
    return {}
  }
}
