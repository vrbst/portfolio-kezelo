import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import {
  buildMonthlyPlan,
  computePlanNeeds,
  defaultPlanAmount,
  moveInOrder,
  orderNeeds,
  planBuy,
  planLineText,
  type PlanNeed,
} from "./monthlyPlan";
import { savingsMonthStates, type SavingsGoal } from "./savings";
import { computeGoalProgress, monthsLeftInPeriod, type Goal } from "./goals";
import { defaultGlobals, type Bucket, type GlideConfig } from "./glidePath";
import { allocationState, costFor, type Position } from "./rebalance";

// Invented sample data — round numbers, not a real portfolio.

const need = (key: string, needHuf: number, patch: Partial<PlanNeed> = {}): PlanNeed => ({
  key,
  kind: key.startsWith("dca:") ? "dca" : "savings",
  name: key,
  needHuf,
  doneHuf: 0,
  target: key,
  holdCash: false,
  ...patch,
});

const bucket = (id: string, w: number, patch: Partial<Bucket> = {}): Bucket => ({
  id,
  name: id,
  finalWeight: w,
  start: { mode: "manual", weight: w },
  startDate: "2026-01-01",
  endDate: "2028-01-01",
  interpolation: "linear",
  band: { kind: "abs", pp: 0.05 },
  ...patch,
});

const GLIDE: GlideConfig = {
  id: "v1",
  validFrom: "2026-01-01",
  savedAt: "2026-01-01T00:00:00Z",
  buckets: [bucket("R", 0.5), bucket("K", 0.5)],
  instruments: {
    ETF: { bucketId: "R", sellable: true, acceptsContributions: true, fractional: true },
    BOND: { bucketId: "K", sellable: true, acceptsContributions: true },
  },
  ...defaultGlobals(),
  minTradeHuf: 1_000,
  monthlyAmount: { kind: "remainder" },
};
const DAY = "2026-06-15";
const POS: Position[] = [
  { key: "ETF", name: "ETF", valueHuf: 400_000, quantity: 40, unitPriceHuf: 10_000 },
  { key: "BOND", name: "BOND", valueHuf: 600_000, quantity: 600_000, unitPriceHuf: 1 },
];
const STATE = allocationState(GLIDE, POS, DAY);

const plan = (amountHuf: number, needs: PlanNeed[], positions: Position[] = []) =>
  buildMonthlyPlan({
    amountHuf,
    needs,
    glide: GLIDE,
    state: STATE,
    budgetHuf: amountHuf,
    positions,
    instruments: new Map(),
  });

describe("monthly plan – order and money", () => {
  const needs = [need("savings:a", 100_000), need("dca:w", 40_000)];

  it("enough money: every goal gets its part, the rest goes to the glide path", () => {
    const p = plan(200_000, needs);
    expect(p.lines.map((l) => [l.allocatedHuf, l.shortHuf])).toEqual([
      [100_000, 0],
      [40_000, 0],
    ]);
    expect(p.glideHuf).toBe(60_000);
    expect(p.glidePlan?.suggestions.some((s) => s.status === "ok")).toBe(true);
    expect(p.shortHuf).toBe(0);
  });

  it("too little: filled in order, the later goal is left short and says by how much", () => {
    const p = plan(120_000, needs);
    expect(p.lines.map((l) => [l.allocatedHuf, l.shortHuf])).toEqual([
      [100_000, 0],
      [20_000, 20_000],
    ]);
    expect(p.glideHuf).toBe(0);
    expect(p.glidePlan).toBeNull();
    expect(p.shortHuf).toBe(20_000);
    expect(planLineText(p.lines[1]).replace(/\s/g, " ")).toMatch(/alul maradt: −20 000 Ft/);
  });

  it("a custom order decides who is left short", () => {
    const ordered = orderNeeds(needs, ["dca:w"]);
    expect(ordered.map((n) => n.key)).toEqual(["dca:w", "savings:a"]);
    const p = plan(120_000, ordered);
    expect(p.lines.map((l) => [l.need.key, l.shortHuf])).toEqual([
      ["dca:w", 0],
      ["savings:a", 20_000],
    ]);
  });

  it("moving an item swaps it with its neighbour; the ends stay put", () => {
    expect(moveInOrder(needs, "dca:w", -1)).toEqual(["dca:w", "savings:a"]);
    expect(moveInOrder(needs, "savings:a", -1)).toEqual(["savings:a", "dca:w"]);
  });

  it("a fixed glide amount caps the glide path; the rest is left free", () => {
    const p = buildMonthlyPlan({
      amountHuf: 200_000,
      needs,
      glide: { ...GLIDE, monthlyAmount: { kind: "fixed", huf: 50_000 } },
      state: STATE,
      budgetHuf: 200_000,
      positions: [],
      instruments: new Map(),
    });
    expect(p.glideHuf).toBe(50_000);
    expect(p.freeHuf).toBe(10_000);
  });

  it("a goal already done this month is planned at 0 and left out of the default amount", () => {
    const done = [need("savings:a", 100_000), need("dca:w", 0, { doneHuf: 40_000 })];
    expect(defaultPlanAmount(228_000, done)).toBe(188_000);
    const p = plan(188_000, done);
    expect(p.lines[1].allocatedHuf).toBe(0);
    expect(planLineText(p.lines[1])).toMatch(/teljesítve/);
    expect(p.glideHuf).toBe(88_000);
  });
});

