import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { bondSaleForCash, futureBondCashflows } from "./bonds";
import { computePortfolio } from "./portfolio";
import { computeSavingsProgress, type SavingsGoal } from "./savings";
import {
  computeRefillProgress,
  plannedSales,
  refillExpenses,
  refillFinishLabel,
  refillImpact,
  withBondFigures,
  type RefillGoal,
} from "./refill";
import { buildMonthlyPlan, computePlanNeeds, orderNeeds, type PlanNeed } from "./monthlyPlan";
import { projectForecast, type ForecastAssumptions } from "./forecast";
import { allocationState, type Position } from "./rebalance";
import type { GlideConfig } from "./glidePath";

// Invented sample data — not a real portfolio. A FixMÁP-like bond: 7%,
// quarterly coupons on the 23rd of Jan/Apr/Jul/Oct, 1% early-sale cost;
// an ETF priced in HUF to keep the sums simple.

const MAK: Account = { id: "mak", name: "Kincstár", provider: "allamkincstar", kind: "treasury", currency: "HUF" };
const LY: Account = { id: "ly", name: "Broker", provider: "lightyear", kind: "regular", currency: "HUF" };

const FIX: Instrument = {
  key: "fix-q1",
  name: "Fix Q1",
  type: "gov_bond",
  currency: "HUF",
  faceValue: 1,
  maturity: "2031-01-23",
  notBuyable: true,
  bond: {
    issueDate: "2026-01-06",
    couponRate: 0.07,
    couponIntervalMonths: 3,
    firstCouponDate: "2026-04-23",
    firstCouponHuf: 100_000,
    maturity: "2031-01-23",
  },
};
const ETF: Instrument = { key: "etf", name: "ETF", type: "etf", currency: "HUF" };
const DCA_ETF: Instrument = { key: "dca", name: "DCA ETF", type: "etf", currency: "HUF" };
const instruments = new Map([FIX, ETF, DCA_ETF].map((i) => [i.key, i]));
const prices = new Map([
  ["etf", { price: 1000, currency: "HUF" }],
  ["dca", { price: 1000, currency: "HUF" }],
]) as never;

const tx = (p: Partial<Transaction> & Pick<Transaction, "id" | "date" | "type">): Transaction => ({
  accountId: MAK.id,
  currency: "HUF",
  ...p,
});

const BASE: Transaction[] = [
  tx({ id: "dep", date: "2026-01-05", type: "deposit", grossAmount: 10_000_000, netAmount: 10_000_000 }),
  tx({ id: "buy-fix", date: "2026-01-06", type: "buy", instrumentKey: FIX.key, quantity: 10_000_000, grossAmount: 10_000_000, netAmount: -10_000_000 }),
];
const at = (day: string) => new Date(`${day}T12:00:00`);

const GOAL: RefillGoal = {
  id: "r",
  name: "Felújítás",
  createdAt: "2026-11-01",
  withdrawal: { day: "2026-12-15", source: { kind: "holding", instrumentKey: FIX.key, accountId: MAK.id }, amountHuf: 2_000_000, faceHuf: 2_000_000 },
  target: { kind: "glide" },
  pace: { kind: "asap" },
};

const summaryAt = (txs: Transaction[], day: string) =>
  computePortfolio([MAK, LY], txs, instruments, prices, {}, at(day));
const coupons = (txs: Transaction[], day: string, goals: RefillGoal[]) =>
  futureBondCashflows(summaryAt(txs, day), at(day), txs, plannedSales(goals, txs)).filter((c) => c.kind === "coupon");

