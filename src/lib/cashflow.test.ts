import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOneMoneyCsv, parseOneMoney } from "./parsers/oneMoney";
import {
  applyCashflowImport,
  cashflowAverage,
  cashflowChanges,
  cashflowTotals,
  isComplete,
  loadCashflow,
  loadCashflowSettings,
  mergeCashflow,
  monthEnd,
  prevMonth,
  saveCashflowSettings,
  type CashflowMonth,
} from "./cashflow";
import { cashflowImportAlerts } from "./alerts";

// Invented data only — never a real export.
const HEAD =
  '"DÁTUM","TÍPUS","FIÓKBÓL","FIÓKBA/KATEGÓRIÁHOZ","ÖSSZEG","VALUTA","ÖSSZEG 2","VALUTA 2","CÍMKÉK","MEGJEGYZÉSEK:"';
const row = (d: string, t: string, from: string, to: string, a: string, c: string, a2 = a, c2 = c, note = "") =>
  `"${d}","${t}","${from}","${to}","${a}","${c}","${a2}","${c2}","","${note}"`;

const CSV = [
  HEAD,
  row("2026. 10. 03.", "Kiadás", "Kártya", "Élelmiszer", "12000", "HUF"),
  row("2026. 09. 30.", "Kiadás", "Kártya", "Élelmiszer", "8000.5", "HUF", "8000.5", "HUF", 'vesz, "idéz"\nsortörés'),
  row("2026. 09. 15.", "Bevétel", "Bank", "Fizetés", "500000", "HUF"),
  row("2026. 09. 10.", "Kiadás", "EUR kártya", "Utazás", "20", "EUR", "8000", "HUF"),
  row("2026. 09. 05.", "Átutalás", "Bank", "Készpénz", "30000", "HUF"),
  row("2026. 08. 31.", "Kiadás", "Kártya", "Lakás", "100000", "HUF"),
  "",
  '"NÉV","EGYENLEG","VALUTA"',
  '"Kártya","123456","HUF"',
].join("\n");

const BOM_CSV = "﻿" + CSV;

describe("isOneMoneyCsv", () => {
  it("recognises the header, with or without BOM", () => {
    expect(isOneMoneyCsv(CSV)).toBe(true);
    expect(isOneMoneyCsv(BOM_CSV)).toBe(true);
  });
  it("rejects other statements", () => {
    expect(isOneMoneyCsv("Date,Reference,Ticker,ISIN,Net Amt.\n")).toBe(false);
  });
});

