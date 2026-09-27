import { describe, expect, it } from "vitest";
import type { Account } from "./model";
import type { AccountContext, AccountLimits, PurchaseAccounts } from "./accountRules";
import { defaultGlobals, type Bucket, type GlideConfig, type InstrumentRule } from "./glidePath";
import {
  allocationState,
  applyShock,
  bandRule,
  incomingBuyOptions,
  placeIncoming,
  planCashflow,
  planSummary,
  suggestionText,
  type Position,
  type RebalancePlan,
} from "./rebalance";

// Invented sample data — generic accounts, buckets and round numbers.
// A TBSZ-like account "T" at broker "ly" holds the EUR equity ETF; a treasury
// account "K" at broker "kt" holds the HUF bond; "REG" is a regular "ly" account.

const acc = (id: string, patch: Partial<Account>): Account => ({
  id,
  name: id,
  provider: "ly",
  kind: "regular",
  currency: "HUF",
  ...patch,
});
const T = acc("T", { kind: "tbsz", tbszYear: 2025, externalRef: "T-1" });
const K = acc("K", { provider: "kt", kind: "treasury" });
const REG = acc("REG", { externalRef: "R-1" });
const DAY = "2026-06-15";

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
const rule = (b: string): InstrumentRule => ({ bucketId: b, sellable: true, acceptsContributions: true });

function setup(
  held: { key: string; acct: string; value: number; unit: number; ccy: string; bucket: string }[],
  opts: { limits?: AccountLimits; purchase?: PurchaseAccounts; fees?: AccountContext["fees"] } = {},
) {
  const buckets = [...new Set(held.map((h) => h.bucket))].map((b) => bucket(b, b === "R" ? 0.6 : 0.4));
  const cfg: GlideConfig = {
    id: "v",
    validFrom: "2026-01-01",
    savedAt: "2026-01-01T00:00:00Z",
    buckets,
    instruments: Object.fromEntries(held.map((h) => [h.key, rule(h.bucket)])),
    ...defaultGlobals(),
    minTradeHuf: 1_000,
  };
  const byKey = new Map<string, Position>();
  for (const h of held) {
    const p = byKey.get(h.key) ?? { key: h.key, name: h.key, valueHuf: 0, quantity: 0, unitPriceHuf: h.unit };
    p.valueHuf += h.value;
    p.quantity! += h.value / h.unit;
    byKey.set(h.key, p);
  }
  const holdings = new Map<string, { accountId: string; valueHuf: number; quantity: number }[]>();
  for (const h of held) {
    const l = holdings.get(h.key) ?? [];
    l.push({ accountId: h.acct, valueHuf: h.value, quantity: h.value / h.unit });
    l.sort((a, b) => b.valueHuf - a.valueHuf);
    holdings.set(h.key, l);
  }
  const ctx: AccountContext = {
    day: DAY,
    accounts: [T, K, REG],
    limits: opts.limits ?? {},
    purchase: opts.purchase ?? {},
    fees: opts.fees ?? {},
    holdings,
    cash: new Map(),
    lastBought: new Map(),
    currency: new Map(held.map((h) => [h.key, h.ccy])),
    fx: { EUR: 400 },
  };
  return { cfg, positions: [...byKey.values()], ctx };
}

const brief = (p: RebalancePlan) =>
  p.suggestions.map((s) =>
    s.side === "transfer"
      ? `transfer ${s.fromAccountId}>${s.toAccountId} ${Math.round(s.amountHuf)}`
      : `${s.status === "ok" ? "" : `[${s.status}] `}${s.side} ${s.instrumentKey ?? s.bucketId}${s.accountId ? `@${s.accountId}` : ""} ${Math.round(s.amountHuf)}`,
  );

/** Equity ETF on T, bond on K. */
const BASE = (etf: number, bond: number) => [
  { key: "ETF", acct: "T", value: etf, unit: 1_000, ccy: "EUR", bucket: "R" },
  { key: "BOND", acct: "K", value: bond, unit: 1, ccy: "HUF", bucket: "K" },
];

