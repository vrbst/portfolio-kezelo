import { useReducedMotion } from "motion/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { monthLabel, type CashflowTotals } from "../lib/cashflow";
import { formatCompact, formatMoney } from "../lib/format";
import { usePortfolio } from "../lib/store";
import { CHART } from "../lib/skin";

const MASK = "•••";

function Tip({
  active,
  payload,
  privacy,
}: {
  active?: boolean;
  payload?: { payload?: CashflowTotals }[];
  privacy: boolean;
}) {
  const m = active ? payload?.[0]?.payload : undefined;
  if (!m) return null;
  const show = (v: number) => (privacy ? MASK : formatMoney(v));
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm shadow-xl">
      <div className="mb-1 text-xs text-[var(--color-muted)]">
        {monthLabel(m.month, true)}
        {!m.complete && " (eddig)"}
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--color-muted)]">Bevétel</span>
        <span className="tabular-nums">{show(m.income)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[var(--color-muted)]">Kiadás</span>
        <span className="tabular-nums">{show(m.expense)}</span>
      </div>
      <div className="flex justify-between gap-4 font-medium">
        <span className="text-[var(--color-muted)]">Megtakarítás</span>
        <span className="tabular-nums">{show(m.saving)}</span>
      </div>
    </div>
  );
}

/**
 * Income and spending per month, side by side. The month still running (the
 * export doesn't reach its end) is drawn faded. Privacy mode masks the axis and
 * the tooltip amounts (SVG text doesn't reliably take the CSS blur).
 */
export default function CashflowChart({ data }: { data: CashflowTotals[] }) {
  const privacy = usePortfolio((s) => s.privacy);
  const reduce = useReducedMotion();
  const tick = { fill: CHART.axis, fontSize: 12 };
  return (
    <div role="img" aria-label="Havi bevétel és kiadás" style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={(m) => monthLabel(String(m))}
            tick={tick}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v) => (privacy ? MASK : formatCompact(Number(v)))}
            tick={tick}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip
            cursor={{ fill: CHART.cursor, opacity: 0.25 }}
            content={<Tip privacy={privacy} />}
          />
          <Bar dataKey="income" fill={CHART.positive} radius={[3, 3, 0, 0]} isAnimationActive={!reduce} />
          <Bar dataKey="expense" fill={CHART.negative} radius={[3, 3, 0, 0]} isAnimationActive={!reduce} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