describe("bondSaleForCash – face to sell for a set amount of cash", () => {
  it("right after a coupon more face is needed than right before the next one", () => {
    const after = bondSaleForCash(FIX, 2_000_000, "2026-10-26")!; // 3 days into the quarter
    const before = bondSaleForCash(FIX, 2_000_000, "2027-01-21")!; // 2 days before the coupon
    expect(after.faceHuf).toBeGreaterThan(before.faceHuf);
    // The cash in hand is what was asked for (rounded up to a whole forint of face).
    for (const s of [after, before]) {
      expect(s.proceedsHuf).toBeGreaterThanOrEqual(2_000_000);
      expect(s.proceedsHuf).toBeLessThan(2_000_002);
      expect(s.saleCostHuf).toBeCloseTo(s.faceHuf * 0.01, 6);
    }
    // 90 of 92 days of a 1.75% quarter accrued.
    expect(before.accruedPct).toBeCloseTo(0.0175 * (90 / 92), 6);
  });

  it("a weekend day settles on Monday; not a bond → undefined", () => {
    expect(bondSaleForCash(FIX, 1_000_000, "2026-12-12")!.settlementDay).toBe("2026-12-14");
    expect(bondSaleForCash(ETF, 1_000_000, "2026-12-14")).toBeUndefined();
  });

  it("withBondFigures stores the face and the cost of the day", () => {
    const w = withBondFigures({ ...GOAL.withdrawal, faceHuf: undefined }, instruments);
    const s = bondSaleForCash(FIX, 2_000_000, "2026-12-15")!;
    expect(w.faceHuf).toBe(s.faceHuf);
    expect(w.costHuf).toBe(Math.round(s.saleCostHuf));
  });
});

describe("planned sale – coupons after the withdrawal day are on the smaller face", () => {
  it("before the day: unchanged; after it: 8 M instead of 10 M", () => {
    const all = coupons(BASE, "2026-11-02", []);
    const less = coupons(BASE, "2026-11-02", [GOAL]);
    const jan = (cs: typeof all) => cs.find((c) => c.date === "2027-01-23")!.amountHuf;
    expect(jan(all)).toBeCloseTo(175_000);
    expect(jan(less)).toBeCloseTo(140_000);
    // A goal dated after the next coupon leaves that coupon whole.
    const late = { ...GOAL, withdrawal: { ...GOAL.withdrawal, day: "2027-02-01" } };
    expect(jan(coupons(BASE, "2026-11-02", [late]))).toBeCloseTo(175_000);
    expect(coupons(BASE, "2026-11-02", [late]).find((c) => c.date === "2027-04-23")!.amountHuf).toBeCloseTo(140_000);
  });

  it("once the sale is imported the ledger's face counts — no second cut", () => {
    const sold = [
      ...BASE,
      tx({ id: "sell", date: "2026-12-15", type: "sell", instrumentKey: FIX.key, quantity: 2_000_000, grossAmount: 1_980_000, netAmount: 1_980_000 }),
    ];
    expect(plannedSales([GOAL], sold)).toEqual([]);
    expect(coupons(sold, "2026-12-20", [GOAL]).find((c) => c.date === "2027-01-23")!.amountHuf).toBeCloseTo(140_000);
  });

  it("a coupon a dated goal picked shrinks with it — the goal's gap grows", () => {
    const goal: SavingsGoal = {
      id: "g",
      name: "Babaváró kamat",
      targetHuf: 400_000,
      targetDate: "2027-04-01",
      instrumentKeys: [],
      includeCoupons: false,
      couponIds: [`${FIX.key}@2027-01-23`],
      createdAt: "2026-01-01",
    };
    const prog = (goals: RefillGoal[]) =>
      computeSavingsProgress([goal], [MAK, LY], BASE, instruments, prices, {}, at("2026-11-02"), plannedSales(goals, BASE))[0];
    expect(prog([]).pickedCouponsHuf).toBeCloseTo(175_000);
    expect(prog([GOAL]).pickedCouponsHuf).toBeCloseTo(140_000);
    expect(prog([GOAL]).gapHuf - prog([]).gapHuf).toBeCloseTo(35_000);
  });

  it("refillImpact lists the goal, the cost and the lost coupons", () => {
    const goal: SavingsGoal = {
      id: "g",
      name: "Babaváró kamat",
      targetHuf: 400_000,
      targetDate: "2027-04-01",
      instrumentKeys: [],
      includeCoupons: false,
      couponIds: [`${FIX.key}@2027-01-23`],
      createdAt: "2026-01-01",
    };
    const now = at("2026-11-02");
    const imp = refillImpact({
      withdrawal: GOAL.withdrawal,
      refills: [],
      summary: summaryAt(BASE, "2026-11-02"),
      accounts: [MAK, LY],
      transactions: BASE,
      instruments,
      prices,
      fx: {},
      savingsGoals: [goal],
      now,
    });
    const face = imp.bond!.faceHuf;
    expect(imp.saleCostHuf).toBeCloseTo(face * 0.01, 6);
    expect(imp.goals).toHaveLength(1);
    expect(imp.goals[0].couponsBeforeHuf - imp.goals[0].couponsAfterHuf).toBeCloseTo(face * 0.0175, 0);
    // 4 quarters within a year after the sale day: ~7% of the face, give or take a coupon.
    expect(imp.lostCoupons12Huf).toBeGreaterThan(face * 0.0175 * 3 - 1);
    expect(imp.lostCouponsTotalHuf).toBeGreaterThan(imp.lostCoupons12Huf);
  });

  it("refillImpact: money locked in the account is flagged", () => {
    const imp = refillImpact({
      withdrawal: { day: "2026-12-15", source: { kind: "cash", accountId: LY.id }, amountHuf: 100_000 },
      refills: [],
      summary: summaryAt(BASE, "2026-11-02"),
      accounts: [MAK, LY],
      transactions: BASE,
      instruments,
      prices,
      fx: {},
      savingsGoals: [],
      accountLimits: { ly: { noOutflowUntil: "2031-12-31", noOutflowNote: "TBSZ lekötés" } },
      now: at("2026-11-02"),
    });
    expect(imp.blocked).toBe("TBSZ lekötés");
  });
});

