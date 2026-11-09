import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  defaultGlobals,
  validateConfig,
  type Bucket,
  type GlideConfig,
  type InstrumentRule,
} from "./glidePath";
import type { Instrument } from "./model";
import type { Cashflow } from "./bonds";
import {
  allocationState,
  applyShock,
  bandRule,
  flowTargets,
  type AllocationState,
  type Position,
} from "./rebalance";
import { projectGlide } from "./glideProjection";
import { computeTargetLive, liveTargetVersions, type TargetInputs } from "./targetCheck";
import { allocateIncome, type IncomeEvent } from "./incomeFlow";

// Invented sample data — generic buckets and round numbers, not a real portfolio.

const TODAY = "2026-11-09";
const END = "2030-06-30";

function bucket(id: string, finalWeight: number, endDate = END): Bucket {
  return {
    id,
    name: id,
    finalWeight,
    start: { mode: "manual", weight: finalWeight },
    startDate: TODAY,
    endDate,
    interpolation: "linear",
    band: { kind: "abs", pp: 0.05 },
  };
}

const rule = (bucketId: string, patch: Partial<InstrumentRule> = {}): InstrumentRule => ({
  bucketId,
  sellable: true,
  acceptsContributions: true,
  ...patch,
});

function config(patch: Partial<GlideConfig> = {}): GlideConfig {
  return {
    id: "v1",
    validFrom: TODAY,
    savedAt: `${TODAY}T00:00:00Z`,
    buckets: [bucket("R", 0.6), bucket("K", 0.4)],
    instruments: {
      ETF: rule("R", { sellable: false }),
      BOND: rule("K", { onMaturity: "reinvest" }),
      BOND2: rule("K"),
    },
    ...defaultGlobals(),
    monthlyAmount: { kind: "remainder" },
    pathMode: "target",
    planReturn: 0.05,
    targetTolPp: 0.02,
    ...patch,
  };
}

const instruments = new Map<string, Instrument>([
  ["ETF", { key: "ETF", name: "ETF", type: "etf" } as Instrument],
  ["BOND", { key: "BOND", name: "BOND", type: "gov_bond" } as Instrument],
  ["BOND2", { key: "BOND2", name: "BOND2", type: "gov_bond" } as Instrument],
]);

const positions = (etf: number, bond: number): Position[] => [
  { key: "ETF", name: "ETF", valueHuf: etf, quantity: etf / 1000, unitPriceHuf: 1000 },
  { key: "BOND", name: "BOND", valueHuf: bond, quantity: bond, unitPriceHuf: 1, bondSellCostPct: 0.01 },
];

const cashflow = (date: string, kind: Cashflow["kind"], amountHuf: number, key = "BOND"): Cashflow => ({
  date,
  kind,
  title: kind,
  amountHuf,
  instrumentKey: key,
});

/** Yearly coupons of 6% and the redemption in 2030. */
const flows: Cashflow[] = [
  ...[2027, 2028, 2029].map((y) => cashflow(`${y}-09-15`, "coupon", 1_080_000)),
  cashflow("2030-03-15", "maturity", 18_000_000),
];

const inputs: TargetInputs = {
  instruments,
  cashflows: flows,
  savings: [],
  dcaGoals: [],
  budgetHuf: 250_000,
};

/** The state with the day's check attached, as the app and the bot see it. */
function liveState(cfg: GlideConfig, ps: Position[], day = TODAY): AllocationState {
  const targetLive = computeTargetLive(cfg, ps, day, inputs);
  return allocationState({ ...cfg, targetLive }, ps, day);
}

const R = (s: AllocationState) => s.buckets.find((b) => b.bucket.id === "R")!;

describe("projectGlide – a redemption marked reinvest", () => {
  it("stays in its bucket instead of being routed to the final weights", () => {
    const base = config({ pathMode: "inflows" });
    const state = allocationState(base, positions(3_000_000, 7_000_000), TODAY);
    const run = (onMaturity?: "reinvest") =>
      projectGlide({
        cfg: { ...base, instruments: { ...base.instruments, BOND: rule("K", { onMaturity }) } },
        state,
        instruments,
        cashflows: [cashflow("2028-01-15", "maturity", 7_000_000)],
        savings: [],
        dcaGoals: [],
        budgetHuf: 0,
        annualReturn: 0,
        today: TODAY,
        until: "2028-06-01",
      });
    const after = (p: ReturnType<typeof run>) => p.points.find((x) => x.day === "2028-02-01")!.weights.R;
    // Routed: the 7 M goes towards 60/40.
    expect(after(run())).toBeCloseTo(0.6, 6);
    // Reinvested: nothing moves.
    const kept = run("reinvest");
    expect(after(kept)).toBeCloseTo(0.3, 6);
    expect(kept.inflows.find((x) => x.kind === "maturity")).toMatchObject({ amountHuf: 0, reinvested: true });
  });
});

