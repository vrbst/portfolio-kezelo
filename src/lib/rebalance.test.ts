import { describe, expect, it } from "vitest";
import {
  defaultGlobals,
  normalizeConfig,
  type Bucket,
  type GlideConfig,
  type InstrumentRule,
} from "./glidePath";
import { splitForQuietHours, type Alert } from "./alerts";
import {
  allocationState,
  applyShock,
  checkPeriod,
  glideAlerts,
  bandDeviation,
  bandLimits,
  bandWidth,
  isDeepGlideAlert,
  nextGlideSignal,
  updateGlideSignals,
  type GlideSignals,
  bandRule,
  checkDays,
  currentWeights,
  flowTargetDay,
  flowTargets,
  planCashflow,
  pathTarget,
  pathTargets,
  resolveSnapshotStarts,
  routeCashflow,
  waterFill,
  weightHistory,
  type Position,
} from "./rebalance";

// Invented sample data — generic buckets and round numbers, not a real portfolio.

function bucket(id: string, finalWeight: number, patch: Partial<Bucket> = {}): Bucket {
  return {
    id,
    name: id,
    finalWeight,
    start: { mode: "manual", weight: finalWeight },
    startDate: "2026-01-01",
    endDate: "2028-01-01",
    interpolation: "linear",
    band: { kind: "abs", pp: 0.05 },
    ...patch,
  };
}

const rule = (bucketId: string, patch: Partial<InstrumentRule> = {}): InstrumentRule => ({
  bucketId,
  sellable: true,
  acceptsContributions: true,
  ...patch,
});

function config(
  buckets: Bucket[],
  instruments: Record<string, InstrumentRule>,
  patch: Partial<GlideConfig> = {},
): GlideConfig {
  return {
    id: "v1",
    validFrom: "2026-01-01",
    savedAt: "2026-01-01T00:00:00Z",
    buckets,
    instruments,
    ...defaultGlobals(),
    minTradeHuf: 1_000,
    ...patch,
  };
}

const etf = (key: string, valueHuf: number, unit = 10_000): Position => ({
  key,
  name: key,
  valueHuf,
  quantity: valueHuf / unit,
  unitPriceHuf: unit,
});
const bond = (key: string, valueHuf: number): Position => ({
  key,
  name: key,
  valueHuf,
  quantity: valueHuf,
  unitPriceHuf: 1,
});

const DAY = "2026-06-15";

describe("pathTarget – linear", () => {
  const b = bucket("R", 0.6, { start: { mode: "manual", weight: 0.8 } });
  it("holds the start weight up to and on the start date", () => {
    expect(pathTarget(b, "2025-06-01")).toBe(0.8);
    expect(pathTarget(b, "2026-01-01")).toBe(0.8);
  });
  it("is halfway at the midpoint", () => {
    expect(pathTarget(b, "2027-01-01")).toBeCloseTo(0.7, 12);
  });
  it("reaches the final weight on and after the end date", () => {
    expect(pathTarget(b, "2028-01-01")).toBe(0.6);
    expect(pathTarget(b, "2031-01-01")).toBe(0.6);
  });
  it("counts the leap day", () => {
    const leap = bucket("R", 0.4, {
      start: { mode: "manual", weight: 0.8 },
      startDate: "2028-01-01",
      endDate: "2029-01-01",
    });
    expect(pathTarget(leap, "2028-03-01")).toBeCloseTo(0.8 - 0.4 * (60 / 366), 12);
  });
  it("uses the frozen snapshot weight as the start", () => {
    const snap = bucket("R", 0.6, { start: { mode: "snapshot", date: "2026-01-01", resolvedWeight: 0.9 } });
    expect(pathTarget(snap, "2026-01-01")).toBe(0.9);
  });
});

describe("pathTarget – stepped", () => {
  const q = bucket("R", 0.4, {
    start: { mode: "manual", weight: 0.8 },
    endDate: "2027-01-01",
    interpolation: "step-quarter",
  });
  it("holds within a quarter and jumps on its first day", () => {
    expect(pathTarget(q, "2026-03-31")).toBe(0.8);
    expect(pathTarget(q, "2026-04-01")).toBeCloseTo(0.8 - 0.4 * (90 / 365), 12);
    expect(pathTarget(q, "2026-05-15")).toBeCloseTo(0.8 - 0.4 * (90 / 365), 12);
    expect(pathTarget(q, "2026-12-31")).toBeCloseTo(0.8 - 0.4 * (273 / 365), 12);
  });
  it("lands exactly on the final weight on the end date", () => {
    expect(pathTarget(q, "2027-01-01")).toBe(0.4);
  });

  const y = bucket("R", 0.4, {
    start: { mode: "manual", weight: 0.8 },
    startDate: "2026-07-01",
    endDate: "2028-07-01",
    interpolation: "step-year",
  });
  it("yearly steps: the first partial year keeps the start weight", () => {
    expect(pathTarget(y, "2026-12-31")).toBe(0.8);
    expect(pathTarget(y, "2027-01-01")).toBeCloseTo(0.8 - 0.4 * (184 / 731), 12);
    expect(pathTarget(y, "2028-06-30")).toBeCloseTo(0.8 - 0.4 * (549 / 731), 12);
    expect(pathTarget(y, "2028-07-01")).toBe(0.4);
  });
});

describe("pathTargets", () => {
  it("normalises buckets with different end dates to 100%", () => {
    const cfg = config(
      [
        bucket("R", 0.5, { start: { mode: "manual", weight: 0.8 }, endDate: "2027-01-01" }),
        bucket("K", 0.5, { start: { mode: "manual", weight: 0.2 }, endDate: "2029-01-01" }),
      ],
      {},
    );
    const t = pathTargets(cfg, "2026-07-01");
    expect(t.get("R")! + t.get("K")!).toBeCloseTo(1, 12);
  });
});

