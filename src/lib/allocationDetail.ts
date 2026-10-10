// Allocation slices WITH their contributors — what the donut's hover popover
// shows (which bonds make up "Állampapír", which assets feed a sector, …).
// Slice values match allocationByClass / allocationByCurrency / sectorExposure.

import { assetClassOf, consolidatedHoldings, type ConsolidatedHolding } from "./holdings";
import { sectorContributions, sectorLabel, type FundamentalsFile } from "./fundamentals";
import { assetClassLabel } from "./labels";
import type { PortfolioSummary } from "./portfolio";

export interface Contributor {
  key: string;
  label: string;
  valueHuf: number;
}

export interface DetailSlice {
  key: string;
  name: string;
  value: number;
  /** Largest first. */
  items: Contributor[];
}

export type DetailMode = "class" | "currency" | "account" | "sector";

const CASH_LABEL = "Készpénz";

export const holdingLabel = (h: Pick<ConsolidatedHolding, "instrument" | "instrumentKey">) =>
  h.instrument?.ticker ?? h.instrument?.name ?? h.instrumentKey;

function toSlices(
  groups: Map<string, { name: string; items: Contributor[] }>,
  minValue = 0,
): DetailSlice[] {
  return [...groups]
    .map(([key, g]) => {
      const items = g.items.slice().sort((a, b) => b.valueHuf - a.valueHuf);
      return { key, name: g.name, value: items.reduce((s, c) => s + c.valueHuf, 0), items };
    })
    .filter((s) => s.value > minValue)
    .sort((a, b) => b.value - a.value);
}

function group(
  groups: Map<string, { name: string; items: Contributor[] }>,
  key: string,
  name: string,
  item: Contributor,
) {
  const g = groups.get(key) ?? { name, items: [] };
  g.items.push(item);
  groups.set(key, g);
}

/** Same totals as allocationByClass: holdings by asset class, cash lumped. */
export function detailByClass(summary: PortfolioSummary): DetailSlice[] {
  const groups = new Map<string, { name: string; items: Contributor[] }>();
  for (const h of consolidatedHoldings(summary)) {
    const cls = assetClassOf(h.instrument);
    group(groups, cls, assetClassLabel[cls] ?? cls, {
      key: h.instrumentKey,
      label: holdingLabel(h),
      valueHuf: h.marketValueHuf,
    });
  }
  for (const acc of summary.accounts)
    if (acc.cashValueHuf > 0.5)
      group(groups, "cash", assetClassLabel.cash, {
        key: acc.account.id,
        label: acc.account.name,
        valueHuf: acc.cashValueHuf,
      });
  // allocationByClass keeps every class, even a zero-valued one.
  return toSlices(groups, -Infinity);
}

/** Same totals as allocationByCurrency. */
export function detailByCurrency(summary: PortfolioSummary, fx: Record<string, number>): DetailSlice[] {
  const groups = new Map<string, { name: string; items: Contributor[] }>();
  for (const h of consolidatedHoldings(summary))
    group(groups, h.currency, h.currency, {
      key: h.instrumentKey,
      label: holdingLabel(h),
      valueHuf: h.marketValueHuf,
    });
  for (const acc of summary.accounts)
    for (const [ccy, amt] of Object.entries(acc.cash)) {
      const huf = ccy === "HUF" ? amt : amt * (fx[ccy] ?? 0);
      if (Math.abs(huf) > 0.5)
        group(groups, ccy, ccy, { key: `${acc.account.id}:${ccy}`, label: `${CASH_LABEL} · ${acc.account.name}`, valueHuf: huf });
    }
  return toSlices(groups, 0.5);
}

/** One slice per account: its holdings plus the cash on it. */
export function detailByAccount(summary: PortfolioSummary): DetailSlice[] {
  const groups = new Map<string, { name: string; items: Contributor[] }>();
  for (const acc of summary.accounts) {
    if (acc.totalValueHuf <= 0) continue;
    for (const h of acc.holdings)
      group(groups, acc.account.id, acc.account.name, {
        key: h.instrumentKey,
        label: holdingLabel(h),
        valueHuf: h.marketValueHuf ?? 0,
      });
    if (acc.cashValueHuf > 0.5)
      group(groups, acc.account.id, acc.account.name, {
        key: `${acc.account.id}:cash`,
        label: CASH_LABEL,
        valueHuf: acc.cashValueHuf,
      });
  }
  return toSlices(groups, -Infinity);
}

/**
 * Sector slices (ETFs looked through by their sector weights). Only the covered
 * part of the portfolio is split — bonds, cash and data-less papers are out.
 */
export function detailBySector(
  summary: PortfolioSummary,
  file: FundamentalsFile | null,
): { slices: DetailSlice[]; coveredHuf: number } {
  const holdings = consolidatedHoldings(summary);
  const names = new Map(holdings.map((h) => [h.instrumentKey, holdingLabel(h)]));
  const { bySector, coveredHuf } = sectorContributions(
    holdings.map((h) => ({ key: h.instrumentKey, valueHuf: h.marketValueHuf })),
    file,
  );
  const groups = new Map<string, { name: string; items: Contributor[] }>();
  for (const [sector, items] of bySector)
    groups.set(sector, {
      name: sectorLabel(sector),
      items: items.map((c) => ({ key: c.key, label: names.get(c.key) ?? c.key, valueHuf: c.valueHuf })),
    });
  return { slices: toSlices(groups), coveredHuf };
}