const GLIDE: GlideConfig = {
  id: "v1",
  validFrom: "2026-01-01",
  savedAt: "2026-01-01T00:00:00.000Z",
  buckets: [
    { id: "eq", name: "Részvény", finalWeight: 0.6, start: { mode: "manual", weight: 0.4 }, startDate: "2026-01-01", endDate: "2031-01-01", interpolation: "linear", band: { kind: "abs", pp: 0.05 } },
    { id: "bd", name: "Kötvény", finalWeight: 0.4, start: { mode: "manual", weight: 0.6 }, startDate: "2026-01-01", endDate: "2031-01-01", interpolation: "linear", band: { kind: "abs", pp: 0.05 } },
  ],
  instruments: {
    etf: { bucketId: "eq", sellable: false, acceptsContributions: true, fractional: true },
    dca: { bucketId: "eq", sellable: false, acceptsContributions: true, fractional: true },
    [FIX.key]: { bucketId: "bd", sellable: true, acceptsContributions: true },
  },
  checkFrequency: "monthly",
  minTradeHuf: 1,
  restoreTo: "path",
  maxCostRatio: 0.01,
  bondsAtFace: true,
  defaultCost: {},
  realertStepPp: 0.02,
  deepAlertsInQuietHours: false,
  monthlyAmount: { kind: "fixed", huf: 10_000 },
  flowTarget: { kind: "today" },
  buyCostMode: "included",
};

const buy = (id: string, day: string, key: string, huf: number) =>
  tx({ id, date: day, type: "buy", accountId: LY.id, instrumentKey: key, quantity: huf / 1000, grossAmount: huf, netAmount: -huf });
const SOLD = [
  ...BASE,
  tx({ id: "sell", date: "2026-12-15", type: "sell", instrumentKey: FIX.key, quantity: 2_000_000, grossAmount: 1_990_000, netAmount: 1_990_000 }),
];

