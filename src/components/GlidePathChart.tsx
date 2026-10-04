import { useMemo, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
} from "recharts";
import type { WeightPoint } from "../lib/rebalance";
import { dayTs, type Row } from "./glideChartData";
import { CHART } from "../lib/skin";
import { utcDay } from "../lib/day";

const tooltipStyle = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 12,
  color: "var(--color-text)",
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
  markers = [],
  goal,
  mirror,
}: {
  rows: Row[];
  color: string;
  height?: string;
  /** Highlighted points: "now" (today's weight) and "goal" (arrival). */
  markers?: ChartMarker[];
  /** The final weight, drawn as a highlighted horizontal line. */
  goal?: number;
  /** Two buckets: the other one's share (100% − this) on a right axis. */
  mirror?: { name: string; color: string };
}) {
  // Zoomed to what is shown (to the nearest 5%), so a narrow band is legible.
  const step = 0.05;
  const values = rows.flatMap((r) =>
    [r.band?.[0], r.band?.[1], r.target, r.weight, r.projZero, r.projReal].filter(
      (v): v is number => v != null && Number.isFinite(v),
    ),
  );
  if (goal != null) values.push(goal);
  const max = Math.min(1, Math.ceil((Math.max(0.1, ...values) + 0.02) / step) * step);
  const min = Math.max(0, Math.floor((Math.min(max - 0.1, ...values) - 0.02) / step) * step);
  // Round ticks: every 5 pp on a narrow range, every 10 pp otherwise.
  const tickStep = max - min <= 0.3 ? 0.05 : 0.1;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / tickStep - 1e-9) * tickStep; t <= max + 1e-9; t += tickStep)
    ticks.push(Math.round(t * 100) / 100);
  return (
    <div className={`${height} w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(ts) => monthLabel(utcDay(ts))}
            tick={{ fill: CHART.axis, fontSize: 12 }}
            stroke={CHART.grid}
            minTickGap={40}
          />
          <YAxis
            domain={[min, max]}
            ticks={ticks}
            tickFormatter={(v) => `${Math.round(v * 100)}%`}
            tick={{ fill: CHART.axis, fontSize: 12 }}
            stroke={CHART.grid}
            width={40}
          />
          {mirror && (
            <YAxis
              yAxisId="mirror"
              orientation="right"
              domain={[min, max]}
              ticks={ticks}
              tickFormatter={(v) => `${Math.round((1 - v) * 100)}%`}
              tick={{ fill: mirror.color, fontSize: 12 }}
              stroke={CHART.grid}
              width={40}
            />
          )}
          <Tooltip
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as Row | undefined;
              if (!active || !row) return null;
              return (
                <div style={tooltipStyle} className="px-3 py-2 text-xs">
                  <div className="mb-1 font-medium">{row.day}</div>
                  {row.weight != null && (
                    <div style={{ color }}>
                      Tényleges: {pct(row.weight)}
                      {mirror && <span style={{ color: mirror.color }}> · {mirror.name} {pct(1 - row.weight)}</span>}
                    </div>
                  )}
                  {row.target != null && <div>Pályacél: {pct(row.target)}</div>}
                  {row.projZero != null && row.weight == null && (
                    <div style={{ color }}>Várható (csak befizetés): {pct(row.projZero)}</div>
                  )}
                  {row.projReal != null && row.weight == null && (
                    <div style={{ color }}>Várható (hozammal): {pct(row.projReal)}</div>
                  )}
                  {row.band && (
                    <div className="text-[var(--color-chart-axis)]">
                      Sáv: {pct(row.band[0])} – {pct(row.band[1])}
                      {row.minApplied && " (minimális sáv)"}
                    </div>
                  )}
                  {row.computed && row.minApplied && (
                    <div className="text-[var(--color-chart-axis)]">
                      Számított sáv: {pct(row.computed[0])} – {pct(row.computed[1])}
                    </div>
                  )}
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
          {rows.some((r) => r.computed) &&
            ([0, 1] as const).map((i) => (
              <Line
                key={i}
                dataKey={(r: Row) => r.computed?.[i]}
                stroke={color}
                strokeOpacity={0.8}
                strokeDasharray="2 3"
                dot={false}
                strokeWidth={1}
                isAnimationActive={false}
              />
            ))}
          <Line
            dataKey="target"
            stroke={CHART.text}
            strokeOpacity={0.7}
            strokeDasharray="5 4"
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          {rows.some((r) => r.projZero != null) && (
            <Line
              dataKey="projZero"
              stroke={color}
              strokeDasharray="1 3"
              strokeLinecap="round"
              dot={false}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {rows.some((r) => r.projReal != null) && (
            <Line
              dataKey="projReal"
              stroke={color}
              strokeOpacity={0.55}
              strokeDasharray="1 3"
              strokeLinecap="round"
              dot={false}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
            />
          )}
          <Line
            dataKey="weight"
            stroke={color}
            dot={false}
            strokeWidth={2}
            connectNulls
            isAnimationActive={false}
          />
          {mirror && (
            // Recharts only draws an axis that has a series: an invisible one.
            <Line
              yAxisId="mirror"
              dataKey="weight"
              stroke="none"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
          )}
          {goal != null && (
            <ReferenceLine
              y={goal}
              stroke={CHART.highlight}
              strokeWidth={1.5}
              strokeOpacity={0.85}
              label={{
                value: `cél ${pct(goal)}${mirror ? ` / ${pct(1 - goal)}` : ""}`,
                position: "insideTopLeft",
                fill: CHART.highlight,
                fontSize: 11,
              }}
            />
          )}
          {markers.map((m) => (
            <ReferenceDot
              key={m.kind}
              x={m.ts}
              y={m.value}
              r={m.kind === "now" ? 5 : 6}
              fill={m.kind === "now" ? color : CHART.text}
              stroke={m.kind === "now" ? CHART.text : color}
              strokeWidth={2}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface ChartMarker {
  kind: "now" | "goal";
  ts: number;
  value: number;
}

/** A line sample (solid or dashed) and its label. */
function LegendItem({
  color,
  label,
  dash,
  opacity = 1,
}: {
  color: string;
  label: string;
  dash?: string;
  opacity?: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden>
        <line
          x1="1"
          y1="3"
          x2="17"
          y2="3"
          stroke={color}
          strokeOpacity={opacity}
          strokeWidth={2}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}

/**
 * The history from the first day every bucket held something: before that
 * the allocation was still being built (one holding at 100%, the others at
 * 0%), which only squashes the chart. Unchanged when no day qualifies.
 */
function builtHistory(history: WeightPoint[]): WeightPoint[] {
  const i = history.findIndex((p) => {
    const ws = Object.values(p.buckets).map((b) => b.weight);
    return ws.length > 0 && ws.every((w) => w > 0.005);
  });
  return i > 0 ? history.slice(i) : history;
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
  pathFrom,
  goalDay,
  goal,
  mirror,
  name,
}: {
  history: WeightPoint[];
  bucketId: string;
  color: string;
  future?: Row[];
  /**
   * Draw the path and band only from this day on (YYYY-MM-DD): an inflow
   * path starts on its save day, and the old versions' paths before it
   * would only confuse.
   */
  pathFrom?: string;
  /** Expected arrival at the final weight (YYYY-MM-DD), marked on the path. */
  goalDay?: string;
  /** The bucket's final weight (highlighted horizontal line). */
  goal?: number;
  /** Two buckets: the pair's share on a right axis (see GlideBucketChart). */
  mirror?: { name: string; color: string };
  /** The bucket's name, for the legend when mirrored. */
  name?: string;
}) {
  const [all, setAll] = useState(false);
  const rows = useMemo(
    () =>
      builtHistory(history).flatMap((p): Row[] => {
        const b = p.buckets[bucketId];
        return b
          ? [
              {
                ts: dayTs(p.day),
                day: p.day,
                weight: b.weight,
                ...(!pathFrom || p.day >= pathFrom
                  ? { target: b.target, band: [b.low, b.high] as [number, number] }
                  : {}),
              },
            ]
          : [];
      }),
    [history, bucketId, pathFrom],
  );
  if (rows.length < 2)
    return (
      <p className="text-xs text-[var(--color-muted)]">
        Az idősoros grafikonhoz legalább két hónapnyi adat kell.
      </p>
    );
  const last = rows[rows.length - 1];
  const ahead = future.filter((r) => r.day > last.day);
  // By default the last 12 months: early history (e.g. a single holding at
  // 100%) and old path versions would squash the part that matters.
  const from = last.ts - 365 * 864e5;
  const shown = all ? rows : rows.filter((r) => r.ts >= from);
  const cut = shown.length < rows.length;
  // "Now" on today's actual weight; "goal" on the path where it arrives.
  const goalRow = goalDay ? ahead.find((r) => r.day >= goalDay && r.target != null) : undefined;
  const markers: ChartMarker[] = [
    ...(last.weight != null ? [{ kind: "now" as const, ts: last.ts, value: last.weight }] : []),
    ...(goalRow?.target != null ? [{ kind: "goal" as const, ts: goalRow.ts, value: goalRow.target }] : []),
  ];
  // The expected-weight lines start from today's actual weight.
  const joined = ahead.some((r) => r.projZero != null || r.projReal != null)
    ? [
        ...shown.slice(0, -1),
        {
          ...last,
          projZero: ahead.some((r) => r.projZero != null) ? last.weight : undefined,
          projReal: last.weight,
        },
      ]
    : shown;
  return (
    <div>
      <GlideBucketChart
        rows={[...joined, ...ahead]}
        color={color}
        markers={markers}
        goal={goal}
        mirror={mirror}
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <LegendItem color={color} label={mirror && name ? `${name} (bal tengely)` : "tényleges arány"} />
        {mirror && (
          <span className="flex items-center gap-1.5" style={{ color: mirror.color }}>
            {mirror.name}: jobb tengely (100% − {name})
          </span>
        )}
        {goal != null && <LegendItem color={CHART.highlight} label="végső cél" />}
        <LegendItem color={CHART.text} dash="5 4" label="pálya (ehhez mér a riasztás)" />
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm" style={{ background: color, opacity: 0.25 }} />
          sáv
        </span>
        {markers.map((m) => (
          <span key={m.kind} className="flex items-center gap-1.5">
            <svg width="12" height="12" aria-hidden>
              <circle
                cx="6"
                cy="6"
                r="4"
                fill={m.kind === "now" ? color : CHART.text}
                stroke={m.kind === "now" ? CHART.text : color}
                strokeWidth={2}
              />
            </svg>
            {m.kind === "now"
              ? `most (${utcDay(m.ts)})`
              : `várhatóan eléri a célt (${monthLabel(utcDay(m.ts))})`}
          </span>
        ))}
        {ahead.some((r) => r.projZero != null) && (
          <LegendItem color={color} dash="1 3" label="várható, csak befizetésből" />
        )}
        {ahead.some((r) => r.projReal != null) && (
          <LegendItem color={color} dash="1 3" opacity={0.55} label="várható, hozammal (tájékoztató)" />
        )}
        {(cut || all) && (
          <button
            className="ml-auto underline hover:text-[var(--color-text)]"
            onClick={() => setAll((v) => !v)}
          >
            {all ? "Csak az utolsó 12 hónap" : "Teljes előzmény"}
          </button>
        )}
      </div>
    </div>
  );
}

