import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { computePlanNeeds, buildMonthlyPlan, defaultPlanAmount, type MonthlyPlan } from "../../src/lib/monthlyPlan";
import { buildLeftoverPlan, leftoverNeeds } from "../../src/lib/leftover";
import { monthlyBudgetHuf } from "../../src/lib/forecast";
import { positionsFromSummary } from "../../src/lib/rebalance";
import { loadSavingsGoals } from "../../src/lib/savings";
import { loadLeftoverSettings, loadPlanOrder } from "../../src/lib/planPrefs";
import { allocateIncome, incomeEvents } from "../../src/lib/incomeFlow";
import { toLocalDay } from "../../src/lib/day";
import { local, FIX } from "../../src/test/fixture";
import type { Context } from "./data";
import { contextAt } from "./testContext";
import { tickMessages } from "./tg-app";
import type { State } from "./state";

// Rules that must hold on ANY day and for ANY amount, checked on many random
// cases of the invented portfolio (src/test/fixture.ts). Each one guards a
// class of bug fixed before: money created or lost in a split, a goal given
// more than it lacks, a plan item and "Hová utald?" disagreeing, crumb-sized
// buys, the same alert twice, NaN in a total. fast-check shrinks a failure to
// the simplest case and prints its seed — rerun with that seed to debug.

afterEach(() => {
  vi.useRealTimers();
});

const RUNS = 25;
const EPS = 0.5; // HUF

/** A random local moment in 2026-01-05 … 2027-12-20 (some near midnight). */
const moment = fc
  .record({
    dayOffset: fc.integer({ min: 0, max: 714 }),
    hour: fc.constantFrom(0, 1, 9, 12, 15, 16, 23),
    minute: fc.constantFrom(0, 30, 59),
  })
  .map(({ dayOffset, hour, minute }) => {
    const d = new Date(2026, 0, 5 + dayOffset);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), hour, minute] as [number, number, number, number, number];
  });

function planFor(ctx: Context, amount: (budget: number, needsDone: number) => number, leftover = false): MonthlyPlan {
  const common = {
    savingsGoals: loadSavingsGoals(),
    dcaGoals: ctx.snapshot.goals ?? [],
    accounts: ctx.snapshot.accounts,
    transactions: ctx.transactions,
    instruments: ctx.instruments,
    prices: ctx.prices,
    fx: ctx.fx,
    order: loadPlanOrder(),
    now: ctx.at,
  };
  const needs = leftover
    ? leftoverNeeds({ ...common, settings: loadLeftoverSettings(), reminders: [] }).needs
    : computePlanNeeds(common);
  const budgetHuf = monthlyBudgetHuf(ctx.transactions, ctx.fx, ctx.at);
  const input = {
    amountHuf: amount(budgetHuf, defaultPlanAmount(budgetHuf, needs)),
    needs,
    glide: ctx.glideConfig,
    state: ctx.glide,
    budgetHuf,
    positions: positionsFromSummary(ctx.summary, ctx.fx, false, toLocalDay(ctx.at)),
    instruments: ctx.instMap,
    accounts: ctx.accountCtx,
  };
  return leftover ? buildLeftoverPlan(input) : buildMonthlyPlan(input);
}