function run(held: Parameters<typeof setup>[0], opts: Parameters<typeof setup>[1] = {}) {
  const { cfg, positions, ctx } = setup(held, opts);
  return bandRule(cfg, allocationState(cfg, positions, DAY), 0, ctx);
}

describe("band rule on accounts – no limits", () => {
  it("above: sell on T, transfer T → K (with the conversion), buy on K", () => {
    const p = run(BASE(700_000, 300_000), { fees: { ly: { fxPct: 0.004, transferFixedHuf: 500 } } });
    expect(brief(p)).toEqual(["sell ETF@T 100000", "transfer T>K 100000", "buy BOND@K 99601"]);
    const tr = p.suggestions.find((s) => s.side === "transfer")!;
    expect(tr.costHuf).toBe(500);
    expect(tr.fxCostHuf).toBeCloseTo(100_000 - 100_000 / 1.004, 0);
    expect(suggestionText(tr)).toContain("Utalás: ly TBSZ 2025 (T-1) → Államkincstár");
  });

  it("below (−20% case): sell the bond on K, transfer K → T, buy the ETF on T", () => {
    const p = run(BASE(500_000, 500_000));
    expect(brief(p)).toEqual(["sell BOND@K 100000", "transfer K>T 100000", "buy ETF@T 100000"]);
  });

  it("never both sides of one instrument", () => {
    for (const held of [BASE(700_000, 300_000), BASE(500_000, 500_000)]) {
      const ok = run(held).suggestions.filter((s) => s.status === "ok" && s.instrumentKey);
      for (const s of ok)
        expect(ok.some((t) => t.instrumentKey === s.instrumentKey && t.side !== s.side)).toBe(false);
    }
  });

  it("sells from the account without a limit first", () => {
    const held = [
      { key: "ETF", acct: "T", value: 500_000, unit: 1_000, ccy: "EUR", bucket: "R" },
      { key: "ETF", acct: "REG", value: 200_000, unit: 1_000, ccy: "EUR", bucket: "R" },
      { key: "BOND", acct: "K", value: 300_000, unit: 1, ccy: "HUF", bucket: "K" },
    ];
    const p = run(held, { limits: { T: { noOutflowUntil: "2030-12-31" } } });
    expect(brief(p).filter((x) => x.startsWith("sell"))).toEqual(["sell ETF@REG 100000"]);
  });
});

