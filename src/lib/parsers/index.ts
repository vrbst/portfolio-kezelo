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
  const results = await Promise.all(files.map(parseFile));
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
    transactions: dedupe(
      results.flatMap((r) => r.transactions),
      (t) => t.id,
    ),
    warnings: results.flatMap((r) => r.warnings),
  };
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.values()];
}