describe("computeRefillProgress", () => {
  const prog = (txs: Transaction[], day: string, goal: RefillGoal = GOAL, extra: Partial<Parameters<typeof computeRefillProgress>[0]> = {}) =>
    computeRefillProgress({ goals: [goal], transactions: txs, instruments, fx: {}, glide: GLIDE, now: at(day), ...extra })[0];

  it("planned before the day; awaiting once past without the sale; then refilling", () => {
    expect(prog(BASE, "2026-12-01").status).toBe("planned");
    expect(prog(BASE, "2026-12-01").needHuf).toBe(0);
    expect(prog(BASE, "2026-12-20").status).toBe("awaiting");
    const p = prog(SOLD, "2026-12-20");
    expect(p.status).toBe("refilling");
    expect(p.sale?.id).toBe("sell");
    expect(p.needHuf).toBe(2_000_000);
  });

  it("buys after the withdrawal count; earlier ones and a DCA goal's share do not", () => {
    const txs = [
      ...SOLD,
      buy("early", "2026-12-01", "etf", 300_000),
      buy("b1", "2026-12-20", "etf", 300_000),
      buy("b2", "2027-01-10", "dca", 150_000),
    ];
    const p = prog(txs, "2027-01-12", GOAL, {
      dcaGoals: [{ id: "d", instrumentKey: "dca", amountHuf: 100_000, periodMonths: 1, createdAt: "2026-01-01" }],
    });
    // 300 000 + (150 000 − the DCA's 100 000).
    expect(p.refilledHuf).toBe(350_000);
    expect(p.remainingHuf).toBe(1_650_000);
    expect(p.thisMonthHuf).toBe(50_000);
  });

  it("a buy outside the glide path's contributions doesn't count; done when refilled", () => {
    const txs = [...SOLD, buy("x", "2026-12-20", "etf", 2_000_000)];
    expect(prog(txs, "2026-12-21").status).toBe("done");
    const noGlide = computeRefillProgress({
      goals: [{ ...GOAL, target: { kind: "instrument", instrumentKey: "dca" } }],
      transactions: txs,
      instruments,
      fx: {},
      glide: GLIDE,
      now: at("2026-12-21"),
    })[0];
    expect(noGlide.refilledHuf).toBe(0);
    expect(noGlide.buyKey).toBe("dca");
  });

  it("'source' target: an unbuyable bond goes along the glide path's bond bucket", () => {
    const p = prog(SOLD, "2026-12-20", { ...GOAL, target: { kind: "source" } });
    expect(p.viaGlide).toBe(true);
    expect(p.sourceUnbuyable).toBe(true);
    const txs = [...SOLD, buy("e", "2026-12-20", "etf", 100_000)];
    expect(prog(txs, "2026-12-21", { ...GOAL, target: { kind: "source" } }).refilledHuf).toBe(0);
  });

  it("pace: months spreads the remainder, monthly caps it; includeCost adds the cost", () => {
    const months = prog(SOLD, "2026-12-20", { ...GOAL, pace: { kind: "months", months: 10 } });
    // December 2026 is the first of the 10 months.
    expect(months.monthsLeft).toBe(10);
    expect(months.needHuf).toBeCloseTo(200_000);
    const monthly = prog(SOLD, "2026-12-20", { ...GOAL, pace: { kind: "monthly", huf: 150_000 } });
    expect(monthly.needHuf).toBe(150_000);
    expect(refillFinishLabel(monthly, 0, at("2026-12-20"))).toBe("2028. január");
    const cost = prog(SOLD, "2026-12-20", { ...GOAL, includeCost: true, withdrawal: { ...GOAL.withdrawal, costHuf: 20_000 } });
    expect(cost.amountHuf).toBe(2_020_000);
  });
});

