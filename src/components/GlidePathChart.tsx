import { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { WeightPoint } from "../lib/rebalance";
import { dayTs, type Row } from "./glideChartData";

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;



const pct = (v: number) =>
  `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`;

const MONTHS = ["jan", "febr", "márc", "ápr", "máj", "jún", "júl", "aug", "szept", "okt", "nov", "dec"];
const monthLabel = (day: string) =>
  `${day.slice(0, 4)}. ${MONTHS[+day.slice(5, 7) - 1]}.`;

/**
 * One bucket over time: the actual weight (solid), the path target (dashed)
 * and the tolerance band (shaded). `rows` may carry path-only points (e.g. a
 * preview of future months) with no actual weight.
 */
export function GlideBucketChart({
  rows,
  color,
  height = "h-56",
}: {
  rows: Row[];
  color: string;
  height?: string;
}) {
  const max = Math.min(
    1,
    Math.max(0.1, ...rows.map((r) => Math.max(r.band[1], r.weight ?? 0))) + 0.05,
  );
  return (
    <div className={`${height} w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#232b45" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(ts) => monthLabel(new Date(ts).toISOString().slice(0, 10))}
            tick={{ fill: "#8b93a7", fontSize: 12 }}
            stroke="#232b45"
            minTickGap={40}
          />
          <YAxis
            domain={[0, max]}
            tickFormatter={(v) => `${Math.round(v * 100)}%`}
            tick={{ fill: "#8b93a7", fontSize: 12 }}
            stroke="#232b45"
            width={40}
          />
          <Tooltip
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as Row | undefined;
              if (!active || !row) return null;
              return (
                <div style={tooltipStyle} className="px-3 py-2 text-xs">
                  <div className="mb-1 font-medium">{row.day}</div>
                  {row.weight != null && (
                    <div style={{ color }}>Tényleges: {pct(row.weight)}</div>
                  )}
                  <div>Pályacél: {pct(row.target)}</div>
                  <div className="text-[#8b93a7]">
                    Sáv: {pct(row.band[0])} – {pct(row.band[1])}
                  </div>
                </div>
              );
            }}
          />
          <Area
            dataKey="band"
            stroke="none"
            fill={color}
            fillOpacity={0.14}
            isAnimationActive={false}
          />
          <Line
            dataKey="target"
            stroke="#e8ecf8"
            strokeOpacity={0.7}
            strokeDasharray="5 4"
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Line
            dataKey="weight"
            stroke={color}
            dot={false}
            strokeWidth={2}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * History chart for one bucket, from the ledger-derived weight series, with
 * the path and band continued into the future (`future`: path-only rows).
 */
export default function GlidePathChart({
  history,
  bucketId,
  color,
  future = [],
}: {
  history: WeightPoint[];
  bucketId: string;
  color: string;
  future?: Row[];
}) {
  const rows = useMemo(
    () =>
      history.flatMap((p): Row[] => {
        const b = p.buckets[bucketId];
        return b
          ? [
              {
                ts: dayTs(p.day),
                day: p.day,
                weight: b.weight,
                target: b.target,
                band: [b.low, b.high],
              },
            ]
          : [];
      }),
    [history, bucketId],
  );
  if (rows.length < 2)
    return (
      <p className="text-xs text-[var(--color-muted)]">
        Az idősoros grafikonhoz legalább két hónapnyi adat kell.
      </p>
    );
  const last = rows[rows.length - 1].day;
  return (
    <GlideBucketChart
      rows={[...rows, ...future.filter((r) => r.day > last)]}
      color={color}
    />
  );
}

