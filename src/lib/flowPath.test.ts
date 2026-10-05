import { describe, expect, it } from "vitest";
import { defaultGlobals, type Bucket, type GlideConfig } from "./glidePath";
import { allocationState, type Position } from "./rebalance";
import { flowAdjustedConfig, liveGlideVersions, type FlowSample } from "./flowPath";

// Invented sample data — two generic buckets and round numbers.
// R (shares) heads from 40% to 60%, K (bonds, at face) from 60% to 40%.

const SAVED = "2026-10-01";

function bucket(id: string, finalWeight: number): Bucket {
  return {
    id,
    name: id,
    finalWeight,
    start: { mode: "manual", weight: finalWeight },
    startDate: SAVED,
    endDate: "2027-10-01",
    interpolation: "linear",
    band: { kind: "abs", pp: 0.05 },
  };
}

function config(patch: Partial<GlideConfig> = {}): GlideConfig {
  return {
    id: "v1",
    validFrom: SAVED,
    savedAt: `${SAVED}T12:00:00Z`,
    buckets: [bucket("R", 0.6), bucket("K", 0.4)],
    instruments: {
      ETF: { bucketId: "R", sellable: true, acceptsContributions: true },
      BOND: { bucketId: "K", sellable: true, acceptsContributions: true },
    },
    ...defaultGlobals(),
    bondsAtFace: true,
    pathMode: "inflows",
    // The plan: 40% → 60% in a year, from the planned monthly money.
    inflowPath: [
      { day: SAVED, weights: { R: 0.4, K: 0.6 } },
      { day: "2027-04-01", weights: { R: 0.5, K: 0.5 } },
      { day: "2027-10-01", weights: { R: 0.6, K: 0.4 } },
    ],
    inflowReached: true,
    ...patch,
  };
}

/** `units` ETF units at `price`, plus `bond` HUF of bonds at face. */
const sample = (day: string, units: number, price: number, bond = 6_000_000): FlowSample => ({
  day,
  positions: [
    { key: "ETF", name: "ETF", valueHuf: units * price, quantity: units, unitPriceHuf: price },
    { key: "BOND", name: "BOND", valueHuf: bond, quantity: bond, unitPriceHuf: 1 },
  ],
});

const positionsOf = (s: FlowSample): Position[] => s.positions;

const stateOn = (cfg: GlideConfig, s: FlowSample) =>
  allocationState(cfg, positionsOf(s), s.day).buckets.find((b) => b.bucket.id === "R")!;

describe("flowAdjustedConfig", () => {
  it("an extra deposit moves the path with it, so the next fall is flagged as without it", () => {
    // 4M shares + 6M bonds; an extra 2.5M buys shares (→ 52%), then shares fall 25%.
    const samples = [
      sample(SAVED, 400, 10_000),
      sample("2026-10-05", 650, 10_000),
      sample("2026-10-20", 650, 7_500),
    ];
    const live = flowAdjustedConfig(config(), samples);
    const r = stateOn(live, samples[2]);
    expect(r.target).toBeCloseTo(6.5 / 12.5, 6);
    expect(r.weight).toBeCloseTo(4.875 / 10.875, 6);
    expect(r.status).toBe("below");
    // The frozen plan alone still sits near 40%: the same fall stayed unflagged.
    expect(stateOn(config(), samples[2]).status).toBe("within");
  });

  it("without the deposit the same fall is flagged against the same path", () => {
    const samples = [sample(SAVED, 400, 10_000), sample("2026-10-20", 400, 7_000)];
    const r = stateOn(flowAdjustedConfig(config(), samples), samples[1]);
    expect(r.target).toBeCloseTo(0.4, 6);
    expect(r.status).toBe("below");
  });

  it("buying a bucket that fell behind closes the gap instead of moving the path", () => {
    // Shares fall 25% (40% → 33,3%), then 100 more units are bought.
    const samples = [
      sample(SAVED, 400, 10_000),
      sample("2026-10-10", 500, 7_500),
      sample("2026-10-20", 500, 7_500),
    ];
    const r = stateOn(flowAdjustedConfig(config(), samples), samples[2]);
    expect(r.target).toBeCloseTo(0.4, 6);
    expect(r.weight).toBeCloseTo(3.75 / 9.75, 6);
    expect(r.status).toBe("within");
  });

  it("money beyond the gap moves the path, never past the final weight", () => {
    const samples = [sample(SAVED, 400, 10_000), sample("2026-10-05", 1_200, 10_000)];
    const live = flowAdjustedConfig(config(), samples);
    // 12M / 18M = 66,7% actual — the path stops at the final 60%.
    expect(stateOn(live, samples[1]).target).toBeCloseTo(0.6, 6);
  });

  it("a missed payment does not put the bucket behind (the path waits for the money)", () => {
    const samples = [sample(SAVED, 400, 10_000), sample("2027-01-15", 400, 10_000)];
    const r = stateOn(flowAdjustedConfig(config(), samples), samples[1]);
    expect(r.target).toBeCloseTo(0.4, 6);
    expect(r.status).toBe("within");
  });

  it("the path holds until the day of a flow, and ahead it rejoins the plan by its last point", () => {
    const samples = [
      sample(SAVED, 400, 10_000),
      sample("2026-10-05", 650, 10_000),
      sample("2026-10-20", 650, 10_000),
    ];
    const pts = flowAdjustedConfig(config(), samples).inflowPath!;
    const at = (day: string) => pts.find((p) => p.day === day)?.weights.R;
    expect(at(SAVED)).toBe(0.4);
    expect(at("2026-10-04")).toBe(0.4);
    expect(at("2026-10-05")).toBeCloseTo(0.52, 6);
    expect(at("2027-10-01")).toBeCloseTo(0.6, 6);
    // Halfway: the plan's 50% plus part of today's lead, still below final.
    expect(at("2027-04-01")!).toBeGreaterThan(0.5);
    expect(at("2027-04-01")!).toBeLessThanOrEqual(0.6);
  });

  it("leaves calendar-mode configs and unsaved paths alone", () => {
    const samples = [sample(SAVED, 400, 10_000), sample("2026-10-05", 650, 10_000)];
    const cal = config({ pathMode: undefined });
    expect(flowAdjustedConfig(cal, samples)).toBe(cal);
    const draft = config({ inflowPath: undefined });
    expect(flowAdjustedConfig(draft, samples)).toBe(draft);
  });
});

describe("liveGlideVersions", () => {
  it("touches only the newest version, and not on its save day", () => {
    const old = config({ id: "old", validFrom: "2026-01-01", savedAt: "2026-01-01T00:00:00Z" });
    const cur = config();
    const versions = [old, cur];
    const data = {
      accounts: [],
      transactions: [],
      instruments: new Map(),
      fx: {},
      history: null,
      summary: { accounts: [], totalValueHuf: 0 } as never,
      brokerFees: {},
    };
    expect(liveGlideVersions(versions, { ...data, today: SAVED })).toBe(versions);
    const next = liveGlideVersions(versions, { ...data, today: "2026-10-20" });
    expect(next[0]).toBe(old);
  });
});