describe("band rule on accounts – limits", () => {
  const locked: AccountLimits = { T: { noOutflowUntil: "2030-12-31", noOutflowNote: "TBSZ" } };

  it("money may not leave T: the sale is blocked, the c) way is offered", () => {
    const p = run(BASE(700_000, 300_000), { limits: locked });
    expect(p.suggestions.some((s) => s.status === "ok" && s.side !== "redirect")).toBe(false);
    const sell = p.suggestions.find((s) => s.side === "sell")!;
    expect(sell.status).toBe("account-locked");
    expect(sell.reason).toContain("2030-12-31-ig nem hagyhatja el a számlát (TBSZ)");
    const r = p.suggestions.find((s) => s.side === "redirect")!;
    expect(r).toMatchObject({ bucketId: "R", status: "ok" });
    expect(r.amountHuf).toBeCloseTo(700_000 / 0.65 - 1_000_000);
    expect(p.notes.join(" ")).toContain("„kereskedés nélkül” (c) módra");
  });

  it("…but inside T the money may buy what T holds", () => {
    // Bucket K also holds a bond ETF on T: that part of the buy is funded inside T.
    const held = [
      ...BASE(700_000, 150_000),
      { key: "BETF", acct: "T", value: 150_000, unit: 1_000, ccy: "EUR", bucket: "K" },
    ];
    const p = run(held, { limits: locked });
    const ok = p.suggestions.filter((s) => s.status === "ok");
    expect(ok.some((s) => s.side === "transfer")).toBe(false);
    expect(ok.find((s) => s.side === "buy")).toMatchObject({ instrumentKey: "BETF", accountId: "T" });
    const sold = ok.filter((s) => s.side === "sell").reduce((a, s) => a + s.amountHuf, 0);
    const bought = ok.filter((s) => s.side === "buy").reduce((a, s) => a + s.amountHuf, 0);
    expect(sold).toBeCloseTo(bought, -3);
    expect(p.suggestions.some((s) => s.status === "account-locked")).toBe(true);
  });

  it("T takes no deposits: no buy there, the sale is undone, the bucket asks for money", () => {
    const p = run(BASE(500_000, 500_000), { limits: { T: { noDepositFrom: "2026-01-01" } } });
    // Both buckets are out (R below, K above): each gets the c) redirect.
    const ok = p.suggestions.filter((s) => s.status === "ok");
    expect(ok.map((s) => [s.side, s.bucketId, !!s.redirectIn])).toEqual([
      ["redirect", "R", true],
      ["redirect", "K", false],
    ]);
    expect(p.suggestions.find((s) => s.side === "buy")!.reason).toContain("2026-01-01 óta nem fogad befizetést");
  });

  it("…with a new account for buys set, the money goes there", () => {
    const p = run(BASE(500_000, 500_000), {
      limits: { T: { noDepositFrom: "2026-01-01" } },
      purchase: { ETF: [{ from: "2026-01-01", target: { accountId: "REG" } }] },
      fees: { ly: { fxPct: 0.004 } },
    });
    expect(brief(p)).toEqual(["sell BOND@K 100000", "transfer K>REG 100000", "buy ETF@REG 99000"]);
    // HUF from K into the EUR ETF: converted at the "ly" broker.
    expect(p.suggestions.find((s) => s.side === "transfer")!.fxCostHuf).toBeCloseTo(398, 0);
  });

  it("the simulation uses the same logic (a shocked state)", () => {
    const { cfg, positions, ctx } = setup(BASE(600_000, 400_000), { limits: locked });
    // +50%: 900k / 1.3M ≈ 69% — above the 55–65% band.
    const shocked = allocationState(cfg, applyShock(cfg, positions, { R: 0.5 }), DAY);
    const p = bandRule(cfg, shocked, 0, ctx);
    expect(p.suggestions.find((s) => s.side === "sell")?.status).toBe("account-locked");
  });
});

describe("incoming money on accounts", () => {
  it("a coupon on K buying the ETF: transfer K → T", () => {
    const { cfg, positions, ctx } = setup(BASE(500_000, 500_000));
    const state = allocationState(cfg, positions, DAY);
    const plan = planCashflow(cfg, state, 50_000, incomingBuyOptions(ctx, "K"));
    const placed = placeIncoming(plan, ctx, "K");
    expect(brief(placed)).toEqual(["transfer K>T 50000", "buy ETF@T 50000"]);
  });

  it("an account that takes no deposits gets nothing; money stays where it may", () => {
    const { cfg, positions, ctx } = setup(BASE(500_000, 500_000), {
      limits: { T: { noDepositFrom: "2026-01-01" } },
    });
    const state = allocationState(cfg, positions, DAY);
    const plan = planCashflow(cfg, state, 50_000, incomingBuyOptions(ctx, "K"));
    expect(brief(placeIncoming(plan, ctx, "K"))).toEqual(["buy BOND@K 50000"]);
  });
});

