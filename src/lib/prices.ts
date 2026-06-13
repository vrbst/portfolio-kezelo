// Live price + FX loading for the browser.
//  - ETF prices come from public/prices.json (written by scripts/fetch-prices.mjs,
//    refreshed by a GitHub Action). Keyed by ISIN (== instrument.key).
//  - EUR/HUF is refreshed live from frankfurter.app (CORS-friendly, no key).

export interface PriceEntry {
  price: number
  currency: string
  symbol?: string
  label?: string
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
