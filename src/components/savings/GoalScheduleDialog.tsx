import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, Coins, Flag, CalendarCheck, PiggyBank, Wallet, X } from "lucide-react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
} from "recharts";
import InfoTip from "../InfoTip";
import { usePortfolio, usePortfolioSummary, useToday, useValuedInstruments } from "../../lib/store";
import type { CouponOption, SavingsGoal, SavingsProgress } from "../../lib/savings";
import {
  goalHistory,
  goalSchedule,
  type ScheduleKind,
  type ScheduleRow,
} from "../../lib/savingsSchedule";
import { CHART } from "../../lib/skin";
import { formatCompact, formatDate, formatMoney } from "../../lib/format";

const MASK = "•••";

const KIND: Record<ScheduleKind, { label: string; icon: typeof Coins; color: string }> = {
  saving: { label: "Félretétel", icon: PiggyBank, color: CHART.brand },
  coupon: { label: "Kupon", icon: Coins, color: CHART.highlight },
  reserve: { label: "Készpénz", icon: Wallet, color: CHART.alt },
  maturity: { label: "Lejárat", icon: CalendarCheck, color: CHART.positive },
  target: { label: "Cél", icon: Flag, color: CHART.text },
};

const dayTs = (day: string) => Date.parse(`${day}T12:00:00`);
const axisLabel = (ts: number) =>
  new Intl.DateTimeFormat("hu-HU", { year: "2-digit", month: "short" }).format(ts);

interface ChartRow {
  ts: number;
  day: string;
  actual?: number;
  expected?: number;
  ideal?: number;
}

const tooltipStyle = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 12,
  color: "var(--color-text)",
} as const;

/**
 * A goal's timeline in a popup: the value from the start day to the target
 * date (what it held so far, what is expected, the straight line to the
 * target) with the planned events marked, and below it the planned amounts
 * with their dates. Esc, the backdrop or the close button dismiss it.
 */
