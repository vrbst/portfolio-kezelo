import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addDaysIso, toLocalDay, txDay } from "./day";
import { allocationState, waterFill } from "./rebalance";
import { defaultGlobals, type GlideConfig } from "./glidePath";
import { splitAmongGoals } from "./incomeClaims";
import { flowAdjustedConfig, type FlowSample } from "./flowPath";
import { unionSnapshots } from "./syncMerge";
import type { PortfolioSnapshot } from "./sync";
import type { Account, Transaction } from "./model";
import type { Goal } from "./goals";

// Property tests of small pure building blocks: fast-check tries hundreds of
// random inputs and shrinks a failure to the simplest one it can find.

const ymd = (d: Date) => toLocalDay(d);
/** A random calendar day 2020-01-01 … 2035-12-31 as a local Date. */
const localDate = fc
  .integer({ min: 0, max: 5843 })
  .map((n) => new Date(2020, 0, 1 + n));

describe("day helpers", () => {
  it("addDaysIso: +n then −n is the same day, and it moves by exactly n days", () => {
    fc.assert(
      fc.property(localDate, fc.integer({ min: -4000, max: 4000 }), (d, n) => {
        const day = ymd(d);
        expect(addDaysIso(addDaysIso(day, n), -n)).toBe(day);
        expect(addDaysIso(day, n)).toBe(ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)));
      }),
    );
  });

  it("txDay: a local time stored as an ISO instant reads back as its local day", () => {
    fc.assert(
      fc.property(localDate, fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), (d, h, m) => {
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
        expect(txDay(at.toISOString())).toBe(ymd(d));
        expect(txDay(ymd(d))).toBe(ymd(d));
      }),
    );
  });
});

describe("waterFill", () => {
  const items = fc.uniqueArray(
    fc.record({
      id: fc.constantFrom("a", "b", "c", "d", "e"),
      valueHuf: fc.integer({ min: 0, max: 10_000_000 }),
      target: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    { selector: (i) => i.id, minLength: 1, maxLength: 5 },
  );

  it("hands out exactly the amount, never a negative share", () => {
    fc.assert(
      fc.property(items, fc.integer({ min: 1, max: 5_000_000 }), (xs, amount) => {
        const total = xs.reduce((s, i) => s + i.valueHuf, 0) + amount;
        const out = waterFill(xs, amount, total);
        const given = [...out.values()];
        for (const v of given) expect(v).toBeGreaterThan(0);
        expect(given.reduce((s, v) => s + v, 0)).toBeCloseTo(amount, 3);
      }),
    );
  });
});

describe("splitAmongGoals", () => {
  const claimants = fc.uniqueArray(
    fc.record({ goalId: fc.constantFrom("g1", "g2", "g3", "g4"), capHuf: fc.integer({ min: -10_000, max: 2_000_000 }) }),
    { selector: (c) => c.goalId, maxLength: 4 },
  );

  it("no goal gets more than its cap, and no more than the amount is split", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), claimants, (amount, cs) => {
        const out = splitAmongGoals(amount, cs);
        const sum = [...out.values()].reduce((s, v) => s + v, 0);
        expect(sum).toBeLessThanOrEqual(amount + 1e-6);
        for (const c of cs) {
          const v = out.get(c.goalId) ?? 0;
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(Math.max(0, c.capHuf) + 1e-6);
        }
        const room = cs.reduce((s, c) => s + Math.max(0, c.capHuf), 0);
        // Enough money: every claimant is filled; otherwise all of it is used.
        expect(sum).toBeCloseTo(Math.min(amount, room), 4);
      }),
    );
  });
});

