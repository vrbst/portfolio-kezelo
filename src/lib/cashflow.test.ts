import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOneMoneyCsv, parseOneMoney } from "./parsers/oneMoney";
import {
  applyCashflowImport,
  cashflowAverage,
  cashflowChanges,
  cashflowSuggestion,
  cashflowTotals,
  allocateReserve,
  emergencyReserve,
  isFixBond,
  monthsFrom,
  reserveTarget,
  isComplete,
  loadCashflow,
  loadCashflowSettings,
  mergeCashflow,
  monthEnd,
  prevMonth,
  saveCashflowSettings,
  applySkips,
  reconcileSkips,
  type CashflowSkip,
  type CashflowMonth,
} from "./cashflow";
import { cashflowImportAlerts } from "./alerts";
import type { PortfolioSummary } from "./portfolio";

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

  it("the part that is synced (the months) holds no single item, account or note", () => {
    const json = JSON.stringify(cf.months);
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

describe("parseOneMoney: single items (kept on this device only)", () => {
  const cf = parseOneMoney("1Money_2026_ 10_ 24_.csv", BOM_CSV, new Date("2026-10-24T10:00:00Z")).cashflow!;

  it("lists every income and expense item, transfers left out", () => {
    expect(cf.items).toHaveLength(5);
    const sale = cf.items.find((i) => i.category === "Utazás")!;
    expect(sale).toMatchObject({ day: "2026-09-10", month: "2026-09", kind: "expense", huf: 8000, account: "EUR kártya" });
    const note = cf.items.find((i) => i.day === "2026-09-30")!;
    // the line break becomes a space (the sample row's inner quotes are not escaped, so they drop out)
    expect(note.note).toBe("vesz, idéz sortörés");
  });

  it("the items add up to the month sums", () => {
    for (const m of cf.months) {
      const mine = cf.items.filter((i) => i.month === m.month);
      expect(mine.filter((i) => i.kind === "income").reduce((s, i) => s + i.huf, 0)).toBeCloseTo(m.income, -1);
      expect(mine.filter((i) => i.kind === "expense").reduce((s, i) => s + i.huf, 0)).toBeCloseTo(m.expense, -1);
    }
  });

  it("ids are stable between parses and unique, even for identical items", () => {
    const twin = [HEAD, row("2026. 09. 10.", "Kiadás", "A", "Étel", "500", "HUF"), row("2026. 09. 10.", "Kiadás", "A", "Étel", "500", "HUF")].join("\n");
    const a = parseOneMoney("x.csv", twin).cashflow!.items;
    const b = parseOneMoney("x.csv", twin).cashflow!.items;
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(new Set(a.map((i) => i.id)).size).toBe(2);
    const first = parseOneMoney("1Money_2026_ 10_ 24_.csv", BOM_CSV).cashflow!.items;
    expect(new Set(first.map((i) => i.id)).size).toBe(first.length);
  });

  it("a recategorised item gets another id (its exclusion no longer applies)", () => {
    const one = (cat: string) => parseOneMoney("x.csv", [HEAD, row("2026. 09. 10.", "Kiadás", "A", cat, "500", "HUF")].join("\n")).cashflow!.items[0].id;
    expect(one("Étel")).not.toBe(one("Egyéb"));
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

describe("an average that starts at a month (new life stage)", () => {
  // Spending drops from 300 to 100 once the loan is gone (from 2026-08).
  const months = [
    month("2026-05", 500, 300, "2026-10-24"),
    month("2026-06", 500, 300, "2026-10-24"),
    month("2026-07", 500, 300, "2026-10-24"),
    month("2026-08", 500, 100, "2026-10-24"),
    month("2026-09", 500, 100, "2026-10-24"),
    month("2026-10", 500, 50, "2026-10-24"), // running
  ];

  it("skips the months before it", () => {
    const t = cashflowTotals(months);
    expect(cashflowAverage(t, 12)!.expense).toBe(220); // (3 × 300 + 2 × 100) / 5
    const a = cashflowAverage(t, 12, "2026-08")!;
    expect(a.months).toBe(2);
    expect(a.expense).toBe(100);
  });

  it("still takes only the last n months after it", () => {
    expect(cashflowAverage(cashflowTotals(months), 1, "2026-06")!.months).toBe(1);
  });

  it("a start after the last complete month leaves nothing", () => {
    expect(cashflowAverage(cashflowTotals(months), 12, "2026-10")).toBeUndefined();
  });
});

describe("single items taken out (skips)", () => {
  const m1: CashflowMonth = {
    month: "2026-09",
    income: 900,
    expense: 500,
    incomeBy: { Fizetés: 600, Egyéb: 300 },
    expenseBy: { Élelmiszer: 200, Egyéb: 300 },
    through: "2026-10-24",
    importedAt: "2026-10-24T00:00:00Z",
  };
  const skip = (patch: Partial<CashflowSkip> = {}): CashflowSkip => ({ id: "s1", month: "2026-09", kind: "income", category: "Egyéb", huf: 250, ...patch });

  it("an income item leaves its category and the month income", () => {
    const [m] = applySkips([m1], [skip()]);
    expect(m.income).toBe(650);
    expect(m.incomeBy).toEqual({ Fizetés: 600, Egyéb: 50 });
    expect(m.expense).toBe(500);
  });

  it("an expense item leaves its category and the month expense; the same name on the other side is untouched", () => {
    const [m] = applySkips([m1], [skip({ kind: "expense", huf: 100 })]);
    expect(m.expense).toBe(400);
    expect(m.expenseBy).toEqual({ Élelmiszer: 200, Egyéb: 200 });
    expect(m.incomeBy.Egyéb).toBe(300);
  });

  it("a category emptied by the skips disappears from the list", () => {
    const [m] = applySkips([m1], [skip({ huf: 300 })]);
    expect(m.incomeBy).toEqual({ Fizetés: 600 });
  });

  it("other months, unknown categories and nothing to skip are left alone; the input is not changed", () => {
    expect(applySkips([m1], [skip({ month: "2026-08" }), skip({ category: "Nincs" })])).toEqual([m1]);
    const same = [m1];
    expect(applySkips(same, [])).toBe(same);
    applySkips([m1], [skip()]);
    expect(m1.income).toBe(900);
  });

  it("never below zero", () => {
    const [m] = applySkips([m1], [skip({ huf: 5000 })]);
    expect(m.income).toBe(600);
    expect(m.incomeBy.Egyéb).toBeUndefined();
  });

  it("reconcile: skips whose item is still in the new import stay, the others are dropped", () => {
    const items = [{ id: "s1", month: "2026-09" }, { id: "other", month: "2026-09" }];
    const skips = [skip(), skip({ id: "s2" }), skip({ id: "s3", month: "2026-05" })];
    const r = reconcileSkips(skips, items, ["2026-09"]);
    expect(r.kept.map((s) => s.id)).toEqual(["s1", "s3"]); // s3's month is not in the import: untouched
    expect(r.dropped.map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("monthsFrom", () => {
  const all = [month("2026-05", 1, 1, "2026-10-24"), month("2026-06", 2, 2, "2026-10-24"), month("2026-07", 3, 3, "2026-10-24")];
  it("keeps the months from the start month on (it included)", () => {
    expect(monthsFrom(all, "2026-06").map((m) => m.month)).toEqual(["2026-06", "2026-07"]);
    expect(monthsFrom(cashflowTotals(all), "2026-07").map((m) => m.month)).toEqual(["2026-07"]);
  });
  it("no start month → everything", () => {
    expect(monthsFrom(all, undefined)).toHaveLength(3);
  });
  it("a start after the last month leaves nothing", () => {
    expect(monthsFrom(all, "2026-09")).toEqual([]);
  });
});

describe("cashflowSuggestion", () => {
  const months = [
    month("2026-07", 500_000, 300_000, "2026-10-24"),
    month("2026-08", 500_000, 100_400, "2026-10-24"),
    month("2026-09", 500_000, 100_000, "2026-10-24"),
  ];

  it("the monthly saving left over, rounded to a thousand", () => {
    // (200 000 + 399 600 + 400 000) / 3 = 333 200
    expect(cashflowSuggestion(months, { excluded: [] })).toEqual({ amount: 333_000, months: 3, since: undefined });
    expect(cashflowSuggestion(months, { excluded: [], since: "2026-08" })).toEqual({ amount: 400_000, months: 2, since: "2026-08" });
  });

  it("uses the excluded categories too", () => {
    const withInvesting = months.map((m) => ({ ...m, expense: m.expense + 100_000, expenseBy: { ...m.expenseBy, Befektetés: 100_000 } }));
    expect(cashflowSuggestion(withInvesting, { excluded: ["expense:Befektetés"] })!.amount).toBe(
      cashflowSuggestion(months, { excluded: [] })!.amount,
    );
  });

  it("no data / no closed month → no suggestion", () => {
    expect(cashflowSuggestion([], { excluded: [] })).toBeUndefined();
    expect(cashflowSuggestion([month("2026-10", 1, 1, "2026-10-24")], { excluded: [] })).toBeUndefined();
  });

  it("can be zero or negative (nothing left over)", () => {
    const tight = [month("2026-09", 100_000, 150_000, "2026-10-24")];
    expect(cashflowSuggestion(tight, { excluded: [] })!.amount).toBe(-50_000);
  });
});

describe("emergency reserve", () => {
  const months = [
    month("2026-07", 500_000, 300_000, "2026-10-24"),
    month("2026-08", 500_000, 100_000, "2026-10-24"),
    month("2026-09", 500_000, 100_000, "2026-10-24"),
  ];
  const on = { excluded: [], reserveMonths: 6 };

  it("the target is N months of the average spending", () => {
    // average (300 + 100 + 100) / 3 = 166 667 → 6 months
    const t = reserveTarget(months, on)!;
    expect(t.monthlyExpense).toBeCloseTo(166_667, 0);
    expect(t.target).toBe(1_000_000);
    expect(t.months).toBe(3);
  });

  it("follows the start month and the excluded categories", () => {
    expect(reserveTarget(months, { ...on, since: "2026-08" })!.target).toBe(600_000);
    const withInvesting = months.map((m) => ({ ...m, expense: m.expense + 50_000, expenseBy: { ...m.expenseBy, Befektetés: 50_000 } }));
    expect(reserveTarget(withInvesting, { ...on, excluded: ["expense:Befektetés"] })!.target).toBe(1_000_000);
  });

  it("no target when off, without data, or without a closed month", () => {
    expect(reserveTarget(months, { excluded: [] })).toBeUndefined();
    expect(reserveTarget(months, { excluded: [], reserveMonths: 0 })).toBeUndefined();
    expect(reserveTarget([], on)).toBeUndefined();
    expect(reserveTarget([month("2026-10", 1, 1, "2026-10-24")], on)).toBeUndefined();
  });

  describe("allocateReserve", () => {
    const cash = new Map([["a", 400_000], ["b", 300_000], ["c", 900_000]]);
    it("fills the chosen accounts in order, up to their cash and the target", () => {
      const r = allocateReserve(600_000, ["a", "b"], cash);
      expect([...r.byAccount]).toEqual([["a", 400_000], ["b", 200_000]]);
      expect(r.held).toBe(600_000);
    });
    it("reports what is still missing", () => {
      const r = allocateReserve(2_000_000, ["a", "b"], cash);
      expect(r.held).toBe(700_000);
    });
    it("cash a goal holds is not available to the reserve", () => {
      const r = allocateReserve(600_000, ["a", "b"], cash, new Map([["a", 350_000]]));
      expect([...r.byAccount]).toEqual([["a", 50_000], ["b", 300_000]]);
      expect(r.held).toBe(350_000);
    });
    it("unknown accounts and no accounts hold nothing", () => {
      expect(allocateReserve(600_000, ["zzz"], cash).held).toBe(0);
      expect(allocateReserve(600_000, [], cash).byAccount.size).toBe(0);
    });
  });
});

describe("emergencyReserve: securities count, cash only fills the rest", () => {
  const months = [month("2026-08", 500_000, 100_000, "2026-10-24"), month("2026-09", 500_000, 100_000, "2026-10-24")];
  // 6 months × 100 000 = 600 000 target.
  const settings = { excluded: [], reserveMonths: 6 };
  const acc = (id: string, cash: number, holdings: { key: string; value?: number }[] = []) => ({
    account: { id },
    cashValueHuf: cash,
    holdings: holdings.map((h) => ({ instrumentKey: h.key, marketValueHuf: h.value, instrument: { name: h.key } })),
  });
  const summary = {
    accounts: [
      acc("mak", 300_000, [{ key: "fixmap", value: 450_000 }, { key: "dkj", value: 900_000 }]),
      acc("ly", 200_000, [{ key: "fixmap", value: 100_000 }]),
    ],
  } as unknown as PortfolioSummary;

  it("the chosen securities' value, across accounts", () => {
    const r = emergencyReserve(summary, months, { ...settings, reserveHoldings: ["fixmap"] });
    expect(r.heldHoldings).toBe(550_000);
    // 50 000 still missing; no cash account chosen → nothing from cash.
    expect(r.heldCash).toBe(0);
    expect(r.held).toBe(550_000);
    expect(r.target!.target).toBe(600_000);
  });

  it("cash is taken only for what the securities leave missing", () => {
    const r = emergencyReserve(summary, months, { ...settings, reserveHoldings: ["fixmap"], reserveAccounts: ["mak"] });
    expect(r.heldCash).toBe(50_000);
    expect([...r.byAccount]).toEqual([["mak", 50_000]]);
    expect(r.held).toBe(600_000);
  });

  it("securities above the target leave the cash free (idle) and are not capped", () => {
    const r = emergencyReserve(summary, months, { ...settings, reserveHoldings: ["fixmap", "dkj"], reserveAccounts: ["mak"] });
    expect(r.heldHoldings).toBe(1_450_000);
    expect(r.heldCash).toBe(0);
    expect(r.byAccount.size).toBe(0);
  });

  it("a security without a value counts as nothing; unknown keys too", () => {
    const s = { accounts: [acc("mak", 0, [{ key: "fixmap" }])] } as unknown as PortfolioSummary;
    expect(emergencyReserve(s, months, { ...settings, reserveHoldings: ["fixmap", "nincs"] }).heldHoldings).toBe(0);
  });

  it("no target → nothing is held either", () => {
    const r = emergencyReserve(summary, months, { excluded: [], reserveHoldings: ["fixmap"] });
    expect(r.target).toBeUndefined();
    expect(r.held).toBe(0);
  });
});

describe("isFixBond", () => {
  it("recognises the fixed-rate government bond by either name", () => {
    for (const n of ["Fix Magyar Állampapír 2030/I", "FixMÁP 2031/T", "FIXMÁP", "fix magyar állampapír"])
      expect(isFixBond(n), n).toBe(true);
  });
  it("and nothing else", () => {
    for (const n of ["Diszkont Kincstárjegy D270310", "VWCE", "Prémium Magyar Állampapír", "Fixed Income ETF"])
      expect(isFixBond(n), n).toBe(false);
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

  it("settings: the start month is kept, junk is dropped, clearing it works", () => {
    saveCashflowSettings({ excluded: [], remind: true, since: "2026-03" });
    expect(loadCashflowSettings().since).toBe("2026-03");
    saveCashflowSettings({ excluded: [], remind: true });
    expect(loadCashflowSettings().since).toBeUndefined();
    store.set("pf-cashflow-settings", JSON.stringify({ excluded: [], remind: true, since: "márc" }));
    expect(loadCashflowSettings().since).toBeUndefined();
  });

  it("settings: the reserve securities are kept as strings", () => {
    saveCashflowSettings({ excluded: [], remind: true, reserveMonths: 6, reserveHoldings: ["fixmap", "fixmap", "x"] });
    expect(loadCashflowSettings().reserveHoldings).toEqual(["fixmap", "x"]);
    store.set("pf-cashflow-settings", JSON.stringify({ excluded: [], reserveHoldings: [1, "fixmap", null] }));
    expect(loadCashflowSettings().reserveHoldings).toEqual(["fixmap"]);
  });

  it("settings: the reserve is kept as whole months 1–36 and the accounts as strings", () => {
    saveCashflowSettings({ excluded: [], remind: true, reserveMonths: 6, reserveAccounts: ["k", "l"] });
    expect(loadCashflowSettings()).toMatchObject({ reserveMonths: 6, reserveAccounts: ["k", "l"] });
    for (const bad of [0, -1, 37, 2.5, "6", null]) {
      store.set("pf-cashflow-settings", JSON.stringify({ excluded: [], reserveMonths: bad, reserveAccounts: [1, "k"] }));
      expect(loadCashflowSettings().reserveMonths, String(bad)).toBeUndefined();
      expect(loadCashflowSettings().reserveAccounts).toEqual(["k"]);
    }
  });

  it("unreadable storage gives empty data", () => {
    store.set("pf-cashflow", "{nope");
    expect(loadCashflow()).toEqual([]);
  });
});