export default function GoalScheduleDialog({
  progress: p,
  planHuf,
  goals,
  coupons,
  onClose,
}: {
  progress: SavingsProgress;
  /** This month's remaining quota (savingsMonthStates). */
  planHuf: number;
  goals: SavingsGoal[];
  coupons: CouponOption[];
  onClose: () => void;
}) {
  const g = p.goal;
  const closeRef = useRef<HTMLButtonElement>(null);
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const privacy = usePortfolio((s) => s.privacy);
  const instruments = useValuedInstruments();
  const today = useToday();

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus();
    };
  }, [onClose]);

  const map = useMemo(() => new Map(instruments.map((i) => [i.key, i])), [instruments]);
  const schedule = useMemo(
    () => goalSchedule(p, goals, coupons, summary, map, planHuf),
    [p, goals, coupons, summary, map, planHuf],
  );
  // Replays the goal at every month end — costly, so only with the dialog open.
  const history = useMemo(
    () => goalHistory(g, accounts, transactions, map, prices, fx),
    [g, accounts, transactions, map, prices, fx],
  );

  const { rows, ymax, endValue } = useMemo(() => {
    const byDay = new Map<string, ChartRow>();
    const at = (day: string) => {
      let r = byDay.get(day);
      if (!r) byDay.set(day, (r = { ts: dayTs(day), day }));
      return r;
    };
    for (const h of history) at(h.day).actual = h.valueHuf;
    for (const pt of schedule.path) at(pt.day).expected = pt.valueHuf;
    // The straight line from where the goal started to the target.
    const startValue = history[0]?.valueHuf ?? 0;
    at(schedule.startDay).ideal = startValue;
    at(schedule.endDay).ideal = g.targetHuf;
    at(today);
    const sorted = [...byDay.values()].sort((a, b) => a.ts - b.ts);
    const end = schedule.path.at(-1)?.valueHuf ?? p.projectedHuf;
    const top = Math.max(g.targetHuf, end, ...history.map((h) => h.valueHuf));
    return { rows: sorted, ymax: Math.ceil((top * 1.08) / 1000) * 1000, endValue: end };
  }, [history, schedule, g.targetHuf, p.projectedHuf, today]);

  const fmt = (v: number) => (privacy ? MASK : formatMoney(v));
  // Beyond the target on its date (only a covered goal has no planned savings
  // to fill the gap, so only then does the expected value pass the target).
  const over = p.reached ? Math.max(0, endValue - g.targetHuf) : 0;
  const events = schedule.rows.filter((r) => !r.done && r.kind !== "target");

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Ütemterv – ${g.name}`}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="priv truncate text-lg font-semibold">{g.name}</h2>
            <div className="text-xs text-[var(--color-muted)]">
              {formatDate(schedule.startDay)} → {formatDate(schedule.endDay)} · cél{" "}
              <span className="amt">{formatMoney(g.targetHuf)}</span>
            </div>
          </div>
          <button ref={closeRef} className="btn-ghost" onClick={onClose} aria-label="Bezárás">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto">
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
            <Stat label="Most a célra" value={fmt(p.assignedValueHuf)} />
            <Stat label="Céldátumra várható" value={fmt(p.projectedHuf)} />
            {p.reached ? (
              <Stat label="Többlet" value={over > 1 ? `+${fmt(over)}` : fmt(0)} tone="positive" />
            ) : (
              <Stat label="Hiány" value={fmt(p.gapHuf)} tone="warning" />
            )}
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={[dayTs(schedule.startDay), dayTs(schedule.endDay)]}
                  tickFormatter={axisLabel}
                  tick={{ fill: CHART.axis, fontSize: 12 }}
                  stroke={CHART.grid}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, ymax]}
                  tickFormatter={(v) => (privacy ? MASK : formatCompact(v))}
                  tick={{ fill: CHART.axis, fontSize: 12 }}
                  stroke={CHART.grid}
                  width={56}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    const row = payload?.[0]?.payload as ChartRow | undefined;
                    if (!active || !row) return null;
                    const todays = schedule.rows.filter((r) => r.day === row.day);
                    return (
                      <div style={tooltipStyle} className="px-3 py-2 text-xs">
                        <div className="mb-1 font-medium">{formatDate(row.day)}</div>
                        {row.actual != null && <div>Eddig: {fmt(row.actual)}</div>}
                        {row.expected != null && <div>Várható: {fmt(row.expected)}</div>}
                        {todays.map((r, i) => (
                          <div key={i} style={{ color: KIND[r.kind].color }}>
                            {r.label}: {fmt(r.huf)}
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                {endValue > g.targetHuf + 1 && (
                  <ReferenceArea
                    y1={g.targetHuf}
                    y2={endValue}
                    x1={dayTs(schedule.startDay)}
                    x2={dayTs(schedule.endDay)}
                    fill={CHART.positive}
                    fillOpacity={0.12}
                    ifOverflow="extendDomain"
                  />
                )}
                <ReferenceLine
                  y={g.targetHuf}
                  stroke={CHART.highlight}
                  strokeWidth={1.5}
                  label={{ value: "cél", position: "insideTopLeft", fill: CHART.highlight, fontSize: 11 }}
                />
                <ReferenceLine
                  x={dayTs(today)}
                  stroke={CHART.axis}
                  strokeDasharray="3 3"
                  label={{ value: "ma", position: "insideTopRight", fill: CHART.axis, fontSize: 11 }}
                />
                <Line
                  dataKey="ideal"
                  stroke={CHART.text}
                  strokeOpacity={0.45}
                  strokeDasharray="1 4"
                  strokeLinecap="round"
                  dot={false}
                  strokeWidth={1.5}
                  connectNulls
                  isAnimationActive={false}
                />
                <Area
                  dataKey="actual"
                  type="monotone"
                  stroke={CHART.brand}
                  fill={CHART.brand}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  dataKey="expected"
                  type="stepAfter"
                  stroke={CHART.brand}
                  strokeDasharray="6 4"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                {events.map((r, i) => (
                  <ReferenceDot
                    key={i}
                    x={dayTs(r.day)}
                    y={r.cumulativeHuf}
                    r={r.kind === "saving" ? 3.5 : 4.5}
                    fill={KIND[r.kind].color}
                    stroke={CHART.surface}
                    strokeWidth={1.5}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
            <Legend color={CHART.brand} label="eddigi érték" />
            <Legend color={CHART.brand} label="várható" dash />
            <Legend color={CHART.text} label="egyenes út a célig" dash opacity={0.5} />
            {(Object.keys(KIND) as ScheduleKind[])
              .filter((k) => k !== "target" && events.some((r) => r.kind === k))
              .map((k) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND[k].color }} />
                  {KIND[k].label.toLowerCase()}
                </span>
              ))}
            <InfoTip>
              Az „eddigi érték” a célhoz rendelt eszközök, a jóváírt kuponok és a
              félretett készpénz hónap végi értéke a mai árfolyamokkal. A
              várható görbe a tervezett félretételekkel, kuponokkal és még nem
              számító készpénzzel lépcsőzik a céldátumig.
            </InfoTip>
          </div>

          <h3 className="mb-1 mt-4 text-sm font-semibold">Tervezett összegek</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--color-muted)]">
                  <th className="py-1 pr-2 font-normal">Dátum</th>
                  <th className="py-1 pr-2 font-normal">Tétel</th>
                  <th className="py-1 pr-2 text-right font-normal">Összeg</th>
                  <th className="py-1 text-right font-normal">Várható összesen</th>
                </tr>
              </thead>
              <tbody>
                {schedule.rows.map((r, i) => (
                  <Row key={i} r={r} today={today} privacy={privacy} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {p.reached ? (
              <span className="text-[var(--color-positive)]">
                A céldátumra várhatóan {fmt(endValue)} gyűlik össze
                {over > 1 ? `, ez ${fmt(over)} többlet a célhoz képest` : ""}.
                {p.surplusHuf > 1 &&
                  ` Ebből ${fmt(p.surplusHuf)} a hozzárendelt eszközökből és kijelölt kuponokból jön: a céldátum után szabad pénz.`}
                {p.unneededCouponsHuf > 1 &&
                  ` A „minden kupon” beállítás miatt ${fmt(p.unneededCouponsHuf)} már nem kell a célhoz.`}
              </span>
            ) : (
              <>A céldátumra a terv szerint {fmt(endValue)} gyűlik össze.</>
            )}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ r, today, privacy }: { r: ScheduleRow; today: string; privacy: boolean }) {
  const k = KIND[r.kind];
  const Icon = k.icon;
  const soon = !r.done && r.kind === "saving" && r.day <= today;
  return (
    <tr
      className={`border-t border-[var(--color-border)]/50 ${r.done ? "opacity-55" : ""} ${
        soon ? "bg-[var(--color-brand)]/10" : ""
      }`}
    >
      <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums text-[var(--color-muted)]">
        {formatDate(r.day)}
      </td>
      <td className="py-1.5 pr-2">
        <span className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: k.color }} />
          <span className="priv">{r.label}</span>
          {r.done && r.kind !== "target" && <Check className="h-3.5 w-3.5 text-[var(--color-positive)]" />}
        </span>
      </td>
      <td className="amt whitespace-nowrap py-1.5 pr-2 text-right tabular-nums">
        {privacy ? MASK : `${r.adds && !r.done ? "+" : ""}${formatMoney(r.huf)}`}
        {r.kind === "maturity" && !privacy && (
          <span className="text-xs text-[var(--color-muted)]"> (névérték)</span>
        )}
      </td>
      <td className="amt whitespace-nowrap py-1.5 text-right tabular-nums text-[var(--color-muted)]">
        {privacy ? MASK : formatMoney(r.cumulativeHuf)}
      </td>
    </tr>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "warning";
}) {
  const color =
    tone === "positive"
      ? "text-[var(--color-positive)]"
      : tone === "warning"
        ? "text-[var(--color-warning,#fbbf24)]"
        : "";
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-2">
      <div className="text-[var(--color-muted)]">{label}</div>
      <div className={`amt mt-0.5 text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Legend({
  color,
  label,
  dash,
  opacity = 1,
}: {
  color: string;
  label: string;
  dash?: boolean;
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
          strokeDasharray={dash ? "4 3" : undefined}
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}
