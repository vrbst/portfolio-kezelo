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

// instrument.key (ISIN) -> label + the currency the position is held in.
// `currency` makes the resolver pick the matching listing (e.g. the EUR Xetra
// line, not the USD London line of the same fund).
const INSTRUMENTS = [
  { isin: 'IE00BK5BQT80', label: 'VWCE', currency: 'EUR' },
  { isin: 'GB00BJYDH287', label: 'WBIT', currency: 'EUR' },
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

async function main() {
  const prices = {}
  for (const { isin, label, currency } of INSTRUMENTS) {
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

  const out = {
    updatedAt: new Date().toISOString(),
    fx: eurHuf ? { EUR: eurHuf } : {},
    prices,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  console.log(`\n→ írva: ${OUT}`)
}

main()
