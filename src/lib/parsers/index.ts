import type { Transaction } from "../model";
import { parseLightyear } from "./lightyear";
import { parseTreasury } from "./treasury";
import { emptyParsed, type ParsedImport } from "./types";

export type { ParsedImport } from "./types";

/** Detect the statement type and parse a single dropped file. */
export async function parseFile(file: File): Promise<ParsedImport> {
  const name = file.name;
  const lower = name.toLowerCase();

  if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
    const buf = await file.arrayBuffer();
    return parseTreasury(name, buf);
  }

  if (lower.endsWith(".csv")) {
    const text = await file.text();
    // Lightyear statements carry these headers.
    if (/Ticker|ISIN|Net Amt\./i.test(text) || /LY-/i.test(name)) {
      return parseLightyear(name, text);
    }
    const out = emptyParsed(name);
    out.warnings.push(
      `${name}: ismeretlen CSV formátum (nem Lightyear kivonat).`,
    );
    return out;
  }

  const out = emptyParsed(name);
  out.warnings.push(`${name}: nem támogatott fájltípus.`);
  return out;
}

/** Parse many files and merge into one result. */
export async function parseFiles(files: File[]): Promise<ParsedImport> {
  // One corrupt file must not abort the whole batch — it becomes a warning,
  // the healthy files still import.
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        return await parseFile(file);
      } catch (e) {
        const out = emptyParsed(file.name);
        out.warnings.push(
          `${file.name}: nem sikerült feldolgozni (${
            e instanceof Error ? e.message : String(e)
          }).`,
        );
        return out;
      }
    }),
  );
  const warnings = results.flatMap((r) => r.warnings);
  return {
    source: files.map((f) => f.name).join(", "),
    accounts: dedupe(
      results.flatMap((r) => r.accounts),
      (a) => a.id,
    ),
    instruments: dedupe(
      results.flatMap((r) => r.instruments),
      (i) => i.key,
    ),
    transactions: dedupeTxs(
      results.flatMap((r) => r.transactions),
      warnings,
    ),
    warnings,
  };
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.values()];
}

/** Two rows with the same id but identical content = the same statement row. */
function sameTx(a: Transaction, b: Transaction): boolean {
  return (
    a.accountId === b.accountId &&
    a.date === b.date &&
    a.type === b.type &&
    a.instrumentKey === b.instrumentKey &&
    a.currency === b.currency &&
    a.grossAmount === b.grossAmount &&
    a.netAmount === b.netAmount &&
    a.quantity === b.quantity
  );
}

/**
 * Dedupe by id, but a 32-bit hash CAN collide for two genuinely different
 * rows — those must not be silently dropped as "duplicates". A collider gets
 * a deterministic suffix (row order is the statement order, so re-imports
 * produce the same ids).
 */
function dedupeTxs(items: Transaction[], warnings: string[]): Transaction[] {
  const map = new Map<string, Transaction>();
  for (const t of items) {
    let id = t.id;
    for (;;) {
      const prev = map.get(id);
      if (!prev) {
        map.set(id, id === t.id ? t : { ...t, id });
        break;
      }
      if (sameTx(prev, t)) break; // true duplicate row — drop
      id = `${id}~x`; // hash collision between different rows — keep both
      if (id === `${t.id}~x`) {
        warnings.push(
          `Azonosító-ütközés két eltérő tranzakció között (${t.date}, ${t.type}) — mindkettő megtartva.`,
        );
      }
    }
  }
  return [...map.values()];
}
