import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  BarChart,
  Bar,
  Cell,
  LabelList,
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

/** Bar label: "+254 E" / "−12,5 E" (3 significant digits) or "+2,7%". */
function labelText(mode: MonthlyMode, v: number): string {
  if (mode === "pct") return formatPercent(v, 1);
  if (Math.abs(v) < 1000)
    return formatMoney(Math.round(v), "HUF", { sign: true });
  return new Intl.NumberFormat("hu-HU", {
    notation: "compact",
    maximumSignificantDigits: 3,
    signDisplay: "exceptZero",
  }).format(v);
}

/** Width of the wrapper, so the layout can follow the card, not the window. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Gridline ticks inside [lo, hi] on round 1/2/2.5/5 × 10ⁿ steps (about
 * `steps` of them). The domain stays exactly [lo, hi] — rounding it outward
 * would squash the bars.
 */
function niceAxis(
  lo: number,
  hi: number,
  steps: number,
): { domain: [number, number]; ticks: number[] } {
  const raw = (hi - lo) / steps || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step =
    [1, 2, 2.5, 5, 10].map((n) => n * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9 * step; k++)
    ticks.push(k * step || 0); // no "−0"
  return { domain: [lo, hi], ticks };
}

/** Columns at least this wide get an upright label; narrower ones a rotated. */
const LABEL_COLUMN_PX = 44;
/** Below this the columns get too thin: one row per month instead. */
const MIN_COLUMN_PX = 18;
const AXIS_PX = 56;
const ROW_PX = 24;

type Layout = "columns" | "rotated" | "rows";

/**
 * One bar per calendar month: the month's time-weighted return (%) or its
 * market result in HUF, green above / red below zero, each labelled with its
 * value (upright, or turned 90° where the columns are narrow). The running
 * month is drawn faded. Too narrow for columns (a phone), it turns into one
 * row per month. Privacy mode masks the HUF axis and tooltip amount and drops
 * the HUF labels (SVG text doesn't reliably take the CSS blur).
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
  const [ref, width] = useWidth();
  const key = mode === "pct" ? "twr" : "profitHuf";
  const slot = (width - AXIS_PX - 16) / data.length;
  const layout: Layout =
    slot >= LABEL_COLUMN_PX
      ? "columns"
      : slot >= MIN_COLUMN_PX
        ? "rotated"
        : "rows";
  const rows = layout === "rows";
  const showLabels = !(privacy && mode === "huf");

  // Headroom past the longest bars so their labels stay inside the plot.
  const values = data.map((m) => m[key]);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const height = rows
    ? data.length * ROW_PX + 32
    : layout === "rotated"
      ? 300
      : 260;
  // Room for a label past each end, in px of the value axis → in value units:
  // labelPx out of plotPx is that share of the final range, hence the divisor.
  const labelPx = !showLabels ? 0 : layout === "columns" ? 18 : 50;
  const plotPx = rows ? width - 72 - 16 : height - 40;
  const pad =
    plotPx > 2 * labelPx ? ((hi - lo) * labelPx) / (plotPx - 2 * labelPx) : 0;
  const axis = niceAxis(
    lo < 0 ? lo - pad : 0,
    hi > 0 ? hi + pad : 0,
    rows ? 3 : 4,
  );

  const valueTick = (v: number) =>
    mode === "pct" ? formatPercent(v, 1) : privacy ? MASK : formatCompact(v);
  const monthTick = (m: string) => monthLabel(String(m));
  const tick = { fill: CHART.axis, fontSize: 12 };
  const renderLabel = (props: {
    x?: number | string;
    y?: number | string;
    width?: number | string;
    height?: number | string;
    index?: number;
  }) => {
    const m = data[props.index ?? -1];
    if (!m) return null;
    const x = Number(props.x);
    const y = Number(props.y);
    const w = Number(props.width);
    const h = Number(props.height);
    const v = m[key];
    const common = {
      fill: CHART.text,
      fontSize: 11,
      fontWeight: 500,
      opacity: m.current ? 0.6 : 0.9,
      style: { fontVariantNumeric: "tabular-nums" },
    };
    if (rows) {
      const left = Math.min(x, x + w);
      const right = Math.max(x, x + w);
      return (
        <text
          {...common}
          x={v >= 0 ? right + 4 : left - 4}
          y={y + h / 2}
          dominantBaseline="central"
          textAnchor={v >= 0 ? "start" : "end"}
        >
          {labelText(mode, v)}
        </text>
      );
    }
    const top = Math.min(y, y + h);
    const bottom = Math.max(y, y + h);
    if (layout === "rotated") {
      // Reads bottom-up, starting just past the bar's end.
      const cx = x + w / 2;
      const cy = v >= 0 ? top - 4 : bottom + 4;
      return (
        <text
          {...common}
          x={cx}
          y={cy}
          transform={`rotate(-90 ${cx} ${cy})`}
          dominantBaseline="central"
          textAnchor={v >= 0 ? "start" : "end"}
        >
          {labelText(mode, v)}
        </text>
      );
    }
    return (
      <text
        {...common}
        x={x + w / 2}
        y={v >= 0 ? top - 5 : bottom + 13}
        textAnchor="middle"
      >
        {labelText(mode, v)}
      </text>
    );
  };

  const bar = (
    <Bar
      dataKey={key}
      radius={[3, 3, 3, 3]}
      maxBarSize={rows ? 16 : 36}
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
      {showLabels && <LabelList dataKey={key} content={renderLabel} />}
    </Bar>
  );
  const tooltip = (
    <Tooltip
      cursor={{ fill: CHART.grid, opacity: 0.5 }}
      content={
        <ChartTooltip privacy={privacy} benchmarkLabel={benchmarkLabel} />
      }
    />
  );

  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <ResponsiveContainer width="100%" height="100%">
          {rows ? (
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke={CHART.grid} horizontal={false} />
              <XAxis
                type="number"
                domain={axis.domain}
                ticks={axis.ticks}
                tickFormatter={valueTick}
                tick={tick}
                stroke={CHART.grid}
              />
              <YAxis
                type="category"
                dataKey="month"
                tickFormatter={monthTick}
                tick={tick}
                stroke={CHART.grid}
                width={rows ? 72 : AXIS_PX}
                interval={0}
              />
              <ReferenceLine x={0} stroke={CHART.cursor} strokeWidth={1} />
              {tooltip}
              {bar}
            </BarChart>
          ) : (
            <BarChart
              data={data}
              margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
            >
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={monthTick}
                tick={tick}
                stroke={CHART.grid}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis
                domain={axis.domain}
                ticks={axis.ticks}
                tickFormatter={valueTick}
                tick={tick}
                stroke={CHART.grid}
                width={rows ? 72 : AXIS_PX}
              />
              <ReferenceLine y={0} stroke={CHART.cursor} strokeWidth={1} />
              {tooltip}
              {bar}
            </BarChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
