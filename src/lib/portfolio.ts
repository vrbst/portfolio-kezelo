// ---------------------------------------------------------------------------
// Pure analytics: turn raw transactions into holdings, balances and P/L.
// ---------------------------------------------------------------------------

import type {
  Account,
  BondTerms,
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
  /** Fixed-rate bond valued at par because its series terms are missing. */
  bondNeedsData?: boolean
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

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)

const DEFAULT_BOND_SALE_COST = 0.01 // FixMÁP early-sale cost (1% of par)

/**
 * Parse a bond date to LOCAL midnight ms. Coupon boundaries are date-only, so
 * everything must compare at day granularity in one timezone — mixing UTC-parsed
 * dates with a local `now` would slip boundaries by the UTC offset (and wrongly
 * accrue a whole period on the coupon day).
 */
function parseDayMs(s: string | undefined): number {
  if (!s) return NaN
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  const d = new Date(s)
  return Number.isNaN(d.getTime())
    ? NaN
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms)
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

/**
 * Bonds are valued on business days at local-midnight granularity: on a weekend
 * MobilKincstár uses the following Monday, so accrued interest runs to Monday.
 */
function bondValuationMs(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0) // local midnight
  const day = d.getDay() // 0 = Sun, 6 = Sat
  if (day === 6) d.setDate(d.getDate() + 2)
  else if (day === 0) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * Accrued-interest fraction of par for a fixed-rate bond from its (user-supplied)
 * coupon schedule. Walks the coupon dates forward from `firstCouponDate` by the
 * interval to the latest boundary on/before `now`, then accrues linearly.
 * Before the first coupon it accrues from the issue date (the first period may be
 * irregular). Returns undefined when there is not enough data (→ value at par).
 */
function fixedBondAccrued(
  bond: BondTerms | undefined,
  nowMs: number,
): number | undefined {
  const rate = bond?.couponRate
  if (!rate || rate <= 0) return undefined
  const interval =
    bond?.couponIntervalMonths && bond.couponIntervalMonths > 0
      ? bond.couponIntervalMonths
      : 12
  const first = parseDayMs(bond?.firstCouponDate)
  const issue = parseDayMs(bond?.issueDate)

  let anchorMs: number
  if (Number.isFinite(first) && nowMs >= first) {
    let cur = first
    for (;;) {
      const next = addMonths(cur, interval)
      if (next > nowMs) break
      cur = next
    }
    anchorMs = cur
  } else if (Number.isFinite(issue)) {
    anchorMs = issue // first coupon not due yet — accrue from issuance
  } else if (Number.isFinite(first)) {
    anchorMs = first
  } else {
    return undefined
  }

  const days = (nowMs - anchorMs) / 86_400_000
  return days > 0 ? (rate * days) / 365 : 0
}

/**
 * Current HUF value of a bond position (face = quantity), more accurate than par:
 *  - Discount T-bill (zero coupon): accretes linearly from the average purchase
 *    price toward par (100%) by maturity. At/after maturity it is par.
 *  - Fixed-rate bond (FixMÁP…): par + accrued coupon from the user-supplied
 *    series terms. Falls back to par (`needsData`) when terms are missing.
 */
function bondMarketValue(
  inst: Instrument | undefined,
  faceQty: number,
  cost: number,
  avgBuyMs: number,
  nowMs: number,
): { value: number; needsData: boolean } {
  const matMs = parseDayMs(inst?.bond?.maturity ?? inst?.maturity)

  if (inst?.type === 'tbill') {
    if (!Number.isFinite(matMs) || nowMs >= matMs)
      return { value: faceQty, needsData: false } // par at/after maturity
    const avgPrice = faceQty > 0 ? cost / faceQty : 1
    const span = matMs - avgBuyMs
    const frac = span > 0 ? clamp01((nowMs - avgBuyMs) / span) : 1
    return { value: faceQty * (avgPrice + (1 - avgPrice) * frac), needsData: false }
  }

  const accrued = fixedBondAccrued(inst?.bond, nowMs)
  if (accrued == null) return { value: faceQty, needsData: true } // par fallback
  // Early-sale cost (what you'd actually get if redeeming now); none at maturity.
  const beforeMaturity = !Number.isFinite(matMs) || nowMs < matMs
  const saleCost = beforeMaturity
    ? (inst?.bond?.saleCostPct ?? DEFAULT_BOND_SALE_COST)
    : 0
  return { value: faceQty * (1 + accrued - saleCost), needsData: false }
}

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
 * Historical EUR/HUF (etc.) rates harvested from `conversion` legs. The two legs
 * of a conversion share a reference; the EFFECTIVE rate is |HUF leg gross| /
 * |foreign leg gross|, which embeds the conversion fee — so a purchase valued at
 * this rate carries its share of the FX fee in the cost basis (not just the
 * fee-free quoted `fxRate`).
 */
