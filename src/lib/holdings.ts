// ---------------------------------------------------------------------------
// Asset classes, allocation slices and cross-account consolidated holdings. Grew out of portfolio.ts, which re-exports everything here.
// ---------------------------------------------------------------------------

import type { AccountKind, Currency, Instrument } from "./model";
import { BOND_TYPES } from "./bonds";
import type { PortfolioSummary } from "./portfolio";

export type AssetClass = "equity" | "crypto" | "bond" | "tbill" | "cash";

const CRYPTO_RE = /btc|bitcoin|crypto|ethereum|wbit|wbtc/i;

/** Coarse asset class for allocation. Crypto ETPs (e.g. WBIT) split off ETFs. */
export function assetClassOf(inst?: Instrument): AssetClass {
  if (!inst) return "cash";
  if (CRYPTO_RE.test(inst.name) || CRYPTO_RE.test(inst.ticker ?? ""))
    return "crypto";
  switch (inst.type) {
    case "gov_bond":
      return "bond";
    case "tbill":
      return "tbill";
    case "cash":
      return "cash";
    default:
      return "equity"; // etf, stock, fund
  }
}

export interface AllocationSlice {
  key: string;
  value: number;
}

/**
 * Portfolio value grouped by asset class (cash lumped across currencies).
 * With `bondsAtFace`, government bonds & T-bills count at their HUF face value
 * (nominal) instead of the fluctuating accreted/redeemable value — used by the
 * target allocation, where the user thinks in the nominal amount invested.
 */
export function allocationByClass(
  summary: PortfolioSummary,
  bondsAtFace = false,
): AllocationSlice[] {
  const m = new Map<string, number>();
  const add = (k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const isBond = h.instrument ? BOND_TYPES.has(h.instrument.type) : false;
      const value =
        bondsAtFace && isBond ? h.quantity : (h.marketValueHuf ?? 0);
      add(assetClassOf(h.instrument), value);
    }
    if (acc.cashValueHuf > 0.5) add("cash", acc.cashValueHuf);
  }
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

/** Portfolio value grouped by the asset's underlying currency. */
export function allocationByCurrency(
  summary: PortfolioSummary,
  fx: Record<string, number>,
): AllocationSlice[] {
  const m = new Map<string, number>();
  const add = (k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) add(h.currency, h.marketValueHuf ?? 0);
    for (const [ccy, amt] of Object.entries(acc.cash)) {
      const huf = ccy === "HUF" ? amt : amt * (fx[ccy] ?? 0);
      if (Math.abs(huf) > 0.5) add(ccy, huf);
    }
  }
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .filter((s) => s.value > 0.5)
    .sort((a, b) => b.value - a.value);
}

export interface ConsolidatedHolding {
  instrumentKey: string;
  instrument?: Instrument;
  currency: Currency;
  /** Total units held across every account. */
  quantity: number;
  costBasisCcy: number;
  costBasisHuf: number;
  marketValueCcy?: number;
  marketValueHuf: number;
  /** Σ of the holdings' redeemable value; undefined when none differs. */
  redeemableValueHuf?: number;
  unrealizedPlHuf: number;
  /** How many accounts hold this instrument. */
  accountCount: number;
  /** Account kind this instrument lives in (treasury bonds vs TBSZ ETFs). */
  accountKind: AccountKind;
}

// Group order in the consolidated view: Államkincstár first, then TBSZ.
const HOLDING_KIND_ORDER: Record<AccountKind, number> = {
  treasury: 0,
  tbsz: 1,
  regular: 2,
  cash: 3,
};

/**
 * Aggregate holdings by instrument across ALL accounts, so a position split over
 * several accounts (e.g. the same ETF in two TBSZ-ek) shows a single combined
 * total. Sorted by market value, highest first.
 */
export function consolidatedHoldings(
  summary: PortfolioSummary,
): ConsolidatedHolding[] {
  const map = new Map<string, ConsolidatedHolding>();
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const mv = h.marketValueHuf ?? 0;
      // Non-bond holdings redeem at their value, so they add `mv` here and the
      // sum is dropped again below when nothing in the group differs.
      const redeemable = h.redeemableValueHuf ?? mv;
      const existing = map.get(h.instrumentKey);
      if (existing) {
        existing.quantity += h.quantity;
        existing.costBasisCcy += h.costBasisCcy;
        existing.costBasisHuf += h.costBasisHuf;
        existing.marketValueHuf += mv;
        existing.redeemableValueHuf =
          (existing.redeemableValueHuf ?? 0) + redeemable;
        if (h.marketValueCcy != null)
          existing.marketValueCcy =
            (existing.marketValueCcy ?? 0) + h.marketValueCcy;
        existing.unrealizedPlHuf += h.unrealizedPlHuf ?? 0;
        existing.accountCount += 1;
      } else {
        map.set(h.instrumentKey, {
          instrumentKey: h.instrumentKey,
          instrument: h.instrument,
          currency: h.currency,
          quantity: h.quantity,
          costBasisCcy: h.costBasisCcy,
          costBasisHuf: h.costBasisHuf,
          marketValueCcy: h.marketValueCcy,
          marketValueHuf: mv,
          redeemableValueHuf: redeemable,
          unrealizedPlHuf: h.unrealizedPlHuf ?? 0,
          accountCount: 1,
          accountKind: acc.account.kind,
        });
      }
    }
  }
  // Only keep the redeemable figure where it actually says something else.
  for (const h of map.values())
    if (Math.abs((h.redeemableValueHuf ?? 0) - h.marketValueHuf) < 0.5)
      h.redeemableValueHuf = undefined;
  // Államkincstár assets on top, then TBSZ; within each group by value desc.
  return [...map.values()].sort((a, b) => {
    const ka = HOLDING_KIND_ORDER[a.accountKind] ?? 9;
    const kb = HOLDING_KIND_ORDER[b.accountKind] ?? 9;
    if (ka !== kb) return ka - kb;
    return b.marketValueHuf - a.marketValueHuf;
  });
}