describe("monthly plan – the refill after the dated goals, instead of the usual split", () => {
  const needOf = (key: string, kind: PlanNeed["kind"], huf: number): PlanNeed => ({
    key, kind, name: key, needHuf: huf, doneHuf: 0, target: key, holdCash: false, instrumentKey: kind === "dca" ? "dca" : undefined,
  });

  it("an unplaced refill goes after the dated goals, before the rest; a placed one keeps its place", () => {
    const needs = [needOf("dca:d", "dca", 40_000), needOf("refill:r", "refill", 1)];
    expect(orderNeeds(needs, ["dca:d"]).map((n) => n.key)).toEqual(["refill:r", "dca:d"]);
    expect(orderNeeds(needs, ["dca:d", "refill:r"]).map((n) => n.key)).toEqual(["dca:d", "refill:r"]);
    // Dated goals (a deadline) keep their money first — wherever the user put them.
    // The default order computePlanNeeds builds: refills, dated goals, DCA.
    const withDated = [
      needOf("refill:r", "refill", 1),
      needOf("savings:a", "savings", 1),
      needOf("savings:b", "savings", 1),
      needOf("dca:d", "dca", 40_000),
    ];
    expect(orderNeeds(withDated, ["savings:a", "dca:d", "savings:b"]).map((n) => n.key)).toEqual([
      "savings:a",
      "dca:d",
      "savings:b",
      "refill:r",
    ]);
    expect(orderNeeds(withDated, ["savings:a"]).map((n) => n.key)).toEqual([
      "savings:a",
      "savings:b",
      "refill:r",
      "dca:d",
    ]);
  });

  it("computePlanNeeds: the refill takes the budget; its money joins the glide path's buys", () => {
    const txs = [...SOLD, buy("e0", "2026-06-01", "etf", 5_000_000)];
    const needs = computePlanNeeds({
      savingsGoals: [],
      dcaGoals: [{ id: "d", instrumentKey: "dca", amountHuf: 40_000, periodMonths: 1, createdAt: "2026-01-01" }],
      refills: [GOAL],
      glide: GLIDE,
      accounts: [MAK, LY],
      transactions: txs,
      instruments: [FIX, ETF, DCA_ETF],
      prices,
      fx: {},
      order: ["dca:d"],
      now: at("2026-12-20"),
    });
    expect(needs.map((n) => n.key)).toEqual(["refill:r", "dca:d"]);
    const positions: Position[] = [
      { key: "etf", name: "ETF", valueHuf: 5_000_000, quantity: 5000, unitPriceHuf: 1000 },
      { key: FIX.key, name: "Fix Q1", valueHuf: 8_000_000, quantity: 8_000_000, unitPriceHuf: 1 },
    ];
    const state = allocationState(GLIDE, positions, "2026-12-20");
    const plan = buildMonthlyPlan({
      amountHuf: 200_000,
      needs,
      glide: GLIDE,
      state,
      budgetHuf: 200_000,
      positions,
      instruments,
    });
    expect(plan.lines[0].viaGlide).toBe(true);
    expect(plan.lines[0].allocatedHuf).toBe(200_000);
    // "As soon as possible" asks for the whole remainder: what doesn't fit this
    // month is the later months' job, not a shortfall.
    expect(plan.lines[0].shortHuf).toBe(0);
    expect(plan.shortHuf).toBe(40_000);
    // The DCA is left short this month — on purpose.
    expect(plan.lines[1].shortHuf).toBe(40_000);
    // The whole refill money is routed by the glide path, past its 10 000 Ft cap.
    expect(plan.glideHuf).toBe(200_000);
    expect(plan.freeHuf).toBe(0);
    const bought = plan.glidePlan!.suggestions.filter((s) => s.side === "buy").reduce((s, x) => s + x.amountHuf, 0);
    expect(bought).toBeCloseTo(200_000, -1);
  });
});

describe("forecast – a planned bond sale shrinks the bond leg, not the liquid part", () => {
  const A: ForecastAssumptions = {
    annualReturn: { pess: 0, real: 0, opt: 0 },
    monthlySavingHuf: 0,
    savingGrowth: 0,
    reinvestTarget: "growth",
    reinvestBondRate: 0,
    months: 12,
  } as ForecastAssumptions;

  it("the value drops by the sold part on the day; no shortfall; later coupons smaller", () => {
    const summary = summaryAt(BASE, "2026-11-02");
    const base = projectForecast(summary, A, [], at("2026-11-02"));
    const exp = refillExpenses([GOAL], BASE, instruments);
    expect(exp).toHaveLength(1);
    expect(exp[0].bondSale?.quantity).toBe(2_000_000);
    const sold = projectForecast(summary, A, exp, at("2026-11-02"));
    expect(sold.shortfall.real).toBeNull();
    const end = (r: typeof base) => r.points.at(-1)!.real;
    // 2 M of face leaves, and a year of its coupons (≈ 4 × 35 000) with it.
    expect(end(base) - end(sold)).toBeGreaterThan(2_000_000);
    expect(end(base) - end(sold)).toBeLessThan(2_200_000);
    expect(base.couponHuf - sold.couponHuf).toBeGreaterThan(100_000);
    // Before the sale month nothing changes.
    expect(sold.points[0].real).toBeCloseTo(base.points[0].real, 0);
    // An imported sale is in the ledger: no planned expense.
    expect(refillExpenses([GOAL], SOLD, instruments)).toEqual([]);
  });
});
