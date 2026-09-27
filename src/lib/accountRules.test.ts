import { describe, expect, it } from "vitest";
import type { Account, Instrument } from "./model";
import {
  depositBlocked,
  missingVenueAlerts,
  outflowBlocked,
  purchaseVenue,
  tbszLimitSuggestion,
  upcomingVenueChange,
  type AccountContext,
  type AccountLimits,
  type PurchaseAccounts,
} from "./accountRules";
import { buildMonthlyPlan, planLineText, planTextLines, type PlanNeed } from "./monthlyPlan";
import { defaultGlobals, type Bucket, type GlideConfig } from "./glidePath";
import { allocationState, type Position } from "./rebalance";

// Invented sample data — generic accounts and round numbers, not a real portfolio.

const acc = (id: string, patch: Partial<Account> = {}): Account => ({
  id,
  name: id,
  provider: "broker",
  kind: "regular",
  currency: "HUF",
  ...patch,
});
const TBSZ25 = acc("T25", { kind: "tbsz", tbszYear: 2025, externalRef: "T-25" });
const REG = acc("REG", { externalRef: "R-1" });
const TREAS = acc("TR", { provider: "treasury-p", kind: "treasury" });

function ctx(patch: Partial<AccountContext> = {}): AccountContext {
  return {
    day: "2026-06-15",
    accounts: [TBSZ25, REG, TREAS],
    limits: {},
    purchase: {},
    fees: {},
    holdings: new Map([
      ["ETF", [{ accountId: "T25", valueHuf: 500_000, quantity: 50 }]],
      ["BOND", [{ accountId: "TR", valueHuf: 500_000, quantity: 500_000 }]],
    ]),
    cash: new Map(),
    lastBought: new Map([["OLD", "REG"]]),
    currency: new Map([
      ["ETF", "EUR"],
      ["BOND", "HUF"],
    ]),
    fx: { EUR: 400 },
    ...patch,
  };
}

describe("account limits", () => {
  const limits: AccountLimits = {
    T25: { noOutflowUntil: "2030-12-31", noDepositFrom: "2026-01-01" },
  };
  it("no outflow up to and including the day; no deposit from the day on", () => {
    expect(outflowBlocked(limits, "T25", "2030-12-31")).toBe(true);
    expect(outflowBlocked(limits, "T25", "2031-01-01")).toBe(false);
    expect(depositBlocked(limits, "T25", "2025-12-31")).toBe(false);
    expect(depositBlocked(limits, "T25", "2026-01-01")).toBe(true);
    expect(outflowBlocked(limits, "REG", "2026-06-15")).toBe(false);
  });
  it("TBSZ prefill: deposits only in the gyűjtőév, locked for 5 more years", () => {
    expect(tbszLimitSuggestion(TBSZ25)).toMatchObject({
      noDepositFrom: "2026-01-01",
      noOutflowUntil: "2030-12-31",
    });
    expect(tbszLimitSuggestion(REG)).toBeNull();
  });
});

