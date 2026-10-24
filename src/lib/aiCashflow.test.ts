import { describe, expect, it } from "vitest";
import { buildAiPortfolioContext } from "./ai";
import { computePortfolio } from "./portfolio";
import { computeReturns } from "./returns";
import { cashflowAiSummary, type CashflowMonth, type CashflowSkip } from "./cashflow";

// Invented data only. The AI gets sums, never categories, items or notes.

const month = (mo: string, income: number, expense: number, extra: Partial<CashflowMonth> = {}): CashflowMonth => ({
  month: mo,
  income,
  expense,
  incomeBy: { "Titkos-Fizetés": income },
  expenseBy: { "Titkos-Lakás": expense },
  through: "2026-10-24",
  importedAt: "2026-10-24T00:00:00Z",
  ...extra,
});

const emptySummary = computePortfolio([], [], new Map(), new Map(), {}, new Date("2026-10-24T12:00:00"));
const reserveSummary = (cash: number) =>
  ({
    ...emptySummary,
    accounts: [{ account: { id: "a" }, cashValueHuf: cash, holdings: [] }],
  }) as unknown as typeof emptySummary;

describe("cashflowAiSummary", () => {
  const months = [
    month("2026-04", 900_000, 700_000),
    month("2026-05", 900_000, 700_000),
    month("2026-06", 900_000, 700_000),
    month("2026-07", 900_000, 800_000),
    month("2026-08", 900_000, 850_000),
    month("2026-09", 900_000, 850_000),
  ];

  it("monthly averages, the rate, and the trend of the last 3 months", () => {
    const s = cashflowAiSummary(months, [], { excluded: [], remind: true }, emptySummary)!;
    expect(s.months).toBe(6);
    expect(s.incomeHuf).toBe(900_000);
    expect(Math.round(s.expenseHuf)).toBe(766_667);
    expect(Math.round(s.savingHuf)).toBe(133_333);
    expect(s.rate).toBeCloseTo(0.148, 2);
    // (100 + 50 + 50) / 2 700 000
    expect(s.last3Rate).toBeCloseTo(200_000 / 2_700_000, 3);
  });

  it("follows the start month, the exclusions and the skipped items", () => {
    const s = cashflowAiSummary(months, [], { excluded: [], remind: true, since: "2026-07" }, emptySummary)!;
    expect(s.months).toBe(3);
    expect(Math.round(s.expenseHuf)).toBe(833_333);
    const skip: CashflowSkip = { id: "x", month: "2026-09", kind: "expense", category: "Titkos-Lakás", huf: 300_000 };
    expect(Math.round(cashflowAiSummary(months, [skip], { excluded: [], remind: true, since: "2026-07" }, emptySummary)!.expenseHuf)).toBe(733_333);
    const ex = cashflowAiSummary(months, [], { excluded: ["expense:Titkos-Lakás"], remind: true }, emptySummary)!;
    expect(ex.expenseHuf).toBe(0);
  });

  it("fewer than 3 complete months → no trend; the running month is left out", () => {
    const two = [month("2026-08", 900_000, 800_000), month("2026-09", 900_000, 800_000)];
    expect(cashflowAiSummary(two, [], { excluded: [], remind: true }, emptySummary)!.last3Rate).toBeUndefined();
    const running = [...two, month("2026-10", 900_000, 100_000, { through: "2026-10-24" })];
    expect(cashflowAiSummary(running, [], { excluded: [], remind: true }, emptySummary)!.months).toBe(2);
  });

  it("the excluded items: investing and one-off spending out, income back, as monthly averages", () => {
    const withInvesting = months.map((m) => ({
      ...m,
      expense: m.expense + 300_000,
      expenseBy: { ...m.expenseBy, "Titkos-Befektetés": 300_000 },
      income: m.income + 100_000,
      incomeBy: { ...m.incomeBy, "Titkos-Kamat": 100_000 },
    }));
    const s = cashflowAiSummary(
      withInvesting,
      [],
      { excluded: ["expense:Titkos-Befektetés", "income:Titkos-Kamat"], remind: true },
      emptySummary,
    )!;
    expect(s.excludedExpenseHuf).toBe(300_000);
    expect(s.excludedIncomeHuf).toBe(100_000);
    // the regular figures are unchanged by them
    expect(s.incomeHuf).toBe(900_000);
    expect(Math.round(s.expenseHuf)).toBe(766_667);
  });

  it("the running month so far, apart from the averages", () => {
    const withRunning = [...months, month("2026-10", 900_000, 400_000, { through: "2026-10-24" })];
    const s = cashflowAiSummary(withRunning, [], { excluded: [], remind: true }, emptySummary)!;
    expect(s.months).toBe(6);
    expect(s.current).toEqual({ month: "2026-10", incomeHuf: 900_000, expenseHuf: 400_000, savingHuf: 500_000, through: "2026-10-24" });
    expect(cashflowAiSummary(months, [], { excluded: [], remind: true }, emptySummary)!.current).toBeUndefined();
  });

  it("the running month follows the exclusions and the skipped items too", () => {
    const running = month("2026-10", 900_000, 400_000, {
      through: "2026-10-24",
      expenseBy: { "Titkos-Lakás": 100_000, "Titkos-Befektetés": 300_000 },
    });
    const skip: CashflowSkip = { id: "y", month: "2026-10", kind: "expense", category: "Titkos-Lakás", huf: 40_000 };
    const s = cashflowAiSummary([...months, running], [skip], { excluded: ["expense:Titkos-Befektetés"], remind: true }, emptySummary)!;
    expect(s.current!.expenseHuf).toBe(60_000);
  });

  it("no data / no closed month → nothing", () => {
    expect(cashflowAiSummary([], [], { excluded: [], remind: true }, emptySummary)).toBeUndefined();
  });

  it("the emergency reserve: target and what is held", () => {
    const s = cashflowAiSummary(
      [month("2026-08", 900_000, 500_000), month("2026-09", 900_000, 500_000)],
      [],
      { excluded: [], remind: true, reserveMonths: 6, reserveAccounts: ["a"] },
      reserveSummary(1_200_000),
    )!;
    expect(s.reserve).toEqual({ months: 6, targetHuf: 3_000_000, heldHuf: 1_200_000 });
    expect(cashflowAiSummary(months, [], { excluded: [], remind: true }, emptySummary)!.reserve).toBeUndefined();
  });
});

