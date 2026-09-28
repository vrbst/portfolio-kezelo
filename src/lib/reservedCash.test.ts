import { describe, expect, it } from "vitest";
import type { Account, Transaction } from "./model";
import { computePortfolio } from "./portfolio";
import { freeCashOf, reservedCashByAccount, type SavingsGoal } from "./savings";
import { positionsFromSummary } from "./rebalance";
import { computeAlerts, DEFAULT_ALERT_CONFIG } from "./alerts";
import { accountContext } from "./accountRules";

// Invented sample data: 600 000 Ft cash on a treasury account, 550 000 Ft of
// it set aside for a savings goal.

const K: Account = { id: "k", name: "Kincstár", provider: "allamkincstar", kind: "treasury", currency: "HUF" };
const TXS: Transaction[] = [
  { id: "d", accountId: "k", date: "2026-09-01", type: "deposit", currency: "HUF", grossAmount: 600_000, netAmount: 600_000 },
];
const goal = (patch: Partial<SavingsGoal> = {}): SavingsGoal => ({
  id: "g",
  name: "Cél",
  targetHuf: 1_000_000,
  targetDate: "2026-11-01",
  instrumentKeys: [],
  includeCoupons: false,
  createdAt: "2026-09-01",
  reserves: [{ id: "r", amountHuf: 550_000, date: "2026-09-20", accountId: "k" }],
  ...patch,
});
const DAY = "2026-09-28";
const summary = computePortfolio([K], TXS, new Map(), new Map(), {}, new Date(`${DAY}T12:00:00`));

describe("cash set aside is not free cash", () => {
  it("reserved per account: only dated, account-bound reserves of goals still ahead", () => {
    expect(reservedCashByAccount([goal()], DAY).get("k")).toBe(550_000);
    expect(reservedCashByAccount([goal({ targetDate: "2026-09-27" })], DAY).size).toBe(0);
    expect(reservedCashByAccount([goal({ reserves: [{ id: "r", amountHuf: 1, date: "2026-10-01", accountId: "k" }] })], DAY).size).toBe(0);
    expect(reservedCashByAccount([goal({ reserves: [{ id: "r", amountHuf: 1, date: "2026-09-20" }] })], DAY).size).toBe(0);
  });

  it("taken from HUF first, then other currencies at today's rate", () => {
    expect(freeCashOf({ HUF: 100_000, EUR: 1_000 }, 300_000, { EUR: 400 })).toEqual({ HUF: 0, EUR: 500 });
  });

  it("the glide path sees only the free part", () => {
    const reserved = reservedCashByAccount([goal()], DAY);
    const cash = (r?: Map<string, number>) =>
      positionsFromSummary(summary, {}, true, DAY, {}, r).find((p) => p.key === "cash:HUF")!.valueHuf;
    expect(cash()).toBe(600_000);
    expect(cash(reserved)).toBe(50_000);
  });

  it("the account context (transfers) sees only the free part", () => {
    const ctx = accountContext({ summary, transactions: TXS, fx: {}, day: DAY, limits: {}, purchase: {}, fees: {}, reserved: reservedCashByAccount([goal()], DAY) });
    expect(ctx.cash.get("k")).toEqual({ HUF: 50_000 });
  });

  it("no idle-cash alert for the reserved part", () => {
    const cfg = { ...DEFAULT_ALERT_CONFIG, idleCashHuf: 100_000 };
    const idle = (r?: Map<string, number>) =>
      computeAlerts(summary, cfg, new Date(`${DAY}T12:00:00`), TXS, r).filter((a) => a.id.startsWith("idle-cash"));
    expect(idle()).toHaveLength(1);
    expect(idle(reservedCashByAccount([goal()], DAY))).toHaveLength(0);
  });
});