describe("purchase venue", () => {
  const purchase: PurchaseAccounts = {
    ETF: [
      { from: "2025-01-01", target: { accountId: "T25" } },
      { from: "2026-07-01", target: { accountId: "REG" } },
    ],
  };

  it("the schedule entry in force on the day", () => {
    expect(purchaseVenue(ctx({ purchase }), "ETF").account?.id).toBe("T25");
    expect(purchaseVenue(ctx({ purchase, day: "2026-07-01" }), "ETF").account?.id).toBe("REG");
  });

  it("without a setting: where most of it is, else the latest buy's account", () => {
    expect(purchaseVenue(ctx(), "BOND")).toMatchObject({ source: "largest", label: "Államkincstár" });
    expect(purchaseVenue(ctx(), "OLD")).toMatchObject({ source: "last" });
    expect(purchaseVenue(ctx(), "NEW")).toMatchObject({ source: "none" });
  });

  it("flags a venue that takes no deposits", () => {
    const v = purchaseVenue(ctx({ limits: { T25: { noDepositFrom: "2026-01-01" } } }), "ETF");
    expect(v).toMatchObject({ depositBlocked: true, blockedFrom: "2026-01-01" });
  });

  it("an upcoming change within ~2 months is announced", () => {
    expect(upcomingVenueChange(ctx({ purchase }), "ETF")).toEqual({
      from: "2026-07-01",
      label: "broker Befektetési (R-1)",
    });
    expect(upcomingVenueChange(ctx({ purchase, day: "2026-01-01" }), "ETF")).toBeUndefined();
  });

  describe("an account not in the ledger yet", () => {
    const future: PurchaseAccounts = {
      ETF: [{ from: "2026-01-01", target: { pending: { provider: "broker", kind: "tbsz", tbszYear: 2026 } } }],
    };
    it("is the venue, marked pending, with an alert", () => {
      const v = purchaseVenue(ctx({ purchase: future }), "ETF");
      expect(v).toMatchObject({ pending: { tbszYear: 2026 }, depositBlocked: false });
      expect(v.label).toBe("broker TBSZ 2026");
      const alerts = missingVenueAlerts(future, [TBSZ25, REG], "2026-06-15", () => "ETF");
      expect(alerts.map((a) => a.id)).toEqual(["venue-missing:broker:tbsz:2026:2026-01-01"]);
      // Not yet in force → no alert.
      expect(missingVenueAlerts(future, [TBSZ25], "2025-12-31", () => "ETF")).toEqual([]);
    });
    it("binds to the matching account once imported", () => {
      const T26 = acc("T26", { kind: "tbsz", tbszYear: 2026 });
      const v = purchaseVenue(ctx({ purchase: future, accounts: [TBSZ25, T26] }), "ETF");
      expect(v.account?.id).toBe("T26");
      expect(v.pending).toBeUndefined();
      expect(missingVenueAlerts(future, [TBSZ25, T26], "2026-06-15", () => "ETF")).toEqual([]);
    });
  });
});