describe("sync merge (unionSnapshots)", () => {
  const accountIds = ["a1", "a2", "a3"];
  const account = fc.record({
    id: fc.constantFrom(...accountIds),
    name: fc.constantFrom("A", "B"),
    restoredAt: fc.option(fc.constantFrom("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z"), { nil: undefined }),
  }).map((a): Account => ({ ...a, provider: "lightyear", kind: "regular", currency: "HUF" }));
  // A transaction id is a hash that includes its account (like the importers').
  const tx = fc.record({
    n: fc.integer({ min: 1, max: 3 }),
    accountId: fc.constantFrom(...accountIds),
    netAmount: fc.integer({ min: -1000, max: 1000 }),
  }).map(({ n, ...t }): Transaction => ({ ...t, id: `${t.accountId}-t${n}`, date: "2026-01-01T10:00:00.000Z", type: "deposit", currency: "HUF" }));
  const goal = fc.record({ id: fc.constantFrom("g1", "g2", "g3"), amountHuf: fc.integer({ min: 1, max: 100 }) })
    .map((g): Goal => ({ ...g, periodMonths: 1, createdAt: "2026-01-01" }));
  const snapshot = fc.record({
    accounts: fc.uniqueArray(account, { selector: (a) => a.id }),
    transactions: fc.uniqueArray(tx, { selector: (t) => t.id }),
    goals: fc.uniqueArray(goal, { selector: (g) => g.id }),
    deletedGoalIds: fc.subarray(["g1", "g2", "g3"]),
    deletedAccounts: fc.dictionary(fc.constantFrom(...accountIds), fc.constantFrom("2026-03-01T00:00:00Z")),
  }).map((s): PortfolioSnapshot => ({ version: 1, exportedAt: "2026-09-01T00:00:00Z", instruments: [], ...s }));

  const ids = (xs: { id: string }[] | undefined) => (xs ?? []).map((x) => x.id).sort();

  it("merging the result again changes nothing (no endless upload loop)", () => {
    fc.assert(
      fc.property(snapshot, snapshot, (remote, local) => {
        const once = unionSnapshots(remote, local);
        expect(unionSnapshots(once, once)).toEqual(once);
        expect(unionSnapshots(remote, once)).toEqual(once);
      }),
    );
  });

  it("both devices end up with the same data, whichever pushes first", () => {
    fc.assert(
      fc.property(snapshot, snapshot, (a, b) => {
        const ab = unionSnapshots(a, b);
        const ba = unionSnapshots(b, a);
        expect(ids(ab.accounts)).toEqual(ids(ba.accounts));
        expect(ids(ab.transactions)).toEqual(ids(ba.transactions));
        expect(ids(ab.goals)).toEqual(ids(ba.goals));
      }),
    );
  });

  it("nothing is lost unless a tombstone deletes it; a deletion is never undone", () => {
    fc.assert(
      fc.property(snapshot, snapshot, (remote, local) => {
        const out = unionSnapshots(remote, local);
        const deletedGoals = new Set([...(remote.deletedGoalIds ?? []), ...(local.deletedGoalIds ?? [])]);
        for (const g of [...(remote.goals ?? []), ...(local.goals ?? [])])
          expect(out.goals!.some((x) => x.id === g.id)).toBe(!deletedGoals.has(g.id));
        const liveAccounts = new Set(out.accounts.map((a) => a.id));
        const tomb = out.deletedAccounts ?? {};
        for (const t of [...remote.transactions, ...local.transactions]) {
          // Kept exactly when its account is live or was never deleted.
          const shouldKeep = liveAccounts.has(t.accountId) || !tomb[t.accountId];
          expect(out.transactions.some((x) => x.id === t.id)).toBe(shouldKeep);
        }
      }),
    );
  });
});

describe("glide path – inflows mode", () => {
  // Two buckets, R moving from `s` to `f` along a monotone frozen path.
  const scenario = fc.record({
    s: fc.double({ min: 0, max: 1, noNaN: true }),
    f: fc.double({ min: 0, max: 1, noNaN: true }),
    steps: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 12 }),
    reached: fc.boolean(),
    pp: fc.double({ min: 0.005, max: 0.2, noNaN: true }),
    dayOffset: fc.integer({ min: -60, max: 800 }),
    r: fc.integer({ min: 0, max: 10_000_000 }),
    k: fc.integer({ min: 1, max: 10_000_000 }),
  });

  it("the target stays between start and final; the band holds it and reaches final ± band on the far side", () => {
    fc.assert(
      fc.property(scenario, ({ s, f, steps, reached, pp, dayOffset, r, k }) => {
        // Cumulative fractions → a monotone path from s towards f.
        const fr = [...steps].sort((a, b) => a - b);
        const days = fr.map((_, i) => addDaysIso("2026-01-01", 30 * (i + 1)));
        const path = [
          { day: "2026-01-01", weights: { R: s, K: 1 - s } },
          ...fr.map((x, i) => ({ day: days[i], weights: { R: s + (f - s) * x, K: 1 - s - (f - s) * x } })),
        ];
        const bucket = (id: string, w: number) => ({
          id,
          name: id,
          finalWeight: w,
          start: { mode: "manual" as const, weight: w },
          startDate: "2026-01-01",
          endDate: "2027-01-01",
          interpolation: "linear" as const,
          band: { kind: "abs" as const, pp },
        });
        const cfg: GlideConfig = {
          id: "v",
          validFrom: "2026-01-01",
          savedAt: "2026-01-01T00:00:00Z",
          buckets: [bucket("R", f), bucket("K", 1 - f)],
          instruments: { A: { bucketId: "R", sellable: true, acceptsContributions: true }, B: { bucketId: "K", sellable: true, acceptsContributions: true } },
          ...defaultGlobals(),
          pathMode: "inflows",
          inflowPath: path,
          inflowReached: reached,
        };
        const day = addDaysIso("2026-01-01", dayOffset);
        const st = allocationState(cfg, [{ key: "A", name: "A", valueHuf: r }, { key: "B", name: "B", valueHuf: k }], day);
        const R = st.buckets[0];
        const lo = Math.min(s, f) - 1e-9;
        const hi = Math.max(s, f) + 1e-9;
        expect(R.target).toBeGreaterThanOrEqual(lo);
        expect(R.target).toBeLessThanOrEqual(hi);
        expect(R.low).toBeLessThanOrEqual(R.target + 1e-9);
        expect(R.high).toBeGreaterThanOrEqual(R.target - 1e-9);
        if (f > s) expect(R.high).toBeGreaterThanOrEqual(Math.min(1, f + pp) - 1e-9);
        if (f < s) expect(R.low).toBeLessThanOrEqual(Math.max(0, f - pp) + 1e-9);
      }),
    );
  });
});