describe("bandLimits", () => {
  it("absolute band: target ± pp", () => {
    const l = bandLimits(bucket("R", 0.6), DAY);
    expect(l.low).toBeCloseTo(0.55);
    expect(l.high).toBeCloseTo(0.65);
  });
  it("relative band: target × (1 ± pct)", () => {
    const l = bandLimits(bucket("A", 0.1, { band: { kind: "rel", pct: 0.2 } }), DAY);
    expect(l.low).toBeCloseTo(0.08);
    expect(l.high).toBeCloseTo(0.12);
  });
  it("is clipped to 0..100%", () => {
    expect(bandLimits(bucket("A", 0.05, { band: { kind: "abs", pp: 0.1 } }), DAY).low).toBe(0);
    expect(bandLimits(bucket("A", 0.95, { band: { kind: "abs", pp: 0.1 } }), DAY).high).toBe(1);
  });
});

describe("checkDays", () => {
  it("monthly: first day of each month in range", () => {
    expect(checkDays("monthly", "2026-01-15", "2026-04-01")).toEqual([
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
  });
  it("quarterly: first day of each quarter, across the year end", () => {
    expect(checkDays("quarterly", "2026-08-10", "2027-04-01")).toEqual([
      "2026-10-01",
      "2027-01-01",
      "2027-04-01",
    ]);
  });
});

describe("allocationState", () => {
  const cfg = config([bucket("R", 0.6), bucket("K", 0.4)], {
    "ETF-A": rule("R"),
    KOTV: rule("K"),
    "cash:HUF": rule("K"),
  });

  it("weights and statuses from positions", () => {
    const s = allocationState(cfg, [etf("ETF-A", 700_000), bond("KOTV", 300_000)], DAY);
    expect(s.totalHuf).toBe(1_000_000);
    expect(s.buckets.map((b) => [b.bucket.id, b.weight, b.status])).toEqual([
      ["R", 0.7, "above"],
      ["K", 0.3, "below"],
    ]);
  });

  it("empty portfolio: weight 0, status empty, no NaN", () => {
    const s = allocationState(cfg, [], DAY);
    expect(s.totalHuf).toBe(0);
    for (const b of s.buckets) {
      expect(b.weight).toBe(0);
      expect(b.status).toBe("empty");
    }
  });

  it("empty cash assigned to a bucket counts as zero", () => {
    const w = currentWeights(cfg, [etf("ETF-A", 600_000), bond("KOTV", 400_000)], DAY);
    expect(w.get("R")).toBeCloseTo(0.6);
    expect(w.get("K")).toBeCloseTo(0.4);
  });

  it("unassigned positions are left out of the weights", () => {
    const s = allocationState(
      cfg,
      [etf("ETF-A", 600_000), bond("KOTV", 400_000), etf("MÁSIK", 500_000), { key: "cash:EUR", name: "EUR", valueHuf: 50_000 }],
      DAY,
    );
    expect(s.totalHuf).toBe(1_000_000);
    expect(s.unassigned.map((p) => p.key)).toEqual(["MÁSIK", "cash:EUR"]);
  });
});

describe("waterFill", () => {
  const items = [
    { id: "R", valueHuf: 600_000, target: 0.5 },
    { id: "K", valueHuf: 200_000, target: 0.3 },
    { id: "A", valueHuf: 200_000, target: 0.2 },
  ];
  it("fills the most underweight first", () => {
    const x = waterFill(items, 100_000, 1_100_000);
    expect(x.get("K")).toBeCloseTo(100_000);
    expect(x.has("A")).toBe(false);
    expect(x.has("R")).toBe(false);
  });
  it("levels two underweight buckets to the same gap", () => {
    const x = waterFill(items, 150_000, 1_150_000);
    expect(x.get("K")).toBeCloseTo(132_500);
    expect(x.get("A")).toBeCloseTo(17_500);
  });
  it("brings every eligible bucket exactly to target when all can receive", () => {
    const x = waterFill(items, 400_000, 1_400_000);
    expect(x.get("R")).toBeCloseTo(100_000);
    expect(x.get("K")).toBeCloseTo(220_000);
    expect(x.get("A")).toBeCloseTo(80_000);
  });
  it("beyond the targets (a bucket can't receive), levels the overshoot", () => {
    // Only R and A eligible: both end up 7.86 pp over target, equally.
    const x = waterFill([items[0], items[2]], 400_000, 1_400_000);
    expect(x.get("R")).toBeCloseTo(210_000);
    expect(x.get("A")).toBeCloseTo(190_000);
  });
});

describe("routeCashflow", () => {
  const buckets = [bucket("R", 0.5), bucket("K", 0.3), bucket("A", 0.2)];
  const positions = [etf("ETF-R", 600_000), bond("KOTV", 200_000), etf("ETF-A", 200_000, 5_000)];
  const rules = { "ETF-R": rule("R"), KOTV: rule("K"), "ETF-A": rule("A") };

  it("sends new money to the underweight buckets, in whole units", () => {
    const cfg = config(buckets, rules);
    const plan = routeCashflow(cfg, allocationState(cfg, positions, DAY), 150_000);
    const by = Object.fromEntries(plan.suggestions.map((s) => [s.instrumentKey, s]));
    expect(by["KOTV"]).toMatchObject({ side: "buy", amountHuf: 132_500, quantity: 132_500, status: "ok" });
    // 17 500 Ft at 5 000 Ft/unit → 3 units = 15 000 Ft.
    expect(by["ETF-A"]).toMatchObject({ side: "buy", quantity: 3, amountHuf: 15_000 });
    expect(by["ETF-R"]).toBeUndefined();
  });

  it("re-routes a bucket slice below the minimum trade", () => {
    const cfg = config(buckets, rules, { minTradeHuf: 20_000 });
    const plan = routeCashflow(cfg, allocationState(cfg, positions, DAY), 150_000);
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.suggestions[0]).toMatchObject({ instrumentKey: "KOTV", amountHuf: 150_000 });
  });

  it("skips instruments that don't accept contributions", () => {
    const cfg = config(buckets, { ...rules, KOTV: rule("K", { acceptsContributions: false }) });
    const plan = routeCashflow(cfg, allocationState(cfg, positions, DAY), 150_000);
    expect(plan.suggestions.some((s) => s.bucketId === "K")).toBe(false);
    expect(plan.notes.some((n) => n.includes("sem fogad befizetést"))).toBe(true);
    // A (below target) is topped up before R (already above its path) gets anything.
    const by = Object.fromEntries(plan.suggestions.map((s) => [s.bucketId, s.amountHuf]));
    expect(by.A).toBeGreaterThan(by.R ?? 0);
    expect(plan.suggestions.reduce((a, s) => a + s.amountHuf, 0)).toBeLessThanOrEqual(150_000);
  });

  it("returns nothing for zero money", () => {
    const cfg = config(buckets, rules);
    expect(routeCashflow(cfg, allocationState(cfg, positions, DAY), 0).suggestions).toEqual([]);
  });

  it("works on an empty portfolio (split by path target)", () => {
    const cfg = config([bucket("R", 0.6), bucket("K", 0.4)], { "ETF-R": rule("R"), KOTV: rule("K") });
    const plan = routeCashflow(cfg, allocationState(cfg, [], DAY), 100_000);
    const amounts = Object.fromEntries(plan.suggestions.map((s) => [s.bucketId, s.amountHuf]));
    expect(amounts).toEqual({ R: 60_000, K: 40_000 });
    expect(plan.weightsAfter.R).toBeCloseTo(0.6);
  });
});

describe("bandRule", () => {
  const buckets = [bucket("R", 0.6), bucket("K", 0.4)];
  const positions = [etf("ETF-R", 700_000), bond("KOTV", 300_000)];
  const rules = { "ETF-R": rule("R"), KOTV: rule("K") };
  const run = (patch: Partial<GlideConfig> = {}, r = rules, cash = 0) => {
    const cfg = config(buckets, r, patch);
    return bandRule(cfg, allocationState(cfg, positions, DAY), cash);
  };

  it("nothing to do inside the band", () => {
    const cfg = config(buckets, rules);
    const plan = bandRule(cfg, allocationState(cfg, [etf("ETF-R", 620_000), bond("KOTV", 380_000)], DAY));
    expect(plan.suggestions).toEqual([]);
  });

  it("restores to the path target: sell the overweight, buy the underweight", () => {
    const plan = run();
    expect(plan.suggestions.map((s) => [s.instrumentKey, s.side, s.amountHuf, s.quantity, s.status])).toEqual([
      ["ETF-R", "sell", 100_000, 10, "ok"],
      ["KOTV", "buy", 100_000, 100_000, "ok"],
    ]);
    expect(plan.weightsAfter.R).toBeCloseTo(0.6);
    expect(plan.weightsAfter.K).toBeCloseTo(0.4);
    expect(plan.cashUsedHuf).toBeCloseTo(0);
  });

  it("restores only to the band edge when configured", () => {
    const plan = run({ restoreTo: "band" });
    expect(plan.suggestions.map((s) => [s.side, s.amountHuf])).toEqual([
      ["sell", 50_000],
      ["buy", 50_000],
    ]);
    expect(plan.weightsAfter.R).toBeCloseTo(0.65);
  });

  it("uses outside cash before selling", () => {
    // K (30%, tight ±1 pp band) is below; R and A are inside their wide bands.
    const cfg = config(
      [
        bucket("R", 0.5),
        bucket("K", 0.3, { band: { kind: "abs", pp: 0.01 } }),
        bucket("A", 0.2),
      ],
      { "ETF-R": rule("R"), KOTV: rule("K"), "ETF-A": rule("A") },
    );
    const pos = [etf("ETF-R", 500_000), bond("KOTV", 270_000), etf("ETF-A", 200_000)];
    const plan = bandRule(cfg, allocationState(cfg, pos, DAY), 100_000);
    // K needs 0.3·(970k + x) − 270k = x → x = 30 000 of outside cash, no sells.
    expect(plan.suggestions.map((x) => [x.instrumentKey, x.side, x.amountHuf])).toEqual([["KOTV", "buy", 30_000]]);
    expect(plan.cashUsedHuf).toBeCloseTo(30_000);
    expect(plan.weightsAfter.K).toBeCloseTo(0.3);
  });

  it("never sells an instrument that is not sellable → redirect instead", () => {
    const plan = run({}, { "ETF-R": rule("R", { sellable: false }), KOTV: rule("K") }, 50_000);
    expect(plan.suggestions.some((s) => s.side === "sell")).toBe(false);
    const redirect = plan.suggestions.find((s) => s.side === "redirect");
    expect(redirect).toMatchObject({ bucketId: "R", amountHuf: 100_000 });
    // Only the 50 000 of cash is available for K.
    const buy = plan.suggestions.find((s) => s.side === "buy");
    expect(buy).toMatchObject({ instrumentKey: "KOTV", amountHuf: 50_000 });
    expect(plan.notes.length).toBeGreaterThan(0);
  });

  it("flags a trade whose cost outweighs the benefit and does not suggest it", () => {
    const plan = run({ defaultCost: { sell: { fixedHuf: 2_000 } }, maxCostRatio: 0.01 });
    const sell = plan.suggestions.find((s) => s.side === "sell")!;
    expect(sell.status).toBe("cost-exceeds");
    expect(sell.costHuf).toBe(2_000);
    // Without the sale there's no money for the buy, so no buy is suggested…
    expect(plan.suggestions.some((s) => s.side === "buy" && s.status === "ok")).toBe(false);
    // …and the overweight becomes a redirect of future money.
    expect(plan.suggestions.find((s) => s.side === "redirect")?.amountHuf).toBe(100_000);
    expect(plan.weightsAfter.R).toBeCloseTo(0.7);
  });

  it("suggests a trade whose cost is within the threshold, with the cost estimated", () => {
    const plan = run({ defaultCost: { sell: { pct: 0.002 }, buy: { pct: 0.001 } } });
    const sell = plan.suggestions.find((s) => s.side === "sell")!;
    expect(sell).toMatchObject({ status: "ok", costHuf: 200 });
    const buy = plan.suggestions.find((s) => s.side === "buy")!;
    expect(buy.status).toBe("ok");
    // The buy is paid from the net proceeds: 100 000 − 200 sale cost − buy cost.
    expect(buy.amountHuf + buy.costHuf).toBeLessThanOrEqual(99_800 + 1);
  });

  it("instrument cost overrides the bucket and the global default", () => {
    const plan = run(
      { defaultCost: { sell: { fixedHuf: 5_000 } } },
      { "ETF-R": rule("R", { cost: { sell: { pct: 0 } } }), KOTV: rule("K") },
    );
    expect(plan.suggestions.find((s) => s.side === "sell")).toMatchObject({ status: "ok", costHuf: 0 });
  });

  it("a bond's own early-sale cost applies when nothing else is set", () => {
    const cfg = config(buckets, rules);
    const pos = [etf("ETF-R", 300_000), { ...bond("KOTV", 700_000), bondSellCostPct: 0.01 }];
    const plan = bandRule(cfg, allocationState(cfg, pos, DAY));
    const sell = plan.suggestions.find((s) => s.side === "sell")!;
    expect(sell.instrumentKey).toBe("KOTV");
    // 1% of 300 000 = 3 000 → exactly 1% of the correction: still within the threshold.
    expect(sell).toMatchObject({ amountHuf: 300_000, costHuf: 3_000, status: "ok" });
  });

  it("marks trades below the minimum size and does not suggest them", () => {
    const plan = run({ minTradeHuf: 150_000 });
    expect(plan.suggestions.find((s) => s.side === "sell")?.status).toBe("below-min");
    expect(plan.suggestions.some((s) => s.status === "ok" && s.side !== "redirect")).toBe(false);
  });

  it("reinvests sale proceeds along the path when nothing is below the band", () => {
    const three = [
      bucket("R", 0.5, { band: { kind: "abs", pp: 0.05 } }),
      bucket("K", 0.3, { band: { kind: "abs", pp: 0.1 } }),
      bucket("A", 0.2, { band: { kind: "abs", pp: 0.1 } }),
    ];
    const cfg = config(three, { "ETF-R": rule("R"), KOTV: rule("K"), "ETF-A": rule("A") });
    const pos = [etf("ETF-R", 600_000), bond("KOTV", 250_000), etf("ETF-A", 150_000, 5_000)];
    const plan = bandRule(cfg, allocationState(cfg, pos, DAY));
    const sold = plan.suggestions.filter((s) => s.side === "sell").reduce((a, s) => a + s.amountHuf, 0);
    const bought = plan.suggestions.filter((s) => s.side === "buy").reduce((a, s) => a + s.amountHuf, 0);
    expect(sold).toBe(100_000);
    expect(bought).toBeCloseTo(100_000);
    expect(plan.weightsAfter.R).toBeCloseTo(0.5);
  });
});

describe("weightHistory", () => {
  const rules = { "ETF-R": rule("R"), KOTV: rule("K") };
  const v1 = config([bucket("R", 0.6), bucket("K", 0.4)], rules, { id: "v1", validFrom: "2026-03-01" });
  const v2 = config(
    [bucket("R", 0.5), bucket("K", 0.5)],
    rules,
    { id: "v2", validFrom: "2026-05-01", savedAt: "2026-05-01T00:00:00Z" },
  );
  // Invented ledger: R grows each month, K stays flat.
  const positionsAt = (day: string): Position[] => {
    const m = +day.slice(5, 7);
    return [etf("ETF-R", 500_000 + m * 50_000), bond("KOTV", 400_000)];
  };

  it("uses the version in force on each day (earliest before the first)", () => {
    const h = weightHistory([v2, v1], ["2026-01-01", "2026-04-01", "2026-06-01"], positionsAt);
    expect(h.map((p) => p.buckets.R.target)).toEqual([0.6, 0.6, 0.5]);
    expect(h[1].buckets.R.weight).toBeCloseTo(700_000 / 1_100_000);
  });

  it("skips days with nothing held", () => {
    expect(weightHistory([v1], ["2026-01-01"], () => [])).toEqual([]);
  });
});

describe("resolveSnapshotStarts", () => {
  it("freezes the actual weight on the snapshot date", () => {
    const cfg = config(
      [
        bucket("R", 0.6, { start: { mode: "snapshot", date: "2026-02-01" } }),
        bucket("K", 0.4, { start: { mode: "snapshot", date: "2026-02-01" } }),
      ],
      { "ETF-R": rule("R"), KOTV: rule("K") },
    );
    const out = resolveSnapshotStarts(cfg, () => [etf("ETF-R", 750_000), bond("KOTV", 250_000)]);
    expect(out.buckets.map((b) => (b.start.mode === "snapshot" ? b.start.resolvedWeight : null))).toEqual([0.75, 0.25]);
    expect(pathTarget(out.buckets[0], "2026-01-01")).toBe(0.75);
  });

  it("leaves it unresolved when nothing was held", () => {
    const cfg = config([bucket("R", 1, { start: { mode: "snapshot", date: "2020-01-01" } })], { "ETF-R": rule("R") });
    const b = resolveSnapshotStarts(cfg, () => []).buckets[0];
    expect(b.start.mode === "snapshot" && b.start.resolvedWeight).toBeUndefined();
  });
});

describe("applyShock (simulation)", () => {
  const cfg = config([bucket("R", 0.6), bucket("K", 0.4)], {
    "ETF-R": rule("R"),
    KOTV: rule("K"),
    "cash:HUF": rule("K"),
  });
  const pos = [
    etf("ETF-R", 600_000),
    bond("KOTV", 300_000),
    { key: "cash:HUF", name: "HUF", valueHuf: 100_000 },
    etf("MÁSIK", 50_000),
  ];

  it("a 20% fall of R pushes it below the band and suggests buying it back", () => {
    const shocked = applyShock(cfg, pos, { R: -0.2 });
    expect(shocked.find((p) => p.key === "ETF-R")).toMatchObject({ valueHuf: 480_000, unitPriceHuf: 8_000 });
    // Cash (even inside a bucket) and unassigned positions are not shocked.
    expect(shocked.find((p) => p.key === "cash:HUF")!.valueHuf).toBe(100_000);
    expect(shocked.find((p) => p.key === "MÁSIK")!.valueHuf).toBe(50_000);
    const s = allocationState(cfg, shocked, DAY);
    expect(s.buckets[0].weight).toBeCloseTo(480 / 880);
    expect(s.buckets[0].status).toBe("below");
    const plan = bandRule(cfg, s);
    expect(plan.suggestions.some((x) => x.side === "buy" && x.bucketId === "R" && x.status === "ok")).toBe(true);
  });

  it("no shock leaves the positions untouched", () => {
    expect(applyShock(cfg, pos, {})).toEqual(pos);
  });
});

describe("glideAlerts", () => {
  const cfg = config([bucket("R", 0.6), bucket("K", 0.4)], { "ETF-R": rule("R"), KOTV: rule("K") });

  it("one alert per out-of-band bucket, keyed by the check period", () => {
    const s = allocationState(cfg, [etf("ETF-R", 700_000), bond("KOTV", 300_000)], "2026-08-20");
    const monthly = glideAlerts(s, cfg);
    expect(monthly.map((a) => a.id)).toEqual(["glide:R:above:2026-08", "glide:K:below:2026-08"]);
    expect(glideAlerts(s, { ...cfg, checkFrequency: "quarterly" })[0].id).toBe("glide:R:above:2026-Q3");
  });

  it("nothing when inside the band or empty", () => {
    const s = allocationState(cfg, [etf("ETF-R", 600_000), bond("KOTV", 400_000)], DAY);
    expect(glideAlerts(s, cfg)).toEqual([]);
    expect(glideAlerts(allocationState(cfg, [], DAY), cfg)).toEqual([]);
    expect(glideAlerts(null, cfg)).toEqual([]);
  });

  it("check periods", () => {
    expect(checkPeriod("monthly", "2026-01-31")).toBe("2026-01");
    expect(checkPeriod("quarterly", "2026-12-01")).toBe("2026-Q4");
  });
});

describe("minimum band width", () => {
  // A relative ±20% band around a small target is very narrow in absolute terms.
  const small = bucket("K", 0.3, {
    start: { mode: "manual", weight: 0.05 },
    band: { kind: "rel", pct: 0.2, minPp: 0.02 },
  });

  it("the minimum applies around a small path target", () => {
    // At the start the target is 5% → computed ±1 pp < minimum ±2 pp.
    const w = bandWidth(small, 0.05);
    expect(w.computed).toBeCloseTo(0.01);
    expect(w.effective).toBeCloseTo(0.02);
    expect(w.minApplied).toBe(true);
    const l = bandLimits(small, "2026-01-01");
    expect(l.low).toBeCloseTo(0.03);
    expect(l.high).toBeCloseTo(0.07);
  });

  it("the computed band applies around a large path target", () => {
    // At the end the target is 30% → computed ±6 pp > minimum ±2 pp.
    const w = bandWidth(small, 0.3);
    expect(w.effective).toBeCloseTo(0.06);
    expect(w.minApplied).toBe(false);
    expect(bandLimits(small, "2028-06-01").low).toBeCloseTo(0.24);
  });

  it("absolute band: the larger of the two", () => {
    expect(bandWidth(bucket("A", 0.5, { band: { kind: "abs", pp: 0.01, minPp: 0.03 } }), 0.5).effective).toBeCloseTo(0.03);
    expect(bandWidth(bucket("A", 0.5, { band: { kind: "abs", pp: 0.05, minPp: 0.03 } }), 0.5).effective).toBeCloseTo(0.05);
  });

  it("an old config without the new fields keeps its band exactly", () => {
    const old = bucket("R", 0.6, { band: { kind: "rel", pct: 0.1 } });
    const l = bandLimits(old, DAY);
    expect([l.target, l.low, l.high].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0.6, 0.54, 0.66]);
    const oldCfg = { ...config([old], {}) } as Partial<GlideConfig>;
    delete oldCfg.realertStepPp;
    delete oldCfg.deepAlertsInQuietHours;
    const n = normalizeConfig(oldCfg as GlideConfig);
    expect(n.realertStepPp).toBe(0.02);
    expect(n.deepAlertsInQuietHours).toBe(false);
  });
});

