import type { Currency } from './model'

const HU = 'hu-HU'

export function formatMoney(
  amount: number | null | undefined,
  currency: Currency = 'HUF',
  opts: { decimals?: number; sign?: boolean } = {},
): string {
  if (amount == null || Number.isNaN(amount)) return '—'
  const decimals =
    opts.decimals ?? (currency === 'HUF' ? 0 : 2)
  const formatted = new Intl.NumberFormat(HU, {
    style: 'currency',
    currency: currency || 'HUF',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: opts.sign ? 'always' : 'auto',
  }).format(amount)
  return formatted
}

export function formatNumber(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value == null || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(HU, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function formatPercent(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value == null || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(HU, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: 'always',
  }).format(value)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(HU, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(HU, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** Compact HUF for axis labels: 1 234 567 -> "1,2 M". */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(HU, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

export const isPositive = (n: number | null | undefined) =>
  typeof n === 'number' && n > 0
export const isNegative = (n: number | null | undefined) =>
  typeof n === 'number' && n < 0

/** Convert a HUF amount to EUR using the current EUR/HUF rate (HUF per 1 EUR). */
export function hufToEur(
  huf: number | null | undefined,
  eurHuf: number | null | undefined,
): number | undefined {
  if (huf == null || Number.isNaN(huf)) return undefined
  if (!eurHuf || eurHuf <= 0) return undefined
  return huf / eurHuf
}

/**
 * Formatted "≈ X €" equivalent of a HUF amount, or undefined when the rate is
 * unknown. Use as a muted secondary line under a HUF value.
 */
export function eurEquivalent(
  huf: number | null | undefined,
  eurHuf: number | null | undefined,
  opts: { sign?: boolean } = {},
): string | undefined {
  const eur = hufToEur(huf, eurHuf)
  if (eur == null) return undefined
  return `≈ ${formatMoney(eur, 'EUR', opts)}`
}
