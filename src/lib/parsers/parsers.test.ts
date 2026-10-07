import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { num, parseCsv } from "./csv";
import { parseLightyear } from "./lightyear";
import { parseTreasury } from "./treasury";
import { maturityFromName, parseDmyDateTime, parseHuDate } from "./util";
import { txDay } from "../day";

// Invented statement rows in the brokers' real column layouts.

describe("num – amounts as the statements write them", () => {
  it.each([
    ["1 234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1.234,56", 1234.56],
    ["112.47", 112.47],
    ["1,5", 1.5],
    ["1,234", 1234],
    ["1,234,567", 1234567],
    ["0,125", 0.125],
    ["-0,5", -0.5],
    ["-2 000 000", -2_000_000],
    ["960200", 960200],
    ["12,50 €", 12.5],
  ])("%s → %d", (raw, expected) => {
    expect(num(raw)).toBeCloseTo(expected, 10);
  });

  it("empty or not a number → undefined", () => {
    expect(num("")).toBeUndefined();
    expect(num("  ")).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num("abc")).toBeUndefined();
  });
});

describe("date helpers – local calendar days", () => {
  it("a treasury day is local midnight and reads back as the same day", () => {
    expect(txDay(parseHuDate("2026.11.18."))).toBe("2026-11-18");
    expect(txDay(parseHuDate("2026-01-01"))).toBe("2026-01-01");
  });
  it("a Lightyear time stays on its local day, even just after midnight", () => {
    expect(txDay(parseDmyDateTime("01/03/2026 00:05:00"))).toBe("2026-03-01");
    expect(txDay(parseDmyDateTime("31/12/2025 23:59:59"))).toBe("2025-12-31");
  });
  it("maturity from the security name", () => {
    expect(maturityFromName("Diszkont Kincstárjegy D261118")).toBe("2026-11-18");
    expect(maturityFromName("Fix Magyar Állampapír 2031/Q1")).toBeUndefined();
    expect(maturityFromName("Fix Magyar Állampapír 2029/Q2")).toBeUndefined();
    expect(maturityFromName("Magyar Állampapír Plusz")).toBeUndefined();
  });
});

describe("parseCsv", () => {
  it("quoted fields with commas, quotes and line breaks", () => {
    expect(parseCsv('a,b,c\n"x, y","he said ""hi""","two\nlines"\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "two\nlines"],
    ]);
  });
});

const LY_HEADER = "Date,Reference,Ticker,ISIN,Type,Quantity,CCY,Price/share,Gross Amount,FX Rate,Fee,Net Amt.,Tax Amt.";

describe("parseLightyear", () => {
  const csv = [
    LY_HEADER,
    "02/01/2026 09:00:00,DEP-1,,,Deposit,,HUF,,200000,,,200000,",
    "02/01/2026 09:10:00,CV-1,HUF,,Conversion,,HUF,,-196000,,,-196000,",
    "02/01/2026 09:10:00,CV-1,EUR,,Conversion,,EUR,,490,0.0025,,490,",
    "02/01/2026 15:30:00,OR-1,VWCE,IE00BK5BQT80,Buy,3.5,EUR,130,456,,1,-456,",
    "15/03/2026 10:00:00,DV-1,VWCE,IE00BK5BQT80,Dividend,,EUR,,2.5,,,2.1,0.4",
    "01/04/2026 00:01:00,XX-1,,,Mystery,,EUR,,1,,,1,",
    "garbage,YY-1,,,Deposit,,HUF,,1,,,1,",
  ].join("\n");
  const out = parseLightyear("AccountStatement_LY-TESZT26.csv", csv);

  it("the account from the file name", () => {
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0]).toMatchObject({ id: "ly-teszt26", provider: "lightyear", externalRef: "LY-TESZT26", kind: "regular" });
  });

  it("rows with their types, signs and local days", () => {
    const rows = out.transactions.map((t) => [t.type, t.currency, t.netAmount, txDay(t.date)]);
    expect(rows).toEqual([
      ["deposit", "HUF", 200000, "2026-01-02"],
      ["conversion", "HUF", -196000, "2026-01-02"],
      ["conversion", "EUR", 490, "2026-01-02"],
      ["buy", "EUR", -456, "2026-01-02"],
      ["dividend", "EUR", 2.1, "2026-03-15"],
    ]);
    const buy = out.transactions[3];
    expect(buy).toMatchObject({ instrumentKey: "IE00BK5BQT80", quantity: 3.5, grossAmount: 456, fee: 1 });
  });

  it("the instrument and the warnings for unknown types and bad dates", () => {
    expect(out.instruments).toEqual([
      expect.objectContaining({ key: "IE00BK5BQT80", ticker: "VWCE", currency: "EUR", type: "etf" }),
    ]);
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings.join("\n")).toMatch(/ismeretlen típus/);
    expect(out.warnings.join("\n")).toMatch(/értelmezhetetlen dátum/);
  });

  it("re-importing the same file gives the same ids (duplicate filtering relies on it)", () => {
    const again = parseLightyear("AccountStatement_LY-TESZT26.csv", csv);
    expect(again.transactions.map((t) => t.id)).toEqual(out.transactions.map((t) => t.id));
    expect(new Set(out.transactions.map((t) => t.id)).size).toBe(out.transactions.length);
  });

  it("the funding hub (sends more internal transfers than it gets) is a cash account", () => {
    const hub = parseLightyear(
      "AccountStatement_LY-HUB.csv",
      [LY_HEADER, "02/01/2026 09:00:00,DEP-1,,,Deposit,,HUF,,200000,,,200000,", "02/01/2026 09:05:00,IT-1,,,Withdrawal,,HUF,,200000,,,-200000,"].join("\n"),
    );
    expect(hub.accounts[0].kind).toBe("cash");
  });
});

