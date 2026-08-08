import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import type { ScenarioProjection } from "../lib/bigDecision";
import { formatMoney, formatCompact } from "../lib/format";
import { usePortfolio } from "../lib/store";

const MASK = "•••";

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;

/** Forgatókönyv-színek (a baseline mindig szürke, szaggatott). */
export const SCENARIO_COLORS = [
  "#6366f1",
  "#34d399",
  "#22d3ee",
  "#fbbf24",
  "#fb7185",
  "#8b5cf6",
];
export const BASELINE_COLOR = "#8a93b2";

function formatYear(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "short",
  }).format(d);
}

function yearTicks(points: { ts: number }[], maxLabels = 8): number[] {
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
 * A forgatókönyvek jövőérték-görbéi egy közös grafikonon: a baseline szaggatott
 * szürke, minden forgatókönyv egy-egy színes vonal.
 */
export default function BigDecisionChart({
  baseline,
  scenarios,
}: {
  baseline: ScenarioProjection;
  scenarios: ScenarioProjection[];
}) {
  const privacy = usePortfolio((s) => s.privacy);

  const { data, series } = useMemo(() => {
    const all = [baseline, ...scenarios];
    const series = all.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: p.isBaseline ? BASELINE_COLOR : SCENARIO_COLORS[(i - 1) % SCENARIO_COLORS.length],
      dashed: p.isBaseline,
    }));
    const len = baseline.points.length;
    const data = Array.from({ length: len }, (_, i) => {
      const row: Record<string, number> = { ts: baseline.points[i]?.ts ?? 0 };
      for (const p of all) row[p.id] = p.points[i]?.value ?? 0;
      return row;
    });
    return { data, series };
  }, [baseline, scenarios]);

  const min = data[0]?.ts ?? 0;
  const max = data[data.length - 1]?.ts ?? 0;
  const ticks = yearTicks(baseline.points);
  const nameById = new Map(series.map((s) => [s.id, s.name]));

  return (
    <div className="h-96 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
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
            formatter={(v, name) => [
              privacy ? MASK : formatMoney(Number(v)),
              nameById.get(String(name)) ?? String(name),
            ]}
          />
          <Legend
            formatter={(name) => nameById.get(String(name)) ?? String(name)}
            wrapperStyle={{ fontSize: 12 }}
          />
          {series.map((s) => (
            <Line
              key={s.id}
              type="monotone"
              dataKey={s.id}
              name={s.id}
              stroke={s.color}
              strokeWidth={s.dashed ? 1.75 : 2.5}
              strokeDasharray={s.dashed ? "5 5" : undefined}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