// ---- goal claims from the real calculations ----------------------------------

const ACC: Account = { id: "k", name: "K", provider: "allamkincstar", kind: "treasury", currency: "HUF" };
const LY: Account = { id: "ly", name: "LY", provider: "lightyear", kind: "regular", currency: "HUF" };
const DKJ: Instrument = { key: "dkj", name: "DKJ 261201", type: "tbill", currency: "HUF", faceValue: 1, maturity: "2026-12-01" };
const WBIT: Instrument = { key: "wbit", name: "WBIT", type: "etf", currency: "HUF" };
const tx = (p: Partial<Transaction> & Pick<Transaction, "id" | "date" | "type">): Transaction => ({
  accountId: ACC.id,
  currency: "HUF",
  ...p,
});
const TXS: Transaction[] = [
  tx({ id: "dep", date: "2026-01-02", type: "deposit", grossAmount: 5_000_000, netAmount: 5_000_000 }),
  tx({ id: "b-dkj", date: "2026-06-01", type: "buy", instrumentKey: DKJ.key, quantity: 400_000, grossAmount: 380_000, netAmount: -380_000 }),
];
const SAVING: SavingsGoal = {
  id: "g",
  name: "Cél",
  targetHuf: 1_000_000,
  targetDate: "2026-12-15",
  instrumentKeys: [DKJ.key],
  includeCoupons: false,
  monthlyReminder: true,
  createdAt: "2026-01-01",
};
const DCA: Goal = { id: "d", instrumentKey: WBIT.key, amountHuf: 40_000, periodMonths: 1, createdAt: "2026-01-01" };
const at = (day: string) => new Date(`${day}T12:00:00`);
const needsAt = (day: string, txs = TXS, goals: SavingsGoal[] = [SAVING], order: string[] = []) =>
  computePlanNeeds({
    savingsGoals: goals,
    dcaGoals: [DCA],
    accounts: [ACC, LY],
    transactions: txs,
    instruments: [DKJ, WBIT],
    prices: new Map(),
    fx: {},
    order,
    now: at(day),
  });

