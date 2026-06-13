// ---------------------------------------------------------------------------
// Domain model — shared across importers, storage and the UI.
// ---------------------------------------------------------------------------

export type Currency = 'HUF' | 'EUR' | 'USD' | string

/** Where the account is held. */
export type Provider = 'lightyear' | 'allamkincstar' | string

/**
 * Account flavour:
 *  - 'tbsz'     — Tartós Befektetési Számla (has a vintage / gyűjtőév year)
 *  - 'treasury' — Magyar Államkincstár állampapír-számla
 *  - 'regular'  — sima befektetési számla
 *  - 'cash'     — kapcsolódó pénzszámla
 */
export type AccountKind = 'tbsz' | 'treasury' | 'regular' | 'cash'

export interface Account {
  id: string
  name: string
  provider: Provider
  kind: AccountKind
  currency: Currency
  /** TBSZ vintage year (the "gyűjtőév"), e.g. 2024. Only for kind === 'tbsz'. */
  tbszYear?: number
  /** External account reference from the statement (e.g. LY-8WRK5A8, 60179832). */
  externalRef?: string
  openedAt?: string
  /** id of the linked cash account, if any. */
  linkedCashAccountId?: string
}

export type InstrumentType =
  | 'etf'
  | 'stock'
  | 'gov_bond' // állampapír (PMÁP, FixMÁP, MÁP Plusz…)
  | 'tbill' // diszkont kincstárjegy
  | 'fund'
  | 'cash'

/**
 * User-supplied terms for a bond series, used to value it between imports
 * (accrued interest from the coupon schedule). Derivable items (maturity) may be
 * overridden here too.
 */
export interface BondTerms {
  /** Kibocsátás dátuma (ISO). */
  issueDate?: string
  /** Éves névleges kamat, tört alakban (0.07 = 7%). */
  couponRate?: number
  /** Kamatfizetés gyakorisága hónapban (12 = éves, 6 = féléves, 3 = negyedéves). */
  couponIntervalMonths?: number
  /** Az első (vagy bármely ismert) kamatfizetés dátuma (ISO) — ettől lépdel. */
  firstCouponDate?: string
  /** Lejárat felülírása, ha a névből származtatott pontatlan (ISO). */
  maturity?: string
  /**
   * Lejárat előtti eladási/visszaváltási költség a névérték törtjében
   * (FixMÁP-nál 0.01 = 1%). Lejáratkor nem vonódik le. Alapértelmezés 1%.
   */
  saleCostPct?: number
  /**
   * Az első (tört) kamatfizetés pontos összege HUF-ban, kézzel megadva. A tört
   * első periódus nap-számlálási konvenciója nem rekonstruálható forintra, ezért
   * ha tudod a MÁK-értéket, ide beírhatod. Üresen a becsült érték jelenik meg.
   */
  firstCouponHuf?: number
}

export interface Instrument {
  /** Stable key: ISIN if known, otherwise a slug of the name. */
  key: string
  name: string
  type: InstrumentType
  isin?: string
  ticker?: string
  currency: Currency
  /** Bonds/T-bills: maturity date if derivable (e.g. D260527 -> 2026-05-27). */
  maturity?: string
  /** Bonds: face value per unit (névérték), usually 1 (HUF). */
  faceValue?: number
  /** Bonds: user-supplied series terms for accurate valuation. */
  bond?: BondTerms
}

/** Normalised transaction type across all providers. */
export type TxType =
  | 'buy'
  | 'sell'
  | 'deposit'
  | 'withdrawal'
  | 'conversion'
  | 'fee'
  | 'interest' // kamat (állampapír)
  | 'redemption' // beváltás / lejárat
  | 'tax'
  | 'dividend'
  | 'transfer'

export interface Transaction {
  id: string
  accountId: string
  /** ISO datetime. */
  date: string
  type: TxType
  /** Instrument key when the tx relates to a security. */
  instrumentKey?: string
  quantity?: number
  pricePerUnit?: number
  currency: Currency
  /** Gross amount in `currency`. */
  grossAmount?: number
  fee?: number
  /** Net cash impact in `currency` (sign meaningful: + in, − out). */
  netAmount?: number
  taxAmount?: number
  fxRate?: number
  /**
   * Internal sub-ledger mirror entry (e.g. Államkincstár "Pénzszámla
   * be-/kifizetés" that mirrors a bond settlement or transfer). Kept for the
   * history view but excluded from cash / P&L computation to avoid double
   * counting.
   */
  internal?: boolean
  /** Statement reference id. */
  reference?: string
  /** Original parsed row, for debugging / audit. */
  raw?: Record<string, unknown>
}

/** Derived position for an instrument inside one account. */
export interface Holding {
  accountId: string
  instrumentKey: string
  quantity: number
  /** Total invested (cost basis) in the instrument's currency. */
  investedCcy: number
  /** Average cost per unit in the instrument's currency. */
  avgCost: number
  /** Total invested converted to HUF (using historical FX at purchase). */
  investedHuf: number
}

export interface ImportResult {
  source: string
  accountsTouched: string[]
  transactionsAdded: number
  transactionsSkipped: number
  warnings: string[]
}
