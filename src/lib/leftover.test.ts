import { afterEach, describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import type { Reminder } from "./alerts";
import type { Goal } from "./goals";
import type { SavingsGoal } from "./savings";
import {
  buildLeftoverPlan,
  leftoverMonth,
  leftoverNeeds,
  leftoverReply,
  parseLeftoverAmount,
  recordedLeftover,
  leftoverTitle,
  type LeftoverNeeds,
} from "./leftover";
import { DEFAULT_LEFTOVER, type LeftoverSettings } from "./planPrefs";
import { defaultGlobals, type Bucket, type GlideConfig } from "./glidePath";
import { allocationState, type Position } from "./rebalance";
import {
  easterSunday,
  isWorkday,
  lastWorkdayOfMonth,
  SWAPPED_DAYS,
} from "./huCalendar";
import { effectiveMonthKey } from "./goals";
import { computePortfolio } from "./portfolio";
import { accountContext } from "./accountRules";
import { depositText, planLineText } from "./monthlyPlan";

// Invented sample data — round numbers, not a real portfolio.

const ACC: Account = { id: "k", name: "K", provider: "allamkincstar", kind: "treasury", currency: "HUF" };
const LY: Account = { id: "ly", name: "LY", provider: "lightyear", kind: "regular", currency: "HUF" };
const DKJ: Instrument = { key: "dkj", name: "DKJ 261102", type: "tbill", currency: "HUF", faceValue: 1, maturity: "2026-11-02" };
const WBIT: Instrument = { key: "wbit", name: "WBIT", type: "etf", currency: "HUF" };
const tx = (p: Partial<Transaction> & Pick<Transaction, "id" | "date" | "type">): Transaction => ({
  accountId: ACC.id,
  currency: "HUF",
  ...p,
});
const TXS: Transaction[] = [
  tx({ id: "dep", date: "2026-01-02", type: "deposit", grossAmount: 5_000_000, netAmount: 5_000_000 }),
  tx({ id: "b1", date: "2026-06-01", type: "buy", instrumentKey: DKJ.key, quantity: 400_000, grossAmount: 400_000, netAmount: -400_000 }),
];
// 600 000 Ft missing on 1 September, three pay days (Sep, Oct, Nov) → 200 000 a month.
const BABA: SavingsGoal = {
  id: "b",
  name: "Babaváró",
  targetHuf: 1_000_000,
  targetDate: "2026-11-20",
  instrumentKeys: [DKJ.key],
  includeCoupons: false,
  minDaysToMaturity: 10,
  createdAt: "2026-01-01",
};
const DCA: Goal = { id: "d", instrumentKey: WBIT.key, amountHuf: 40_000, periodMonths: 1, createdAt: "2026-01-01" };
const PRICES = new Map([[DKJ.key, 1]]);
const LAST_WD = "2026-09-30T17:00:00"; // Wednesday — September's last working day

const needsAt = (
  now: string,
  o: {
    txs?: Transaction[];
    goals?: SavingsGoal[];
    dca?: Goal[];
    settings?: Partial<LeftoverSettings>;
    reminders?: Reminder[];
  } = {},
): LeftoverNeeds =>
  leftoverNeeds({
    savingsGoals: o.goals ?? [BABA],
    dcaGoals: o.dca ?? [],
    accounts: [ACC, LY],
    transactions: o.txs ?? TXS,
    instruments: [DKJ, WBIT],
    prices: PRICES,
    fx: {},
    order: [],
    settings: { ...DEFAULT_LEFTOVER, ...o.settings },
    reminders: o.reminders,
    now: new Date(now),
  });

const bucket = (id: string, w: number): Bucket => ({
  id,
  name: id,
  finalWeight: w,
  start: { mode: "manual", weight: w },
  startDate: "2026-01-01",
  endDate: "2028-01-01",
  interpolation: "linear",
  band: { kind: "abs", pp: 0.05 },
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
  // The monthly saving's cap — the leftover ignores it.
  monthlyAmount: { kind: "fixed", huf: 10_000 },
};
const POS: Position[] = [
  { key: "ETF", name: "ETF", valueHuf: 400_000, quantity: 40, unitPriceHuf: 10_000 },
  { key: "BOND", name: "BOND", valueHuf: 600_000, quantity: 600_000, unitPriceHuf: 1 },
];
const plan = (amountHuf: number, ln: LeftoverNeeds) =>
  buildLeftoverPlan({
    amountHuf,
    needs: ln.needs,
    glide: GLIDE,
    state: allocationState(GLIDE, POS, "2026-09-30"),
    budgetHuf: 300_000,
    positions: [],
    instruments: new Map(),
  });

describe("leftover – order of the split", () => {
  it("an open goal part of the closing month gets the money first", () => {
    const ln = needsAt(LAST_WD, { settings: { pullForward: false } });
    expect(ln.month.label).toBe("2026. szeptember");
    expect(ln.needs.map((n) => [n.key, Math.round(n.needHuf)])).toEqual([["savings:b", 200_000]]);
    const p = plan(250_000, ln);
    expect(p.lines[0].allocatedHuf).toBe(200_000);
    expect(p.glideHuf).toBe(50_000);
  });

  it("too little leftover: the open part takes all of it, the glide path none", () => {
    const p = plan(80_000, needsAt(LAST_WD, { settings: { pullForward: false } }));
    expect(p.lines[0].allocatedHuf).toBe(80_000);
    expect(p.lines[0].shortHuf).toBe(120_000);
    expect(p.glideHuf).toBe(0);
  });

  it("the closing month's DCA part is a claim too; a done one is not", () => {
    const ln = needsAt(LAST_WD, { dca: [DCA], settings: { pullForward: false } });
    expect(ln.needs.map((n) => n.key)).toEqual(["savings:b", "dca:d"]);
    const bought = tx({ id: "w", date: "2026-09-10", type: "buy", accountId: LY.id, instrumentKey: WBIT.key, quantity: 4, grossAmount: 40_000, netAmount: -40_000 });
    const done = needsAt(LAST_WD, { dca: [DCA], txs: [...TXS, bought], settings: { pullForward: false } });
    expect(done.needs.map((n) => n.key)).toEqual(["savings:b"]);
  });
});

describe("leftover – pulling next month's part forward", () => {
  it("on: a goal due within X months gets all it still lacks; the rest goes on", () => {
    const ln = needsAt(LAST_WD);
    expect(ln.needs.map((n) => [n.key, Math.round(n.needHuf)])).toEqual([
      ["savings:b", 200_000],
      // the whole gap (600 000) less step 1's 200 000
      ["ahead:savings:b", 400_000],
    ]);
    expect(ln.needs[1].name).toBe("Babaváró (a céldátumig hátralévő rész)");
    expect(ln.needs[1].ahead).toBe("2026. október");
    const p = plan(500_000, ln);
    expect(p.lines.map((l) => l.allocatedHuf)).toEqual([200_000, 300_000]);
    expect(p.glideHuf).toBe(0);
    // More than the goal needs: it is filled, the glide path gets the rest.
    const big = plan(5_000_000, ln);
    expect(big.lines.map((l) => l.allocatedHuf)).toEqual([200_000, 400_000]);
    expect(big.glideHuf).toBe(4_400_000);
  });

  it("off: nothing is pulled forward", () => {
    expect(needsAt(LAST_WD, { settings: { pullForward: false } }).needs.some((n) => n.ahead)).toBe(false);
  });

  it("the X-month limit: a goal due later than X months is not pulled forward", () => {
    // 30 Sep + 1 month = 30 Oct < 20 Nov.
    expect(needsAt(LAST_WD, { settings: { pullForwardMonths: 1 } }).needs.some((n) => n.ahead)).toBe(false);
    // 15 Sep + 2 months = 15 Nov < 20 Nov; 30 Sep + 2 months = 30 Nov ≥ 20 Nov.
    expect(needsAt("2026-09-15T17:00:00").needs.some((n) => n.ahead)).toBe(false);
    expect(needsAt(LAST_WD, { settings: { pullForwardMonths: 2 } }).needs.some((n) => n.ahead)).toBe(true);
    const far = { ...BABA, targetDate: "2027-06-30" };
    expect(needsAt(LAST_WD, { goals: [far] }).needs.some((n) => n.ahead)).toBe(false);
    expect(needsAt(LAST_WD, { goals: [far], settings: { pullForwardMonths: 12 } }).needs.some((n) => n.ahead)).toBe(true);
  });

  it("a goal ending this month has no next part", () => {
    const ending = { ...BABA, targetDate: "2026-09-30" };
    expect(needsAt("2026-09-15T17:00:00", { goals: [ending] }).needs.some((n) => n.ahead)).toBe(false);
  });
});

describe("leftover – every goal done", () => {
  it("the whole leftover goes to the glide path, its monthly cap not applied", () => {
    const paid = [
      ...TXS,
      tx({ id: "b2", date: "2026-09-20", type: "buy", instrumentKey: DKJ.key, quantity: 600_000, grossAmount: 600_000, netAmount: -600_000 }),
    ];
    const ln = needsAt(LAST_WD, { txs: paid });
    expect(ln.needs).toEqual([]);
    const p = plan(80_000, ln);
    expect(p.lines).toEqual([]);
    expect(p.glideHuf).toBe(80_000);
    expect(p.freeHuf).toBe(0);
    expect(p.glidePlan?.suggestions.some((s) => s.status === "ok")).toBe(true);
  });
});

describe("leftover – no double split with the Havi terv and the incoming money", () => {
  const havi = (amount: number): Reminder => ({
    id: "r1",
    createdAt: "2026-09-02T10:00:00Z",
    severity: "info",
    title: "Havi terv – 2026. szeptember (300 000 Ft)",
    plan: [{ side: "buy", bucketName: "Babaváró", instrumentKey: DKJ.key, amountHuf: amount, costHuf: 0 }],
  });

  it("a recorded, not yet executed Havi terv covers its goal part", () => {
    const ln = needsAt(LAST_WD, { reminders: [havi(200_000)], settings: { pullForward: false } });
    expect(ln.needs).toEqual([]);
    const half = needsAt(LAST_WD, { reminders: [havi(150_000)], settings: { pullForward: false } });
    expect(Math.round(half.needs[0].needHuf)).toBe(50_000);
  });

  it("once executed (imported), the recorded plan is not taken off a second time", () => {
    const executed = [
      ...TXS,
      tx({ id: "b2", date: "2026-09-05", type: "buy", instrumentKey: DKJ.key, quantity: 150_000, grossAmount: 150_000, netAmount: -150_000 }),
    ];
    const ln = needsAt(LAST_WD, { txs: executed, reminders: [havi(150_000)], settings: { pullForward: false } });
    expect(Math.round(ln.needs[0].needHuf)).toBe(50_000);
  });

  it("the pulled-forward part excludes what next month's recorded Havi terv already plans", () => {
    const oct: Reminder = { ...havi(200_000), id: "r2", title: "Havi terv – 2026. október (300 000 Ft)" };
    const ahead = needsAt(LAST_WD, { reminders: [oct] }).needs.find((n) => n.ahead);
    expect(Math.round(ahead!.needHuf)).toBe(200_000);
  });

  it("a coupon a goal claims stays with the incoming-money list, not the leftover", () => {
    const withCoupons = { ...BABA, includeCoupons: true };
    const coupon = tx({ id: "c", date: "2026-09-10", type: "interest", instrumentKey: DKJ.key, grossAmount: 30_000, netAmount: 30_000 });
    const base = needsAt(LAST_WD, { goals: [withCoupons], settings: { pullForward: false } });
    const ln = needsAt(LAST_WD, { goals: [withCoupons], txs: [...TXS, coupon], settings: { pullForward: false } });
    expect(ln.needs[0].needHuf).toBeLessThanOrEqual(base.needs[0].needHuf);
  });

  it("a recorded leftover is found by its month", () => {
    const m = leftoverMonth(new Date(LAST_WD));
    const r: Reminder = { id: "x", createdAt: "", severity: "info", title: leftoverTitle(m, 50_000) };
    expect(recordedLeftover([r], m)).toBe(r);
    expect(recordedLeftover([r], leftoverMonth(new Date("2026-10-30T12:00:00")))).toBeUndefined();
  });
});

describe("Hungarian working days – the month's last one", () => {
  afterEach(() => {
    delete SWAPPED_DAYS["2027-07-31"];
  });

  it("Easter", () => {
    expect(easterSunday(2024)).toEqual([2, 31]);
    expect(easterSunday(2025)).toEqual([3, 20]);
    expect(easterSunday(2026)).toEqual([3, 5]);
  });

  it("weekend: a month ending on Saturday / Sunday → Friday", () => {
    expect(lastWorkdayOfMonth(2026, 9)).toBe(30); // 31 Oct 2026 = Saturday
    expect(lastWorkdayOfMonth(2026, 4)).toBe(29); // 31 May 2026 = Sunday
    expect(lastWorkdayOfMonth(2026, 8)).toBe(30); // Wednesday
  });

  it("public holiday: Good Friday at the month's end", () => {
    // 2029: Easter 1 April → Good Friday 30 March, 31 March = Saturday.
    expect(lastWorkdayOfMonth(2029, 2)).toBe(29);
    // 2024: Good Friday 29 March, 30–31 = weekend.
    expect(lastWorkdayOfMonth(2024, 2)).toBe(28);
    expect(isWorkday(new Date(2026, 7, 20, 12))).toBe(false); // Aug 20
  });

  it("swapped days: a worked Saturday counts, a rest weekday does not", () => {
    expect(isWorkday(new Date(2026, 0, 10, 12))).toBe(true); // Saturday worked
    expect(isWorkday(new Date(2026, 0, 2, 12))).toBe(false); // Friday off
    expect(lastWorkdayOfMonth(2027, 6)).toBe(30); // 31 Jul 2027 = Saturday
    SWAPPED_DAYS["2027-07-31"] = "work";
    expect(lastWorkdayOfMonth(2027, 6)).toBe(31);
  });

  it("the app's month boundary follows the same calendar", () => {
    expect(effectiveMonthKey("2029-03-29")).toBe("2029-04");
    expect(effectiveMonthKey("2029-03-28")).toBe("2029-03");
  });
});

describe("/maradek", () => {
  const ln = needsAt(LAST_WD, { settings: { pullForward: false } });

  it("a valid amount: the plan in the Havi terv's words", () => {
    const r = leftoverReply("50 000", ln, (huf) => plan(huf, ln));
    expect(r.ok).toBe(true);
    expect(r.lines[0].replace(/\s/g, " ")).toBe("Hónap végi maradék – 2026. szeptember: 50 000 Ft");
    expect(r.lines.join("\n")).toMatch(/Babaváró: DKJ 261102 vétel/);
    expect(leftoverReply("50e", ln, (huf) => plan(huf, ln)).lines[0].replace(/\s/g, " ")).toMatch(/50 000 Ft$/);
  });

  it("amount formats", () => {
    expect(parseLeftoverAmount("50000")).toEqual({ huf: 50_000 });
    expect(parseLeftoverAmount("50.000 Ft")).toEqual({ huf: 50_000 });
    expect(parseLeftoverAmount("75k")).toEqual({ huf: 75_000 });
  });

  it("an invalid amount is an error, not a plan", () => {
    for (const bad of ["", "abc", "-5000", "0", "12,5", "1e9"]) {
      const r = leftoverReply(bad, ln, (huf) => plan(huf, ln));
      expect(r.ok, bad).toBe(false);
      expect(r.lines).toHaveLength(1);
    }
  });
});

describe("hold cash with an assigned instrument", () => {
  // Target before the DKJ's maturity: the DKJ can't be bought for it.
  const early = { ...BABA, targetDate: "2026-10-31" };
  const instMap = new Map([[DKJ.key, DKJ], [WBIT.key, WBIT]]);
  const summary = computePortfolio([ACC, LY], TXS, instMap, PRICES, {}, new Date(LAST_WD));
  const ctx = accountContext({ summary, transactions: TXS, fx: {}, day: "2026-09-30", limits: {}, purchase: {}, fees: {}, reserved: new Map() });

  it("the set-aside goes to the account of the goal's instrument, and says why", () => {
    const ln = needsAt(LAST_WD, { goals: [early], settings: { pullForward: false } });
    expect(ln.needs[0].holdCash).toBe(true);
    expect(ln.needs[0].holdReason).toBe("DKJ 261102: a céldátum (2026-10-31) után jár le (2026-11-02)");
    const p = buildLeftoverPlan({
      amountHuf: 100_000,
      needs: ln.needs,
      glide: undefined,
      state: null,
      budgetHuf: 0,
      positions: [],
      instruments: instMap,
      accounts: ctx,
    });
    expect(p.deposits.map((d) => [d.label, d.accountId, d.totalHuf])).toEqual([
      ["Államkincstár (félretétel)", ACC.id, 100_000],
    ]);
    expect(depositText(p.deposits[0])).not.toMatch(/bankszámla/);
    expect(planLineText(p.lines[0])).toMatch(/→ Államkincstár \(DKJ 261102: a céldátum/);
  });
});
