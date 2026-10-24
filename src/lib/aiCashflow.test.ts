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

  it("never carries a category name", () => {
    expect(text).not.toContain("Titkos");
  });

  it("without cash flow data there is no section", () => {
    expect(buildAiPortfolioContext(emptySummary, {}, returns, {})).not.toContain("Pénzáramlás");
  });
});
