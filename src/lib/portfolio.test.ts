import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { computePortfolio } from "./portfolio";
import { computeReturns } from "./returns";

// Invented sample data, round numbers so every expected value can be checked
// by hand in the comments.

const HUB: Account = { id: "hub", name: "Pénzszámla", provider: "lightyear", kind: "cash", currency: "HUF" };
const INV: Account = { id: "inv", name: "Befektetési", provider: "lightyear", kind: "regular", currency: "HUF" };
const MAK: Account = { id: "mak", name: "Kincstár", provider: "allamkincstar", kind: "treasury", currency: "HUF" };

const ETF: Instrument = { key: "ETF", name: "ETF", type: "etf", currency: "EUR" };
const instruments = new Map([[ETF.key, ETF]]);

const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).toISOString();
let n = 0;
const tx = (t: Omit<Transaction, "id">): Transaction => ({ id: `t${++n}`, ...t });

// 1 000 000 Ft in → the investment account (internal transfer) → 2 400 EUR at
// 400 (= 960 000 Ft) → 20 ETF at 100 EUR (2 000 EUR, fee included) → later
// 5 of them sold at 120 EUR (600 EUR).
const TXS: Transaction[] = [
  tx({ accountId: "hub", date: at(2025, 1, 2), type: "deposit", currency: "HUF", grossAmount: 1_000_000, netAmount: 1_000_000 }),
  tx({ accountId: "hub", date: at(2025, 1, 2, 11), type: "withdrawal", currency: "HUF", grossAmount: 1_000_000, netAmount: -1_000_000, reference: "IT-1" }),
  tx({ accountId: "inv", date: at(2025, 1, 2, 11), type: "deposit", currency: "HUF", grossAmount: 1_000_000, netAmount: 1_000_000, reference: "IT-1" }),
  tx({ accountId: "inv", date: at(2025, 1, 3), type: "conversion", currency: "HUF", grossAmount: -960_000, netAmount: -960_000, reference: "CV-1" }),
  tx({ accountId: "inv", date: at(2025, 1, 3), type: "conversion", currency: "EUR", grossAmount: 2_400, netAmount: 2_400, reference: "CV-1" }),
  tx({ accountId: "inv", date: at(2025, 1, 4), type: "buy", instrumentKey: "ETF", quantity: 20, pricePerUnit: 99.95, currency: "EUR", grossAmount: 2_000, fee: 1, netAmount: -2_000 }),
  tx({ accountId: "inv", date: at(2025, 6, 2), type: "sell", instrumentKey: "ETF", quantity: 5, pricePerUnit: 120, currency: "EUR", grossAmount: 600, netAmount: 600 }),
];

