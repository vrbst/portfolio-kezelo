import { useMemo } from "react";
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import type { RebuildRow } from "../lib/bigDecision";
import { formatMoney, formatCompact } from "../lib/format";
import { usePortfolio } from "../lib/store";

const MASK = "•••";

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;

function formatYm(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "short",
  }).format(d);
}

function yearTicks(rows: { ts: number }[], maxLabels = 8): number[] {
  const ticks: number[] = [];
  let lastYear = -1;
  for (const r of rows) {
    const y = new Date(r.ts).getFullYear();
    if (y !== lastYear) {
      ticks.push(r.ts);
      lastYear = y;
    }
  }
  const step = Math.max(1, Math.ceil(ticks.length / maxLabels));
  return ticks.filter((_, i) => i % step === 0);
}

const NAMES: Record<string, string> = {
  switchTotal: "Váltás (autócsere)",
  baseTotal: "Maradok",
  diff: "Különbség",
};

/**
 * FixMÁP-állomány a lízing lejáratáig: VÁLTÁS vs ALAP (maradok), a 40M-es cél
 * vonalával; alul a KÜLÖNBSÉG (alap − váltás) halvány sávban.
 */
export default function BigDecisionChart({
  rows,
  target,
  reach40Ts,
}: {
  rows: RebuildRow[];
  /** A visszaépítési cél (kiinduló FixMÁP-állomány), pl. 40M. */
  target: number;
  reach40Ts: number | null;
}) {
  const privacy = usePortfolio((s) => s.privacy);
  const data = useMemo(() => rows, [rows]);
  const min = data[0]?.ts ?? 0;
  const max = data[data.length - 1]?.ts ?? 0;
  const ticks = yearTicks(rows);

  return (
    <div className="h-96 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="diffFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fb7185" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#fb7185" stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#232b45" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[min, max]}
            ticks={ticks}
            tickFormatter={formatYm}
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
            labelFormatter={(l) => formatYm(Number(l))}
            formatter={(v, name) => {
              if (name === "diff") return [null, null] as unknown as [string, string];
              return [
                privacy ? MASK : formatMoney(Number(v)),
                NAMES[String(name)] ?? String(name),
              ];
            }}
          />
          <Legend
            formatter={(name) => NAMES[String(name)] ?? String(name)}
            wrapperStyle={{ fontSize: 12 }}
          />
          <ReferenceLine
            y={target}
            stroke="#34d399"
            strokeDasharray="4 4"
            label={{
              value: `Cél: ${formatCompact(target)}`,
              position: "insideTopRight",
              fill: "#34d399",
              fontSize: 11,
            }}
          />
          {reach40Ts != null && (
            <ReferenceLine
              x={reach40Ts}
              stroke="#34d399"
              strokeOpacity={0.5}
              strokeDasharray="3 4"
            />
          )}
          <Area
            type="monotone"
            dataKey="diff"
            stroke="none"
            fill="url(#diffFill)"
            name="diff"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="baseTotal"
            stroke="#8a93b2"
            strokeWidth={1.75}
            strokeDasharray="5 5"
            dot={false}
            name="baseTotal"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="switchTotal"
            stroke="#6366f1"
            strokeWidth={2.5}
            dot={false}
            name="switchTotal"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
