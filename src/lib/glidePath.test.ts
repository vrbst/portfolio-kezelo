import { describe, expect, it } from "vitest";
import {
  cashKey,
  configAt,
  defaultGlobals,
  latestConfig,
  mergeGlideVersions,
  migrateFromAllocation,
  validateConfig,
  type Bucket,
  type GlideConfig,
} from "./glidePath";
import type { Instrument } from "./model";

// Invented sample data — not a real portfolio.
function bucket(id: string, finalWeight: number, patch: Partial<Bucket> = {}): Bucket {
  return {
    id,
    name: id,
    finalWeight,
    start: { mode: "manual", weight: finalWeight },
    startDate: "2026-01-01",
    endDate: "2030-01-01",
    interpolation: "linear",
    band: { kind: "abs", pp: 0.05 },
    ...patch,
  };
}

function config(buckets: Bucket[], patch: Partial<GlideConfig> = {}): GlideConfig {
  return {
    id: "v1",
    validFrom: "2026-01-01",
    savedAt: "2026-01-01T10:00:00.000Z",
    buckets,
    instruments: Object.fromEntries(
      buckets.map((b) => [
        `INST-${b.id}`,
        { bucketId: b.id, sellable: true, acceptsContributions: true },
      ]),
    ),
    ...defaultGlobals(),
    ...patch,
  };
}

