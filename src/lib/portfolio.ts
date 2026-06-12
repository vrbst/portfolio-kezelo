// ---------------------------------------------------------------------------
// Pure analytics: turn raw transactions into holdings, balances and P/L.
// ---------------------------------------------------------------------------

import type {
  Account,
  Currency,
  Instrument,
  Transaction,
} from './model'

/** Current price lookup, in the instrument's own currency. */
export type PriceMap = Map<string, number>

export interface HoldingView {
  instrumentKey: string
  instrument?: Instrument
  quantity: number
  /** Cost basis remaining (avg-cost method), instrument currency. */
  costBasisCcy: number
  avgCost: number
  currency: Currency
  /** Current price (instrument ccy), if known. */
  currentPrice?: number
  /** Market value in instrument currency. */
  marketValueCcy?: number
  /** Market value converted to HUF. */
  marketValueHuf?: number
  /** Cost basis converted to HUF (par/face proxy for bonds). */
  costBasisHuf: number
  unrealizedPlHuf?: number
}

export interface CashByCurrency {
  [currency: string]: number
}

export interface AccountSummary {
  account: Account
  holdings: HoldingView[]
  cash: CashByCurrency
  /** Σ external deposits − withdrawals, account currency (HUF). */
  netDepositedHuf: number
  holdingsValueHuf: number
  cashValueHuf: number
  totalValueHuf: number
  costBasisHuf: number
  unrealizedPlHuf: number
  realizedPlHuf: number
  interestHuf: number
  feesHuf: number
  taxHuf: number
}

export interface PortfolioSummary {
  accounts: AccountSummary[]
  totalValueHuf: number
  holdingsValueHuf: number
  cashValueHuf: number
  netDepositedHuf: number
  costBasisHuf: number
  unrealizedPlHuf: number
  realizedPlHuf: number
  interestHuf: number
  totalPlHuf: number
  /** total P/L as a fraction of net deposited. */
  totalReturnPct: number
}

const BOND_TYPES = new Set(['gov_bond', 'tbill'])

/**
 * Convert an amount to HUF.
 *  - HUF stays as is.
 *  - other currencies use `fx[ccy]` (units of HUF per 1 unit of ccy).
 */
function toHuf(amount: number, ccy: Currency, fx: Record<string, number>) {
  if (ccy === 'HUF') return amount
  const rate = fx[ccy]
  return rate ? amount * rate : amount // fall back to raw if rate unknown
}

