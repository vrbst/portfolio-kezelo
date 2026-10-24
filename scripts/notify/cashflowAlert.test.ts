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

  it("never imported → no to-do (the default fixture stays as it was)", () => {
    const ctx = contextAt([2026, 10, 14, 10]);
    expect(ids(ctx).some((id) => id.startsWith("cashflow-import:"))).toBe(false);
  });
});