function treasuryXls(headers: string[], rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return buf;
}

describe("parseTreasury", () => {
  const EN = ["Account number", "Account type", "Transaction type", "Transaction ID", "Securities", "Transaction status", "Face value", "Amount", "Currency", "Value date", "Amount of income tax"];
  const HU = ["Számlaszám", "Számla típusa", "Tranzakció típusa", "Tranzakció azonosítója", "Instrumentum", "Tranzakció státusza", "Névérték", "Összeg", "Devizanem", "Értéknap", "Jövedelemadó összege"];
  const rows: (string | number)[][] = [
    ["12345678", "ÁPSZ", "Utalás érkeztetés", "T1", "MAGYAR FORINT", "Teljesült", "", 1_000_000, "HUF", "2026.03.02.", ""],
    ["12345678", "ÁPSZ", "Pénzszámla befizetés", "T2", "MAGYAR FORINT", "Teljesült", "", 1_000_000, "HUF", "2026.03.02.", ""],
    ["12345678", "ÁPSZ", "Vétel", "T3", "Diszkont Kincstárjegy D261118", "Teljesült", 1_000_000, 960_200, "HUF", "2026.03.03.", ""],
    ["12345678", "ÁPSZ", "Kamatfizetés", "T4", "Fix Magyar Állampapír 2030/I", "Teljesült", "", 65_000, "HUF", "2026.03.16.", 0],
    ["12345678", "ÁPSZ", "Beváltás", "T5", "Diszkont Kincstárjegy D261118", "Teljesült", 1_000_000, 1_000_000, "HUF", "2026.11.18.", ""],
    ["12345678", "ÁPSZ", "Ismeretlen", "T6", "MAGYAR FORINT", "Teljesült", "", 1, "HUF", "2026.11.19.", ""],
  ];

  for (const [lang, headers] of [["English", EN], ["Hungarian", HU]] as const) {
    it(`${lang} headers: account, instruments, signs and local days`, () => {
      const out = parseTreasury("tranzakciok.xlsx", treasuryXls([...headers], rows));
      expect(out.accounts[0]).toMatchObject({ id: "mak-12345678", kind: "treasury", provider: "allamkincstar" });
      expect(out.transactions.map((t) => [t.type, t.netAmount, t.internal ?? false, txDay(t.date)])).toEqual([
        ["deposit", 1_000_000, false, "2026-03-02"],
        ["deposit", 1_000_000, true, "2026-03-02"],
        ["buy", -960_200, false, "2026-03-03"],
        ["interest", 65_000, false, "2026-03-16"],
        ["redemption", 1_000_000, false, "2026-11-18"],
      ]);
      const dkj = out.instruments.find((i) => i.name.includes("D261118"))!;
      expect(dkj).toMatchObject({ type: "tbill", maturity: "2026-11-18", faceValue: 1 });
      expect(out.instruments.find((i) => i.name.includes("2030"))?.type).toBe("gov_bond");
      expect(out.transactions[2].quantity).toBe(1_000_000);
      expect(out.warnings).toEqual([expect.stringMatching(/ismeretlen tranzakciótípus „Ismeretlen"/)]);
    });
  }
});
