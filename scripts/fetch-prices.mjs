// Fetches current ETF prices (by ISIN via Yahoo Finance) and EUR/HUF FX,
// then writes public/prices.json. Runs in Node (no CORS) — locally now and
// from a GitHub Action cron later.
//
//   node scripts/fetch-prices.mjs
//
// Extend INSTRUMENTS with any new ISIN you hold.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public/prices.json')
const HIST_OUT = resolve(__dirname, '../public/history.json')
const HISTORY_YEARS = 2

// instrument.key (ISIN) -> label + the currency the position is held in.
// `currency` makes the resolver pick the matching listing (e.g. the EUR Xetra
// line, not the USD London line of the same fund).
// `historySymbol` pins the Yahoo symbol used for the daily history chart, since
// the ISIN search often surfaces a listing (e.g. *.SG) that has no history.
// `proxySymbol` derives the history from an underlying when the instrument has
// no usable Yahoo history of its own. WBIT (physical Bitcoin ETP) tracks BTC, so
// its past prices = BTC history scaled by today's WBIT/BTC ratio. The proxy must
// quote in the instrument's currency (BTC-EUR for the EUR-held WBIT).
const INSTRUMENTS = [
  {
    isin: 'IE00BK5BQT80',
    label: 'VWCE',
    currency: 'EUR',
    historySymbol: 'VWCE.DE',
  },
  {
    isin: 'GB00BJYDH287',
    label: 'WBIT',
    currency: 'EUR',
    proxySymbol: 'BTC-EUR',
  },
]

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
}

async function searchSymbols(isin) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    isin,
  )}&quotesCount=10&newsCount=0`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`search ${isin}: HTTP ${res.status}`)
  const data = await res.json()
  return (data.quotes || []).map((q) => q.symbol).filter(Boolean)
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=1d&interval=1d`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`quote ${symbol}: HTTP ${res.status}`)
  const data = await res.json()
  const meta = data?.chart?.result?.[0]?.meta
  if (!meta?.regularMarketPrice) throw new Error(`no price for ${symbol}`)
  return { price: meta.regularMarketPrice, currency: meta.currency, symbol }
}

/** Pick the listing whose currency matches the position's currency. */
async function resolveQuote(isin, wantCcy) {
  const symbols = await searchSymbols(isin)
  if (symbols.length === 0) throw new Error('nincs tőzsdei szimbólum')
  let fallback = null
  for (const symbol of symbols.slice(0, 8)) {
    try {
      const q = await fetchQuote(symbol)
      if (!fallback) fallback = q
      if (!wantCcy || q.currency === wantCcy) return q
    } catch {
      // try the next listing
    }
  }
  if (fallback) return fallback
  throw new Error('egyik listán sincs ár')
}

async function fetchFx() {
  const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=HUF')
  if (!res.ok) throw new Error(`fx: HTTP ${res.status}`)
  const data = await res.json()
  return data.rates?.HUF
}

/** Daily close history for a resolved symbol: [[YYYY-MM-DD, close], …]. */
async function fetchHistory(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${HISTORY_YEARS}y&interval=1d`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`history ${symbol}: HTTP ${res.status}`)
  const data = await res.json()
  const r = data?.chart?.result?.[0]
  const ts = r?.timestamp || []
  const closes = r?.indicators?.quote?.[0]?.close || []
  const out = []
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i]
    if (c == null) continue
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10)
    out.push([date, Math.round(c * 1e4) / 1e4])
  }
  return out
}

/** Daily EUR/HUF history from frankfurter: [[YYYY-MM-DD, rate], …]. */
async function fetchFxHistory() {
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - HISTORY_YEARS * 365 * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const res = await fetch(
    `https://api.frankfurter.app/${start}..${end}?from=EUR&to=HUF`,
  )
  if (!res.ok) throw new Error(`fx history: HTTP ${res.status}`)
  const data = await res.json()
  return Object.entries(data.rates || {})
    .map(([date, r]) => [date, r.HUF])
    .filter(([, h]) => h != null)
    .sort((a, b) => a[0].localeCompare(b[0]))
}

async function main() {
  const prices = {}
  const histPrices = {}
  for (const { isin, label, currency, historySymbol, proxySymbol } of INSTRUMENTS) {
    try {
      const q = await resolveQuote(isin, currency)
      prices[isin] = {
        price: q.price,
        currency: q.currency,
        symbol: q.symbol,
        label,
      }
      const warn = currency && q.currency !== currency ? '  ⚠ deviza eltér!' : ''
      console.log(
        `✓ ${label} (${isin}) = ${q.price} ${q.currency} [${q.symbol}]${warn}`,
      )
      try {
        if (proxySymbol) {
          // Derive history from the underlying, scaled to today's price ratio.
          const proxy = await fetchHistory(proxySymbol)
          const proxyLast = proxy.at(-1)?.[1]
          if (proxy.length && proxyLast) {
            const ratio = q.price / proxyLast
            histPrices[isin] = proxy.map(([d, p]) => [
              d,
              Math.round(p * ratio * 1e4) / 1e4,
            ])
            console.log(
              `  ↳ ${proxy.length} nap ${proxySymbol}-ből skálázva (arány ${ratio.toExponential(3)})`,
            )
          } else {
            console.warn(`  ↳ nincs proxy history [${proxySymbol}]`)
          }
        } else {
          const histSym = historySymbol || q.symbol
          const hist = await fetchHistory(histSym)
          if (hist.length) {
            histPrices[isin] = hist
            console.log(`  ↳ ${hist.length} napi záróár [${histSym}]`)
          } else {
            console.warn(`  ↳ nincs history [${histSym}]`)
          }
        }
      } catch (err) {
        console.warn(`  ↳ history ${label}: ${err.message}`)
      }
    } catch (err) {
      console.warn(`! ${label} (${isin}): ${err.message}`)
    }
  }

  let eurHuf
  try {
    eurHuf = await fetchFx()
    console.log(`✓ EUR/HUF = ${eurHuf}`)
  } catch (err) {
    console.warn(`! FX: ${err.message}`)
  }

  let fxHist = []
  try {
    fxHist = await fetchFxHistory()
    console.log(`✓ EUR/HUF history: ${fxHist.length} nap`)
  } catch (err) {
    console.warn(`! FX history: ${err.message}`)
  }

  const out = {
    updatedAt: new Date().toISOString(),
    fx: eurHuf ? { EUR: eurHuf } : {},
    prices,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  console.log(`→ írva: ${OUT}`)

  const histOut = {
    updatedAt: new Date().toISOString(),
    prices: histPrices,
    fx: fxHist.length ? { EUR: fxHist } : {},
  }
  writeFileSync(HIST_OUT, JSON.stringify(histOut) + '\n')
  console.log(`→ írva: ${HIST_OUT}`)
}

main()