describe("relative band base", () => {
  // Path 10% → 40%: on the start day the target is 10%, the final weight 40%.
  const onPath = bucket("A", 0.4, {
    start: { mode: "manual", weight: 0.1 },
    band: { kind: "rel", pct: 0.25 },
  });
  const onFinal = { ...onPath, band: { kind: "rel" as const, pct: 0.25, base: "final" as const } };

  it("path target: ± 25% of the day's target (10% → ±2.5 pp)", () => {
    const l = bandLimits(onPath, "2026-01-01");
    expect(l.high - l.target).toBeCloseTo(0.025);
  });

  it("final weight: ± 25% of the final weight (40% → ±10 pp) all along", () => {
    expect(bandLimits(onFinal, "2026-01-01").high).toBeCloseTo(0.2);
    expect(bandLimits(onFinal, "2028-01-01").high).toBeCloseTo(0.5);
  });
});

describe("re-alert on a deepening deviation", () => {
  const cur = (deviation: number, status: "below" | "above" | "within" = "below", period = "2026-09") => ({
    status,
    deviation,
    period,
    day: "2026-09-10",
  });

  it("first time out → 'first', baseline stored", () => {
    const r = nextGlideSignal(undefined, cur(0.005), 0.02);
    expect(r.event).toBe("first");
    expect(r.signal).toMatchObject({ deviation: 0.005, count: 1 });
  });

  it("no new alert below the step", () => {
    const first = nextGlideSignal(undefined, cur(0.005), 0.02).signal;
    const r = nextGlideSignal(first, cur(0.024), 0.02);
    expect(r.event).toBeUndefined();
    expect(r.signal).toBe(first);
  });

  it("alerts again when the step is reached, measured from the LAST alert", () => {
    const s1 = nextGlideSignal(undefined, cur(0.005), 0.02).signal;
    const r2 = nextGlideSignal(s1, cur(0.025), 0.02);
    expect(r2.event).toBe("deeper");
    expect(r2.signal).toMatchObject({ deviation: 0.025, prevDeviation: 0.005, count: 2 });
    // Next step counts from 2.5 pp, not from the first 0.5 pp.
    expect(nextGlideSignal(r2.signal, cur(0.04), 0.02).event).toBeUndefined();
    expect(nextGlideSignal(r2.signal, cur(0.045), 0.02).event).toBe("deeper");
  });

  it("back inside the band clears the state", () => {
    const s1 = nextGlideSignal(undefined, cur(0.03), 0.02).signal;
    expect(nextGlideSignal(s1, cur(0, "within"), 0.02)).toEqual({});
    // …so leaving it again is a fresh 'first' with a new baseline.
    expect(nextGlideSignal(undefined, cur(0.001), 0.02).signal?.deviation).toBe(0.001);
  });

  it("a new check period or a flipped side starts over", () => {
    const s1 = nextGlideSignal(undefined, cur(0.03), 0.02).signal;
    expect(nextGlideSignal(s1, cur(0.03, "below", "2026-10"), 0.02).event).toBe("first");
    expect(nextGlideSignal(s1, cur(0.03, "above"), 0.02).event).toBe("first");
  });

  it("step 0 turns re-alerts off", () => {
    const s1 = nextGlideSignal(undefined, cur(0.01), 0).signal;
    expect(nextGlideSignal(s1, cur(0.2), 0).event).toBeUndefined();
  });

  // Whole flow on allocation states: R (60%, ±5 pp) falls step by step.
  const buckets = [bucket("R", 0.6), bucket("K", 0.4)];
  const rules = { "ETF-R": rule("R"), KOTV: rule("K") };
  const at = (rValue: number, cfg: GlideConfig) =>
    allocationState(cfg, [etf("ETF-R", rValue), bond("KOTV", 400_000)], "2026-09-10");

  it("fires after a dismissal: the deeper alert has a new id and says how far it grew", () => {
    const cfg = config(buckets, rules);
    const s1 = at(540_000, cfg); // R 57.4% → inside
    let sig: GlideSignals = updateGlideSignals({}, s1, cfg).signals;
    expect(sig).toEqual({});
    const s2 = at(500_000, cfg); // R 55.6% → inside still (low 55%)
    sig = updateGlideSignals(sig, s2, cfg).signals;
    const s3 = at(480_000, cfg); // R 54.5% → below by 0.45 pp
    sig = updateGlideSignals(sig, s3, cfg).signals;
    const first = glideAlerts(s3, cfg, sig).find((a) => a.id.startsWith("glide:R"))!;
    expect(first.id).toBe("glide:R:below:2026-09");
    expect(isDeepGlideAlert(first)).toBe(false);
    // The user dismisses it (in the app: alertState[first.id] = dismissed) —
    // the market keeps falling: R 50% → 5 pp below the band.
    const s4 = at(400_000, cfg);
    expect(bandDeviation(s4.buckets[0])).toBeCloseTo(0.05);
    const upd = updateGlideSignals(sig, s4, cfg);
    expect(upd.changed).toBe(true);
    const deep = glideAlerts(s4, cfg, upd.signals).find((a) => a.id.startsWith("glide:R"))!;
    expect(deep.id).toBe("glide:R:below:2026-09:n2");
    expect(deep.id).not.toBe(first.id);
    expect(isDeepGlideAlert(deep)).toBe(true);
    expect(deep.title).toContain("tovább mélyült");
    expect(deep.detail).toContain("0,5 %pont → 5 %pont");
    expect(deep.detail).toContain("Frissített javaslat");
    // Recovery into the band clears the state.
    expect(updateGlideSignals(upd.signals, at(600_000, cfg), cfg).signals).toEqual({});
  });

  it("a bucket's own step overrides the global one", () => {
    const fine = config(
      [bucket("R", 0.6, { realertStepPp: 0.005 }), bucket("K", 0.4)],
      rules,
      { realertStepPp: 0.02 },
    );
    const coarse = config(buckets, rules, { realertStepPp: 0.02 });
    // R goes from 0.45 pp to 1.9 pp below the band: +1.45 pp.
    for (const [cfg, expected] of [[fine, 2], [coarse, 1]] as const) {
      let sig = updateGlideSignals({}, at(480_000, cfg), cfg).signals;
      sig = updateGlideSignals(sig, at(452_000, cfg), cfg).signals;
      expect(sig.R.count).toBe(expected);
    }
  });
});

