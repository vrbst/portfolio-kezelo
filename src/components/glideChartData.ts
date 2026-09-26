// Plain data helpers for the glide-path charts (kept out of the component
// files so fast refresh keeps working).

/** Distinct, dark-theme-friendly colours for the buckets (cycled). */
export const BUCKET_COLORS = [
  "#6366f1",
  "#22d3ee",
  "#fbbf24",
  "#34d399",
  "#f472b6",
  "#a78bfa",
  "#fb923c",
];

export interface Row {
  ts: number;
  day: string;
  weight?: number;
  target: number;
  band: [number, number];
}

export const dayTs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Rows for a path preview (path target + band only, no actual weight). */
export function previewRows(
  days: string[],
  targetAt: (day: string) => { target: number; low: number; high: number },
): Row[] {
  return days.map((day) => {
    const l = targetAt(day);
    return { ts: dayTs(day), day, target: l.target, band: [l.low, l.high] };
  });
}
