// Plain data helpers for the glide-path charts (kept out of the component
// files so fast refresh keeps working).

import { ASSZISZTENS, PAPER, RETRO, skinned, TERM } from "../lib/skin";
import type { WeightPoint } from "../lib/rebalance";

/** Distinct, dark-theme-friendly colours for the buckets (cycled). */
export const BUCKET_COLORS = skinned({
  classic: [
    "#6366f1",
    "#22d3ee",
    "#fbbf24",
    "#34d399",
    "#f472b6",
    "#a78bfa",
    "#fb923c",
  ],
  terminal: [
    TERM.green,
    TERM.cyan,
    TERM.yellow,
    TERM.magenta,
    TERM.blue,
    TERM.orange,
    TERM.greenPale,
  ],
  paper: [
    PAPER.blue,
    PAPER.teal,
    PAPER.ochre,
    PAPER.moss,
    PAPER.claret,
    PAPER.plum,
    PAPER.slate,
  ],
  retro: [
    RETRO.navy,
    RETRO.teal,
    RETRO.olive,
    RETRO.green,
    RETRO.fuchsia,
    RETRO.purple,
    RETRO.maroon,
  ],
  asszisztens: [
    ASSZISZTENS.orange,
    ASSZISZTENS.sky,
    ASSZISZTENS.green,
    ASSZISZTENS.violet,
    ASSZISZTENS.amber,
    ASSZISZTENS.pink,
    ASSZISZTENS.teal,
  ],
});

export interface Row {
  ts: number;
  day: string;
  weight?: number;
  /** Path target and band; missing before the path started (history). */
  target?: number;
  band?: [number, number];
  /** Band before the minimum width (preview only). */
  computed?: [number, number];
  /** The minimum band sets the width on this day (preview only). */
  minApplied?: boolean;
  /** Expected weight from the inflows alone (see glideProjection). */
  projZero?: number;
  /** Expected weight with the assumed return. */
  projReal?: number;
}

export const dayTs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Rows for a path preview (path target + band only, no actual weight). */
export function previewRows(
  days: string[],
  targetAt: (day: string) => {
    target: number;
    low: number;
    high: number;
    computed?: [number, number];
    minApplied?: boolean;
  },
): Row[] {
  return days.map((day) => {
    const l = targetAt(day);
    return {
      ts: dayTs(day),
      day,
      target: l.target,
      band: [l.low, l.high],
      computed: l.computed,
      minApplied: l.minApplied,
    };
  });
}

/**
 * "target" mode: the months ahead with the expected weights, and the day's
 * check's corridor — the required weight ahead (drawn as the path) and its
 * band.
 */
export function targetFutureRows(
  days: string[],
  corridor: { day: string; target: number; low: number; high: number }[] | undefined,
  projZero: (day: string) => number | undefined,
  projReal: (day: string) => number | undefined,
): Row[] {
  const at = new Map((corridor ?? []).map((c) => [c.day, c]));
  return days.map((day) => ({
    ts: dayTs(day),
    day,
    target: at.get(day)?.target,
    band: at.has(day) ? ([at.get(day)!.low, at.get(day)!.high] as [number, number]) : undefined,
    projZero: projZero(day),
    projReal: projReal(day),
  }));
}

/**
 * The history from the first day the charted bucket was neither empty nor
 * the whole portfolio: before that the allocation was still being built (one
 * holding at 100%, the other at 0%), which only squashes the chart. Only the
 * charted bucket counts — an old version's other bucket that stayed empty
 * for months (e.g. a small one funded later) must not hide the past.
 */
export function builtHistory(history: WeightPoint[], bucketId: string): WeightPoint[] {
  const i = history.findIndex((p) => {
    const w = p.buckets[bucketId]?.weight;
    return w != null && w > 0.005 && w < 0.995;
  });
  return i > 0 ? history.slice(i) : history;
}
