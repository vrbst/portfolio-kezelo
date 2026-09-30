import { describe, expect, it } from "vitest";
import type { Account, Transaction } from "./model";
import { computePortfolio } from "./portfolio";
import {
  freeCashOf,
  reserveConflictAlerts,
  reserveConflicts,
  reservedCashByAccount,
  settleReserveConflict,
  type SavingsGoal,
} from "./savings";
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

  it("set-aside cash is idle unless the goal is due within the grace days", () => {
    const cfg = { ...DEFAULT_ALERT_CONFIG, idleCashHuf: 100_000, reserveGraceDays: 30 };
    const idle = (g: SavingsGoal, days = cfg.reserveGraceDays) =>
      computeAlerts(
        summary,
        { ...cfg, reserveGraceDays: days },
        new Date(`${DAY}T12:00:00`),
        TXS,
        reservedCashByAccount([g], DAY, [], {}, days),
        reservedCashByAccount([g], DAY),
      ).filter((a) => a.id.startsWith("idle-cash"));
    // Due 2026-11-01: 34 days away → the 550 000 set aside counts as idle.
    const far = idle(goal());
    expect(far).toHaveLength(1);
    expect(far[0].detail).toMatch(/^600\s000\sFt fekszik/);
    expect(far[0].detail).toMatch(/ebből 550\s000\sFt célra félretett/);
    // Within 30 days (target day included), or a longer grace → not idle.
    expect(idle(goal({ targetDate: "2026-10-28" }))).toHaveLength(0);
    expect(idle(goal(), 40)).toHaveLength(0);
    expect(reservedCashByAccount([goal()], DAY, [], {}, 34).get("k")).toBe(550_000);
    expect(reservedCashByAccount([goal()], DAY, [], {}, 33).size).toBe(0);
  });
});

describe("possible double counting: a buy paid from a reserve", () => {
  const DKJ = { key: "dkj", name: "DKJ", type: "tbill" as const, currency: "HUF", faceValue: 1, maturity: "2026-12-01" };
  const insts = new Map([[DKJ.key, DKJ]]);
  const g = goal({ instrumentKeys: [DKJ.key], targetDate: "2026-12-15" });
  const buy = (id: string, date: string, accountId = "k"): Transaction => ({
    id, accountId, date, type: "buy", instrumentKey: DKJ.key, currency: "HUF", quantity: 200_000, grossAmount: 195_000, netAmount: -195_000,
  });

  it("a later buy of the goal's instrument on the reserve's account is flagged", () => {
    const c = reserveConflicts([g], [...TXS, buy("b1", "2026-10-05")], insts, {});
    expect(c).toMatchObject([{ goalId: "g", reserveId: "r", buyTxId: "b1", buyHuf: 195_000, reserveHuf: 550_000 }]);
    expect(reserveConflictAlerts(c)[0].detail).toMatch(/felhasználtad a félretett pénzt/);
  });

  it("not flagged: another account, an earlier buy, or a buy after the target date", () => {
    const txs = [...TXS, buy("b2", "2026-10-05", "other"), buy("b3", "2026-09-10"), buy("b4", "2026-12-20")];
    expect(reserveConflicts([g], txs, insts, {})).toEqual([]);
  });

  it("'used it' lowers the reserve by the buy; either answer silences it — nothing automatic", () => {
    const txs = [...TXS, buy("b1", "2026-10-05")];
    const [c] = reserveConflicts([g], txs, insts, {});
    // Unanswered, the reserve stays as it was.
    expect(g.reserves![0].amountHuf).toBe(550_000);
    const used = settleReserveConflict(g, c, true);
    expect(used.reserves![0].amountHuf).toBe(355_000);
    expect(reserveConflicts([used], txs, insts, {})).toEqual([]);
    const separate = settleReserveConflict(g, c, false);
    expect(separate.reserves![0].amountHuf).toBe(550_000);
    expect(reserveConflicts([separate], txs, insts, {})).toEqual([]);
  });
});
