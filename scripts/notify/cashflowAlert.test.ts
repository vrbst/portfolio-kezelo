import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureCashflow } from "../../src/test/fixture";
import { contextAt } from "./testContext";
import { analysisContext } from "./analysis/job";

// The bot sees the monthly 1Money to-do like the app does (same prefs, same rule).

afterEach(() => vi.useRealTimers());

const withCashflow = (through: string, upTo: string, remind = true) => (s: Parameters<NonNullable<Parameters<typeof contextAt>[1]>>[0]) => {
  const at = "2026-10-02T08:00:00.000Z";
  s.prefs = {
    ...s.prefs,
    cashflow: {
      updatedAt: at,
      value: fixtureCashflow()
        .filter((m) => m.month <= upTo)
        .map((m) => ({ ...m, through })),
    },
    cashflowSettings: { updatedAt: at, value: { excluded: [], remind } },
  };
};

const ids = (ctx: ReturnType<typeof contextAt>) => ctx.alerts.map((a) => a.id);

describe("bot: monthly 1Money export to-do", () => {
  it("last month missing → in the alert list", () => {
    const ctx = contextAt([2026, 10, 14, 10], withCashflow("2026-09-02", "2026-08"));
    expect(ids(ctx)).toContain("cashflow-import:2026-09");
  });

  it("last month imported after it ended → no to-do", () => {
    const ctx = contextAt([2026, 10, 14, 10], withCashflow("2026-10-02", "2026-09"));
    expect(ids(ctx).some((id) => id.startsWith("cashflow-import:"))).toBe(false);
  });

  it("the reminder switched off → no to-do", () => {
    const ctx = contextAt([2026, 10, 14, 10], withCashflow("2026-09-02", "2026-08", false));
    expect(ids(ctx).some((id) => id.startsWith("cashflow-import:"))).toBe(false);
  });

  describe("emergency reserve and the idle-cash alert", () => {
    // The fixture's treasury account holds 363 430 Ft cash (100 000 Ft of it set aside for a goal);
    // spending averages 248 000 Ft a month.
    const reserve = (months: number, accounts: string[]) => (s: Parameters<NonNullable<Parameters<typeof contextAt>[1]>>[0]) => {
      withCashflow("2026-10-02", "2026-09")(s);
      s.prefs!.cashflowSettings = {
        updatedAt: "2026-10-02T08:00:00.000Z",
        value: { excluded: [], remind: true, reserveMonths: months, reserveAccounts: accounts },
      };
    };
    const idle = (ctx: ReturnType<typeof contextAt>) => ctx.alerts.find((a) => a.id === "idle-cash:mak");

    it("without a reserve the cash is idle", () => {
      expect(idle(contextAt([2026, 10, 14, 10], withCashflow("2026-10-02", "2026-09")))?.detail).toMatch(/^363\s430\sFt/);
    });

    it("part of the cash is the reserve → less is idle, and the text says why", () => {
      const a = idle(contextAt([2026, 10, 14, 10], reserve(1, ["mak"])));
      expect(a?.detail).toMatch(/^115\s430\sFt fekszik/);
      expect(a?.detail).toContain("vésztartalékon felül");
    });

    it("an item taken out lowers the spending, so the reserve target — the bot counts it too", () => {
      const withSkip = (s: Parameters<NonNullable<Parameters<typeof contextAt>[1]>>[0]) => {
        reserve(1, ["mak"])(s);
        s.prefs!.cashflowSkips = {
          updatedAt: "2026-10-03T08:00:00.000Z",
          value: [{ id: "x", month: "2026-09", kind: "expense", category: "Teszt-Lakás", huf: 80_000 }],
        };
      };
      // 9 months: the average spending falls by 80 000 / 9 → the 1-month target is 239 111 instead of 248 000.
      expect(idle(contextAt([2026, 10, 14, 10], withSkip))?.detail).toMatch(/^124\s319\sFt fekszik/);
    });

    it("all the free cash is the reserve → no idle-cash alert", () => {
      expect(idle(contextAt([2026, 10, 14, 10], reserve(2, ["mak"])))).toBeUndefined();
    });

    it("a reserve on another account leaves this one alone", () => {
      expect(idle(contextAt([2026, 10, 14, 10], reserve(2, ["ly-tbsz26"])))?.detail).toMatch(/^363\s430\sFt/);
    });
  });

  it("never imported → no to-do (the default fixture stays as it was)", () => {
    const ctx = contextAt([2026, 10, 14, 10]);
    expect(ids(ctx).some((id) => id.startsWith("cashflow-import:"))).toBe(false);
  });
});

describe("bot: the nightly AI analysis sees the cash flow as sums", () => {
  it("the 1Money sums are in the AI snapshot, without any category name", () => {
    const ctx = contextAt([2026, 10, 14, 10], withCashflow("2026-10-02", "2026-09"));
    const text = analysisContext(ctx);
    expect(text).toContain("Pénzáramlás");
    expect(text).toMatch(/9 lezárt hónap/);
    expect(text).toMatch(/havi bevétel 600\s000 Ft/);
    for (const name of ["Teszt-Fizetés", "Teszt-Lakás", "Teszt-Élelmiszer"]) expect(text).not.toContain(name);
  });

  it("an item taken out lowers the spending the AI sees", () => {
    const ctx = contextAt([2026, 10, 14, 10], (s) => {
      withCashflow("2026-10-02", "2026-09")(s);
      s.prefs!.cashflowSkips = {
        updatedAt: "2026-10-03T08:00:00.000Z",
        value: [{ id: "x", month: "2026-09", kind: "expense", category: "Teszt-Lakás", huf: 90_000 }],
      };
    });
    // 9 months, average spending 248 000 − 90 000 / 9 = 238 000
    expect(analysisContext(ctx)).toMatch(/kiadás 238\s000 Ft/);
  });

  it("no 1Money data → no section (the nightly analysis stays as it was)", () => {
    expect(analysisContext(contextAt([2026, 10, 14, 10]))).not.toContain("Pénzáramlás");
  });
});

describe("bot: the AI snapshot says what was left out and how the running month stands", () => {
  it("the running month (without what is left out) is in the nightly snapshot", () => {
    const ctx = contextAt([2026, 10, 14, 10], (s) => {
      withCashflow("2026-10-02", "2026-09")(s);
      const months = s.prefs!.cashflow!.value;
      months.push({
        month: "2026-10",
        income: 600_000,
        expense: 350_000,
        incomeBy: { "Teszt-Fizetés": 600_000 },
        expenseBy: { "Teszt-Lakás": 150_000, "Teszt-Élelmiszer": 100_000, "Teszt-Befektetés": 100_000 },
        through: "2026-10-12",
        importedAt: "2026-10-12T08:00:00.000Z",
      });
      s.prefs!.cashflowSettings = { updatedAt: "2026-10-12T08:00:00.000Z", value: { excluded: ["expense:Teszt-Befektetés"], remind: true } };
    });
    const text = analysisContext(ctx);
    // 600 000 − (150 000 + 100 000) so far, the 100 000 investing is left out
    expect(text).toMatch(/Folyó hónap \(2026-10, 2026-10-12-ig\): bevétel 600\s000 Ft, kiadás 250\s000 Ft, eddigi maradék 350\s000 Ft/);
    // the excluded line comes from the closed months (none of them has investing here)
    expect(text).not.toContain("Kizárt tételek");
    expect(text).not.toContain("Teszt-Befektetés");
  });
});