describe("plan summary (simulation totals)", () => {
  it("adds up the steps: moves, the cost split and the transfers", () => {
    const { cfg, positions, ctx } = setup(BASE(500_000, 500_000), {
      fees: { ly: { fxPct: 0.004, buy: { pct: 0.001 } }, kt: { transferFixedHuf: 300 } },
    });
    // The bond pays a 1% early redemption cost when sold.
    const pos = positions.map((p) => (p.key === "BOND" ? { ...p, bondSellCostPct: 0.01 } : p));
    const plan = bandRule(cfg, allocationState(cfg, pos, DAY), 0, ctx);
    const sum = planSummary(plan);
    const ok = plan.suggestions.filter((s) => s.status === "ok");
    const sell = ok.find((s) => s.side === "sell")!;
    const buy = ok.find((s) => s.side === "buy")!;
    const tr = ok.find((s) => s.side === "transfer")!;
    expect(sell.redemptionCost).toBe(true);
    expect(sum.redemptionCostHuf).toBeCloseTo(sell.costHuf);
    expect(sum.tradeCostHuf).toBeCloseTo(buy.costHuf);
    expect(sum.fxCostHuf).toBeCloseTo((tr.fxCostHuf ?? 0) + (buy.fxCostHuf ?? 0));
    expect(sum.transferCostHuf).toBe(300);
    expect(sum.totalCostHuf).toBeCloseTo(
      sum.tradeCostHuf + sum.redemptionCostHuf + sum.fxCostHuf + sum.transferCostHuf,
    );
    expect(sum.transfers.map((t) => [t.fromAccountId, t.toAccountId])).toEqual([["K", "T"]]);
    expect(sum.blocked).toEqual([]);
  });

  it("lists the steps the limits block", () => {
    const plan = run(BASE(700_000, 300_000), { limits: { T: { noOutflowUntil: "2030-12-31" } } });
    expect(planSummary(plan).blocked.map((s) => s.side)).toEqual(["sell", "buy"]);
  });
});

describe("band rule on accounts – a conversion gap is not a limit", () => {
  // The −20% case: equity below its band, the bond sold on K funds the ETF
  // on T. The sale's proceeds shrink by the conversion (0.35%) and the bond's
  // early redemption cost (1%) — the buy is a little smaller, nothing more.
  const fees = { ly: { fxPct: 0.0035 } };
  const withRedemption = (limits?: AccountLimits) => {
    const { cfg, positions, ctx } = setup(BASE(500_000, 500_000), { fees, limits });
    const pos = positions.map((p) => (p.key === "BOND" ? { ...p, bondSellCostPct: 0.01 } : p));
    return bandRule(cfg, allocationState(cfg, pos, DAY), 0, ctx);
  };

  it("no limit set: no limit warning, no c) redirect, the buy is suggested", () => {
    const p = withRedemption();
    expect(p.notes.join(" ")).not.toMatch(/számlakorlát/);
    expect(p.suggestions.some((s) => s.side === "redirect")).toBe(false);
    expect(p.suggestions.some((s) => s.status === "account-locked")).toBe(false);
    const buy = p.suggestions.find((s) => s.side === "buy")!;
    expect(buy).toMatchObject({ status: "ok", instrumentKey: "ETF", accountId: "T" });
    // Funded by the sale net of its costs: a bit below the sale amount.
    const sell = p.suggestions.find((s) => s.side === "sell")!;
    expect(buy.amountHuf).toBeLessThan(sell.amountHuf);
    expect(buy.amountHuf).toBeGreaterThanOrEqual(sell.amountHuf * 0.97); // whole 1 000 Ft units
  });

  it("an unrelated limit (money may not leave T) changes nothing here", () => {
    const p = withRedemption({ T: { noOutflowUntil: "2030-12-31" } });
    expect(p.notes.join(" ")).not.toMatch(/számlakorlát/);
    expect(p.suggestions.find((s) => s.side === "buy")?.status).toBe("ok");
  });

  it("a real limit still warns: T takes no deposits", () => {
    const p = withRedemption({ T: { noDepositFrom: "2026-01-01" } });
    expect(p.suggestions.find((s) => s.side === "buy")?.status).toBe("account-locked");
    expect(p.notes.join(" ")).toMatch(/számlakorlát/);
  });
});
