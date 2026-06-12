// Minimal, dependency-free CSV parser that handles quoted fields, escaped
// quotes ("") and commas inside quotes. Good enough for broker statements.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false

  // Normalise newlines, strip a leading BOM.
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

  for (let i = 0; i < src.length; i++) {
    const c = src[i]

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }

  // Flush trailing field/row.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Parse rows into objects keyed by the header row. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim()
    })
    return obj
  })
}

/** "1 234,56" or "1,234.56" or "112.47" -> number. Empty -> undefined. */
export function num(value: string | undefined | null): number | undefined {
  if (value == null) return undefined
  const s = String(value).trim()
  if (s === '') return undefined
  // Drop spaces (thousands) and currency symbols.
  let cleaned = s.replace(/\s/g, '').replace(/[^0-9.,\-]/g, '')
  // If both separators present, the last one is the decimal separator.
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (lastComma > -1) {
    // Only commas: treat as decimal if it looks like one (≤2 trailing digits).
    cleaned = cleaned.replace(',', '.')
  }
  const n = Number(cleaned)
  return Number.isNaN(n) ? undefined : n
}
