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
  ReferenceLine,
  ReferenceDot,
} from "recharts";
import {
  EVENT_COLORS,
  type ForecastEvent,
  type ForecastPoint,
} from "../lib/forecast";
import { formatMoney, formatCompact } from "../lib/format";
import { usePortfolio } from "../lib/store";

const MASK = "•••";

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;

type Band3 = { pess: number; real: number; opt: number };

/** A past month-end value (already converted to the shown forint). */
export interface HistoryPoint {
  ts: number;
  actual: number;
  /** Backtest value on the same day, if the backtest covers it. */
  bt?: Band3;
}

/** An earlier saved forecast's path from its month up to now. */
export interface PastForecast {
  label: string;
  points: { ts: number; value: number }[];
}

const BT_COLOR = "#a5b4fc";
const SNAP_COLOR = "#fbbf24";

function formatYear(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "short",
  }).format(d);
}

/** Year-start timestamps across the series, thinned to at most `maxLabels`. */
function yearTicks(tss: number[], maxLabels = 8): number[] {
  const ticks: number[] = [];
  let lastYear = -1;
  for (const ts of tss) {
    const y = new Date(ts).getFullYear();
    if (y !== lastYear) {
      ticks.push(ts);
      lastYear = y;
    }
  }
  const step = Math.max(1, Math.ceil(ticks.length / maxLabels));
  return ticks.filter((_, i) => i % step === 0);
}

interface Row {
  ts: number;
  actual?: number;
  real?: number;
  contributed?: number;
  band?: [number, number];
  events?: ForecastEvent[];
  btReal?: number;
  btBand?: [number, number];
  /** Saved-forecast values by line index ("snap0", "snap1", …). */
  [snap: `snap${number}`]: number | undefined;
}

/**
 * Projection fan: a shaded band between the pessimistic and optimistic
 * scenarios, the realistic path as a solid line, and the contributed-capital
 * baseline dashed. The actual past values lead into "ma", and dated events
 * (maturities, expenses, goals, withdrawal start) sit as dots on the path.
 * With `showPast`, the past also carries a backtest (dashed line + faint
 * band) and the earlier saved forecasts (thin amber lines).
 * Privacy mode masks the amounts like the value chart.
 */
