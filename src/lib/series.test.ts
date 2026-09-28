import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { dayChangeBreakdown } from "./series";

// Invented sample data: a Lightyear account with 10 units of a EUR ETF and
// 50 EUR of cash. Yesterday: price 100, EUR/HUF 390; today: 110, 400.

const LY: Account = { id: "ly", name: "Lightyear", provider: "lightyear", kind: "regular", currency: "EUR" };
const ETF: Instrument = { key: "IE00TEST", name: "Teszt ETF", ticker: "TST", type: "etf", currency: "EUR" };
const TXS: Transaction[] = [
  { id: "d", accountId: "ly", date: "2026-09-01T10:00:00Z", type: "deposit", currency: "EUR", grossAmount: 1050, netAmount: 1050 },
  { id: "b", accountId: "ly", date: "2026-09-02T10:00:00Z", type: "buy", instrumentKey: ETF.key, quantity: 10, pricePerUnit: 100, currency: "EUR", grossAmount: 1000, netAmount: -1000 },
];
const inst = new Map([[ETF.key, ETF]]);

describe("dayChangeBreakdown", () => {
  it("splits the move into ETF price and EUR/HUF parts that add up", () => {
    // Value yesterday: 1050 × 390 = 409 500; today: (1100 + 50) × 400 = 460 000.
    const total = 460_000 - 409_500;
    const items = dayChangeBreakdown(
      [LY],
      TXS,
      inst,
      new Map([[ETF.key, 110]]),
      { EUR: 400 },
      null,
      "2026-09-27",
      { prices: { [ETF.key]: 100 }, fx: { EUR: 390 } },
      total,
      new Date("2026-09-28T12:00:00Z"),
    );
    const price = items.find((i) => i.kind === "price")!;
    const fx = items.find((i) => i.kind === "fx")!;
    expect(price.abs).toBeCloseTo(10 * 10 * 390); // price move at yesterday's FX
    expect(price.pct).toBeCloseTo(0.1);
    expect(fx.label).toBe("EUR/HUF árfolyam");
    expect(fx.abs).toBeCloseTo(1150 * 10); // ETF + cash, 10 Ft/EUR
    expect(fx.pct).toBeCloseTo(400 / 390 - 1);
    expect(items.some((i) => i.kind === "other")).toBe(false);
    expect(items.reduce((s, i) => s + i.abs, 0)).toBeCloseTo(total);
  });

  it("puts what re-marking can't explain into the 'other' line", () => {
    const items = dayChangeBreakdown(
      [LY],
      TXS,
      inst,
      new Map([[ETF.key, 100]]),
      { EUR: 390 },
      null,
      "2026-09-27",
      { prices: { [ETF.key]: 100 }, fx: { EUR: 390 } },
      -500,
      new Date("2026-09-28T12:00:00Z"),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "other", abs: -500 }),
    ]);
  });
});