describe("quiet hours", () => {
  const cfg = (quiet: boolean) =>
    config([bucket("R", 0.6), bucket("K", 0.4)], { "ETF-R": rule("R"), KOTV: rule("K") }, {
      deepAlertsInQuietHours: quiet,
    });
  const deepAlert = (c: GlideConfig): Alert => {
    const s1 = allocationState(c, [etf("ETF-R", 480_000), bond("KOTV", 400_000)], DAY);
    const s2 = allocationState(c, [etf("ETF-R", 400_000), bond("KOTV", 400_000)], DAY);
    let sig = updateGlideSignals({}, s1, c).signals;
    sig = updateGlideSignals(sig, s2, c).signals;
    return glideAlerts(s2, c, sig).find(isDeepGlideAlert)!;
  };
  const normal: Alert = { id: "x", severity: "medium", title: "Első jelzés" };

  it("a deep re-alert goes out during quiet hours when allowed", () => {
    const a = deepAlert(cfg(true));
    expect(splitForQuietHours([a, normal], true)).toEqual({ now: [a], held: [normal] });
  });

  it("…and waits for the morning by default", () => {
    const a = deepAlert(cfg(false));
    expect(splitForQuietHours([a], true)).toEqual({ now: [], held: [a] });
  });

  it("outside quiet hours everything goes", () => {
    const a = deepAlert(cfg(false));
    expect(splitForQuietHours([a, normal], false).now).toHaveLength(2);
  });
});