export default function ForecastChart({
  points,
  centerLabel = "Reális",
  history = [],
  events = [],
  backtestNow,
  pastForecasts = [],
  showPast = false,
}: {
  points: ForecastPoint[];
  /** Tooltip label of the highlighted middle line (det: Reális, MC: Medián). */
  centerLabel?: string;
  history?: HistoryPoint[];
  events?: ForecastEvent[];
  /** Backtest value at the forecast start ("ma"), where its line ends. */
  backtestNow?: Band3;
  pastForecasts?: PastForecast[];
  showPast?: boolean;
}) {
  const privacy = usePortfolio((s) => s.privacy);
  const fmt = (v: number) => (privacy ? MASK : formatMoney(v));

  const { data, dots } = useMemo(() => {
    const byMonth = new Map<string, ForecastEvent[]>();
    for (const e of events) {
      const arr = byMonth.get(e.month) ?? [];
      arr.push(e);
      byMonth.set(e.month, arr);
    }
    // Rows keyed by timestamp: past samples, saved-forecast points and the
    // forecast months can share a day and must merge into one row.
    const byTs = new Map<number, Row>();
    const row = (ts: number) => {
      let r = byTs.get(ts);
      if (!r) byTs.set(ts, (r = { ts }));
      return r;
    };
    const withBt = (r: Row, b: Band3 | undefined) => {
      if (!showPast || !b) return;
      r.btReal = b.real;
      r.btBand = [b.pess, b.opt];
    };
    for (const h of history) {
      const r = row(h.ts);
      r.actual = h.actual;
      withBt(r, h.bt);
    }
    if (showPast)
      pastForecasts.forEach((pf, k) => {
        for (const p of pf.points) row(p.ts)[`snap${k}`] = p.value;
      });
    const dots: { ts: number; y: number; color: string }[] = [];
    points.forEach((p, i) => {
      const evs = byMonth.get(p.month);
      const r = row(p.ts);
      r.real = p.real;
      r.contributed = p.contributed;
      r.band = [p.pess, p.opt];
      r.events = evs;
      if (i === 0 && history.length) {
        // Join the past lines to the forecast start.
        r.actual = p.real;
        withBt(r, backtestNow);
      }
      if (evs)
        dots.push({ ts: p.ts, y: p.real, color: EVENT_COLORS[evs[0].kind] });
    });
    const data = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    return { data, dots };
  }, [points, history, events, backtestNow, pastForecasts, showPast]);

  const min = data[0]?.ts ?? 0;
  const max = data[data.length - 1]?.ts ?? 0;
  const now = points[0]?.ts;
  const ticks = yearTicks(data.map((d) => d.ts));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
        >
          <defs>
            <linearGradient id="fanFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#232b45" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[min, max]}
            ticks={ticks}
            tickFormatter={formatYear}
            tick={{ fill: "#8b93a7", fontSize: 12 }}
            stroke="#232b45"
          />
          <YAxis
            tickFormatter={(v) => (privacy ? MASK : formatCompact(v))}
            tick={{ fill: "#8b93a7", fontSize: 12 }}
            stroke="#232b45"
            width={52}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as Row | undefined;
              if (!active || !row) return null;
              const past = row.real == null;
              return (
                <div style={tooltipStyle} className="px-3 py-2 text-xs">
                  <div className="mb-1 font-medium">{formatYear(row.ts)}</div>
                  {past && row.actual != null && (
                    <div>Tényleges érték: {fmt(row.actual)}</div>
                  )}
                  {row.btReal != null && (
                    <div style={{ color: BT_COLOR }}>
                      Visszateszt: {fmt(row.btReal)}
                      {row.btBand && (
                        <span className="text-[#8b93a7]">
                          {" "}
                          ({fmt(row.btBand[0])} – {fmt(row.btBand[1])})
                        </span>
                      )}
                    </div>
                  )}
                  {showPast &&
                    pastForecasts.map((pf, k) => {
                      const v = row[`snap${k}`];
                      return v == null ? null : (
                        <div key={k} style={{ color: SNAP_COLOR }}>
                          {pf.label}: {fmt(v)}
                        </div>
                      );
                    })}
                  {!past && (
                    <>
                      <div className="font-semibold text-[#a5b4fc]">
                        {centerLabel}: {fmt(row.real!)}
                      </div>
                      {row.band && (
                        <div className="text-[#8b93a7]">
                          Sáv: {fmt(row.band[0])} – {fmt(row.band[1])}
                        </div>
                      )}
                      {row.contributed != null && (
                        <div className="text-[#8b93a7]">
                          Befektetett tőke: {fmt(row.contributed)}
                        </div>
                      )}
                    </>
                  )}
                  {row.events?.map((e, i) => (
                    <div
                      key={i}
                      className="mt-1 flex items-center gap-1.5"
                      style={{ color: EVENT_COLORS[e.kind] }}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: EVENT_COLORS[e.kind] }}
                      />
                      <span className="priv">{e.label}</span>
                      <span>
                        {e.kind === "withdrawal"
                          ? `${fmt(e.huf)}/hó`
                          : fmt(e.huf)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="band"
            stroke="none"
            fill="url(#fanFill)"
            dot={false}
            activeDot={false}
            name="band"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="contributed"
            stroke="#8b93a7"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            name="contributed"
          />
          {showPast && (
            <Area
              type="monotone"
              dataKey="btBand"
              stroke="none"
              fill={BT_COLOR}
              fillOpacity={0.12}
              connectNulls
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
          {showPast && (
            <Line
              type="monotone"
              dataKey="btReal"
              stroke={BT_COLOR}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              connectNulls
              dot={false}
              isAnimationActive={false}
            />
          )}
          {showPast &&
            pastForecasts.map((_, k) => (
              <Line
                key={k}
                type="monotone"
                dataKey={`snap${k}`}
                stroke={SNAP_COLOR}
                // Older forecasts fade out, the latest is the most visible.
                strokeOpacity={0.35 + (0.55 * (k + 1)) / pastForecasts.length}
                strokeWidth={1.25}
                connectNulls
                dot={false}
                isAnimationActive={false}
              />
            ))}
          <Line
            type="monotone"
            dataKey="actual"
            connectNulls
            stroke="#e8ecf8"
            strokeOpacity={0.7}
            strokeWidth={1.5}
            dot={false}
            name="actual"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="real"
            stroke="#6366f1"
            strokeWidth={2.5}
            dot={false}
            name="real"
          />
          {history.length > 0 && now != null && (
            <ReferenceLine
              x={now}
              stroke="#8b93a7"
              strokeDasharray="2 4"
              label={{
                value: "ma",
                position: "insideTopLeft",
                fill: "#8b93a7",
                fontSize: 11,
              }}
            />
          )}
          {dots.map((d) => (
            <ReferenceDot
              key={d.ts}
              x={d.ts}
              y={d.y}
              r={4}
              fill={d.color}
              stroke="#141a2e"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