describe("computePortfolio", () => {
  const prices = new Map([["ETF", 130]]);
  const fx = { EUR: 410 };
  const s = computePortfolio([HUB, INV], TXS, instruments, prices, fx, new Date(2025, 11, 31, 12));
  const inv = s.accounts.find((a) => a.account.id === "inv")!;
  const hub = s.accounts.find((a) => a.account.id === "hub")!;

  it("an internal transfer moves cash but is not new capital", () => {
    expect(hub.cash.HUF ?? 0).toBeCloseTo(0);
    expect(hub.netDepositedHuf).toBe(1_000_000);
    expect(inv.netDepositedHuf).toBe(0);
    expect(inv.transfersInHuf).toBe(1_000_000);
    expect(s.netDepositedHuf).toBe(1_000_000);
  });

  it("cash per currency follows conversions, buys and sells", () => {
    // HUF: 1 000 000 − 960 000; EUR: 2 400 − 2 000 + 600.
    expect(inv.cash.HUF).toBeCloseTo(40_000);
    expect(inv.cash.EUR).toBeCloseTo(1_000);
    expect(inv.cashValueHuf).toBeCloseTo(40_000 + 1_000 * 410);
  });

  it("the cost basis is locked at the FX paid; the sale realizes against it", () => {
    const h = inv.holdings.find((x) => x.instrumentKey === "ETF")!;
    expect(h.quantity).toBe(15);
    // Paid 400 Ft/EUR (960 000 / 2 400): 15 × 100 EUR × 400.
    expect(h.costBasisHuf).toBeCloseTo(600_000);
    expect(h.marketValueHuf).toBeCloseTo(15 * 130 * 410);
    // 5 sold: 600 EUR at 400 Ft/EUR (the latest conversion) − 5 × 100 × 400.
    expect(inv.realizedPlHuf).toBeCloseTo(600 * 400 - 200_000);
    expect(inv.feesHuf).toBeCloseTo(410);
  });

  it("total = holdings + cash; the result is value minus net deposits", () => {
    expect(s.totalValueHuf).toBeCloseTo(s.holdingsValueHuf + s.cashValueHuf);
    expect(s.totalValueHuf).toBeCloseTo(15 * 130 * 410 + 40_000 + 410_000);
  });

  it("internal (mirror) rows never touch cash", () => {
    const mirror = tx({ accountId: "mak", date: at(2025, 2, 1), type: "deposit", currency: "HUF", grossAmount: 5_000_000, netAmount: 5_000_000, internal: true });
    const s2 = computePortfolio([MAK], [mirror], instruments, prices, fx);
    expect(s2.totalValueHuf).toBe(0);
    expect(s2.netDepositedHuf).toBe(0);
  });
});

describe("computeReturns", () => {
  // 1 000 000 Ft deposited, 100 000 Ft interest credited, measured exactly
  // one year (365 days) after the deposit: every measure is 10%.
  const txs: Transaction[] = [
    tx({ accountId: "mak", date: at(2025, 1, 1, 0), type: "deposit", currency: "HUF", grossAmount: 1_000_000, netAmount: 1_000_000 }),
    tx({ accountId: "mak", date: at(2025, 6, 1, 0), type: "interest", currency: "HUF", grossAmount: 100_000, netAmount: 100_000 }),
  ];
  const now = new Date(2026, 0, 1, 0);

  it("simple return, XIRR and TWR agree on a single deposit", () => {
    const r = computeReturns([MAK], txs, new Map(), new Map(), {}, null, now);
    expect(r.simplePct).toBeCloseTo(0.1, 10);
    expect(r.xirrPct).toBeCloseTo(0.1, 3);
    expect(r.xirrCumulativePct).toBeCloseTo(0.1, 3);
    expect(r.twrCumulativePct).toBeCloseTo(0.1, 6);
    expect(r.days).toBe(365);
  });

  it("XIRR weights the money by time: a later deposit earned for less time", () => {
    // −1 000 000 at t=0, −1 000 000 at t=½ year, worth 2 150 000 at t=1.
    const two = [
      ...txs.slice(0, 1),
      tx({ accountId: "mak", date: at(2025, 7, 2, 12), type: "deposit", currency: "HUF", grossAmount: 1_000_000, netAmount: 1_000_000 }),
      tx({ accountId: "mak", date: at(2025, 12, 1, 0), type: "interest", currency: "HUF", grossAmount: 150_000, netAmount: 150_000 }),
    ];
    const r = computeReturns([MAK], two, new Map(), new Map(), {}, null, now);
    // Independent solution of −1e6·(1+x) − 1e6·(1+x)^½ + 2.15e6 = 0.
    const f = (x: number) => -1e6 * (1 + x) - 1e6 * Math.sqrt(1 + x) + 2.15e6;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    expect(r.xirrPct).toBeCloseTo(lo, 2);
    expect(r.simplePct).toBeCloseTo(0.075, 10);
  });

  it("no external money in → no XIRR", () => {
    const r = computeReturns([MAK], [], new Map(), new Map(), {}, null, now);
    expect(r.xirrPct).toBeUndefined();
    expect(r.days).toBe(0);
  });
});
