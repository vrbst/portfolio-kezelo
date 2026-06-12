import type { Account, Instrument, Transaction, TxType } from '../model'
import { parseCsvObjects, num } from './csv'
import { hashId, slug, parseDmyDateTime } from './util'
import { emptyParsed, type ParsedImport } from './types'

// Lightyear "Account statement" CSV.
// Columns: Date, Reference, Ticker, ISIN, Type, Quantity, CCY, Price/share,
//          Gross Amount, FX Rate, Fee, Net Amt., Tax Amt.

const TYPE_MAP: Record<string, TxType> = {
  buy: 'buy',
  sell: 'sell',
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  conversion: 'conversion',
  dividend: 'dividend',
  interest: 'interest',
  fee: 'fee',
}

/** Pull the account ref out of the file name (LY-8WRK5A8). */
function refFromName(fileName: string): string | undefined {
  const m = fileName.match(/LY-([A-Z0-9]+)/i)
  return m ? `LY-${m[1].toUpperCase()}` : undefined
}

function classifyInstrument(
  ticker: string,
  isin: string,
): Instrument | undefined {
  const t = ticker.trim()
  const i = isin.trim()
  if (!i && !t) return undefined
  // A bare currency code in the Ticker column (EUR/HUF) is a conversion leg,
  // not a real instrument.
  if (!i && /^[A-Z]{3}$/.test(t)) return undefined
  const key = i || slug(t)
  return {
    key,
    name: t || i,
    type: 'etf', // Lightyear holdings in scope are ETFs; refined later if needed.
    isin: i || undefined,
    ticker: t || undefined,
    currency: 'EUR',
  }
}

export function parseLightyear(
  fileName: string,
  text: string,
): ParsedImport {
  const out = emptyParsed(fileName)
  const rows = parseCsvObjects(text)
  if (rows.length === 0) {
    out.warnings.push(`${fileName}: üres vagy felismerhetetlen CSV.`)
    return out
  }

  const externalRef = refFromName(fileName)
  const hasSecurities = rows.some((r) =>
    /^(buy|sell)$/i.test((r['Type'] || '').trim()),
  )

  const account: Account = {
    id: externalRef ? slug(externalRef) : `lightyear-${slug(fileName)}`,
    name: hasSecurities
      ? `Lightyear befektetési${externalRef ? ` (${externalRef})` : ''}`
      : `Lightyear pénzszámla${externalRef ? ` (${externalRef})` : ''}`,
    provider: 'lightyear',
    kind: hasSecurities ? 'regular' : 'cash',
    currency: 'HUF',
    externalRef,
  }
  out.accounts.push(account)

  const instruments = new Map<string, Instrument>()

  for (const r of rows) {
    const rawType = (r['Type'] || '').trim().toLowerCase()
    const type = TYPE_MAP[rawType]
    if (!type) {
      out.warnings.push(`${fileName}: ismeretlen típus „${r['Type']}".`)
      continue
    }

    const date = parseDmyDateTime(r['Date'] || '')
    const ccy = (r['CCY'] || 'HUF').trim() || 'HUF'
    const instrument =
      type === 'buy' || type === 'sell'
        ? classifyInstrument(r['Ticker'] || '', r['ISIN'] || '')
        : undefined
    if (instrument && !instruments.has(instrument.key)) {
      instruments.set(instrument.key, instrument)
    }

    const grossAmount = num(r['Gross Amount'])
    const netAmount = num(r['Net Amt.'])
    const reference = (r['Reference'] || '').trim()

    const tx: Transaction = {
      id: hashId(
        account.id,
        reference,
        date,
        type,
        instrument?.key,
        ccy,
        grossAmount ?? netAmount,
      ),
      accountId: account.id,
      date,
      type,
      instrumentKey: instrument?.key,
      quantity: num(r['Quantity']),
      pricePerUnit: num(r['Price/share']),
      currency: ccy,
      grossAmount,
      fee: num(r['Fee']),
      netAmount,
      taxAmount: num(r['Tax Amt.']),
      fxRate: num(r['FX Rate']),
      reference,
      raw: r,
    }
    out.transactions.push(tx)
  }

  out.instruments.push(...instruments.values())
  return out
}
