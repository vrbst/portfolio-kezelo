import * as XLSX from "xlsx";
import type {
  Account,
  Instrument,
  InstrumentType,
  Transaction,
  TxType,
} from "../model";
import { num } from "./csv";
import { hashId, slug, parseHuDate, maturityFromName } from "./util";
import { emptyParsed, type ParsedImport } from "./types";

// Magyar Államkincstár "transaction" export (.xls).
// Columns: Account number, Account type, Transaction type, Transaction ID,
//   Securities, Transaction status, Face value, Amount, Currency, Value date,
//   Distribution channel, Nominal interest, Net buying price, Accrued interest,
//   Gross purchase price, Net interest, Amount of income tax, Gross interest

const CASH = "MAGYAR FORINT";

// The portal exports the SAME sheet with either English or Hungarian headers,
// depending on the UI language at download time (the cell values are Hungarian
// either way). Reading only the English names made a Hungarian export come out
// completely blank — every row then failed as `ismeretlen tranzakciótípus ""`.
const COLUMN_ALIASES: Record<string, string> = {
  "Account number": "Számlaszám",
  "Account type": "Számla típusa",
  "Transaction type": "Tranzakció típusa",
  "Transaction ID": "Tranzakció azonosítója",
  Securities: "Instrumentum",
  "Transaction status": "Tranzakció státusza",
  "Face value": "Névérték",
  Amount: "Összeg",
  Currency: "Devizanem",
  "Value date": "Értéknap",
  "Distribution channel": "Forgalmazási csatorna",
  "Nominal interest": "Névleges kamat",
  "Net buying price": "Nettó vételi árfolyam",
  "Accrued interest": "Felhalmozott kamat",
  "Gross purchase price": "Bruttó vételi árfolyam",
  "Net interest": "Nettó kamat",
  "Amount of income tax": "Jövedelemadó összege",
  "Gross interest": "Bruttó kamat",
};

/** Read a column by its English name, falling back to the Hungarian header. */
function field(row: Record<string, unknown>, name: string): unknown {
  const direct = row[name];
  if (direct !== undefined && direct !== "") return direct;
  const hu = COLUMN_ALIASES[name];
  const alias = hu ? row[hu] : undefined;
  return alias !== undefined && alias !== "" ? alias : (direct ?? "");
}

// Maps the Hungarian "Transaction type" to our normalised type.
const TYPE_MAP: Record<string, TxType> = {
  vétel: "buy",
  eladás: "sell",
  beváltás: "redemption",
  tőketörlesztés: "redemption",
  "esedékesség fizetés": "interest",
  kamatfizetés: "interest",
  "pénzszámla befizetés": "deposit",
  "pénzszámla kifizetés": "withdrawal",
  "utalás érkeztetés": "deposit",
  "utalás indítás": "withdrawal",
  "bankkártyás fizetés": "deposit",
};

// "Pénzszámla be-/kifizetés" are internal mirror entries: they duplicate the
// cash side of bond settlements and bank transfers. Marked internal so they
// show in history but never affect cash / P&L. Verified reconstruction:
//   Utalás érkeztetés + Bankkártya − Utalás indítás − Vétel + Eladás + kamat = 0
const INTERNAL_TYPES = new Set([
  "pénzszámla befizetés",
  "pénzszámla kifizetés",
]);

function classifySecurity(name: string): InstrumentType {
  if (/diszkont kincstárjegy/i.test(name)) return "tbill";
  return "gov_bond";
}

export function parseTreasury(
  fileName: string,
  data: ArrayBuffer,
): ParsedImport {
  const out = emptyParsed(fileName);
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: "",
  });
  if (rows.length === 0) {
    out.warnings.push(`${fileName}: üres munkalap.`);
    return out;
  }

  const accountNo = String(field(rows[0], "Account number") ?? "").trim();
  const account: Account = {
    id: accountNo ? `mak-${slug(accountNo)}` : `mak-${slug(fileName)}`,
    name: `Államkincstár${accountNo ? ` (${accountNo})` : ""}`,
    provider: "allamkincstar",
    kind: "treasury",
    currency: "HUF",
    externalRef: accountNo || undefined,
  };
  out.accounts.push(account);

  const instruments = new Map<string, Instrument>();

  for (const r of rows) {
    const rawType = String(field(r, "Transaction type") ?? "").trim();
    const type = TYPE_MAP[rawType.toLowerCase()];
    if (!type) {
      out.warnings.push(
        `${fileName}: ismeretlen tranzakciótípus „${rawType}".`,
      );
      continue;
    }

    const securitiesName = String(field(r, "Securities") ?? "").trim();
    const isCashLine = !securitiesName || securitiesName === CASH;
    const date = parseHuDate(String(field(r, "Value date") ?? ""));
    // An unparseable date would flow through as a raw string, breaking the
    // chronological ordering every consumer relies on — skip the row loudly.
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
      out.warnings.push(
        `${fileName}: értelmezhetetlen dátum „${String(field(r, "Value date") ?? "")}" — a sor kimaradt.`,
      );
      continue;
    }
    const amount = num(String(field(r, "Amount") ?? ""));
    const faceValue = num(String(field(r, "Face value") ?? ""));
    const txId = String(field(r, "Transaction ID") ?? "").trim();

    let instrument: Instrument | undefined;
    if (!isCashLine) {
      const key = slug(securitiesName);
      instrument = instruments.get(key);
      if (!instrument) {
        instrument = {
          key,
          name: securitiesName,
          type: classifySecurity(securitiesName),
          currency: "HUF",
          maturity: maturityFromName(securitiesName),
          faceValue: 1,
        };
        instruments.set(key, instrument);
      }
    }

    // Sign convention for net cash: inflows positive, outflows negative.
    const outflow = type === "buy" || type === "withdrawal";
    const netAmount = amount == null ? undefined : outflow ? -amount : amount;

    const tx: Transaction = {
      id: hashId(account.id, txId, date, type, securitiesName, amount),
      accountId: account.id,
      date,
      type,
      internal: INTERNAL_TYPES.has(rawType.toLowerCase()) || undefined,
      instrumentKey: instrument?.key,
      // For bonds we treat face value as the "quantity" (HUF nominal held).
      quantity: instrument ? faceValue : undefined,
      currency: "HUF",
      grossAmount: amount,
      netAmount,
      taxAmount: num(String(field(r, "Amount of income tax") ?? "")),
      reference: txId,
      raw: {
        ...r,
        _nominalInterest: field(r, "Nominal interest"),
        _netBuyingPrice: field(r, "Net buying price"),
        _grossPurchasePrice: field(r, "Gross purchase price"),
        _accruedInterest: field(r, "Accrued interest"),
        _grossInterest: field(r, "Gross interest"),
        _netInterest: field(r, "Net interest"),
        _channel: field(r, "Distribution channel"),
      },
    };
    out.transactions.push(tx);
  }

  out.instruments.push(...instruments.values());
  return out;
}
