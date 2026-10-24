import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureCashflow } from "../../src/test/fixture";
import { contextAt } from "./testContext";

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
