import { parseCsv } from "./csv";
import { emptyParsed, type ParsedImport } from "./types";
import type { CashflowItem, CashflowMonth } from "../cashflow";
import { hashId } from "./util";

// 1Money (Android) CSV export: one row per expense / income / transfer.
// Only monthly sums per category are kept — never single items, accounts or
// notes — so the sync repo and the AI never see what was bought where.

const HEADER = ["DÁTUM", "TÍPUS", "FIÓKBÓL", "FIÓKBA/KATEGÓRIÁHOZ"];
const DAY_RE = /^(\d{4})\. (\d\d)\. (\d\d)\.$/;
/** The export's own name: "1Money_2026_ 10_ 24_.csv". */
const FILE_DAY_RE = /(\d{4})_\s*(\d{1,2})_\s*(\d{1,2})_/;

/** Is this CSV an 1Money export (by its header row)? */
export function isOneMoneyCsv(text: string): boolean {
  const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).slice(0, 400);
  const first = head.split(/\r?\n/, 1)[0] ?? "";
  const cells = first.split(",").map((c) => c.replace(/"/g, "").trim());
  return HEADER.every((h, i) => cells[i] === h);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function fileDay(name: string): string | undefined {
  const m = name.match(FILE_DAY_RE);
  return m ? `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}` : undefined;
}

/** The forint side of a row: transfers and foreign spending carry both. */
function hufAmount(row: Record<string, string>): number | undefined {
  const side = row.VALUTA === "HUF" ? row.ÖSSZEG : row["VALUTA 2"] === "HUF" ? row["ÖSSZEG 2"] : "";
  const n = Number(side);
  return side !== "" && Number.isFinite(n) ? n : undefined;
}

function addTo(map: Record<string, number>, key: string, value: number) {
  map[key] = (map[key] ?? 0) + value;
}

const roundMap = (m: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));

export function parseOneMoney(fileName: string, text: string, now = new Date()): ParsedImport {
  const out = emptyParsed(fileName);
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const at = (r: string[], name: string) => r[header.indexOf(name)]?.trim() ?? "";

  const months = new Map<string, CashflowMonth>();
  const items: CashflowItem[] = [];
  const seen = new Map<string, number>();
  let last = "";
  let skipped = 0;
  let unconverted = 0;
  for (const r of rows.slice(1)) {
    const m = at(r, "DÁTUM").match(DAY_RE);
    // The balance table below the items has no date: not a transaction.
    if (!m) continue;
    const type = at(r, "TÍPUS");
    if (type !== "Kiadás" && type !== "Bevétel") {
      skipped++; // transfers between own accounts are neither
      continue;
    }
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (day > last) last = day;
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = r[i]?.trim() ?? ""));
    const huf = hufAmount(row);
    if (huf == null || huf < 0) {
      unconverted++;
      continue;
    }
    const month = day.slice(0, 7);
    const kind = type === "Bevétel" ? "income" : "expense";
    const itemCategory = at(r, "FIÓKBA/KATEGÓRIÁHOZ") || "Egyéb";
    const account = at(r, "FIÓKBÓL");
    const note = at(r, "MEGJEGYZÉSEK:").replace(/\s+/g, " ");
    // Identical items on a day get the order they appear in; the id is two
    // 32-bit hashes (a clash would skip the wrong item).
    const key = [day, kind, itemCategory, Math.round(huf * 100), account, note].join("|");
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    items.push({
      id: hashId(key, nth) + hashId("#", nth, key),
      month,
      day,
      kind,
      category: itemCategory,
      huf: Math.round(huf * 100) / 100,
      account,
      note,
    });
    const cur =
      months.get(month) ??
      ({ month, income: 0, expense: 0, incomeBy: {}, expenseBy: {}, through: "", importedAt: "" } as CashflowMonth);
    const category = at(r, "FIÓKBA/KATEGÓRIÁHOZ") || "Egyéb";
    if (type === "Bevétel") {
      cur.income += huf;
      addTo(cur.incomeBy, category, huf);
    } else {
      cur.expense += huf;
      addTo(cur.expenseBy, category, huf);
    }
    months.set(month, cur);
  }

  if (unconverted > 0)
    out.warnings.push(`${fileName}: ${unconverted} tétel kimaradt, mert nincs forintos összegük.`);
  if (months.size === 0) {
    out.warnings.push(`${fileName}: nem találtam bevételt vagy kiadást az 1Money-exportban.`);
    return out;
  }

  // How far the export reaches: its date, or at least its latest item. A month
  // before that is complete; the running one is only a part.
  const through = [last, fileDay(fileName)].filter(Boolean).sort().pop() ?? last;
  const importedAt = now.toISOString();
  out.cashflow = {
    items,
    through,
    skippedTransfers: skipped,
    months: [...months.values()]
      .map((c) => ({
        ...c,
        income: Math.round(c.income),
        expense: Math.round(c.expense),
        incomeBy: roundMap(c.incomeBy),
        expenseBy: roundMap(c.expenseBy),
        through,
        importedAt,
      }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
  return out;
}
