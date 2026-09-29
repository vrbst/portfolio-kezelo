// ---------------------------------------------------------------------------
// "Ha most eladnék mindent": what the whole portfolio would net if every
// position were sold today.
//   • Early-redemption cost: a fixed-rate bond sold before maturity loses its
//     sale cost (FixMÁP: 1% of par) — the holdings carry it as
//     redeemableValueHuf (see bondMarketValue).
//   • TBSZ tax: breaking a TBSZ taxes its gain (value after the sale cost minus
//     the capital paid in) at the account's current tier (tbszStatus).
// Other accounts are counted at their realisable value, without tax.
// ---------------------------------------------------------------------------

import type { AccountSummary, PortfolioSummary } from "./portfolio";
import { tbszStatus } from "./tbsz";

export interface AccountLiquidation {
  account: AccountSummary["account"];
  /** Value as the portfolio counts it (nominal + accrued for bonds). */
  grossHuf: number;
  /** Early-redemption cost of the bonds (≥ 0). */
  saleCostHuf: number;
  /** TBSZ tax on the gain (≥ 0; 0 for non-TBSZ accounts). */
  taxHuf: number;
  /** Tax rate applied (TBSZ only). */
  taxRate?: number;
  /** Taxable gain after the sale cost (TBSZ only, may be ≤ 0). */
  gainHuf?: number;
  /** What would land in your pocket. */
  netHuf: number;
}

export interface Liquidation {
  accounts: AccountLiquidation[];
  grossHuf: number;
  saleCostHuf: number;
  taxHuf: number;
  netHuf: number;
}

export function accountLiquidation(a: AccountSummary, now: Date = new Date()): AccountLiquidation {
  const grossHuf = a.totalValueHuf;
  const saleCostHuf = a.holdings.reduce(
    (s, h) =>
      h.redeemableValueHuf != null && h.marketValueHuf != null
        ? s + Math.max(0, h.marketValueHuf - h.redeemableValueHuf)
        : s,
    0,
  );
  const afterCost = grossHuf - saleCostHuf;
  if (a.account.kind === "tbsz" && a.account.tbszYear) {
    const taxRate = tbszStatus(a.account.tbszYear, now).taxRate;
    const gainHuf = afterCost - a.capitalBasisHuf;
    const taxHuf = Math.max(0, gainHuf) * taxRate;
    return { account: a.account, grossHuf, saleCostHuf, taxHuf, taxRate, gainHuf, netHuf: afterCost - taxHuf };
  }
  return { account: a.account, grossHuf, saleCostHuf, taxHuf: 0, netHuf: afterCost };
}

export function portfolioLiquidation(s: PortfolioSummary, now: Date = new Date()): Liquidation {
  const accounts = s.accounts.map((a) => accountLiquidation(a, now));
  const sum = (f: (a: AccountLiquidation) => number) => accounts.reduce((t, a) => t + f(a), 0);
  return {
    accounts,
    grossHuf: sum((a) => a.grossHuf),
    saleCostHuf: sum((a) => a.saleCostHuf),
    taxHuf: sum((a) => a.taxHuf),
    netHuf: sum((a) => a.netHuf),
  };
}