export function buildFxHistory(txs: Transaction[]): FxHistory {
  // Group the legs of each conversion together (same account + reference).
  const groups = new Map<string, Transaction[]>()
  for (const t of txs) {
    if (t.type !== 'conversion') continue
    const ref = (t.reference ?? '').trim()
    const key = `${t.accountId}|${ref || t.date}`
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }

  const map: FxHistory = new Map()
  for (const legs of groups.values()) {
    const hufLeg = legs.find((l) => (l.currency || 'HUF') === 'HUF')
    const hufAbs = Math.abs(hufLeg?.grossAmount ?? hufLeg?.netAmount ?? 0)
    if (!hufAbs) continue
    for (const leg of legs) {
      const ccy = leg.currency
      if (!ccy || ccy === 'HUF') continue
      const foreignAbs = Math.abs(leg.grossAmount ?? leg.netAmount ?? 0)
      if (!foreignAbs) continue
      const rate = hufAbs / foreignAbs // effective, fee-inclusive
      if (rate <= 1) continue
      const arr = map.get(ccy) ?? []
      arr.push({ date: leg.date, rate })
      map.set(ccy, arr)
    }
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
  now: Date = new Date(),
): AccountSummary {
  const accountTxs = txs
    .filter((t) => t.accountId === account.id)
    .sort((a, b) => a.date.localeCompare(b.date))
  const history = fxHistory ?? buildFxHistory(txs)
  const nowMs = now.getTime()
  const bondNowMs = bondValuationMs(nowMs) // weekend → next Monday

  // ---- Holdings (avg-cost) + realized P/L ----
  // `cost` is the avg-cost basis in the instrument's own currency; `costHuf` is
  // the same basis fixed in HUF at the historical FX paid on each purchase;
  // `costDateMs` is Σ(spend × buy date) for a cost-weighted average buy date.
  const positions = new Map<
    string,
    {
      qty: number
      cost: number
      costHuf: number
      costDateMs: number
      ccy: Currency
      realized: number
    }
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
          costDateMs: 0,
          ccy: inst?.currency ?? ccy,
          realized: 0,
        }
        const qty = t.quantity ?? 0
        const spend = Math.abs(t.grossAmount ?? t.netAmount ?? 0)
        p.qty += qty
        p.cost += spend
        // Lock the HUF cost at the FX actually paid on the purchase date.
        p.costHuf += spend * histFxRate(history, ccy, t.date, fx)
        p.costDateMs += spend * Date.parse(t.date)
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
          p.costDateMs -= p.costDateMs * soldFrac
          if (p.qty < 1e-9) {
            p.qty = 0
            p.cost = 0
            p.costHuf = 0
            p.costDateMs = 0
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
    let bondNeedsData = false
    if (isBond) {
      const avgBuyMs = p.cost > 0 ? p.costDateMs / p.cost : nowMs
      const bv = bondMarketValue(inst, p.qty, p.cost, avgBuyMs, bondNowMs)
      marketValueCcy = bv.value
      bondNeedsData = bv.needsData
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
      bondNeedsData: bondNeedsData || undefined,
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
  now: Date = new Date(),
): PortfolioSummary {
  const fxHistory = buildFxHistory(txs)
  const summaries = accounts.map((a) =>
    computeAccountSummary(a, txs, instruments, prices, fx, fxHistory, now),
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

export interface ValuePoint {
  /** ISO day (YYYY-MM-DD). */
  date: string
  /** Total portfolio value in HUF as of that day. */
  value: number
  /** Cumulative net external capital (befektetett tőke) in HUF. */
  invested: number
}

/** Daily history series: ascending [YYYY-MM-DD, value] per key. */
export interface ValueHistory {
  prices: Record<string, [string, number][]>
  fx: Record<string, [string, number][]>
}

/** Last value in an ascending [date, value][] series on/before `day`. */
function asOf(
  series: [string, number][] | undefined,
  day: string,
): number | undefined {
  if (!series || series.length === 0) return undefined
  let v: number | undefined
  for (const [d, x] of series) {
    if (d <= day) v = x
    else break
  }
  return v
}

/**
 * Portfolio value over time, reconstructed from the transactions.
 *  - With `history` (daily ETF closes + EUR/HUF from the GitHub Action) each
 *    sample day is marked to the real market close and FX of that day → a
 *    genuine daily curve, sampled weekly.
 *  - Without history we fall back to the price embedded in the most recent
 *    trade on/before the day and the conversion-rate FX, sampled at trade days.
 * Bonds use their accrued value on the day. The final point uses live prices so
 * it matches the dashboard total.
 */
export function buildValueSeries(
  accounts: Account[],
  txs: Transaction[],
  instruments: Map<string, Instrument>,
  prices: PriceMap,
  fx: Record<string, number>,
  history?: ValueHistory | null,
  now: Date = new Date(),
): ValuePoint[] {
  if (txs.length === 0) return []
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date))
  const fxHistory = buildFxHistory(sorted)
  const hasHistory =
    !!history && Object.values(history.prices).some((s) => s.length > 0)

  // Per-instrument trade-price timeline (instrument currency per unit) — the
  // fallback when no market history is available.
  const priceTimeline = new Map<string, { date: string; price: number }[]>()
  for (const t of sorted) {
    if (
      (t.type === 'buy' || t.type === 'sell') &&
      t.instrumentKey &&
      t.pricePerUnit
    ) {
      const arr = priceTimeline.get(t.instrumentKey) ?? []
      arr.push({ date: t.date, price: t.pricePerUnit })
      priceTimeline.set(t.instrumentKey, arr)
    }
  }
  const tradePriceAsOf = (key: string, dayEnd: string): number | undefined => {
    const arr = priceTimeline.get(key)
    if (!arr) return undefined
    let p: number | undefined
    for (const x of arr) {
      if (x.date <= dayEnd) p = x.price
      else break
    }
    return p
  }

  // Bridge money in transit between the user's own accounts. A withdrawal from
  // one account is often funded into another a few days later (e.g. treasury →
  // bank → Lightyear), with no shared reference and possibly split across
  // deposits. FIFO-match external outflows to later external inflows within a
  // short window; for the in-transit interval the amount is added back so the
  // chart doesn't show a phantom dip while the money is between accounts.
  const TRANSIT_DAYS = 10
  const flows = sorted
    .filter(
      (t) =>
        !t.internal && // skip sub-ledger mirror entries (e.g. bond settlements)
        !isInternalTransfer(t) &&
        (t.type === 'deposit' || t.type === 'withdrawal'),
    )
    .map((t) => {
      const huf = toHuf(
        Math.abs(t.netAmount ?? t.grossAmount ?? 0),
        t.currency,
        fx,
      )
      return { day: t.date.slice(0, 10), amt: t.type === 'deposit' ? huf : -huf }
    })
  const pending: { day: string; rem: number }[] = []
  const bridges: { from: string; to: string; amt: number }[] = []
  for (const ev of flows) {
    if (ev.amt < 0) {
      pending.push({ day: ev.day, rem: -ev.amt })
      continue
    }
    let dep = ev.amt
    while (dep > 1 && pending.length) {
      const o = pending[0]
      const gap = (Date.parse(ev.day) - Date.parse(o.day)) / 86_400_000
      if (gap > TRANSIT_DAYS) {
        pending.shift() // too old to be a transfer — treat as real spending
        continue
      }
      const m = Math.min(dep, o.rem)
      if (o.day < ev.day) bridges.push({ from: o.day, to: ev.day, amt: m })
      o.rem -= m
      dep -= m
      if (o.rem < 1) pending.shift()
    }
  }
  const inTransitOn = (day: string) =>
    bridges.reduce((s, b) => (b.from <= day && day < b.to ? s + b.amt : s), 0)

  const todayIso = now.toISOString().slice(0, 10)
  const tradeDays = [...new Set(sorted.map((t) => t.date.slice(0, 10)))]
  // With history, sample at a fixed cadence from the first trade so hovering is
  // smooth: daily for up to ~a year, thinning for longer spans (≤ ~370 points).
  // Trade days are always included so events land exactly on the line.
  const dayset = new Set(tradeDays)
  if (hasHistory) {
    const startMs = Date.parse(tradeDays[0])
    const endMs = Date.parse(todayIso)
    const spanDays = (endMs - startMs) / 86_400_000
    const stepDays = spanDays <= 370 ? 1 : Math.ceil(spanDays / 370)
    for (let t = startMs; t <= endMs; t += stepDays * 86_400_000)
      dayset.add(new Date(t).toISOString().slice(0, 10))
  }
  const days = [...dayset].filter((d) => d <= todayIso).sort()

  const points: ValuePoint[] = []
  for (const day of days) {
    const dayEnd = `${day}T23:59:59.999Z`
    const txsUpTo = sorted.filter((t) => t.date <= dayEnd)
    const pricesAtD: PriceMap = new Map()
    for (const inst of instruments.values()) {
      const p =
        asOf(history?.prices[inst.key], day) ??
        tradePriceAsOf(inst.key, dayEnd)
      if (p != null) pricesAtD.set(inst.key, p)
    }
    const fxAtD = {
      ...fx,
      EUR:
        asOf(history?.fx['EUR'], day) ??
        histFxRate(fxHistory, 'EUR', dayEnd, fx),
    }
    const s = computePortfolio(
      accounts,
      txsUpTo,
      instruments,
      pricesAtD,
      fxAtD,
      new Date(`${day}T12:00:00`),
    )
    const transit = inTransitOn(day)
    points.push({
      date: day,
      value: s.totalValueHuf + transit,
      invested: s.netDepositedHuf + transit,
    })
  }

  // Final point: today, at live prices / FX (matches the dashboard total).
  const live = computePortfolio(accounts, sorted, instruments, prices, fx, now)
  const transitToday = inTransitOn(todayIso)
  const livePoint: ValuePoint = {
    date: todayIso,
    value: live.totalValueHuf + transitToday,
    invested: live.netDepositedHuf + transitToday,
  }
  if (points.length && points[points.length - 1].date === todayIso) {
    points[points.length - 1] = livePoint
  } else {
    points.push(livePoint)
  }
  return points
}
