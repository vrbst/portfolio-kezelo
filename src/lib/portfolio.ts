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

interface FxPoint {
  date: string
  rate: number
}
/** currency -> conversion rates over time (HUF per 1 unit), sorted by date. */
export type FxHistory = Map<string, FxPoint[]>

/**
 * Historical EUR/HUF (etc.) rates harvested from `conversion` legs. Lightyear
 * records the realised rate on the foreign-currency leg, so this is exactly
 * what the user paid to acquire the currency that funded a purchase.
 */
export function buildFxHistory(txs: Transaction[]): FxHistory {
  const map: FxHistory = new Map()
  for (const t of txs) {
    if (t.type !== 'conversion') continue
    const ccy = t.currency
    if (!ccy || ccy === 'HUF') continue
    const rate = t.fxRate
    if (typeof rate !== 'number' || rate <= 1) continue
    const arr = map.get(ccy) ?? []
    arr.push({ date: t.date, rate })
    map.set(ccy, arr)
  }
  for (const arr of map.values())
    arr.sort((a, b) => a.date.localeCompare(b.date))
  return map
}

/** Rate in effect at `date`: the latest conversion on/before it (else nearest). */
function histFxRate(
  history: FxHistory | undefined,
  ccy: Currency,
  date: string,
  fx: Record<string, number>,
): number {
  if (ccy === 'HUF') return 1
  const arr = history?.get(ccy)
  if (arr && arr.length) {
    let chosen = arr[0]
    for (const p of arr) {
      if (p.date <= date) chosen = p
      else break
    }
    return chosen.rate
  }
  return fx[ccy] ?? 1 // no conversion history — fall back to current rate
}

export function computeAccountSummary(
  account: Account,
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  fxHistory?: FxHistory,
): AccountSummary {
  const accountTxs = txs
    .filter((t) => t.accountId === account.id)
    .sort((a, b) => a.date.localeCompare(b.date))
  const history = fxHistory ?? buildFxHistory(txs)

  // ---- Holdings (avg-cost) + realized P/L ----
  // `cost` is the avg-cost basis in the instrument's own currency; `costHuf` is
  // the same basis fixed in HUF at the historical FX paid on each purchase.
  const positions = new Map<
    string,
    { qty: number; cost: number; costHuf: number; ccy: Currency; realized: number }
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
      // Value the transfer in HUF at the FX of its date, so a foreign-currency
      // transfer never inflates an account's basis above what was deposited.
      const huf = amt * histFxRate(history, ccy, t.date, fx)
      if (t.type === 'deposit') {
        addCash(ccy, amt)
        transfersInHuf += huf
      } else {
        addCash(ccy, -amt)
        transfersOutHuf += huf
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
          costHuf: 0,
          ccy: inst?.currency ?? ccy,
          realized: 0,
        }
        const qty = t.quantity ?? 0
        const spend = Math.abs(t.grossAmount ?? t.netAmount ?? 0)
        p.qty += qty
        p.cost += spend
        // Lock the HUF cost at the FX actually paid on the purchase date.
        p.costHuf += spend * histFxRate(history, ccy, t.date, fx)
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
          p.costHuf -= p.costHuf * soldFrac
          if (p.qty < 1e-9) {
            p.qty = 0
            p.cost = 0
            p.costHuf = 0
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
    // HUF cost fixed at the FX paid on purchase (bonds are HUF-native already).
    const costBasisHufThis = isBond ? p.cost : p.costHuf
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
  const fxHistory = buildFxHistory(txs)
  const summaries = accounts.map((a) =>
    computeAccountSummary(a, txs, instruments, prices, fx, fxHistory),
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
