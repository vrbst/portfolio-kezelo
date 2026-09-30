import { describe, expect, it } from "vitest";
import type { Instrument, Transaction } from "./model";
import { purchaseLots } from "./lots";

// Invented sample data: three buys of a EUR ETF on two accounts, then a sell
// on the first account that eats its oldest lot first (FIFO, per account).

const ETF: Instrument = { key: "ETF", name: "ETF", type: "etf", currency: "EUR" };
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).toISOString();
const buy = (id: string, acct: string, date: string, qty: number, eur: number): Transaction => ({
  id, accountId: acct, date, type: "buy", instrumentKey: "ETF", quantity: qty, currency: "EUR", grossAmount: eur, netAmount: -eur,
});
const TXS: Transaction[] = [
  // Conversions give the historical EUR/HUF: 400 in January, 380 in March.
  { id: "c1", accountId: "a", date: at(2025, 1, 2), type: "conversion", currency: "HUF", grossAmount: -400_000, reference: "C1" },
  { id: "c2", accountId: "a", date: at(2025, 1, 2), type: "conversion", currency: "EUR", grossAmount: 1_000, reference: "C1" },
  { id: "c3", accountId: "a", date: at(2025, 3, 2), type: "conversion", currency: "HUF", grossAmount: -380_000, reference: "C2" },
  { id: "c4", accountId: "a", date: at(2025, 3, 2), type: "conversion", currency: "EUR", grossAmount: 1_000, reference: "C2" },
  buy("b1", "a", at(2025, 1, 3), 10, 1_000),
  buy("b2", "a", at(2025, 3, 3), 10, 1_200),
  buy("b3", "b", at(2025, 3, 1, 0), 5, 550), // local midnight
  { id: "s1", accountId: "a", date: at(2025, 6, 1), type: "sell", instrumentKey: "ETF", quantity: 12, currency: "EUR", grossAmount: 1_500, netAmount: 1_500 },
];

describe("purchaseLots", () => {
  const r = purchaseLots("ETF", TXS, new Map([["ETF", ETF]]), new Map([["ETF", 130]]), { EUR: 410 });

  it("sells consume the oldest lot of the SAME account first", () => {
    expect(r.hadSells).toBe(true);
    expect(r.lots.map((l) => [l.accountId, l.date, l.quantity])).toEqual([
      ["b", "2025-03-01", 5],
      ["a", "2025-03-03", 8],
    ]);
  });

  it("each lot keeps its own cost and the FX paid on its day", () => {
    const [b, a] = r.lots;
    expect(a.unitCostCcy).toBeCloseTo(120);
    expect(a.fxAtBuy).toBeCloseTo(380);
    expect(a.costHuf).toBeCloseTo(8 * 120 * 380);
    expect(a.currentValueHuf).toBeCloseTo(8 * 130 * 410);
    expect(a.plHuf).toBeCloseTo(8 * 130 * 410 - 8 * 120 * 380);
    expect(b.unitCostCcy).toBeCloseTo(110);
    // The held quantities add up to the position.
    expect(r.lots.reduce((s, l) => s + l.quantity, 0)).toBe(13);
  });
});
