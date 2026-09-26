import { describe, expect, it } from "vitest";
import {
  budgetBreakdown,
  couponClaimingGoals,
  dcaMonthlyHuf,
  glideAmountSource,
  glideMonthlyHuf,
  savingsMonthlyHuf,
} from "./budget";
import {
  defaultGlobals,
  mergeGlideVersions,
  normalizeConfig,
  type GlideConfig,
  type MonthlyAmount,
} from "./glidePath";
import type { Goal } from "./goals";
import type { SavingsProgress } from "./savings";

// Invented sample data — not a real portfolio.
function glide(monthlyAmount?: MonthlyAmount): GlideConfig {
  return {
    id: "v1",
    validFrom: "2026-01-01",
    savedAt: "2026-01-01T10:00:00.000Z",
    buckets: [
      {
        id: "A",
        name: "A",
        finalWeight: 1,
        start: { mode: "manual", weight: 1 },
        startDate: "2026-01-01",
        endDate: "2030-01-01",
        interpolation: "linear",
        band: { kind: "abs", pp: 0.05 },
      },
    ],
    instruments: { "INST-A": { bucketId: "A", sellable: true, acceptsContributions: true } },
    ...defaultGlobals(),
    ...(monthlyAmount ? { monthlyAmount } : {}),
  };
}

function progress(patch: Partial<SavingsProgress> & { name?: string; includeCoupons?: boolean }): SavingsProgress {
  const { name = "Cél", includeCoupons = false, ...rest } = patch;
  return {
    goal: {
      id: name,
      name,
      targetHuf: 1_000_000,
      targetDate: "2027-01-01",
      instrumentKeys: [],
      includeCoupons,
      createdAt: "2026-01-01",
    },
    monthlyNeededHuf: 0,
    daysLeft: 100,
    reached: false,
    ...rest,
  } as SavingsProgress;
}

const dca = (amountHuf: number, periodMonths: Goal["periodMonths"]): Goal => ({
  id: `${amountHuf}/${periodMonths}`,
  instrumentKey: "X",
  amountHuf,
  periodMonths,
  createdAt: "2026-01-01",
});

describe("glideMonthlyHuf", () => {
  it("fixed: the amount itself, independent of the budget", () => {
    expect(glideMonthlyHuf({ kind: "fixed", huf: 150_000 }, 200_000, 120_000)).toBe(150_000);
  });

  it("pct: a share of the budget", () => {
    expect(glideMonthlyHuf({ kind: "pct", pct: 0.25 }, 200_000, 0)).toBe(50_000);
  });

  it("remainder: what the other goals leave", () => {
    expect(glideMonthlyHuf({ kind: "remainder" }, 200_000, 120_000)).toBe(80_000);
  });

  it("remainder never goes below 0", () => {
    expect(glideMonthlyHuf({ kind: "remainder" }, 228_206, 293_542)).toBe(0);
    expect(glideMonthlyHuf({ kind: "remainder" }, -5_000, 0)).toBe(0);
  });

  it("unset (old versions): the whole budget, as before", () => {
    expect(glideMonthlyHuf(undefined, 200_000, 120_000)).toBe(200_000);
  });
});