describe("monthly plan with accounts", () => {
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
    monthlyAmount: { kind: "remainder" },
  };
  const POS: Position[] = [
    { key: "ETF", name: "ETF", valueHuf: 400_000, quantity: 40, unitPriceHuf: 10_000 },
    { key: "BOND", name: "BOND", valueHuf: 600_000, quantity: 600_000, unitPriceHuf: 1 },
  ];
  const STATE = allocationState(GLIDE, POS, "2026-06-15");
  const INST = new Map<string, Instrument>([
    ["ETF", { key: "ETF", name: "ETF", type: "etf", currency: "EUR" } as Instrument],
    ["BOND", { key: "BOND", name: "BOND", type: "gov_bond", currency: "HUF" } as Instrument],
  ]);
  const need = (key: string, instrumentKey: string, needHuf: number): PlanNeed => ({
    key,
    kind: "dca",
    name: key,
    needHuf,
    doneHuf: 0,
    instrumentKey,
    target: instrumentKey,
    holdCash: false,
  });
  const run = (c: AccountContext, amount = 100_000, needs = [need("dca:e", "ETF", 50_000)]) =>
    buildMonthlyPlan({
      amountHuf: amount,
      needs,
      glide: GLIDE,
      state: STATE,
      budgetHuf: amount,
      positions: POS,
      instruments: INST,
      accounts: c,
    });

  it("every buy names its account; the deposits add up per account", () => {
    const p = run(ctx(), 100_000, [need("dca:e", "ETF", 50_000), need("dca:b", "BOND", 30_000)]);
    expect(p.lines[0].venue?.account?.id).toBe("T25");
    expect(planLineText(p.lines[0])).toContain("→ broker TBSZ 2025 (T-25)");
    const total = p.deposits.reduce((s, d) => s + d.totalHuf, 0);
    expect(total).toBeLessThanOrEqual(100_000 + 1);
    expect(total).toBeGreaterThan(95_000);
    expect(p.deposits.map((d) => d.label).sort()).toEqual(
      ["broker TBSZ 2025 (T-25)", "Államkincstár"].sort(),
    );
  });

  it("a HUF deposit into a EUR instrument pays the broker's conversion", () => {
    const p = run(ctx({ fees: { broker: { fxPct: 0.005 } } }));
    const t = p.lines[0].trade!;
    expect(t.fxCostHuf).toBeCloseTo(t.amountHuf * 0.005);
    expect(t.amountHuf + t.costHuf + t.fxCostHuf!).toBeLessThanOrEqual(50_000);
  });

  it("an account that takes no deposits: no buy, the money moves on, a note says why", () => {
    const limits: AccountLimits = { T25: { noDepositFrom: "2026-01-01" } };
    const p = run(ctx({ limits }), 100_000, [need("dca:e", "ETF", 50_000), need("dca:b", "BOND", 30_000)]);
    expect(p.lines[0]).toMatchObject({ blocked: true, allocatedHuf: 0, shortHuf: 50_000 });
    expect(p.lines[0].trade).toBeUndefined();
    expect(planLineText(p.lines[0])).toContain("nem vehető — broker TBSZ 2025 (T-25) 2026-01-01 óta nem fogad befizetést");
    // The 50 000 went on: the bond goal is covered, the rest to the glide path…
    expect(p.lines[1].allocatedHuf).toBe(30_000);
    expect(p.glideHuf).toBe(70_000);
    // …which buys only the bond, never the blocked ETF.
    const buys = p.glidePlan!.suggestions.filter((s) => s.status === "ok");
    expect(buys.every((s) => s.instrumentKey === "BOND")).toBe(true);
    expect(p.glidePlan!.notes.join(" ")).toContain("ETF: nem vehető");
    expect(p.deposits.map((d) => d.label)).toEqual(["Államkincstár"]);
  });

  it("shows a scheduled account change and a pending account in the text", () => {
    const purchase: PurchaseAccounts = {
      ETF: [
        { from: "2026-01-01", target: { pending: { provider: "broker", kind: "tbsz", tbszYear: 2026 } } },
        { from: "2026-07-01", target: { accountId: "REG" } },
      ],
    };
    const p = run(ctx({ purchase }));
    const text = planLineText(p.lines[0]);
    expect(text).toContain("→ broker TBSZ 2026 (még nincs a nyilvántartásban — nyisd meg)");
    expect(text).toContain("2026-07-01-tól: broker Befektetési (R-1)");
    expect(planTextLines(p).at(-1)).toMatch(/^Befizetések: /);
  });

  it("without an account context nothing changes (no venue, no deposits)", () => {
    const p = buildMonthlyPlan({
      amountHuf: 100_000,
      needs: [need("dca:e", "ETF", 50_000)],
      glide: GLIDE,
      state: STATE,
      budgetHuf: 100_000,
      positions: POS,
      instruments: INST,
    });
    expect(p.lines[0].venue).toBeUndefined();
    expect(p.deposits).toEqual([]);
  });
});

describe("missing-venue alert – one per missing account", () => {
  it("two instruments waiting for the same new account raise ONE alert naming both", () => {
    const pending = { pending: { provider: "broker", kind: "tbsz" as const, tbszYear: 2027 } };
    const purchase: PurchaseAccounts = {
      ETF: [{ from: "2027-01-01", target: pending }],
      BTC: [{ from: "2027-01-01", target: pending }],
    };
    const alerts = missingVenueAlerts(purchase, [TBSZ25], "2027-01-15", (k) => `${k} papír`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("Hiányzó vételi számla – broker TBSZ 2027");
    expect(alerts[0].detail).toContain("ETF papír");
    expect(alerts[0].detail).toContain("BTC papír");
  });
});