describe("routeCashflow – reasons", () => {
  const buckets = [bucket("R", 0.5), bucket("K", 0.3), bucket("A", 0.2)];
  const rules = { "ETF-R": rule("R"), KOTV: rule("K"), "ETF-A": rule("A") };
  const reasons = (pos: Position[], r = rules) => {
    const cfg = config(buckets, r);
    return routeCashflow(cfg, allocationState(cfg, pos, DAY), 150_000).suggestions.map((s) => s.reason);
  };

  it("every bucket on its path → split by the path targets", () => {
    const rs = reasons([etf("ETF-R", 500_000), bond("KOTV", 300_000), etf("ETF-A", 200_000, 5_000)]);
    expect(rs.length).toBe(3);
    for (const r of rs) expect(r).toContain("A pályán van");
  });

  it("an underweight bucket is named as such", () => {
    const rs = reasons([etf("ETF-R", 600_000), bond("KOTV", 200_000), etf("ETF-A", 200_000, 5_000)]);
    expect(rs.every((r) => r.includes("alulsúlyozott — a bejövő pénz ide megy"))).toBe(true);
  });

  it("only when the underweight buckets can't take money does the rest go elsewhere", () => {
    const rs = reasons(
      [etf("ETF-R", 600_000), bond("KOTV", 200_000), etf("ETF-A", 200_000, 5_000)],
      { ...rules, KOTV: rule("K", { acceptsContributions: false }) },
    );
    expect(rs.some((r) => r.includes("Az alulsúlyozott csoportok nem fogadnak pénzt"))).toBe(true);
  });
});