describe("parseOneMoney", () => {
  const out = parseOneMoney("1Money_2026_ 10_ 24_.csv", BOM_CSV, new Date("2026-10-24T10:00:00Z"));
  const cf = out.cashflow!;
  const m = (month: string) => cf.months.find((x) => x.month === month)!;

  it("sums income and expenses per month and category", () => {
    expect(cf.months.map((x) => x.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(m("2026-09").income).toBe(500000);
    expect(m("2026-09").incomeBy).toEqual({ Fizetés: 500000 });
    // 8000.5 + 8000 (the forint side of the EUR row), rounded to whole forints
    expect(m("2026-09").expense).toBe(16001);
    expect(m("2026-09").expenseBy).toEqual({ Élelmiszer: 8001, Utazás: 8000 });
    expect(m("2026-08").expense).toBe(100000);
  });

  it("keeps the day in its own month (no time zone shift)", () => {
    expect(m("2026-09").expenseBy["Élelmiszer"]).toBe(8001); // 30 Sep
    expect(m("2026-10").expense).toBe(12000);
  });

  it("leaves transfers and the balance table out", () => {
    expect(cf.skippedTransfers).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(JSON.stringify(cf)).not.toContain("123456");
  });

  it("stores no single item, account or note", () => {
    const json = JSON.stringify(cf);
    for (const secret of ["Kártya", "Bank", "idéz", "sortörés"]) expect(json).not.toContain(secret);
  });

  it("knows how far the export reaches (the file's date)", () => {
    expect(cf.through).toBe("2026-10-24");
    expect(m("2026-09").through).toBe("2026-10-24");
  });

  it("without the date in the name: the latest item", () => {
    expect(parseOneMoney("export.csv", CSV).cashflow!.through).toBe("2026-10-03");
  });

  it("warns on an export without items", () => {
    const o = parseOneMoney("x.csv", HEAD + "\n");
    expect(o.cashflow).toBeUndefined();
    expect(o.warnings).toHaveLength(1);
  });

  it("skips a row without a forint side, with a warning", () => {
    const o = parseOneMoney("x.csv", [HEAD, row("2026. 09. 10.", "Kiadás", "A", "Utazás", "20", "EUR")].join("\n"));
    expect(o.cashflow).toBeUndefined();
    expect(o.warnings.join(" ")).toContain("nincs forintos összegük");
  });
});

const month = (mo: string, income: number, expense: number, through: string, at = "2026-10-24T00:00:00Z"): CashflowMonth => ({
  month: mo,
  income,
  expense,
  incomeBy: { Fizetés: income },
  expenseBy: { Élelmiszer: expense },
  through,
  importedAt: at,
});

describe("month helpers", () => {
  it("monthEnd / prevMonth", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
    expect(prevMonth("2026-01")).toBe("2025-12");
    expect(prevMonth("2026-10")).toBe("2026-09");
  });
  it("a month is complete once the export reached its last day", () => {
    expect(isComplete(month("2026-09", 1, 1, "2026-09-30"))).toBe(true);
    expect(isComplete(month("2026-09", 1, 1, "2026-09-29"))).toBe(false);
  });
});

describe("mergeCashflow", () => {
  it("per month the later import wins, others stay", () => {
    const old = [month("2026-08", 1, 1, "2026-09-02", "2026-09-02T00:00:00Z"), month("2026-09", 5, 5, "2026-09-10", "2026-09-10T00:00:00Z")];
    const fresh = [month("2026-09", 7, 7, "2026-10-02", "2026-10-02T00:00:00Z")];
    const merged = mergeCashflow(old, fresh);
    expect(merged.map((x) => [x.month, x.income])).toEqual([
      ["2026-08", 1],
      ["2026-09", 7],
    ]);
    // order of the arguments doesn't matter
    expect(mergeCashflow(fresh, old)).toEqual(merged);
  });
  it("ignores junk", () => {
    expect(mergeCashflow(null, [{ month: "x" }, 3])).toEqual([]);
  });
});

describe("cashflowTotals / cashflowAverage", () => {
  const months = [
    month("2026-07", 400, 300, "2026-10-24"),
    month("2026-08", 500, 300, "2026-10-24"),
    month("2026-09", 600, 300, "2026-10-24"),
    month("2026-10", 100, 50, "2026-10-24"), // running month
  ];
  it("saving and rate per month", () => {
    const t = cashflowTotals(months);
    expect(t[1]).toMatchObject({ month: "2026-08", saving: 200, complete: true });
    expect(t[1].rate).toBeCloseTo(0.4);
    expect(t[3].complete).toBe(false);
  });
  it("the average skips the running month", () => {
    const a = cashflowAverage(cashflowTotals(months))!;
    expect(a.months).toBe(3);
    expect(a.income).toBe(500);
    expect(a.saving).toBe(200);
  });
  it("covers only the last n complete months", () => {
    const a = cashflowAverage(cashflowTotals(months), 2)!;
    expect(a.months).toBe(2);
    expect(a.income).toBe(550);
  });
  it("an excluded category drops out of its own side", () => {
    const m2: CashflowMonth = { ...month("2026-09", 600, 300, "2026-10-24"), expenseBy: { Élelmiszer: 200, Befektetés: 100 } };
    expect(cashflowTotals([m2], { excluded: ["expense:Befektetés"] })[0].expense).toBe(200);
  });

  it("the same name on both sides: excluding the income does not touch the expense", () => {
    // Real case: "Egyéb" is both one-off sales (income) and everyday spending.
    const m2: CashflowMonth = {
      ...month("2026-09", 0, 0, "2026-10-24"),
      income: 900,
      expense: 500,
      incomeBy: { Fizetés: 600, Egyéb: 300 },
      expenseBy: { Élelmiszer: 200, Egyéb: 300 },
    };
    const t = cashflowTotals([m2], { excluded: ["income:Egyéb"] })[0];
    expect(t.income).toBe(600);
    expect(t.expense).toBe(500);
    expect(t.excludedIncome).toBe(300);
    const both = cashflowTotals([m2], { excluded: ["income:Egyéb", "expense:Egyéb"] })[0];
    expect(both.expense).toBe(200);
  });

  it("the average carries the excluded income (one-off money must not vanish)", () => {
    const m2: CashflowMonth = { ...month("2026-09", 900, 300, "2026-10-24"), incomeBy: { Fizetés: 600, Egyéb: 300 } };
    const a = cashflowAverage(cashflowTotals([m2], { excluded: ["income:Egyéb"] }))!;
    expect(a.income).toBe(600);
    expect(a.excludedIncome).toBe(300);
  });
  it("no data / no income", () => {
    expect(cashflowAverage([])).toBeUndefined();
    expect(cashflowTotals([{ ...month("2026-09", 0, 10, "2026-10-24"), incomeBy: {} }])[0].rate).toBeUndefined();
  });
});

describe("cashflowChanges", () => {
  it("counts new, changed and same months", () => {
    const stored = [month("2026-08", 1, 1, "2026-09-02"), month("2026-09", 5, 5, "2026-09-10")];
    const incoming = [month("2026-08", 1, 1, "2026-09-02"), month("2026-09", 5, 6, "2026-10-02"), month("2026-10", 1, 1, "2026-10-02")];
    expect(cashflowChanges(stored, incoming)).toEqual({ added: 1, updated: 1, same: 1 });
  });
});

describe("cashflowImportAlerts", () => {
  const sept = month("2026-09", 1, 1, "2026-10-02");
  it("nothing imported ever → no nudge", () => {
    expect(cashflowImportAlerts([], "2026-10-01")).toEqual([]);
  });
  it("the first of the month, last month missing → nudge", () => {
    const a = cashflowImportAlerts([month("2026-08", 1, 1, "2026-09-02")], "2026-10-01");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: "cashflow-import:2026-09", severity: "info", to: "/import" });
    expect(a[0].title).toContain("2026. szeptember");
  });
  it("an export taken before the month ended doesn't count", () => {
    expect(cashflowImportAlerts([month("2026-09", 1, 1, "2026-09-20")], "2026-10-01")).toHaveLength(1);
  });
  it("last month imported after it ended → fulfilled", () => {
    expect(cashflowImportAlerts([sept], "2026-10-01")).toEqual([]);
  });
  it("a later month proves the export reached past a month without items", () => {
    expect(cashflowImportAlerts([month("2026-10", 1, 1, "2026-11-02")], "2026-11-05")).toEqual([]);
  });
  it("year boundary: January asks for December", () => {
    expect(cashflowImportAlerts([month("2025-11", 1, 1, "2025-12-02")], "2026-01-02")[0].id).toBe("cashflow-import:2025-12");
  });
});

describe("storage", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal("window", { dispatchEvent: () => true });
  });

  it("an import is stored, a re-import replaces its months and stamps the pref", () => {
    const out = parseOneMoney("1Money_2026_ 10_ 24_.csv", CSV, new Date("2026-10-24T10:00:00Z"));
    applyCashflowImport(out.cashflow!);
    expect(loadCashflow()).toHaveLength(3);
    expect(store.get("pf-cashflow-updated")).toBeTruthy();
    applyCashflowImport({ ...out.cashflow!, months: [{ ...out.cashflow!.months[0], income: 999 }] });
    expect(loadCashflow()).toHaveLength(3);
    expect(loadCashflow()[0].income).toBe(999);
  });

  it("settings: reminder on by default, excluded categories kept sorted and unique", () => {
    expect(loadCashflowSettings()).toEqual({ excluded: [], remind: true });
    saveCashflowSettings({ excluded: ["b", "a", "b"], remind: false });
    expect(loadCashflowSettings()).toEqual({ excluded: ["a", "b"], remind: false });
  });

  it("unreadable storage gives empty data", () => {
    store.set("pf-cashflow", "{nope");
    expect(loadCashflow()).toEqual([]);
  });
});
