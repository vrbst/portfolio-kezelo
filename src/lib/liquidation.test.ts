import { describe, expect, it } from "vitest";
import type { Account } from "./model";
import type { AccountSummary, HoldingView, PortfolioSummary } from "./portfolio";
import { accountLiquidation, portfolioLiquidation } from "./liquidation";

// Invented sample data — round numbers, not a real portfolio.

const NOW = new Date(2026, 8, 29);
const acc = (a: Partial<Account> & Pick<Account, "id" | "kind">): Account => ({
  name: a.id,
  provider: "lightyear",
  currency: "HUF",
  ...a,
});
const holding = (marketValueHuf: number, redeemableValueHuf?: number): HoldingView =>
  ({ instrumentKey: "x", quantity: 1, marketValueHuf, redeemableValueHuf }) as HoldingView;
const summary = (
  account: Account,
  totalValueHuf: number,
  capitalBasisHuf: number,
  holdings: HoldingView[] = [],
): AccountSummary => ({ account, totalValueHuf, capitalBasisHuf, holdings }) as AccountSummary;

describe("accountLiquidation", () => {
  it("taxes a new (2025+) TBSZ's gain at 28% before the 3-year turn", () => {
    const r = accountLiquidation(summary(acc({ id: "t25", kind: "tbsz", tbszYear: 2025 }), 1_200_000, 1_000_000), NOW);
    expect(r.taxRate).toBeCloseTo(0.28);
    expect(r.taxHuf).toBeCloseTo(56_000);
    expect(r.netHuf).toBeCloseTo(1_144_000);
  });

  it("uses the reduced rate in the 3–5 year window and 0% after 5 years", () => {
    const reduced = accountLiquidation(summary(acc({ id: "t22", kind: "tbsz", tbszYear: 2022 }), 1_200_000, 1_000_000), NOW);
    expect(reduced.taxRate).toBeCloseTo(0.1); // opened by 2024: no szocho
    expect(reduced.netHuf).toBeCloseTo(1_180_000);
    const matured = accountLiquidation(summary(acc({ id: "t20", kind: "tbsz", tbszYear: 2020 }), 1_200_000, 1_000_000), NOW);
    expect(matured.taxHuf).toBe(0);
    expect(matured.netHuf).toBe(1_200_000);
  });

  it("does not tax a TBSZ at a loss", () => {
    const r = accountLiquidation(summary(acc({ id: "t", kind: "tbsz", tbszYear: 2025 }), 900_000, 1_000_000), NOW);
    expect(r.taxHuf).toBe(0);
    expect(r.netHuf).toBe(900_000);
  });

  it("takes the treasury bonds' early-redemption cost off, without tax", () => {
    const k = acc({ id: "k", kind: "treasury", provider: "allamkincstar" });
    // 1 M face + 20 000 accrued; 1% of par off → 1 010 000 redeemable. Plus cash.
    const r = accountLiquidation(summary(k, 1_070_000, 1_000_000, [holding(1_020_000, 1_010_000), holding(50_000)]), NOW);
    expect(r.saleCostHuf).toBe(10_000);
    expect(r.taxHuf).toBe(0);
    expect(r.netHuf).toBe(1_060_000);
  });

  it("taxes a TBSZ's gain after the sale cost", () => {
    const t = acc({ id: "tk", kind: "tbsz", tbszYear: 2025, provider: "allamkincstar" });
    const r = accountLiquidation(summary(t, 1_100_000, 1_000_000, [holding(1_100_000, 1_090_000)]), NOW);
    expect(r.gainHuf).toBe(90_000);
    expect(r.taxHuf).toBeCloseTo(25_200);
    expect(r.netHuf).toBeCloseTo(1_064_800);
  });
});

describe("portfolioLiquidation", () => {
  it("sums the accounts", () => {
    const s = {
      accounts: [
        summary(acc({ id: "t", kind: "tbsz", tbszYear: 2025 }), 1_200_000, 1_000_000),
        summary(acc({ id: "k", kind: "treasury" }), 1_020_000, 1_000_000, [holding(1_020_000, 1_010_000)]),
      ],
    } as PortfolioSummary;
    const r = portfolioLiquidation(s, NOW);
    expect(r.grossHuf).toBe(2_220_000);
    expect(r.saleCostHuf).toBe(10_000);
    expect(r.taxHuf).toBeCloseTo(56_000);
    expect(r.netHuf).toBeCloseTo(2_154_000);
  });
});
