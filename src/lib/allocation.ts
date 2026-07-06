// Target allocation per asset class + DCA split helper ("what should the next
// monthly saving buy to drift back toward the targets — without selling").
// The targets sync across devices via the cloud snapshot (see prefs.ts).

import type { AssetClass, PortfolioSummary } from "./portfolio";
import { allocationByClass } from "./portfolio";
import { touchPref } from "./prefs";

export interface AllocationSettings {
  /** Target share per asset class, 0..1. Classes not listed count as 0. */
  targets: Partial<Record<AssetClass, number>>;
}

const STORE_KEY = "pf-allocation";

export function loadAllocationSettings(): AllocationSettings | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AllocationSettings;
    if (!parsed || typeof parsed !== "object" || !parsed.targets) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAllocationSettings(s: AllocationSettings | null) {
  try {
    const json = s ? JSON.stringify(s) : null;
    // Only stamp a real change — a no-op save must not claim "newer" in sync.
    if (localStorage.getItem(STORE_KEY) === json) return;
    if (json != null) localStorage.setItem(STORE_KEY, json);
    else localStorage.removeItem(STORE_KEY);
    touchPref("allocation");
  } catch {
    /* ignore */
  }
}

export interface DriftRow {
  key: AssetClass;
  valueHuf: number;
  /** Current share of the total, 0..1. */
  actualPct: number;
  targetPct: number;
  /** Ft above (+) or below (−) the target. */
  driftHuf: number;
}

/** Actual vs. target per class — union of held classes and targeted classes. */
export function computeDrift(
  summary: PortfolioSummary,
  targets: Partial<Record<AssetClass, number>>,
): DriftRow[] {
  const total = summary.totalValueHuf;
  const actual = new Map<string, number>(
    allocationByClass(summary).map((s) => [s.key, s.value]),
  );
  const keys = new Set<AssetClass>([
    ...([...actual.keys()] as AssetClass[]),
    ...(Object.keys(targets) as AssetClass[]).filter(
      (k) => (targets[k] ?? 0) > 0,
    ),
  ]);
  return [...keys]
    .map((key) => {
      const valueHuf = actual.get(key) ?? 0;
      const targetPct = targets[key] ?? 0;
      return {
        key,
        valueHuf,
        actualPct: total > 0 ? valueHuf / total : 0,
        targetPct,
        driftHuf: valueHuf - targetPct * total,
      };
    })
    .sort((a, b) => b.targetPct - a.targetPct || b.valueHuf - a.valueHuf);
}

export interface DcaSlice {
  key: AssetClass;
  amountHuf: number;
}

/**
 * Split a new contribution across the classes so the portfolio moves toward
 * the targets by BUYING only (no sells → no tax event). Underweight classes
 * get money proportionally to their shortfall vs. the post-contribution
 * total; if the shortfalls are smaller than the contribution, the remainder
 * is spread by target share.
 */
export function dcaSplit(
  summary: PortfolioSummary,
  targets: Partial<Record<AssetClass, number>>,
  savingHuf: number,
): DcaSlice[] {
  if (savingHuf <= 0) return [];
  const total = summary.totalValueHuf;
  const newTotal = total + savingHuf;
  const actual = new Map<string, number>(
    allocationByClass(summary).map((s) => [s.key, s.value]),
  );
  const keys = (Object.keys(targets) as AssetClass[]).filter(
    (k) => (targets[k] ?? 0) > 0,
  );
  if (keys.length === 0) return [];

  const need = keys.map((k) => ({
    key: k,
    need: Math.max(0, (targets[k] ?? 0) * newTotal - (actual.get(k) ?? 0)),
  }));
  const sumNeed = need.reduce((s, n) => s + n.need, 0);

  let alloc: DcaSlice[];
  if (sumNeed <= 0) {
    // Already at/above target everywhere — keep the target proportions.
    const sumT = keys.reduce((s, k) => s + (targets[k] ?? 0), 0) || 1;
    alloc = keys.map((k) => ({
      key: k,
      amountHuf: (savingHuf * (targets[k] ?? 0)) / sumT,
    }));
  } else if (sumNeed >= savingHuf) {
    alloc = need.map((n) => ({
      key: n.key,
      amountHuf: (savingHuf * n.need) / sumNeed,
    }));
  } else {
    // Shortfalls covered in full; the rest by target share.
    const rest = savingHuf - sumNeed;
    const sumT = keys.reduce((s, k) => s + (targets[k] ?? 0), 0) || 1;
    alloc = need.map((n) => ({
      key: n.key,
      amountHuf: n.need + (rest * (targets[n.key] ?? 0)) / sumT,
    }));
  }
  return alloc
    .filter((a) => a.amountHuf > 0.5)
    .sort((a, b) => b.amountHuf - a.amountHuf);
}