describe("computeTargetLive", () => {
  const ps = positions(12_000_000, 18_000_000);

  it("is undefined outside the target mode", () => {
    expect(computeTargetLive(config({ pathMode: "inflows" }), ps, TODAY, inputs)).toBeUndefined();
  });

  it("does not depend on when the version was saved (memoryless)", () => {
    const a = computeTargetLive(config(), ps, TODAY, inputs);
    const b = computeTargetLive(
      config({ id: "v9", validFrom: "2026-01-01", savedAt: "2026-01-01T08:00:00Z" }),
      ps,
      TODAY,
      inputs,
    );
    expect(b).toEqual(a);
  });

  it("target: moving today's shortfall into the bucket lands the projection on the final weight", () => {
    const live = computeTargetLive(config(), ps, TODAY, inputs)!;
    const T = 30_000_000;
    const w = 12_000_000 / T;
    const move = (live.buckets.R.target - w) * T;
    const after = computeTargetLive(config(), positions(12_000_000 + move, 18_000_000 - move), TODAY, inputs)!;
    expect(after.buckets.R.projected).toBeCloseTo(0.6, 3);
    // The two buckets mirror each other.
    expect(live.buckets.R.target + live.buckets.K.target).toBeCloseTo(1, 4);
  });

  it("requiredReturn: projecting with it lands on the final weight", () => {
    const live = computeTargetLive(config(), ps, TODAY, inputs)!;
    const r = live.buckets.R.requiredReturn!;
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.2);
    const again = computeTargetLive(config({ planReturn: r }), ps, TODAY, inputs)!;
    expect(again.buckets.R.projected).toBeCloseTo(0.6, 4);
    // A bond-only bucket has no growing part.
    expect(live.buckets.K.requiredReturn).toBeNull();
  });

  it("the redemption marked reinvest is not counted towards the equity weight", () => {
    const routed = config({ instruments: { ...config().instruments, BOND: rule("K") } });
    const a = computeTargetLive(config(), ps, TODAY, inputs)!;
    const b = computeTargetLive(routed, ps, TODAY, inputs)!;
    // Routed, the 18 M would carry the bucket to its final weight anyway.
    expect(b.buckets.R.projectedZero).toBeCloseTo(0.6, 2);
    expect(a.buckets.R.projectedZero).toBeLessThan(b.buckets.R.projectedZero - 0.005);
  });

  it("alarmShock: a fall just past it trips the band, just short of it does not", () => {
    const cfg = config();
    const s = computeTargetLive(cfg, ps, TODAY, inputs)!.buckets.R.alarmShock!;
    expect(s).toBeGreaterThan(0.02);
    expect(s).toBeLessThan(0.6);
    const shocked = (x: number) => applyShock(cfg, ps, { R: -x });
    expect(R(liveState(cfg, shocked(s + 0.01))).status).toBe("below");
    expect(R(liveState(cfg, shocked(Math.max(0, s - 0.01)))).status).toBe("within");
  });

  it("near the end date the band is simply final ± tolerance", () => {
    const live = computeTargetLive(config(), ps, "2030-06-27", inputs)!;
    expect(live.buckets.R.target).toBeCloseTo(0.6, 3);
    expect(live.buckets.R.low).toBeCloseTo(0.58, 3);
    expect(live.buckets.R.high).toBeCloseTo(0.62, 3);
  });

  it("ahead (actual mode): not over the band while the actual weight is under final + tolerance", () => {
    // Far ahead: the projection runs well past 62%, the actual weight is 59%.
    // (A high plan return: the growth outruns the money routed to the bonds.)
    const ahead = positions(17_700_000, 12_300_000);
    const fast = { planReturn: 0.25 };
    expect(R(liveState(config(fast), ahead)).check!.projected).toBeGreaterThan(0.62);
    expect(R(liveState(config(fast), ahead)).status).toBe("within");
    expect(R(liveState(config({ ...fast, aheadMode: "projected" }), ahead)).status).toBe("above");
  });

  it("liveTargetVersions attaches the check to the newest version only", () => {
    const old = config({ id: "v0", validFrom: "2026-10-01", savedAt: "2026-10-01T00:00:00Z" });
    const cur = config();
    const live = liveTargetVersions([old, cur], () => ps, TODAY, inputs);
    expect(live[0]).toBe(old);
    expect(live[1].targetLive?.day).toBe(TODAY);
  });
});

