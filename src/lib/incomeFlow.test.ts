import { beforeEach, describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import type { SavingsProgress } from "./savings";
import { defaultGlobals, type Bucket, type GlideConfig } from "./glidePath";
import { allocationState, planCashflow, type Position } from "./rebalance";
import {
  allocateIncome,
  ensureIncomeState,
  incomeAlerts,
  incomeEvents,
  loadIncomeState,
  markIncomeAllocated,
  mergeIncomeState,
  pendingIncome,
  type IncomeEvent,
} from "./incomeFlow";

// Invented sample data — generic names and round numbers, not a real portfolio.

const DAY = "2026-10-20";

function bucket(id: string, w: number): Bucket {
  return {
    id,
    name: id,
    finalWeight: w,
    start: { mode: "manual", weight: w },
    startDate: "2026-01-01",
    endDate: "2028-01-01",
    interpolation: "linear",
    band: { kind: "abs", pp: 0.05 },
  };
}

const GLIDE: GlideConfig = {
  id: "v1",
  validFrom: "2026-01-01",
  savedAt: "2026-01-01T00:00:00Z",
  buckets: [bucket("R", 0.6), bucket("K", 0.4)],
  instruments: {
    ETF: { bucketId: "R", sellable: true, acceptsContributions: true },
    KOTV: { bucketId: "K", sellable: true, acceptsContributions: true },
  },
  ...defaultGlobals(),
  minTradeHuf: 0,
};
const bond = (key: string, valueHuf: number): Position => ({
  key,
  name: key,
  valueHuf,
  quantity: valueHuf,
  unitPriceHuf: 1,
});
// On the path: 600 000 / 400 000.
const STATE = allocationState(GLIDE, [bond("ETF", 600_000), bond("KOTV", 400_000)], DAY);

function goal(
  name: string,
  roomHuf: number,
  patch: Partial<SavingsProgress> & { targetDate?: string; includeCoupons?: boolean; instrumentKeys?: string[] } = {},
): SavingsProgress {
  const { targetDate = "2026-12-15", includeCoupons = true, instrumentKeys = [], ...rest } = patch;
  return {
    goal: { id: name, name, targetHuf: 1_000_000, targetDate, instrumentKeys, includeCoupons, createdAt: "2026-01-01" },
    couponRoomHuf: roomHuf,
    gapHuf: roomHuf,
    daysLeft: 56,
    reached: roomHuf <= 0,
    ...rest,
  } as SavingsProgress;
}

const coupon = (id: string, day: string, amountHuf: number): IncomeEvent => ({
  id,
  day,
  kind: "coupon",
  instrumentKey: "FIX",
  instrumentName: "Fix 2031",
  accountId: "kincstar",
  provider: "allamkincstar",
  currency: "HUF",
  amount: amountHuf,
  amountHuf,
});

const shares = (a: ReturnType<typeof allocateIncome>[number]) =>
  Object.fromEntries(a.goals.map((g) => [g.goalId, Math.round(g.huf)]));
const buys = (a: ReturnType<typeof allocateIncome>[number]) =>
  Object.fromEntries((a.plan?.suggestions ?? []).map((s) => [s.bucketId, Math.round(s.amountHuf)]));

describe("allocateIncome – goal first, then the glide path", () => {
  it("a claiming goal takes up to its room, the rest goes along the glide path", () => {
    const [a] = allocateIncome([coupon("c1", "2026-10-10", 300_000)], [goal("Cél", 200_000)], GLIDE, STATE);
    expect(shares(a)).toEqual({ Cél: 200_000 });
    expect(a.glideHuf).toBeCloseTo(100_000);
    expect(buys(a)).toEqual({ R: 60_000, K: 40_000 });
  });

  it("a goal short by more than the coupon takes it all", () => {
    const [a] = allocateIncome([coupon("c1", "2026-10-10", 300_000)], [goal("Cél", 900_000)], GLIDE, STATE);
    expect(shares(a)).toEqual({ Cél: 300_000 });
    expect(a.glideHuf).toBe(0);
    expect(a.plan).toBeNull();
  });

  it.each([
    ["expired", goal("Cél", 900_000, { daysLeft: 0 })],
    ["covered", goal("Cél", 0)],
    ["coupon after its date", goal("Cél", 900_000, { targetDate: "2026-10-01" })],
    ["not earmarking coupons", goal("Cél", 900_000, { includeCoupons: false })],
  ])("a goal that is %s gets nothing", (_why, g) => {
    const [a] = allocateIncome([coupon("c1", "2026-10-10", 300_000)], [g], GLIDE, STATE);
    expect(a.goals).toEqual([]);
    expect(a.glideHuf).toBe(300_000);
    expect(buys(a)).toEqual({ R: 180_000, K: 120_000 });
  });

  it("several claiming goals share in proportion to their room", () => {
    const [a] = allocateIncome(
      [coupon("c1", "2026-10-10", 300_000)],
      [goal("A", 400_000), goal("B", 200_000)],
      GLIDE,
      STATE,
    );
    expect(shares(a)).toEqual({ A: 200_000, B: 100_000 });
    expect(a.glideHuf).toBeCloseTo(0);
  });

  it("…and each gets its full room when the rooms don't reach the coupon", () => {
    const [a] = allocateIncome(
      [coupon("c1", "2026-10-10", 300_000)],
      [goal("A", 100_000), goal("B", 50_000)],
      GLIDE,
      STATE,
    );
    expect(shares(a)).toEqual({ A: 100_000, B: 50_000 });
    expect(a.glideHuf).toBeCloseTo(150_000);
  });

  it("income nobody claims (dividend, cash interest) goes wholly along the glide path", () => {
    for (const kind of ["dividend", "interest"] as const) {
      const [a] = allocateIncome(
        [{ ...coupon("d1", "2026-10-10", 100_000), kind, instrumentKey: undefined, provider: "lightyear" }],
        [goal("Cél", 900_000)],
        GLIDE,
        STATE,
      );
      expect(a.goals).toEqual([]);
      expect(a.glideHuf).toBe(100_000);
      expect(buys(a)).toEqual({ R: 60_000, K: 40_000 });
    }
  });

  it("a goal's own instrument maturing is its payout — not split", () => {
    const [a] = allocateIncome(
      [{ ...coupon("r1", "2026-10-10", 400_000), kind: "redemption", instrumentKey: "DKJ" }],
      [goal("Cél", 900_000, { instrumentKeys: ["DKJ"] })],
      GLIDE,
      STATE,
    );
    expect(a.payoutOf).toEqual(["Cél"]);
    expect(a.glideHuf).toBe(0);
    expect(a.plan).toBeNull();
  });

  it("events build on each other in date order: the goal's room and the glide state", () => {
    // Given newest-first on purpose: they are still handled oldest first.
    const [first, second] = allocateIncome(
      [coupon("c2", "2026-10-12", 300_000), coupon("c1", "2026-10-10", 300_000)],
      [goal("Cél", 400_000)],
      GLIDE,
      STATE,
    );
    expect(first.event.id).toBe("c1");
    expect(shares(first)).toEqual({ Cél: 300_000 });
    // Only 100 000 room left for the second coupon.
    expect(shares(second)).toEqual({ Cél: 100_000 });
    expect(second.glideHuf).toBeCloseTo(200_000);
    // Routed on the state after the first event's buys (none here) — on the path.
    expect(buys(second)).toEqual({ R: 120_000, K: 80_000 });
  });

  it("the glide path's suggested buys shift the state the next event is routed on", () => {
    const e1 = { ...coupon("d1", "2026-10-10", 100_000), kind: "dividend" as const };
    const e2 = { ...coupon("d2", "2026-10-11", 100_000), kind: "dividend" as const };
    // K is underweight: the first 100 000 fills it; the second must see that.
    const state = allocationState(GLIDE, [bond("ETF", 700_000), bond("KOTV", 300_000)], DAY);
    const [a1, a2] = allocateIncome([e1, e2], [], GLIDE, state);
    expect(buys(a1)).toEqual({ K: 100_000 });
    // After the first: 700 000 / 400 000 → the second goes to K again, but
    // not as if the first had never happened.
    const independent = planCashflow(GLIDE, state, 100_000).suggestions;
    expect(buys(a2)).toEqual({ R: 20_000, K: 80_000 });
    expect(independent.map((s) => Math.round(s.amountHuf))).toEqual([100_000]);
  });
});

describe("incomeEvents", () => {
  const accounts: Account[] = [
    { id: "kincstar", name: "K", provider: "allamkincstar", kind: "treasury", currency: "HUF" },
    { id: "ly", name: "L", provider: "lightyear", kind: "regular", currency: "EUR" },
  ];
  const instruments = new Map<string, Instrument>([
    ["FIX", { key: "FIX", name: "Fix 2031", type: "gov_bond", currency: "HUF" }],
  ]);
  const t = (p: Partial<Transaction> & Pick<Transaction, "id" | "date" | "type">): Transaction => ({
    accountId: "kincstar",
    currency: "HUF",
    netAmount: 100,
    ...p,
  });
  const txs: Transaction[] = [
    t({ id: "old", date: "2026-08-01", type: "interest", instrumentKey: "FIX" }),
    t({ id: "cpn", date: "2026-10-10", type: "interest", instrumentKey: "FIX" }),
    t({ id: "mirror", date: "2026-10-10", type: "interest", instrumentKey: "FIX", internal: true }),
    t({ id: "cash-int", date: "2026-10-11", type: "interest", accountId: "ly", currency: "EUR", netAmount: 2 }),
    t({ id: "div", date: "2026-10-12", type: "dividend", accountId: "ly", currency: "EUR", netAmount: 10 }),
    t({ id: "dep", date: "2026-10-13", type: "deposit", netAmount: 200_000 }),
  ];

  it("lists coupons, cash interest and dividends from the start day — no deposits, no mirror rows", () => {
    const ev = incomeEvents(txs, instruments, accounts, { EUR: 400 }, "2026-09-20");
    expect(ev.map((e) => [e.id, e.kind, e.provider, Math.round(e.amountHuf)])).toEqual([
      ["cpn", "coupon", "allamkincstar", 100],
      ["cash-int", "interest", "lightyear", 800],
      ["div", "dividend", "lightyear", 4_000],
    ]);
  });
});

describe("distributed marks", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  it("switches tracking on with a 30-day look-back, once", () => {
    expect(loadIncomeState()).toBeNull();
    expect(ensureIncomeState("2026-10-20").since).toBe("2026-09-20");
    expect(ensureIncomeState("2026-12-01").since).toBe("2026-09-20");
  });

  it("an event marked distributed is not listed again", () => {
    const st = ensureIncomeState("2026-10-20");
    const ev = [coupon("c1", "2026-10-10", 1), coupon("c2", "2026-10-11", 1)];
    expect(pendingIncome(ev, st).map((e) => e.id)).toEqual(["c1", "c2"]);
    markIncomeAllocated(["c1"]);
    expect(pendingIncome(ev, loadIncomeState()).map((e) => e.id)).toEqual(["c2"]);
    // …and its alert (the bot's message) goes away with it.
    const alerts = incomeAlerts(allocateIncome(pendingIncome(ev, loadIncomeState()), [], GLIDE, STATE));
    expect(alerts.map((a) => a.id)).toEqual(["income:c2"]);
  });

  it("nothing is listed before tracking is switched on, or before its start", () => {
    expect(pendingIncome([coupon("c1", "2026-10-10", 1)], null)).toEqual([]);
    expect(pendingIncome([coupon("c0", "2026-09-01", 1)], { since: "2026-09-20", allocated: [] })).toEqual([]);
  });

  it("two devices merge: the earlier start, every mark", () => {
    expect(
      mergeIncomeState({ since: "2026-09-20", allocated: ["a"] }, { since: "2026-09-25", allocated: ["b"] }),
    ).toEqual({ since: "2026-09-20", allocated: ["a", "b"] });
  });
});