describe("budgetBreakdown", () => {
  const base = { budgetHuf: 200_000, dcaHuf: 40_000, savingsHuf: 80_000 };

  it("counts the glide path's fixed amount in the overshoot", () => {
    const b = budgetBreakdown({ ...base, glide: glide({ kind: "fixed", huf: 100_000 }) });
    expect(b).toMatchObject({ glideHuf: 100_000, committedHuf: 220_000, freeHuf: 0, overHuf: 20_000, glideMode: "fixed" });
  });

  it("leaves the rest free when it fits", () => {
    const b = budgetBreakdown({ ...base, glide: glide({ kind: "pct", pct: 0.2 }) });
    expect(b).toMatchObject({ glideHuf: 40_000, committedHuf: 160_000, freeHuf: 40_000, overHuf: 0 });
  });

  it("remainder mode fills the budget exactly and causes no overshoot", () => {
    const b = budgetBreakdown({ ...base, glide: glide({ kind: "remainder" }) });
    expect(b).toMatchObject({ glideHuf: 80_000, freeHuf: 0, overHuf: 0 });
  });

  it("remainder mode doesn't hide an overshoot the other goals cause", () => {
    const b = budgetBreakdown({ budgetHuf: 100_000, dcaHuf: 40_000, savingsHuf: 80_000, glide: glide({ kind: "remainder" }) });
    expect(b).toMatchObject({ glideHuf: 0, overHuf: 20_000 });
  });

  it("an old version takes the whole budget, so every other goal overshoots", () => {
    const b = budgetBreakdown({ ...base, glide: glide() });
    expect(b).toMatchObject({ glideHuf: 200_000, glideMode: "legacy", overHuf: 120_000 });
  });

  it("a switched-off glide path takes nothing", () => {
    const b = budgetBreakdown({ ...base, glide: { ...glide({ kind: "fixed", huf: 1 }), buckets: [] } });
    expect(b).toMatchObject({ glideHuf: 0, glideMode: null, freeHuf: 80_000 });
    expect(budgetBreakdown({ ...base, glide: undefined }).glideMode).toBeNull();
  });
});

describe("old glide-path versions", () => {
  it("load and merge without a monthly amount — the whole budget stays", () => {
    const old = glide();
    const [loaded] = mergeGlideVersions([normalizeConfig(old)], []);
    expect(loaded.monthlyAmount).toBeUndefined();
    expect(budgetBreakdown({ budgetHuf: 150_000, dcaHuf: 0, savingsHuf: 0, glide: loaded }).glideHuf).toBe(150_000);
  });
});

describe("Teendők default amount", () => {
  it("is the glide path's monthly amount, with its source", () => {
    const cfg = glide({ kind: "fixed", huf: 150_000 });
    const b = budgetBreakdown({ budgetHuf: 300_000, dcaHuf: 0, savingsHuf: 0, glide: cfg });
    expect(b.glideHuf).toBe(150_000);
    expect(glideAmountSource(b, cfg)?.replace(/\s/g, " ")).toBe("Célpálya havi összege: 150 000 Ft — fix");
  });

  it("names the mode for pct, remainder and legacy", () => {
    const src = (spec?: MonthlyAmount) => {
      const cfg = glide(spec);
      return glideAmountSource(budgetBreakdown({ budgetHuf: 200_000, dcaHuf: 0, savingsHuf: 50_000, glide: cfg }), cfg)!.replace(/\s/g, " ");
    };
    expect(src({ kind: "pct", pct: 0.2 })).toBe("Célpálya havi összege: 40 000 Ft — a havi keret 20%-a");
    expect(src({ kind: "remainder" })).toBe("Célpálya havi összege: 150 000 Ft — ami a többi cél után marad");
    expect(src()).toMatch(/200 000 Ft — a teljes havi keret — nincs beállítva/);
  });

  it("is null while the glide path is off", () => {
    const b = budgetBreakdown({ budgetHuf: 1, dcaHuf: 0, savingsHuf: 0, glide: undefined });
    expect(glideAmountSource(b, undefined)).toBeNull();
  });
});

describe("goal commitments", () => {
  it("DCA goals as monthly equivalents", () => {
    expect(dcaMonthlyHuf([dca(40_000, 1), dca(300_000, 3)])).toBe(140_000);
  });

  it("medium-term goals: only those still ahead and not reached", () => {
    expect(
      savingsMonthlyHuf([
        progress({ monthlyNeededHuf: 46_875 }),
        progress({ monthlyNeededHuf: 99_999, reached: true }),
        progress({ monthlyNeededHuf: 99_999, daysLeft: 0 }),
      ]),
    ).toBe(46_875);
  });

  it("flags goals still ahead that earmark the coupons", () => {
    expect(
      couponClaimingGoals([
        progress({ name: "Babaváró", includeCoupons: true }),
        progress({ name: "Kész", includeCoupons: true, reached: true }),
        progress({ name: "Nózi" }),
      ]),
    ).toEqual(["Babaváró"]);
  });
});
