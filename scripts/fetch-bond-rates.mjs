import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public/bond-rates.json')
const API = 'https://www.akk.hu/api/data/xpose3-dwh/data'
const DKJ_DAYS = 370

const budapestDay = (ms) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))

const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = (v) => (typeof v === 'string' && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null)
const num = (v) => {
  if (v == null || String(v).trim() === '') return null
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

async function query(params, required) {
  const url = `${API}?${new URLSearchParams(params)}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'portfolio-kezelo' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`${params.query}: HTTP ${res.status}`)
  const body = await res.json()
  if (body?.meta?.status !== 'OK') throw new Error(`${params.query}: státusz ${body?.meta?.status}`)
  if (!Array.isArray(body.data)) throw new Error(`${params.query}: nincs data lista`)
  const names = new Set((body.fields ?? []).map((f) => f.name))
  const missing = required.filter((f) => !names.has(f))
  if (missing.length) throw new Error(`${params.query}: hiányzó mezők: ${missing.join(', ')}`)
  return body.data
}

function rateRange(text) {
  const parts = String(text ?? '')
    .split('-')
    .map((s) => num(s.trim()))
    .filter((n) => n != null)
  return parts.length ? [Math.min(...parts), Math.max(...parts)] : [null, null]
}

async function fetchRetail() {
  const rows = await query({ query: 'getRetailInterestExt', underIssue: '1' }, [
    'type',
    'name',
    'rate',
    'ehm',
    'maturity',
    'validFrom',
    'validTo',
  ])
  return rows
    .filter((r) => r.type && r.name && r.rate != null)
    .map((r) => {
      const [rateMin, rateMax] = rateRange(r.rate)
      return {
        type: String(r.type),
        series: String(r.name),
        rateText: String(r.rate).replace(/\s+/g, ' ').trim(),
        rateMin,
        rateMax,
        ehm: num(r.ehm),
        maturity: day(r.maturity),
        currency: /_EUR$/i.test(r.name) ? 'EUR' : 'HUF',
        validFrom: day(r.validFrom),
        validTo: day(r.validTo),
      }
    })
}

async function fetchPeriods(today) {
  const rows = await query({ query: 'getActualInterests', date: today }, [
    'securityType',
    'name',
    'interest',
    'interestPeriodStart',
    'interestPeriodEnd',
    'paymentDate',
    'maturityDate',
    'currency',
  ])
  return rows
    .map((r) => ({
      type: String(r.securityType ?? ''),
      series: String(r.name ?? ''),
      rate: num(r.interest),
      periodStart: day(r.interestPeriodStart),
      periodEnd: day(r.interestPeriodEnd),
      paymentDate: day(r.paymentDate),
      maturity: day(r.maturityDate),
      currency: String(r.currency ?? 'HUF'),
    }))
    .filter((p) => p.type && p.series && p.rate != null && p.periodStart && p.periodEnd)
}

async function fetchDkj(today) {
  const from = budapestDay(Date.parse(`${today}T12:00:00Z`) - DKJ_DAYS * 86_400_000)
  const rows = await query(
    {
      query: 'getAuction',
      auctionDateStart: from,
      auctionDateEnd: today,
      auctionType: 'ISSUE',
      securityType: 'DKJ',
    },
    ['auctionDate', 'name', 'isin', 'maturityDate', 'avgYield'],
  )
  return rows
    .map((r) => ({
      auctionDate: day(r.auctionDate),
      series: String(r.name ?? ''),
      isin: r.isin ? String(r.isin) : null,
      maturity: day(r.maturityDate),
      avgYield: num(r.avgYield),
    }))
    .filter((a) => a.auctionDate && a.series && a.avgYield != null)
    .sort((a, b) => a.auctionDate.localeCompare(b.auctionDate))
}

async function main() {
  const prev = readJson(OUT)
  const today = budapestDay(Date.now())
  const parts = [
    ['retail', fetchRetail],
    ['periods', () => fetchPeriods(today)],
    ['dkj', () => fetchDkj(today)],
  ]
  const out = { updatedAt: prev?.updatedAt, retail: [], periods: [], dkj: [] }
  let fresh = 0
  for (const [key, run] of parts) {
    try {
      const rows = await run()
      if (key !== 'dkj' && !rows.length) throw new Error('üres válasz')
      out[key] = rows
      fresh++
      console.log(`✓ ${key}: ${rows.length} sor`)
    } catch (err) {
      console.warn(`! ${key}: ${err.message}`)
      if (Array.isArray(prev?.[key])) {
        out[key] = prev[key]
        console.log(`  ↳ ${key} megtartva a korábbi fájlból`)
      }
    }
  }
  if (fresh === parts.length) out.updatedAt = new Date().toISOString()
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out) + '\n')
  console.log(`→ írva: ${OUT}`)
  if (fresh < parts.length) {
    console.error('✗ Az ÁKK-adatok egy része nem frissült — a korábbi adatok maradtak.')
    process.exitCode = 1
  }
}

main()
