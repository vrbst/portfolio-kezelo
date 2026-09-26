// LEGACY target allocation per asset class — superseded by the glide path
// (glidePath.ts / rebalance.ts). Kept read-only: its value still syncs as a
// planning pref (see prefs.ts), and the glide path is seeded from it once
// (migrateFromAllocation) on a device that has no glide-path version yet.

import type { AssetClass } from "./portfolio";

export interface AllocationSettings {
  /** Target share per asset class, 0..1. Normalised across `included`. */
  targets: Partial<Record<AssetClass, number>>;
  /**
   * Which asset classes the target allocation manages. Only these count toward
   * the 100% and the actual-vs-target split; everything else (e.g. a T-bill
   * parking spot, crypto, cash) is ignored. Undefined = legacy setting: derive
   * from the targeted classes so old saves keep working.
   */
  included?: AssetClass[];
}

const STORE_KEY = "pf-allocation";

/** The managed classes — explicit `included`, or (legacy) the targeted ones. */
export function includedClasses(s: AllocationSettings): AssetClass[] {
  if (s.included && s.included.length) return s.included;
  return (Object.keys(s.targets) as AssetClass[]).filter(
    (k) => (s.targets[k] ?? 0) > 0,
  );
}

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
