import type { Transaction } from "../model";
import { parseLightyear } from "./lightyear";
import { parseTreasury } from "./treasury";
import { isOneMoneyCsv, parseOneMoney } from "./oneMoney";
import { mergeCashflow } from "../cashflow";
import { emptyParsed, type ParsedImport } from "./types";
import { sameTx } from "./match";

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
    // Checked first: a note in an 1Money row may contain "ISIN" or "Ticker".
    if (isOneMoneyCsv(text)) return parseOneMoney(name, text);
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
    cashflow: mergeCashflowImports(results.map((r) => r.cashflow)),
  };
}

/** Several 1Money exports: a month in more than one keeps the newer import. */
function mergeCashflowImports(
  parts: (ParsedImport["cashflow"] | undefined)[],
): ParsedImport["cashflow"] | undefined {
  const used = parts.filter((p): p is NonNullable<typeof p> => !!p);
  if (used.length === 0) return undefined;
  // A month's items come from the same file its sums do (the newer import).
  const winner = new Map<string, (typeof used)[number]>();
  for (const p of used)
    for (const m of p.months) {
      const cur = winner.get(m.month)?.months.find((x) => x.month === m.month);
      if (!cur || m.importedAt >= cur.importedAt) winner.set(m.month, p);
    }
  return {
    months: mergeCashflow(
      [],
      used.flatMap((p) => p.months),
    ),
    items: used.flatMap((p) => p.items.filter((i) => winner.get(i.month) === p)),
    through: used.map((p) => p.through).sort().pop() ?? "",
    skippedTransfers: used.reduce((s, p) => s + p.skippedTransfers, 0),
  };
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.values()];
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