describe("fractional units", () => {
  const frac = (bucketId: string, patch: Partial<InstrumentRule> = {}) =>
    rule(bucketId, { fractional: true, ...patch });

  it("buys are rounded DOWN to the decimals, not to whole units", () => {
    const buckets = [bucket("R", 0.5), bucket("K", 0.3), bucket("A", 0.2)];
    const cfg = config(buckets, { "ETF-R": rule("R"), KOTV: rule("K"), "ETF-A": frac("A") });
    const pos = [etf("ETF-R", 600_000), bond("KOTV", 200_000), etf("ETF-A", 200_000, 5_000)];
    const plan = routeCashflow(cfg, allocationState(cfg, pos, DAY), 150_000);
    // Whole units gave 3 db = 15 000 Ft of the planned 17 500; fractional: 3,5 db.
    expect(plan.suggestions.find((s) => s.instrumentKey === "ETF-A")).toMatchObject({ quantity: 3.5, amountHuf: 17_500 });
    // No rounding change left over: the whole 150 000 is placed.
    expect(plan.suggestions.reduce((a, s) => a + s.amountHuf, 0)).toBeCloseTo(150_000);
  });

  it("an amount between the decimals is floored (never more than planned)", () => {
    const cfg = config([bucket("R", 1)], { "ETF-R": frac("R") });
    const plan = routeCashflow(cfg, allocationState(cfg, [etf("ETF-R", 100_000)], DAY), 12_345.67);
    expect(plan.suggestions[0]).toMatchObject({ quantity: 1.2345, amountHuf: 12_345 });
  });

  it("qtyDecimals = 0 behaves like whole units; a non-fractional rule is unchanged", () => {
    for (const r of [frac("R", { qtyDecimals: 0 }), rule("R")]) {
      const cfg = config([bucket("R", 1)], { "ETF-R": r });
      const plan = routeCashflow(cfg, allocationState(cfg, [etf("ETF-R", 100_000)], DAY), 25_000);
      expect(plan.suggestions[0]).toMatchObject({ quantity: 2, amountHuf: 20_000 });
    }
  });

  it("a whole fractional position can be sold, but never more than held", () => {
    const cfg = config(
      [bucket("R", 0), bucket("K", 1)],
      { "ETF-R": frac("R"), KOTV: rule("K") },
    );
    const held: Position = { key: "ETF-R", name: "ETF-R", valueHuf: 31_415.9, quantity: 3.14159, unitPriceHuf: 10_000 };
    const plan = bandRule(cfg, allocationState(cfg, [held, bond("KOTV", 500_000)], DAY));
    const sell = plan.suggestions.find((s) => s.side === "sell")!;
    expect(sell.quantity).toBe(3.1415);
    expect(sell.quantity!).toBeLessThanOrEqual(held.quantity!);
  });

  it("the minimum trade size still applies", () => {
    const cfg = config([bucket("R", 1)], { "ETF-R": frac("R") }, { minTradeHuf: 10_000 });
    const plan = routeCashflow(cfg, allocationState(cfg, [etf("ETF-R", 100_000)], DAY), 5_000);
    expect(plan.suggestions[0]).toMatchObject({ quantity: 0.5, status: "below-min" });
  });
});