describe("the AI context text", () => {
  const returns = computeReturns([], [], new Map(), new Map(), {});
  const cashflow = cashflowAiSummary(
    [month("2026-08", 900_000, 700_000), month("2026-09", 900_000, 700_000), month("2026-07", 900_000, 700_000)],
    [],
    { excluded: [], remind: true, since: "2026-03", reserveMonths: 6, reserveAccounts: ["a"] },
    reserveSummary(2_000_000),
  )!;
  const text = buildAiPortfolioContext(emptySummary, {}, returns, { cashflow });

  it("has a cash flow section with the sums, the rate, the trend and the reserve", () => {
    expect(text).toContain("Pénzáramlás");
    expect(text).toMatch(/havi bevétel 900\s000 Ft/);
    expect(text).toMatch(/kiadás 700\s000 Ft/);
    expect(text).toMatch(/megtakarítás 200\s000 Ft/);
    expect(text).toContain("22.2%");
    expect(text).toMatch(/Vésztartalék: 6 havi kiadás/);
    expect(text).toMatch(/4\s200\s000 Ft/);
  });

  it("tells the model what the figures mean and what they are not", () => {
    expect(text).toMatch(/befektetés/i);
    expect(text).toMatch(/nem a brókerbe/i);
  });

  it("tells the excluded items, the running month and that a deposit can exceed the leftover", () => {
    const full = cashflowAiSummary(
      [
        month("2026-08", 900_000, 700_000, { expenseBy: { "Titkos-Lakás": 700_000 } }),
        month("2026-09", 900_000, 700_000),
        month("2026-10", 897_000, 609_000, { through: "2026-10-24" }),
      ].map((m) => (m.month === "2026-08" ? { ...m, expense: 1_000_000, expenseBy: { "Titkos-Lakás": 700_000, "Titkos-Befektetés": 300_000 } } : m)),
      [],
      { excluded: ["expense:Titkos-Befektetés"], remind: true },
      emptySummary,
    )!;
    const t = buildAiPortfolioContext(emptySummary, {}, returns, { cashflow: full });
    expect(t).toMatch(/Kizárt tételek/);
    expect(t).toMatch(/befektetésnek könyvelt/);
    expect(t).toMatch(/Folyó hónap \(2026-10, 2026-10-24-ig\): bevétel 897\s000 Ft, kiadás 609\s000 Ft, eddigi maradék 288\s000 Ft/);
    expect(t).toMatch(/hátralévő költései még nincsenek benne/);
    expect(t).toMatch(/lehet nagyobb a havi maradéknál/);
    expect(t).not.toContain("Titkos");
  });

  it("no excluded items and no running month → those lines are left out", () => {
    expect(text).not.toContain("Kizárt tételek");
    expect(text).not.toContain("Folyó hónap");
  });

  it("never carries a category name", () => {
    expect(text).not.toContain("Titkos");
  });

  it("without cash flow data there is no section", () => {
    expect(buildAiPortfolioContext(emptySummary, {}, returns, {})).not.toContain("Pénzáramlás");
  });
});

describe("the AI context: obligations that end", () => {
  const returns = computeReturns([], [], new Map(), new Map(), {});
  const ctx = (steps?: { fromMonth: string; monthlyHuf: number }[]) =>
    buildAiPortfolioContext(emptySummary, {}, returns, {
      forecast: { monthlySavingHuf: 169_000, milestones: [], shortfall: null, ...(steps ? { steps } : {}) },
    });

  it("lists the steps by amount and month — no names", () => {
    const t = ctx([
      { fromMonth: "2027-06", monthlyHuf: 35_000 },
      { fromMonth: "2029-04", monthlyHuf: 118_000 },
    ]);
    expect(t).toMatch(/Lejáró kötelezettségek/);
    expect(t).toMatch(/\+35\s000 Ft\/hó 2027-06-tól/);
    expect(t).toMatch(/\+118\s000 Ft\/hó 2029-04-tól/);
  });

  it("without steps there is no such line", () => {
    expect(ctx()).not.toContain("Lejáró kötelezettségek");
    expect(ctx([])).not.toContain("Lejáró kötelezettségek");
  });
});