/** The money rules every plan (Havi terv, month-end leftover) must obey. */
function checkPlan(plan: MonthlyPlan, minTradeHuf: number) {
  const allocated = plan.lines.reduce((s, l) => s + l.allocatedHuf, 0);
  // 1) No forint is created or lost: goals + glide path + unplanned = amount.
  expect(allocated + plan.glideHuf + plan.freeHuf).toBeCloseTo(plan.amountHuf, 6);
  expect(plan.freeHuf).toBeGreaterThanOrEqual(-EPS);

  let shortSeen = false;
  for (const l of plan.lines) {
    // 2) An item gets at most what it needs, never a negative amount.
    expect(l.allocatedHuf).toBeGreaterThanOrEqual(0);
    expect(l.allocatedHuf).toBeLessThanOrEqual(Math.max(0, l.need.needHuf) + EPS);
    expect(l.shortHuf).toBeCloseTo(Math.max(0, l.need.needHuf - l.allocatedHuf), 6);
    // 3) Priority: once an item was left short, nothing later gets money.
    if (!l.blocked) {
      if (shortSeen) expect(l.allocatedHuf).toBeLessThan(EPS);
      if (l.shortHuf >= 1) shortSeen = true;
    }
    // 4) The buy (+ its costs) is exactly the item's money (fb454c7).
    if (l.trade) {
      const total = l.trade.amountHuf + l.trade.costHuf + (l.trade.fxCostHuf ?? 0);
      expect(total).toBeCloseTo(l.allocatedHuf, 2);
      expect(l.trade.amountHuf).toBeGreaterThanOrEqual(0);
    }
  }

  const glideBuys = (plan.glidePlan?.suggestions ?? []).filter(
    (s) => s.status === "ok" && s.side === "buy" && s.instrumentKey,
  );
  for (const s of glideBuys) {
    // 5) No crumb-sized glide-path buy (0bf3490).
    expect(s.amountHuf).toBeGreaterThanOrEqual(minTradeHuf - EPS);
  }
  const glideSpent = glideBuys.reduce((t, s) => t + s.amountHuf + s.costHuf + (s.fxCostHuf ?? 0), 0);
  expect(glideSpent).toBeLessThanOrEqual(plan.glideHuf + EPS);

  // 6) "Hová utald?" is the plan's lines summed by account — not more, not less.
  const deposits = plan.deposits.reduce((t, d) => t + d.totalHuf, 0);
  const lineMoney = plan.lines.reduce(
    (t, l) =>
      t +
      (l.trade ? l.trade.amountHuf + l.trade.costHuf + (l.trade.fxCostHuf ?? 0) : 0) +
      (l.need.holdCash && l.allocatedHuf >= 1 ? l.allocatedHuf : 0),
    0,
  );
  expect(deposits).toBeCloseTo(lineMoney + glideSpent, 2);
  expect(deposits).toBeLessThanOrEqual(plan.amountHuf + EPS);
  for (const d of plan.deposits) {
    expect(d.totalHuf).toBeCloseTo(d.amountHuf + d.costHuf + d.fxCostHuf, 6);
    expect(d.items.length).toBeGreaterThan(0);
  }
}