describe("validateConfig", () => {
  it("accepts final weights summing to 100%", () => {
    const r = validateConfig(config([bucket("Részvény", 0.6), bucket("Kötvény", 0.4)]));
    expect(r.errors).toEqual([]);
  });

  it("tolerates percentage rounding", () => {
    const r = validateConfig(
      config([bucket("A", 0.3333), bucket("B", 0.3333), bucket("C", 0.3334)]),
    );
    expect(r.errors).toEqual([]);
  });

  it.each([0.99, 1.01])("rejects a final sum of %s", (last) => {
    const r = validateConfig(config([bucket("A", 0.5), bucket("B", last - 0.5)]));
    expect(r.errors.some((e) => e.message.includes("végső célsúlyok"))).toBe(true);
  });

  it("rejects manual start weights not summing to 100%", () => {
    const r = validateConfig(
      config([
        bucket("A", 0.5, { start: { mode: "manual", weight: 0.7 } }),
        bucket("B", 0.5, { start: { mode: "manual", weight: 0.2 } }),
      ]),
    );
    expect(r.errors.some((e) => e.message.includes("kezdő súlyok"))).toBe(true);
  });

  it("skips the start-sum check when a bucket uses a snapshot", () => {
    const r = validateConfig(
      config([
        bucket("A", 0.5, { start: { mode: "snapshot", date: "2026-01-01" } }),
        bucket("B", 0.5, { start: { mode: "manual", weight: 0.9 } }),
      ]),
    );
    expect(r.errors).toEqual([]);
  });

  it("rejects an end date not after the start date", () => {
    const r = validateConfig(
      config([bucket("A", 1, { startDate: "2027-01-01", endDate: "2027-01-01" })]),
    );
    expect(r.errors.some((e) => e.message.includes("záró dátum"))).toBe(true);
  });

  it("rejects empty or oversized bands", () => {
    const abs = validateConfig(config([bucket("A", 1, { band: { kind: "abs", pp: 0 } })]));
    const rel = validateConfig(config([bucket("A", 1, { band: { kind: "rel", pct: 1 } })]));
    expect(abs.errors).toHaveLength(1);
    expect(rel.errors).toHaveLength(1);
  });

  it("rejects negative costs and a negative minimum trade", () => {
    const r = validateConfig(
      config([bucket("A", 1, { cost: { buy: { pct: -0.01 } } })], { minTradeHuf: -1 }),
    );
    expect(r.errors).toHaveLength(2);
  });

  it("rejects an instrument pointing at a missing bucket", () => {
    const cfg = config([bucket("A", 1)]);
    cfg.instruments["X"] = { bucketId: "nincs", sellable: true, acceptsContributions: true };
    expect(validateConfig(cfg).errors.some((e) => e.instrumentKey === "X")).toBe(true);
  });

  it("rejects duplicate bucket names", () => {
    const r = validateConfig(config([bucket("A", 0.5), { ...bucket("B", 0.5), name: "a" }]));
    expect(r.errors.some((e) => e.message.includes("Két csoport"))).toBe(true);
  });

  it("warns about held positions outside every bucket", () => {
    const r = validateConfig(
      config([bucket("A", 1)], { monthlyAmount: { kind: "remainder" } }),
      ["INST-A", "MÁSIK"],
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("warns while the monthly amount is unset (old versions: whole budget)", () => {
    const r = validateConfig(config([bucket("A", 1)]));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.message.includes("havi összege"))).toBe(true);
  });

  it.each([
    [{ kind: "fixed", huf: -1 }],
    [{ kind: "pct", pct: 1.2 }],
    [{ kind: "pct", pct: -0.1 }],
  ] as const)("rejects an invalid monthly amount %j", (monthlyAmount) => {
    const r = validateConfig(config([bucket("A", 1)], { monthlyAmount }));
    expect(r.errors.some((e) => e.message.includes("havi összege"))).toBe(true);
  });

  it.each([0, 1.5, NaN, 5000])("rejects a flow look-ahead of %s days", (days) => {
    const r = validateConfig(
      config([bucket("A", 1)], { monthlyAmount: { kind: "remainder" }, flowTarget: { kind: "days", days } }),
    );
    expect(r.errors.some((e) => e.message.includes("célpontja"))).toBe(true);
  });

  it.each([
    [{ kind: "today" }],
    [{ kind: "nextCheck" }],
    [{ kind: "days", days: 90 }],
  ] as const)("accepts the flow target %j", (flowTarget) => {
    const r = validateConfig(config([bucket("A", 1)], { monthlyAmount: { kind: "remainder" }, flowTarget }));
    expect(r.errors).toEqual([]);
  });

  it.each([
    [{ kind: "fixed", huf: 150_000 }],
    [{ kind: "pct", pct: 0.2 }],
    [{ kind: "remainder" }],
  ] as const)("accepts a valid monthly amount %j", (monthlyAmount) => {
    const r = validateConfig(config([bucket("A", 1)], { monthlyAmount }));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("treats a config without buckets as switched off", () => {
    expect(validateConfig(config([]))).toEqual({ errors: [], warnings: [] });
  });
});

describe("versions", () => {
  const v = (id: string, validFrom: string, savedAt: string) =>
    config([bucket("A", 1)], { id, validFrom, savedAt });
  const versions = [
    v("a", "2026-01-01", "2026-01-01T08:00:00Z"),
    v("b", "2026-06-01", "2026-05-20T08:00:00Z"),
    v("c", "2026-06-01", "2026-05-25T08:00:00Z"),
  ];

  it("picks the version in force on a day", () => {
    expect(configAt(versions, "2025-12-31")).toBeUndefined();
    expect(configAt(versions, "2026-01-01")?.id).toBe("a");
    expect(configAt(versions, "2026-05-31")?.id).toBe("a");
    // Same validFrom: the later save wins.
    expect(configAt(versions, "2026-06-01")?.id).toBe("c");
  });

  it("latest is the newest by validFrom, then savedAt", () => {
    expect(latestConfig(versions)?.id).toBe("c");
  });

  it("merges two histories as a union by id", () => {
    const merged = mergeGlideVersions([versions[0], versions[2]], [versions[1], versions[0]]);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("migrateFromAllocation", () => {
  const inst = (key: string, type: Instrument["type"], name = key): Instrument => ({
    key,
    name,
    type,
    currency: "EUR",
  });
  let n = 0;
  const makeId = () => `id${++n}`;

  it("turns managed classes into flat-path buckets", () => {
    const cfg = migrateFromAllocation(
      { targets: { equity: 0.7, bond: 0.3, crypto: 0.1 }, included: ["equity", "bond"] },
      [inst("ETF1", "etf"), inst("KOTV1", "gov_bond"), inst("KRIPTO1", "etf", "Bitcoin ETP")],
      ["HUF"],
      "2026-03-01",
      makeId,
    )!;
    expect(cfg.buckets.map((b) => [b.name, b.finalWeight])).toEqual([
      ["Részvény / ETF", 0.7],
      ["Állampapír", 0.3],
    ]);
    for (const b of cfg.buckets)
      expect(b.start).toEqual({ mode: "manual", weight: b.finalWeight });
    expect(Object.keys(cfg.instruments).sort()).toEqual(["ETF1", "KOTV1"]);
    // Cash was not managed → its balance stays outside.
    expect(cfg.instruments[cashKey("HUF")]).toBeUndefined();
    expect(validateConfig(cfg).errors).toEqual([]);
  });

  it("normalises old targets that did not sum to 100%", () => {
    const cfg = migrateFromAllocation(
      { targets: { equity: 0.6, cash: 0.2 } },
      [],
      ["HUF", "EUR"],
      "2026-03-01",
      makeId,
    )!;
    expect(cfg.buckets.map((b) => b.finalWeight)).toEqual([0.75, 0.25]);
    expect(cfg.instruments[cashKey("EUR")]?.bucketId).toBe(cfg.buckets[1].id);
  });

  it("returns null without any target", () => {
    expect(migrateFromAllocation({ targets: {} }, [], [], "2026-03-01")).toBeNull();
  });
});

describe("validateConfig – mixed starts", () => {
  it("warns when snapshot + manual starts don't sum to 100%", () => {
    const cfg = config([
      bucket("A", 0.6, { start: { mode: "snapshot", date: "2026-01-01", resolvedWeight: 0.35 } }),
      bucket("B", 0.4, { start: { mode: "manual", weight: 0.4 } }),
    ]);
    const r = validateConfig(cfg);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.message.includes("kezdő súlyok"))).toBe(true);
  });
});

describe("validateConfig – fractional decimals", () => {
  it("accepts 0–8 whole decimals and rejects anything else", () => {
    const cfg = config([bucket("A", 1)]);
    const withDec = (d: number) => ({
      ...cfg,
      instruments: { "INST-A": { ...cfg.instruments["INST-A"], fractional: true, qtyDecimals: d } },
    });
    expect(validateConfig(withDec(4)).errors).toEqual([]);
    expect(validateConfig(withDec(0)).errors).toEqual([]);
    expect(validateConfig(withDec(9)).errors).toHaveLength(1);
    expect(validateConfig(withDec(2.5)).errors).toHaveLength(1);
  });
});
