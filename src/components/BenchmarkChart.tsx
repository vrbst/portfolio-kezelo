import { useMemo } from "react";
import { useReducedMotion } from "motion/react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { formatPercent } from "../lib/format";

const PORTFOLIO_COLOR = "#6366f1";
const BENCHMARK_COLOR = "#8b93a7";

export interface BenchmarkPoint {
  date: string;
  /** Cumulative time-weighted return of the portfolio (fraction). */
  portfolio: number;
  /** Cumulative return of the benchmark in HUF (fraction). */
  benchmark?: number;
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function formatMonth(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    year: "2-digit",
    month: "short",
  }).format(d);
}

function ChartTooltip({
  active,
  payload,
  label,
  names,
}: {
  active?: boolean;
  payload?: { dataKey?: string; value?: number; stroke?: string }[];
  label?: number;
  names: Record<string, string>;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 shadow-xl">
      <div className="mb-1 text-xs text-[var(--color-muted)]">
        {formatDay(Number(label))}
      </div>
      {payload.map((p) => (
        <div
          key={p.dataKey}
          className="flex items-center justify-between gap-4 text-sm"
        >
          <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: p.stroke }}
            />
            {names[p.dataKey ?? ""] ?? p.dataKey}
          </span>
          <span className="font-medium tabular-nums">
            {formatPercent(Number(p.value))}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Portfolio TWR vs. a benchmark, both as cumulative % from the same start day
 * on one shared axis. Percentages only — nothing to mask in privacy mode.
 */
export default function BenchmarkChart({
  data,
  benchmarkLabel,
}: {
  data: BenchmarkPoint[];
  benchmarkLabel: string;
}) {
  const chartData = useMemo(
    () => data.map((d) => ({ ...d, ts: new Date(d.date).getTime() })),
    [data],
  );
  const reduce = useReducedMotion();
  const anim = {
    isAnimationActive: !reduce,
    animationDuration: 900,
    animationEasing: "ease-out" as const,
  };
  const names = { portfolio: "Portfólió (TWR)", benchmark: benchmarkLabel };
  const min = chartData[0]?.ts ?? 0;
  const max = chartData[chartData.length - 1]?.ts ?? 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-[var(--color-muted)]">
        <span className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-4 rounded"
            style={{ background: PORTFOLIO_COLOR }}
          />
          {names.portfolio}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="w-4 border-t-2 border-dashed"
            style={{ borderColor: BENCHMARK_COLOR }}
          />
          {names.benchmark}
        </span>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
          >
            <CartesianGrid stroke="#232b45" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={[min, max]}
              tickFormatter={formatMonth}
              tick={{ fill: "#8b93a7", fontSize: 12 }}
              stroke="#232b45"
              minTickGap={32}
            />
            <YAxis
              tickFormatter={(v) => formatPercent(v)}
              tick={{ fill: "#8b93a7", fontSize: 12 }}
              stroke="#232b45"
              width={56}
            />
            <ReferenceLine y={0} stroke="#3a4468" strokeWidth={1} />
            <Tooltip
              cursor={{ stroke: "#3a4468", strokeWidth: 1 }}
              content={<ChartTooltip names={names} />}
            />
            <Line
              type="monotone"
              dataKey="portfolio"
              stroke={PORTFOLIO_COLOR}
              strokeWidth={2}
              dot={false}
              {...anim}
            />
            <Line
              type="monotone"
              dataKey="benchmark"
              stroke={BENCHMARK_COLOR}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
              {...anim}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