describe("invariants on any day", () => {
  it("the whole context: no NaN, unique alerts, goal numbers in range", () => {
    fc.assert(
      fc.property(moment, (when) => {
        const ctx = contextAt(when);
        try {
          const s = ctx.summary;
          for (const n of [s.totalValueHuf, s.holdingsValueHuf, s.cashValueHuf, s.netDepositedHuf, s.costBasisHuf])
            expect(Number.isFinite(n)).toBe(true);
          expect(s.totalValueHuf).toBeCloseTo(s.holdingsValueHuf + s.cashValueHuf, 4);

          // The same alert (or two with one title) must not show twice (a9050d6).
          const ids = ctx.alerts.map((a) => a.id);
          expect(new Set(ids).size).toBe(ids.length);
          const titles = ctx.alerts.map((a) => a.title);
          expect(new Set(titles).size).toBe(titles.length);

          for (const p of ctx.savings) {
            for (const v of [p.gapHuf, p.monthlyNeededHuf, p.projectedHuf, p.couponRoomHuf])
              expect(Number.isFinite(v)).toBe(true);
            expect(p.gapHuf).toBeGreaterThanOrEqual(-EPS);
            expect(p.monthlyNeededHuf).toBeGreaterThanOrEqual(-EPS);
            // A goal can't take in more incoming money than it lacks (fe5c2a2).
            expect(p.couponRoomHuf).toBeLessThanOrEqual(p.gapHuf + EPS);
          }

          if (ctx.glide && ctx.glide.totalHuf > 0) {
            const w = ctx.glide.buckets.reduce((t, b) => t + b.weight, 0);
            const tg = ctx.glide.buckets.reduce((t, b) => t + b.target, 0);
            expect(w).toBeCloseTo(1, 6);
            expect(tg).toBeCloseTo(1, 6);
            for (const b of ctx.glide.buckets) expect(b.low).toBeLessThanOrEqual(b.high);
          }
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("the tick sends nothing twice: a second run at the same moment is silent", () => {
    const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };
    fc.assert(
      fc.property(moment, fc.boolean(), (when, seasoned) => {
        try {
          const st: State = seasoned
            ? { sentAlerts: {}, warned: {}, lastWeekly: "2025-12-26", lastMonthly: "2025-12", lastYearly: "2025" }
            : { sentAlerts: {}, warned: {} };
          tickMessages(contextAt(when), st, env);
          expect(tickMessages(contextAt(when), st, env)).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("Havi terv: money rules hold for any amount", () => {
    fc.assert(
      fc.property(moment, fc.integer({ min: 0, max: 3_000_000 }), fc.boolean(), (when, amount, useDefault) => {
        const ctx = contextAt(when);
        try {
          const plan = planFor(ctx, (_b, def) => (useDefault ? def : amount));
          checkPlan(plan, ctx.glideConfig?.minTradeHuf ?? 0);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("Hónap végi maradék: money rules hold for any leftover", () => {
    fc.assert(
      fc.property(moment, fc.integer({ min: 1, max: 3_000_000 }), (when, amount) => {
        const ctx = contextAt(when);
        try {
          checkPlan(planFor(ctx, () => amount, true), ctx.glideConfig?.minTradeHuf ?? 0);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("Bejövő pénz: a coupon is split without creating money or overfilling a goal", () => {
    fc.assert(
      fc.property(
        moment,
        fc.integer({ min: 1_000, max: 2_000_000 }),
        fc.integer({ min: 0, max: 60 }),
        (when, amount, daysBack) => {
          // A FixMÁP coupon credited `daysBack` days before "now" (local midnight, like the importer).
          const [y, m, d] = when;
          const credited = new Date(y, m - 1, d - daysBack);
          const ctx = contextAt(when, (s) => {
            s.transactions.push({
              id: "prop-coupon",
              accountId: "mak",
              date: local(credited.getFullYear(), credited.getMonth() + 1, credited.getDate(), 0),
              type: "interest",
              instrumentKey: FIX,
              currency: "HUF",
              grossAmount: amount,
              netAmount: amount,
            });
          });
          try {
            const events = incomeEvents(ctx.transactions, ctx.instMap, ctx.snapshot.accounts, ctx.fx, "2025-01-01");
            const ev = events.find((e) => e.id === "prop-coupon");
            expect(ev?.day).toBe(toLocalDay(credited));
            const allocs = allocateIncome(events, ctx.savings, ctx.glideConfig, ctx.glide, ctx.accountCtx);
            const room = new Map(ctx.savings.map((p) => [p.goal.id, p.couponRoomHuf]));
            const given = new Map<string, number>();
            for (const a of allocs) {
              const toGoals = a.goals.reduce((t, g) => t + g.huf, 0);
              // Goals + glide path = the event, nothing more, nothing less.
              expect(toGoals + a.glideHuf).toBeCloseTo(
                a.payoutOf || a.pickedBy ? 0 : a.event.amountHuf,
                4,
              );
              for (const g of a.goals) {
                expect(g.huf).toBeGreaterThanOrEqual(0);
                given.set(g.goalId, (given.get(g.goalId) ?? 0) + g.huf);
              }
              if (a.plan) {
                const spent = a.plan.suggestions
                  .filter((s) => s.status === "ok" && s.side === "buy")
                  .reduce((t, s) => t + s.amountHuf + s.costHuf + (s.fxCostHuf ?? 0), 0);
                expect(spent).toBeLessThanOrEqual(a.glideHuf + EPS);
              }
            }
            // Over all events, no goal gets more than its room (its real gap).
            for (const [id, huf] of given) expect(huf).toBeLessThanOrEqual((room.get(id) ?? 0) + EPS);
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
