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
  /**
   * Σ EXTERNAL deposits − withdrawals (HUF). Internal transfers between the
   * user's own accounts are excluded, so summing this across accounts gives the
   * true external capital without double counting.
   */
  netDepositedHuf: number
  /** Internal transfers received from the user's other accounts (HUF). */
  transfersInHuf: number
  /** Internal transfers sent to the user's other accounts (HUF). */
  transfersOutHuf: number
  /**
   * Capital committed to THIS account = external net + net internal transfers
   * in. The right denominator for a single account's return (a TBSZ funded by
   * transfers from the cash hub still shows a sensible % on its own holdings).
   */
  capitalBasisHuf: number
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
 * A deposit/withdrawal that is really a transfer between the user's own
 * Lightyear accounts. Lightyear marks these with an `IT-` reference (Internal
 * Transfer), versus `DT-` for real external deposits. Detected by reference so
 * the stored transaction (and its id) stays untouched — no re-import needed.
 */
export function isInternalTransfer(t: Transaction): boolean {
  return (
    (t.type === 'deposit' || t.type === 'withdrawal') &&
    /^IT-/i.test((t.reference ?? '').trim())
  )
}

/**
 * Per-account return on the capital committed to it. Undefined for the cash hub
 * (a pass-through with no meaningful return) and when no capital is committed.
 */
export function accountReturn(s: AccountSummary): number | undefined {
  if (s.account.kind === 'cash') return undefined
  if (s.capitalBasisHuf <= 0) return undefined
  return (s.totalValueHuf - s.capitalBasisHuf) / s.capitalBasisHuf
}

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
  let transfersInHuf = 0
  let transfersOutHuf = 0
  const cash: CashByCurrency = {}

  const addCash = (ccy: Currency, amount: number) => {
    cash[ccy] = (cash[ccy] ?? 0) + amount
  }

  for (const t of accountTxs) {
    if (t.internal) continue // mirror entries — excluded from cash / P&L
    const ccy = t.currency || 'HUF'

    // Internal transfer between the user's own accounts: it moves cash, but it
    // is NOT external capital, so it never touches netDeposited. Tracked
    // separately so a transfer-funded account still shows a real return.
    if (isInternalTransfer(t)) {
      const amt = Math.abs(t.netAmount ?? t.grossAmount ?? 0)
      if (t.type === 'deposit') {
        addCash(ccy, amt)
        transfersInHuf += toHuf(amt, ccy, fx)
      } else {
        addCash(ccy, -amt)
        transfersOutHuf += toHuf(amt, ccy, fx)
      }
      continue
    }

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
        // Incoming money: net of fees is what actually hits the cash pocket.
        const proceeds = Math.abs(t.netAmount ?? t.grossAmount ?? 0)
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
        // Outgoing money: gross is the full debit (incl. fee).
        addCash(ccy, -Math.abs(t.grossAmount ?? t.netAmount ?? 0))
        break
      case 'conversion': {
        // A conversion leg moves money between currency pockets. Gross is the
        // full signed amount moved in this currency (fee is embedded in the
        // spread between the two legs), so using gross keeps the books square.
        const amt = t.grossAmount ?? t.netAmount ?? 0
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

  // ---- Net deposited (EXTERNAL money in − out only), HUF ----
  let netDepositedHuf = 0
  for (const t of accountTxs) {
    if (t.internal) continue
    if (isInternalTransfer(t)) continue // internal — not external capital
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
    transfersInHuf,
    transfersOutHuf,
    capitalBasisHuf: netDepositedHuf + transfersInHuf - transfersOutHuf,
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