describe("glide path – flow-adjusted path", () => {
  // R 40% → 60% plan; ETF units at a price plus bonds at face, sampled daily.
  const cfg: GlideConfig = {
    id: "v",
    validFrom: "2026-01-01",
    savedAt: "2026-01-01T00:00:00Z",
    buckets: (["R", "K"] as const).map((id) => ({
      id,
      name: id,
      finalWeight: id === "R" ? 0.6 : 0.4,
      start: { mode: "manual" as const, weight: 0.5 },
      startDate: "2026-01-01",
      endDate: "2027-01-01",
      interpolation: "linear" as const,
      band: { kind: "abs" as const, pp: 0.05 },
    })),
    instruments: {
      A: { bucketId: "R", sellable: true, acceptsContributions: true },
      B: { bucketId: "K", sellable: true, acceptsContributions: true },
    },
    ...defaultGlobals(),
    pathMode: "inflows",
    inflowPath: [
      { day: "2026-01-01", weights: { R: 0.4, K: 0.6 } },
      { day: "2027-01-01", weights: { R: 0.6, K: 0.4 } },
    ],
    inflowReached: true,
  };
  const sample = (i: number, units: number, price: number, bond: number): FlowSample => ({
    day: addDaysIso("2026-01-01", i),
    positions: [
      { key: "A", name: "A", valueHuf: units * price, quantity: units, unitPriceHuf: price },
      { key: "B", name: "B", valueHuf: bond, quantity: bond, unitPriceHuf: 1 },
    ],
  });
  const R = (c: GlideConfig, s: FlowSample) =>
    allocationState(c, s.positions, s.day).buckets.find((b) => b.bucket.id === "R")!;
  const units = fc.integer({ min: 1, max: 2_000 });
  const price = fc.integer({ min: 1_000, max: 20_000 });
  const bond = fc.integer({ min: 100_000, max: 20_000_000 });

  it("prices only: the path stays where it was on the save day", () => {
    fc.assert(
      fc.property(units, bond, fc.array(price, { minLength: 2, maxLength: 8 }), (u, k, ps) => {
        const samples = ps.map((p, i) => sample(i, u, p, k));
        const last = samples[samples.length - 1];
        const start = R(cfg, samples[0]).weight;
        const live = flowAdjustedConfig(
          { ...cfg, inflowPath: [{ day: samples[0].day, weights: { R: start, K: 1 - start } }, ...cfg.inflowPath!.slice(1)] },
          samples,
        );
        expect(R(live, last).target).toBeCloseTo(start, 9);
      }),
    );
  });

  it("money only (flat prices): the path is the actual weight, up to the final", () => {
    fc.assert(
      fc.property(price, fc.array(fc.tuple(units, bond), { minLength: 2, maxLength: 8 }), (p, steps) => {
        const samples = steps.map(([u, k], i) => sample(i, u, p, k));
        const last = samples[samples.length - 1];
        const r = R(flowAdjustedConfig(cfg, samples), last);
        expect(r.target).toBeCloseTo(Math.min(0.6, r.weight), 9);
      }),
    );
  });

  it("a deposit before a fall does not hide it: the gap is the fall's own effect", () => {
    fc.assert(
      fc.property(units, units, bond, fc.double({ min: 0.05, max: 0.6, noNaN: true }), (u, extra, k, fall) => {
        const p = 10_000;
        const after = Math.round(p * (1 - fall));
        const samples = [sample(0, u, p, k), sample(1, u + extra, p, k), sample(2, u + extra, after, k)];
        const before = R(cfg, samples[1]).weight;
        // Not when the deposit already overshoots the final (then the cap rules).
        fc.pre(before < 0.6);
        const r = R(flowAdjustedConfig(cfg, samples), samples[2]);
        expect(r.weight - r.target).toBeCloseTo(r.weight - before, 9);
      }),
    );
  });
});