describe("target mode in the band machinery", () => {
  const ps = positions(12_000_000, 18_000_000);

  it("without a check for the day (history, a draft) the limits are final ± tolerance", () => {
    const s = allocationState(config(), ps, TODAY);
    expect(R(s)).toMatchObject({ target: 0.6, low: 0.58 });
    expect(R(s).high).toBeCloseTo(0.62, 9);
  });

  it("new money goes towards the final weights by default", () => {
    const f = flowTargets(config(), TODAY);
    expect(f.weights.get("R")).toBeCloseTo(0.6, 9);
  });

  it("a deep fall: the band rule sells bonds and buys back to the required weight", () => {
    const cfg = config();
    const crashed = applyShock(cfg, ps, { R: -0.35 });
    const state = liveState(cfg, crashed);
    expect(R(state).status).toBe("below");
    const plan = bandRule(cfg, state);
    const sell = plan.suggestions.find((s) => s.side === "sell" && s.status === "ok");
    const buy = plan.suggestions.find((s) => s.side === "buy" && s.status === "ok");
    expect(sell?.instrumentKey).toMatch(/^BOND/);
    expect(buy?.instrumentKey).toBe("ETF");
    // Back to the required weight (fees aside), not just to the band edge.
    const after = R(state).valueHuf + buy!.amountHuf;
    expect(after / state.totalHuf).toBeGreaterThan(R(state).low + 0.01);
    expect(after / state.totalHuf).toBeCloseTo(R(state).target, 2);
  });

  it("rule: below ⇔ both the projection and the actual weight short of final − tolerance", () => {
    const cfg = config();
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.8, noNaN: true }), (fall) => {
        const shocked = applyShock(cfg, ps, { R: -fall });
        const b = R(liveState(cfg, shocked));
        const short = b.check!.projected < 0.58 - 1e-4 && b.weight < 0.58 - 1e-4;
        const clear = b.check!.projected > 0.58 + 1e-4 || b.weight > 0.58 + 1e-4;
        if (short) expect(b.status).toBe("below");
        if (clear) expect(b.status).not.toBe("below");
      }),
      { numRuns: 25 },
    );
  });
});

describe("incoming redemption marked reinvest", () => {
  it("is split into the bond's own bucket, never the redeemed bond or the equity", () => {
    const cfg = config();
    const ps = positions(12_000_000, 18_000_000);
    const state = liveState(cfg, ps);
    const event: IncomeEvent = {
      id: "t1",
      day: TODAY,
      kind: "redemption",
      instrumentKey: "BOND",
      accountId: "a1",
      provider: "allamkincstar",
      currency: "HUF",
      amount: 5_000_000,
      amountHuf: 5_000_000,
    };
    const [a] = allocateIncome([event], [], cfg, state);
    const buys = (a.plan?.suggestions ?? []).filter((s) => s.side === "buy" && s.status === "ok");
    expect(buys.length).toBeGreaterThan(0);
    expect(buys.every((s) => s.instrumentKey === "BOND2")).toBe(true);
    // A coupon still goes towards the final weights (the equity here).
    const [c] = allocateIncome([{ ...event, id: "t2", kind: "coupon" }], [], cfg, state);
    expect(c.plan?.suggestions.some((s) => s.instrumentKey === "ETF")).toBe(true);
  });
});

describe("validateConfig – target mode", () => {
  const errorsOf = (patch: Partial<GlideConfig>) => validateConfig(config(patch)).errors.map((e) => e.message);

  it("accepts the defaults", () => {
    expect(errorsOf({})).toEqual([]);
  });

  it("rejects an out-of-range plan return or tolerance", () => {
    expect(errorsOf({ planReturn: 0.9 }).join(" ")).toMatch(/tervezési hozam/);
    expect(errorsOf({ targetTolPp: -0.01 }).join(" ")).toMatch(/tűrés/);
  });

  it("needs each bucket's end date", () => {
    const cfg = config();
    const bad = { ...cfg, buckets: [{ ...cfg.buckets[0], endDate: "" }, cfg.buckets[1]] };
    expect(validateConfig(bad).errors.map((e) => e.message).join(" ")).toMatch(/mikorra/);
  });
});
