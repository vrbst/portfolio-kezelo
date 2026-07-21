import { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceDot,
} from "recharts";
import { formatMoney } from "../lib/format";

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;

type Range = "1M" | "3M" | "6M" | "1Y" | "5Y";
const RANGE_DAYS: Record<Range, number> = {
  "1M": 31,
  "3M": 92,
  "6M": 183,
  "1Y": 366,
  "5Y": Infinity,
};
const RANGE_LABEL: Record<Range, string> = {
  "1M": "1H",
  "3M": "3H",
  "6M": "6H",
  "1Y": "1É",
  "5Y": "5É",
};

export interface BuyPoint {
  /** ISO date. */
  date: string;
  /** Unit price in the instrument's currency. */
  price: number;
}

function formatTick(ms: number, longSpan: boolean): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(
    "hu-HU",
    longSpan
      ? { year: "2-digit", month: "short" }
      : { month: "2-digit", day: "2-digit" },
  ).format(d);
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

/**
 * Expandable per-holding price chart. The daily close series (instrument ccy)
 * comes from the store's live-fetched history; when an EUR/HUF series is present
 * the price can be shown in HUF too (forward-filled rate at each day). Own buys
 * are marked on the line so you see where you entered.
 */
export default function HoldingPriceChart({
  series,
  currency,
  fxSeries,
  buys,
}: {
  series: [string, number][];
  currency: string;
  /** EUR/HUF daily series ([date, HUF per 1 EUR]); enables the HUF toggle. */
  fxSeries?: [string, number][];
  buys: BuyPoint[];
}) {
  const [range, setRange] = useState<Range>("1Y");
  // HUF conversion only works when the price is in EUR and we have the EUR/HUF
  // history; otherwise we can only show the instrument currency.
  const canHuf = currency === "EUR" && !!fxSeries?.length;
  const [inHuf, setInHuf] = useState(false);
  const showHuf = canHuf && inHuf;
  const displayCcy = showHuf ? "HUF" : currency;

  // Forward-fill EUR/HUF: rate on the latest fx day on or before a given day.
  const fxAt = useMemo(() => {
    const sorted = (fxSeries ?? [])
      .slice()
      .sort((a, b) => a[0].localeCompare(b[0]));
    return (day: string): number | undefined => {
      let rate: number | undefined;
      for (const [d, r] of sorted) {
        if (d > day) break;
        rate = r;
      }
      return rate;
    };
  }, [fxSeries]);

  const cutoff = useMemo(() => {
    const days = RANGE_DAYS[range];
    if (!Number.isFinite(days)) return "";
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }, [range]);

  const chartData = useMemo(() => {
    return series
      .filter(([date]) => date >= cutoff)
      .map(([date, close]) => {
        const rate = showHuf ? fxAt(date) : 1;
        const value = rate != null ? close * rate : null;
        return { ts: new Date(date).getTime(), value, date };
      })
      .filter((p) => p.value != null);
  }, [series, cutoff, showHuf, fxAt]);

  const buyDots = useMemo(() => {
    const times = chartData.map((d) => d.ts);
    if (times.length === 0) return [];
    // Snap each buy to the nearest charted trading day so its X always lands
    // inside the axis domain (a weekend/edge buy would otherwise be clipped).
    const snap = (ts: number) => {
      let best = times[0];
      let bestDiff = Math.abs(times[0] - ts);
      for (const t of times) {
        const diff = Math.abs(t - ts);
        if (diff < bestDiff) {
          best = t;
          bestDiff = diff;
        }
      }
      return best;
    };
    return buys
      .filter((b) => b.date.slice(0, 10) >= cutoff)
      .map((b) => {
        const rate = showHuf ? fxAt(b.date.slice(0, 10)) : 1;
        const value = rate != null ? b.price * rate : null;
        return value != null
          ? { ts: snap(new Date(b.date.slice(0, 10)).getTime()), value }
          : null;
      })
      .filter((b): b is { ts: number; value: number } => b != null);
  }, [buys, cutoff, showHuf, fxAt, chartData]);

  if (chartData.length < 2) {
    return (
      <div className="py-6 text-center text-xs text-[var(--color-muted)]">
        Nincs elég historikus adat a grafikonhoz ezen az időtávon.
      </div>
    );
  }

  const min = chartData[0].ts;
  const max = chartData[chartData.length - 1].ts;
  const longSpan = RANGE_DAYS[range] > 200;

  // Y domain must cover the buy prices too, otherwise a dot above/below the
  // visible price band gets clipped even with ifOverflow.
  const yValues = [
    ...chartData.map((d) => d.value as number),
    ...buyDots.map((b) => b.value),
  ];
  const yLo = Math.min(...yValues);
  const yHi = Math.max(...yValues);
  const yPad = (yHi - yLo) * 0.06 || Math.abs(yHi) * 0.02 || 1;
  const yDomain: [number, number] = [yLo - yPad, yHi + yPad];

  const btn = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium transition ${
      active
        ? "bg-[var(--color-brand)] text-white"
        : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
    }`;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
            <button
              key={r}
              className={btn(range === r)}
              onClick={() => setRange(r)}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        {canHuf && (
          <div className="flex gap-1">
            <button className={btn(!inHuf)} onClick={() => setInHuf(false)}>
              {currency}
            </button>
            <button className={btn(inHuf)} onClick={() => setInHuf(true)}>
              HUF
            </button>
          </div>
        )}
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
          >
            <defs>
              <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#232b45" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={[min, max]}
              tickFormatter={(v) => formatTick(Number(v), longSpan)}
              tick={{ fill: "#8b93a7", fontSize: 12 }}
              stroke="#232b45"
              minTickGap={40}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(v) =>
                formatMoney(Number(v), displayCcy, {
                  decimals: displayCcy === "HUF" ? 0 : 2,
                })
              }
              tick={{ fill: "#8b93a7", fontSize: 12 }}
              stroke="#232b45"
              width={64}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(l) => formatDay(Number(l))}
              formatter={(v) => [
                formatMoney(Number(v), displayCcy, {
                  decimals: displayCcy === "HUF" ? 0 : 2,
                }),
                "Árfolyam",
              ]}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#6366f1"
              strokeWidth={2}
              fill="url(#priceFill)"
              dot={false}
              name="value"
              isAnimationActive={false}
            />
            {buyDots.map((b, i) => (
              <ReferenceDot
                key={i}
                x={b.ts}
                y={b.value}
                r={4}
                fill="#fbbf24"
                stroke="#141a2e"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {buyDots.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
          Saját vételeid
        </div>
      )}
    </div>
  );
}
