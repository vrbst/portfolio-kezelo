import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import type { LiveQuote } from "../lib/prices";
import { formatPercent } from "../lib/format";

const BAR_MS = 5 * 60_000;

interface Row {
  /** Sequential slot: yesterday's bars, then today's session (padded). */
  i: number;
  t: number;
  prev?: number;
  today?: number;
}

const hhmm = (t: number) =>
  new Intl.DateTimeFormat("hu-HU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(t);
const dayLabel = (t: number) =>
  new Intl.DateTimeFormat("hu-HU", { month: "short", day: "numeric" }).format(t);
const dayTime = (t: number) =>
  new Intl.DateTimeFormat("hu-HU", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(t);

/**
 * Enlarged two-session chart for a live price tile: the previous session on
 * the left, today's session on the right (padded to its full length, so the
 * time axis shows how far into the day we are), the previous close as a
 * dashed line and a divider between the days. Esc, the backdrop or the close
 * button dismiss it.
 */
export default function PriceChartDialog({
  title,
  value,
  sub,
  quote,
  decimals = 2,
  onClose,
}: {
  title: string;
  /** Formatted current price, as on the tile. */
  value: string;
  sub?: string;
  quote: LiveQuote;
  decimals?: number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
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

  // A borrowed curve (WBIT → BTC-EUR) is in the proxy's own price scale, so
  // its previous close is its own last bar of the prior day.
  const prevClose = quote.intradayFrom
    ? quote.prevDay?.at(-1)
    : quote.prevClose;
  const change =
    quote.prevClose != null ? quote.price / quote.prevClose - 1 : undefined;
  const up = (change ?? 0) >= 0;

  const { rows, split, ticks } = useMemo(() => {
    const rows: Row[] = [];
    const prev = quote.prevDay ?? [];
    const prevT = quote.prevDayT ?? [];
    prev.forEach((c, k) =>
      rows.push({ i: rows.length, t: prevT[k], prev: c }),
    );
    const split = rows.length;
    const today = quote.intraday ?? [];
    const todayT = quote.intradayT ?? [];
    today.forEach((c, k) =>
      rows.push({ i: rows.length, t: todayT[k], today: c }),
    );
    // Pad today to the end of its session (or to as long as yesterday was),
    // so the chart shows the part of the day that is still ahead.
    const start = todayT[0];
    const full = quote.session
      ? Math.round(
          (quote.session.end - (start ?? quote.session.start)) / BAR_MS,
        )
      : Math.max(prev.length, 1);
    for (let k = today.length; k < full && start != null; k++)
      rows.push({ i: rows.length, t: start + k * BAR_MS });
    // Ticks on round hours, thinned to ~8 labels.
    const hourly = rows.filter((r) => r.t && new Date(r.t).getMinutes() === 0);
    const step = Math.max(1, Math.ceil(hourly.length / 8));
    const ticks = hourly.filter((_, k) => k % step === 0).map((r) => r.i);
    return { rows, split, ticks };
  }, [quote]);

  const fmt = (v: number) =>
    v.toLocaleString("hu-HU", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  const color = up ? "var(--color-positive)" : "var(--color-negative)";

  // Portalled to <body>: an animated (transformed) ancestor card would
  // otherwise become the containing block of `position: fixed`.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} árfolyam-grafikon`}
        className="w-full max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-[var(--color-muted)]">
              {title}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {value}
              </span>
              {change != null && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
                    up
                      ? "bg-[var(--color-positive)]/12 text-[var(--color-positive)]"
                      : "bg-[var(--color-negative)]/12 text-[var(--color-negative)]"
                  }`}
                >
                  {formatPercent(change)}
                </span>
              )}
            </div>
            {sub && (
              <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                {sub}
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            className="btn-ghost shrink-0"
            onClick={onClose}
            aria-label="Bezárás"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={rows}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="#232b45" vertical={false} />
              <XAxis
                dataKey="i"
                type="number"
                domain={[0, Math.max(1, rows.length - 1)]}
                ticks={ticks}
                tickFormatter={(i) => (rows[i]?.t ? hhmm(rows[i].t) : "")}
                tick={{ fill: "#8b93a7", fontSize: 11 }}
                stroke="#232b45"
              />
              <YAxis
                domain={["auto", "auto"]}
                tickFormatter={(v) => fmt(Number(v))}
                tick={{ fill: "#8b93a7", fontSize: 11 }}
                stroke="#232b45"
                width={64}
              />
              <Tooltip
                content={({ active, payload }) => {
                  const r = payload?.[0]?.payload as Row | undefined;
                  const v = r?.today ?? r?.prev;
                  if (!active || !r || v == null) return null;
                  return (
                    <div className="rounded-xl border border-[#232b45] bg-[#141a2e] px-3 py-2 text-xs text-[#e8ecf8] shadow-xl">
                      <div className="mb-1 font-medium">{dayTime(r.t)}</div>
                      <div className="tabular-nums">{fmt(v)}</div>
                      {prevClose != null && r.today != null && (
                        <div className="text-[#8b93a7] tabular-nums">
                          előző záráshoz: {formatPercent(v / prevClose - 1)}
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              {split > 0 && (
                <ReferenceLine
                  x={split - 0.5}
                  stroke="#8b93a7"
                  strokeOpacity={0.5}
                  label={{
                    value: rows[split]?.t ? dayLabel(rows[split].t) : "ma",
                    position: "insideTopRight",
                    fill: "#8b93a7",
                    fontSize: 11,
                  }}
                />
              )}
              {prevClose != null && (
                <ReferenceLine
                  y={prevClose}
                  stroke="#8b93a7"
                  strokeDasharray="4 4"
                  label={{
                    value: `előző zárás ${fmt(prevClose)}`,
                    position: "insideBottomLeft",
                    fill: "#8b93a7",
                    fontSize: 11,
                  }}
                />
              )}
              <Line
                dataKey="prev"
                stroke="#8b93a7"
                strokeOpacity={0.7}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="today"
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Bal oldalt az előző kereskedési nap, jobb oldalt a mai (a még hátralévő
          része üres); szaggatott vonal: előző napi zárás.
          {quote.intradayFrom &&
            ` A görbe a(z) ${quote.intradayFrom} árfolyamát mutatja (ennek a jegyzésnek nincs napközbeni adata).`}
        </p>
      </div>
    </div>,
    document.body,
  );
}