describe("monthly plan – goal claims", () => {
  it("default order: dated goals first, then DCA; custom order is applied", () => {
    expect(needsAt("2026-10-05").map((n) => n.key)).toEqual(["savings:g", "dca:d"]);
    expect(needsAt("2026-10-05", TXS, [SAVING], ["dca:d"]).map((n) => n.key)).toEqual([
      "dca:d",
      "savings:g",
    ]);
  });

  it("the goal's claim is the same figure the goal card / reminder use", () => {
    const n = needsAt("2026-10-05")[0];
    const s = savingsMonthStates([SAVING], [ACC], TXS, new Map([[DKJ.key, DKJ]]), new Map(), {}, at("2026-10-05"))[0];
    expect(n.needHuf).toBeCloseTo(s.planHuf);
    expect(n.instrumentKey).toBe(DKJ.key);
    expect(n.holdCash).toBe(false);
  });

  it("a DCA part already bought this month is not planned again", () => {
    const bought = tx({ id: "b-w", date: "2026-10-03", type: "buy", accountId: LY.id, instrumentKey: WBIT.key, quantity: 2, grossAmount: 40_000, netAmount: -40_000 });
    const dca = needsAt("2026-10-05", [...TXS, bought]).find((n) => n.key === "dca:d")!;
    expect(dca.needHuf).toBe(0);
    expect(dca.doneHuf).toBe(40_000);
  });

  it("maturity filter: nothing buyable → hold cash, no instrument", () => {
    const n = needsAt("2026-11-10")[0];
    expect(n.holdCash).toBe(true);
    expect(n.instrumentKey).toBeUndefined();
    const p = plan(300_000, [n]);
    expect(p.lines[0].trade).toBeUndefined();
    expect(planLineText(p.lines[0])).toMatch(/tartsd készpénzben a céldátumig/);
  });

  it("a goal with no instrument at all also holds cash", () => {
    const noInst = { ...SAVING, id: "n", instrumentKeys: [] };
    const n = needsAt("2026-10-05", TXS, [noInst])[0];
    expect(n.holdCash).toBe(true);
    expect(n.needHuf).toBeGreaterThan(0);
  });

  it("quarterly DCA: the period's remainder spread over the months left", () => {
    const q: Goal = { ...DCA, id: "q", amountHuf: 300_000, periodMonths: 3 };
    // October = first month of Q4 → 3 months left.
    expect(monthsLeftInPeriod(9, 3)).toBe(3);
    expect(monthsLeftInPeriod(11, 3)).toBe(1);
    const [p] = computeGoalProgress([q], TXS, [DKJ, WBIT], {}, at("2026-10-05"));
    expect(p.monthPartHuf).toBeCloseTo(100_000);
  });
});

// ---- costs -------------------------------------------------------------------

describe("cost source order: bucket rule → bond redemption → broker → general → 0", () => {
  const lyFee = { buy: { pct: 0.0035 }, sell: { pct: 0.0035 } };
  const etfPos: Position = {
    key: "WB",
    name: "WB",
    valueHuf: 100_000,
    quantity: 10,
    unitPriceHuf: 10_000,
    provider: "lightyear",
    brokerCost: lyFee,
  };

  it("outside the glide path the broker's fee applies, then the general one, then none", () => {
    expect(costFor(GLIDE, etfPos, "buy")).toEqual({ pct: 0.0035 });
    const noBroker = { ...etfPos, brokerCost: undefined };
    expect(costFor({ ...GLIDE, defaultCost: { buy: { pct: 0.001 } } }, noBroker, "buy")).toEqual({ pct: 0.001 });
    expect(costFor(GLIDE, noBroker, "buy")).toBeUndefined();
  });

  it("the bucket rule beats the broker", () => {
    const cfg = { ...GLIDE, buckets: [bucket("R", 0.5, { cost: { buy: { pct: 0.002 } } }), bucket("K", 0.5)] };
    const inGlide = { ...etfPos, rule: cfg.instruments.ETF };
    expect(costFor(cfg, inGlide, "buy")).toEqual({ pct: 0.002 });
  });

  it("a bond's own redemption cost beats a 0% broker fee", () => {
    const bond: Position = { key: "B", name: "B", valueHuf: 1, bondSellCostPct: 0.01, brokerCost: { sell: { pct: 0 } } };
    expect(costFor(GLIDE, bond, "sell")).toEqual({ pct: 0.01 });
  });

  it("a DCA buy outside the glide path is priced with the broker fee, taken out of the money", () => {
    const t = planBuy("WB", 40_000, GLIDE, [etfPos], new Map());
    expect(t.amountHuf + t.costHuf).toBeLessThanOrEqual(40_000);
    expect(t.costHuf).toBeGreaterThan(100);
    expect(t.quantity).toBe(3.986); // 40 000 / 1,0035 / 10 000, floored to 4 decimals
  });
});