describe("flow target (look-ahead cash-flow routing)", () => {
  // R rises 50% → 70%, K falls 50% → 30% over 2026–2028.
  const rising = [
    bucket("R", 0.7, { start: { mode: "manual", weight: 0.5 } }),
    bucket("K", 0.3, { start: { mode: "manual", weight: 0.5 } }),
  ];
  const rules = { "ETF-R": rule("R"), KOTV: rule("K") };
  const cfgWith = (flowTarget?: GlideConfig["flowTarget"], patch: Partial<GlideConfig> = {}) =>
    config(rising, rules, { ...(flowTarget ? { flowTarget } : {}), ...patch });
  // Exactly on today's path, 1M in total (bond-like units of 1 Ft: no rounding).
  const onPath = () => {
    const t = pathTargets(cfgWith(), DAY);
    return [bond("ETF-R", t.get("R")! * 1_000_000), bond("KOTV", t.get("K")! * 1_000_000)];
  };
  const amounts = (cfg: GlideConfig, amount: number) =>
    Object.fromEntries(
      planCashflow(cfg, allocationState(cfg, onPath(), DAY), amount).suggestions.map((s) => [
        s.bucketId,
        Math.round(s.amountHuf),
      ]),
    );

  it("today mode (and an old config without the setting) routes exactly as before", () => {
    for (const cfg of [cfgWith(), cfgWith({ kind: "today" }), normalizeConfig(cfgWith())]) {
      const state = allocationState(cfg, onPath(), DAY);
      const plan = planCashflow(cfg, state, 100_000);
      const { flow, ...rest } = plan;
      expect(rest).toEqual(routeCashflow(cfg, state, 100_000));
      expect(flow).toMatchObject({ day: DAY, ahead: false, label: "a mai pályacél" });
    }
    // On the path today, the money follows the path weights — K gets its share.
    expect(amounts(cfgWith(), 100_000)).toEqual({ R: 54_520, K: 45_479 });
  });

  it("next check day: an on-path portfolio's money goes to the rising bucket, not the falling one", () => {
    const cfg = cfgWith({ kind: "nextCheck" }, { minTradeHuf: 0 });
    expect(flowTargets(cfg, DAY)).toMatchObject({ day: "2026-07-01", ahead: true, label: "a 2026-07-01-i pályacél" });
    const a = amounts(cfg, 5_000);
    expect(a.R).toBe(5_000);
    expect(a.K).toBeUndefined();
  });

  it("N days ahead: the same, with a bigger contribution", () => {
    const cfg = cfgWith({ kind: "days", days: 365 }, { minTradeHuf: 0 });
    expect(flowTargets(cfg, DAY).day).toBe("2027-06-15");
    expect(amounts(cfg, 100_000)).toEqual({ R: 100_000 });
    const plan = planCashflow(cfg, allocationState(cfg, onPath(), DAY), 100_000);
    expect(plan.suggestions[0].reason).toBe(
      "A 2027-06-15-i pályacélhoz képest alulsúlyozott — a bejövő pénz ide megy.",
    );
  });

  it("never looks past the path end: beyond it the final weights apply", () => {
    const cfg = cfgWith({ kind: "days", days: 3000 });
    const f = flowTargets(cfg, DAY);
    expect(f.label).toBe("a végső cél");
    expect(f.weights.get("R")).toBeCloseTo(0.7);
    expect(f.weights.get("K")).toBeCloseTo(0.3);
    expect(f.weights).toEqual(pathTargets(cfg, "2028-01-01"));
  });

  it("quarterly checks look to the next quarter start", () => {
    expect(flowTargetDay(cfgWith({ kind: "nextCheck" }, { checkFrequency: "quarterly" }), "2026-07-01")).toBe("2026-10-01");
  });

  it("an invalid N (while typing) falls back to today instead of throwing", () => {
    expect(flowTargetDay(cfgWith({ kind: "days", days: NaN }), DAY)).toBe(DAY);
  });

  it("band, status and alerts still measure against today's path target", () => {
    const pos = [bond("ETF-R", 300_000), bond("KOTV", 700_000)];
    const today = cfgWith();
    const ahead = cfgWith({ kind: "days", days: 365 });
    const sa = allocationState(today, pos, DAY);
    const sb = allocationState(ahead, pos, DAY);
    expect(sb.buckets.map(({ bucket: _b, ...r }) => r)).toEqual(sa.buckets.map(({ bucket: _b, ...r }) => r));
    const strip = (a: Alert[]) => a.map(({ id, title, severity }) => ({ id, title, severity }));
    expect(strip(glideAlerts(sb, ahead))).toEqual(strip(glideAlerts(sa, today)));
    expect(glideAlerts(sa, today).length).toBeGreaterThan(0);
  });
});

