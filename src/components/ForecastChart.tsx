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
import type { ForecastPoint } from "../lib/forecast";
import { formatMoney, formatCompact } from "../lib/format";
import { usePortfolio } from "../lib/store";

const MASK = "•••";

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;

function formatYear(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "short",
  }).format(d);
}

/** Year-start timestamps across the series, thinned to at most `maxLabels`. */
function yearTicks(points: ForecastPoint[], maxLabels = 8): number[] {
  const ticks: number[] = [];
  let lastYear = -1;
  for (const p of points) {
    const y = new Date(p.ts).getFullYear();
    if (y !== lastYear) {
      ticks.push(p.ts);
      lastYear = y;
    }
  }
  const step = Math.max(1, Math.ceil(ticks.length / maxLabels));
  return ticks.filter((_, i) => i % step === 0);
}

/**
 * Projection fan: a shaded band between the pessimistic and optimistic
 * scenarios, the realistic path as a solid line, and the contributed-capital
 * baseline dashed. Privacy mode masks the amounts like the value chart.
 */
export default function ForecastChart({ points }: { points: ForecastPoint[] }) {
  const privacy = usePortfolio((s) => s.privacy);
  const data = points.map((p) => ({
    ...p,
    band: [p.pess, p.opt] as [number, number],
  }));
  const min = data[0]?.ts ?? 0;
  const max = data[data.length - 1]?.ts ?? 0;
  const ticks = yearTicks(points);

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
            labelFormatter={(l) => formatYear(Number(l))}
            formatter={(v, name) => {
              if (name === "band")
                return [null, null] as unknown as [string, string];
              const label =
                name === "real"
                  ? "Reális"
                  : name === "contributed"
                    ? "Befektetett tőke"
                    : name;
              return [privacy ? MASK : formatMoney(Number(v)), label];
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
          <Line
            type="monotone"
            dataKey="real"
            stroke="#6366f1"
            strokeWidth={2.5}
            dot={false}
            name="real"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
