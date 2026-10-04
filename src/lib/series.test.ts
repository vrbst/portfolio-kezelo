import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { buildValueSeries, dayChangeBreakdown, liveDayOverrides } from "./series";

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

// Invented sample data: two HUF accounts. Dates are local midnights (as the
// importers store them), built from the local date so the test means the same
// in any time zone.
const localMidnightIso = (m0: number, d: number) => new Date(2026, m0, d).toISOString();
const BANK: Account = { id: "bank", name: "Bank", provider: "manual", kind: "cash", currency: "HUF" };
const AK: Account = { id: "ak", name: "Kincstár", provider: "treasury", kind: "treasury", currency: "HUF" };
const flow = (id: string, accountId: string, d: number, amt: number): Transaction => ({
  id,
  accountId,
  date: localMidnightIso(8, d),
  type: amt > 0 ? "deposit" : "withdrawal",
  currency: "HUF",
  grossAmount: Math.abs(amt),
  netAmount: amt,
});
const invested = (txs: Transaction[], nowDay: number) => {
  const s = buildValueSeries([BANK, AK], txs, new Map(), new Map(), {}, null, new Date(2026, 8, nowDay, 12));
  // Without history only trade days are sampled: read the last sample on/before.
  return { get: (day: string) => s.filter((p) => p.date <= day).at(-1)?.invested };
};

describe("buildValueSeries — flows", () => {
  it("files a local-midnight deposit under its own local day", () => {
    const inv = invested([flow("a", "bank", 1, 1_000_000), flow("b", "ak", 30, 200_000)], 30);
    expect(inv.get("2026-09-29")).toBe(1_000_000);
    expect(inv.get("2026-09-30")).toBe(1_200_000);
  });

  it("does not pair unrelated amounts as money in transit", () => {
    const inv = invested(
      [flow("a", "bank", 1, 1_000_000), flow("w", "bank", 26, -90_000), flow("d", "ak", 30, 200_000)],
      30,
    );
    expect(inv.get("2026-09-26")).toBe(910_000);
    expect(inv.get("2026-09-29")).toBe(910_000);
    expect(inv.get("2026-09-30")).toBe(1_110_000);
  });

  it("bridges a same-amount transfer within 4 days, not later", () => {
    const within = invested(
      [flow("a", "bank", 1, 1_000_000), flow("w", "bank", 26, -200_000), flow("d", "ak", 30, 200_000)],
      30,
    );
    expect(within.get("2026-09-27")).toBe(1_000_000);
    expect(within.get("2026-09-30")).toBe(1_000_000);
    const late = invested(
      [flow("a", "bank", 1, 1_000_000), flow("w", "bank", 25, -200_000), flow("d", "ak", 30, 200_000)],
      30,
    );
    expect(late.get("2026-09-27")).toBe(800_000);
    expect(late.get("2026-09-30")).toBe(1_000_000);
  });
});

describe("liveDayOverrides — today's move only from quotes that traded today", () => {
  const friClose = new Date(2026, 9, 2, 17, 35).getTime(); // Fri 2026-10-02, local
  const monNoon = new Date(2026, 9, 5, 12, 0).getTime();
  const quotes = {
    ETF: { price: 110, prevClose: 100, marketTime: friClose },
    EUR: { price: 390, prevClose: 385, marketTime: friClose },
  };

  it("on Sunday the last session's move is not today's: prices count as unchanged", () => {
    expect(liveDayOverrides(quotes, (k) => k === "ETF", "2026-10-04")).toEqual({
      prices: { ETF: 110 },
      fx: { EUR: 390 },
    });
  });

  it("a quote that traded today uses its previous close", () => {
    const live = { ...quotes, ETF: { ...quotes.ETF, marketTime: monNoon } };
    expect(liveDayOverrides(live, (k) => k === "ETF", "2026-10-05")?.prices).toEqual({ ETF: 100 });
  });

  it("without a trade time (fallback source) it counts as today's", () => {
    const q = { ETF: { price: 110, prevClose: 100 } };
    expect(liveDayOverrides(q, () => true, "2026-10-04")?.prices).toEqual({ ETF: 100 });
  });

  it("null when no held quote has a previous close", () => {
    expect(liveDayOverrides({ X: { price: 1 } }, () => false, "2026-10-04")).toBeNull();
  });
});