export function computeAccountSummary(
  account: Account,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
): AccountSummary {
  const accountTxs = txs
    .filter((t) => t.accountId === account.id)
    .sort((a, b) => a.date.localeCompare(b.date))

  // ---- Holdings (avg-cost) + realized P/L ----
  const positions = new Map<
    string,
    { qty: number; cost: number; ccy: Currency; realized: number }
  >()
  let realizedPlHuf = 0
  let interestHuf = 0
  let feesHuf = 0
  let taxHuf = 0
  const cash: CashByCurrency = {}

  const addCash = (ccy: Currency, amount: number) => {
    cash[ccy] = (cash[ccy] ?? 0) + amount
  }

  for (const t of accountTxs) {
    if (t.internal) continue // mirror entries — excluded from cash / P&L
    const ccy = t.currency || 'HUF'
    if (t.fee) feesHuf += toHuf(t.fee, ccy, fx)
    if (t.taxAmount) taxHuf += toHuf(t.taxAmount, ccy, fx)

    switch (t.type) {
      case 'buy': {
        if (!t.instrumentKey) break
        const inst = instruments.get(t.instrumentKey)
        const p = positions.get(t.instrumentKey) ?? {
          qty: 0,
          cost: 0,
          ccy: inst?.currency ?? ccy,
          realized: 0,
        }
        const qty = t.quantity ?? 0
        const spend = Math.abs(t.grossAmount ?? t.netAmount ?? 0)
        p.qty += qty
        p.cost += spend
        positions.set(t.instrumentKey, p)
        addCash(ccy, -spend) // money left the cash pocket
        break
      }
      case 'sell':
      case 'redemption': {
        if (!t.instrumentKey) break
        const p = positions.get(t.instrumentKey)
        const qty = t.quantity ?? 0
        const proceeds = Math.abs(t.grossAmount ?? t.netAmount ?? 0)
        if (p && p.qty > 0) {
          const soldFrac = qty > 0 ? Math.min(qty / p.qty, 1) : 1
          const costOut = p.cost * soldFrac
          const realized = proceeds - costOut
          p.realized += realized
          realizedPlHuf += toHuf(realized, p.ccy, fx)
          p.qty -= qty
          p.cost -= costOut
          if (p.qty < 1e-9) {
            p.qty = 0
            p.cost = 0
          }
          positions.set(t.instrumentKey, p)
        }
        addCash(ccy, proceeds)
        break
      }
      case 'interest': {
        const amt = t.netAmount ?? t.grossAmount ?? 0
        interestHuf += toHuf(amt, ccy, fx)
        addCash(ccy, amt)
        break
      }
      case 'deposit':
        addCash(ccy, Math.abs(t.netAmount ?? t.grossAmount ?? 0))
        break
      case 'withdrawal':
        addCash(ccy, -Math.abs(t.netAmount ?? t.grossAmount ?? 0))
        break
      case 'conversion': {
        // A conversion leg moves money between currency pockets.
        const amt = t.netAmount ?? t.grossAmount ?? 0
        addCash(ccy, amt)
        break
      }
      case 'fee':
        addCash(ccy, -Math.abs(t.netAmount ?? t.fee ?? 0))
        break
      case 'dividend':
        addCash(ccy, Math.abs(t.netAmount ?? t.grossAmount ?? 0))
        break
      default:
        break
    }
  }

  // ---- Build holding views ----
  const holdings: HoldingView[] = []
  let holdingsValueHuf = 0
  let costBasisHuf = 0
  let unrealizedPlHuf = 0

  for (const [key, p] of positions) {
    if (p.qty <= 1e-9) continue
    const inst = instruments.get(key)
    const ccy = p.ccy
    const isBond = inst ? BOND_TYPES.has(inst.type) : false
    const avgCost = p.qty > 0 ? p.cost / p.qty : 0
    const currentPrice = prices.get(key)

    let marketValueCcy: number | undefined
    if (isBond) {
      // Value bonds/T-bills at nominal held (par proxy).
      marketValueCcy = p.qty
    } else if (currentPrice != null) {
      marketValueCcy = p.qty * currentPrice
    } else {
      marketValueCcy = p.cost // fall back to cost if no price yet
    }

    const marketValueHuf = toHuf(marketValueCcy, ccy, fx)
    const costBasisHufThis = isBond ? p.cost : toHuf(p.cost, ccy, fx)
    const unrealized = marketValueHuf - costBasisHufThis

    holdingsValueHuf += marketValueHuf
    costBasisHuf += costBasisHufThis
    unrealizedPlHuf += unrealized

    holdings.push({
      instrumentKey: key,
      instrument: inst,
      quantity: p.qty,
      costBasisCcy: p.cost,
      avgCost,
      currency: ccy,
      currentPrice: isBond ? undefined : currentPrice,
      marketValueCcy,
      marketValueHuf,
      costBasisHuf: costBasisHufThis,
      unrealizedPlHuf: unrealized,
    })
  }

  holdings.sort((a, b) => (b.marketValueHuf ?? 0) - (a.marketValueHuf ?? 0))

  // ---- Net deposited (external money in − out), HUF ----
  let netDepositedHuf = 0
  for (const t of accountTxs) {
    if (t.internal) continue
    if (t.type === 'deposit')
      netDepositedHuf += toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      )
    if (t.type === 'withdrawal')
      netDepositedHuf -= toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      )
  }

  const cashValueHuf = Object.entries(cash).reduce(
    (sum, [ccy, amt]) => sum + toHuf(amt, ccy, fx),
    0,
  )

  return {
    account,
    holdings,
    cash,
    netDepositedHuf,
    holdingsValueHuf,
    cashValueHuf,
    totalValueHuf: holdingsValueHuf + cashValueHuf,
    costBasisHuf,
    unrealizedPlHuf,
    realizedPlHuf,
    interestHuf,
    feesHuf,
    taxHuf,
  }
}

export function computePortfolio(
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
): PortfolioSummary {
  const summaries = accounts.map((a) =>
    computeAccountSummary(a, txs, instruments, prices, fx),
  )

  const sum = (pick: (s: AccountSummary) => number) =>
    summaries.reduce((acc, s) => acc + pick(s), 0)

  const holdingsValueHuf = sum((s) => s.holdingsValueHuf)
  const cashValueHuf = sum((s) => s.cashValueHuf)
  const netDepositedHuf = sum((s) => s.netDepositedHuf)
  const costBasisHuf = sum((s) => s.costBasisHuf)
  const unrealizedPlHuf = sum((s) => s.unrealizedPlHuf)
  const realizedPlHuf = sum((s) => s.realizedPlHuf)
  const interestHuf = sum((s) => s.interestHuf)
  const totalValueHuf = holdingsValueHuf + cashValueHuf
  const totalPlHuf = totalValueHuf - netDepositedHuf

  return {
    accounts: summaries,
    totalValueHuf,
    holdingsValueHuf,
    cashValueHuf,
    netDepositedHuf,
    costBasisHuf,
    unrealizedPlHuf,
    realizedPlHuf,
    interestHuf,
    totalPlHuf,
    totalReturnPct: netDepositedHuf > 0 ? totalPlHuf / netDepositedHuf : 0,
  }
}
