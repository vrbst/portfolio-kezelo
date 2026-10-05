import { useReducedMotion } from "motion/react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import type { MonthPerformance } from "../lib/portfolio";
import { formatCompact, formatMoney, formatPercent } from "../lib/format";
import { usePortfolio } from "../lib/store";
import { CHART } from "../lib/skin";

const MASK = "•••";

export type MonthlyMode = "pct" | "huf";

/** "2026-08" → a local-date label ("aug. 26" / "2026. augusztus"). */
function monthLabel(month: string, long = false): string {
  const d = new Date(+month.slice(0, 4), +month.slice(5, 7) - 1, 1);
  return new Intl.DateTimeFormat(
    "hu-HU",
    long
      ? { year: "numeric", month: "long" }
      : { year: "2-digit", month: "short" },
  ).format(d);
}

function TipRow({
  label,
  value,
  dot,
  amount,
}: {
  label: string;
  value: string;
  dot?: string;
  amount?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
        {dot && (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: dot }}
          />
        )}
        {label}
      </span>
      <span className={`font-medium tabular-nums ${amount ? "amt" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  privacy,
  benchmarkLabel,
}: {
  active?: boolean;
  payload?: { payload?: MonthPerformance }[];
  privacy: boolean;
  benchmarkLabel: string;
}) {
  const m = active ? payload?.[0]?.payload : undefined;
  if (!m) return null;
  const color = m.twr >= 0 ? CHART.positive : CHART.negative;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 shadow-xl">
      <div className="mb-1 text-xs text-[var(--color-muted)]">
        {monthLabel(m.month, true)}
        {m.current && " (eddig)"}
      </div>
      <TipRow label="Hozam (TWR)" value={formatPercent(m.twr)} dot={color} />
      <TipRow
        label="Piaci eredmény"
        value={privacy ? MASK : formatMoney(m.profitHuf, "HUF", { sign: true })}
        amount
      />
      {m.benchmark != null && (
        <TipRow
          label={benchmarkLabel}
          value={formatPercent(m.benchmark)}
          dot={CHART.axis}
        />
      )}
    </div>
  );
}

/**
 * One bar per calendar month: the month's time-weighted return (%) or its
 * market result in HUF, green above / red below zero. The running month is
 * drawn faded. Privacy mode masks the HUF axis and tooltip amount.
 */
export default function MonthlyPerformanceChart({
  data,
  mode,
  benchmarkLabel,
}: {
  data: MonthPerformance[];
  mode: MonthlyMode;
  benchmarkLabel: string;
}) {
  const privacy = usePortfolio((s) => s.privacy);
  const reduce = useReducedMotion();
  const key = mode === "pct" ? "twr" : "profitHuf";

  return (
    <div className="h-60 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={(m) => monthLabel(String(m))}
            tick={{ fill: CHART.axis, fontSize: 12 }}
            stroke={CHART.grid}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v) =>
              mode === "pct"
                ? formatPercent(v, 1)
                : privacy
                  ? MASK
                  : formatCompact(v)
            }
            tick={{ fill: CHART.axis, fontSize: 12 }}
            stroke={CHART.grid}
            width={56}
          />
          <ReferenceLine y={0} stroke={CHART.cursor} strokeWidth={1} />
          <Tooltip
            cursor={{ fill: CHART.grid, opacity: 0.5 }}
            content={
              <ChartTooltip privacy={privacy} benchmarkLabel={benchmarkLabel} />
            }
          />
          <Bar
            dataKey={key}
            radius={[3, 3, 3, 3]}
            maxBarSize={36}
            isAnimationActive={!reduce}
            animationDuration={700}
          >
            {data.map((m) => (
              <Cell
                key={m.month}
                fill={m[key] >= 0 ? CHART.positive : CHART.negative}
                fillOpacity={m.current ? 0.45 : 0.9}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