describe("bandRule – leftover after the restore follows the flow target", () => {
  // R rises 30% → 50%, K falls 40% → 20%, S flat 30%. K is above its band.
  const buckets = [
    bucket("R", 0.5, { start: { mode: "manual", weight: 0.3 } }),
    bucket("K", 0.2, { start: { mode: "manual", weight: 0.4 } }),
    bucket("S", 0.3),
  ];
  const rules = { R: rule("R"), K: rule("K"), S: rule("S") };
  const pos = [bond("R", 300_000), bond("K", 440_000), bond("S", 260_000)];
  const run = (flowTarget?: GlideConfig["flowTarget"]) => {
    const cfg = config(buckets, rules, flowTarget ? { flowTarget } : {});
    return bandRule(cfg, allocationState(cfg, pos, DAY)).suggestions;
  };
  const brief = (ss: ReturnType<typeof run>) =>
    ss.map((s) => `${s.side} ${s.instrumentKey} ${Math.round(s.amountHuf)}`);

  it("restores the band to TODAY's target in every mode", () => {
    for (const ft of [undefined, { kind: "nextCheck" as const }, { kind: "days" as const, days: 365 }])
      expect(brief(run(ft).filter((s) => s.side === "sell"))).toEqual(["sell K 85205"]);
  });

  it("today: the proceeds spread along today's path (R and S)", () => {
    expect(brief(run().filter((s) => s.side === "buy"))).toEqual(["buy R 45205", "buy S 39999"]);
  });

  it("look-ahead: the proceeds go to the rising bucket", () => {
    const buys = run({ kind: "days", days: 365 }).filter((s) => s.side === "buy");
    expect(brief(buys)).toEqual(["buy R 85205"]);
    expect(buys[0].reason).toContain("2027-06-15-i pályacélhoz");
  });
});
