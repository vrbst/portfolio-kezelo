import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  TrendingUp,
  Coins,
  CalendarClock,
} from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import {
  buildFxHistory,
  futureBondCashflows,
  histFxRate,
  isInternalTransfer,
} from "../lib/portfolio";
import { tbszStatus } from "../lib/tbsz";
import { PageHeader, Card, Badge, AnimatedAmount } from "../components/ui";
import CashflowForecast from "../components/CashflowForecast";
import { formatMoney, formatCompact, formatDate } from "../lib/format";
import { txTypeLabel } from "../lib/labels";

const WEEKDAYS = ["H", "K", "Sz", "Cs", "P", "Sz", "V"];
const MONTHS = [
  "január",
  "február",
  "március",
  "április",
  "május",
  "június",
  "július",
  "augusztus",
  "szeptember",
  "október",
  "november",
  "december",
];

/**
 * Map a transaction type to a calendar category, or null to skip it. This is an
 * INVESTMENT-activity view: money you put into investments (buy) is out (−),
 * money you get from them (sell / coupon / interest / maturity) is in (+).
 * Moving your OWN money to/from the account (deposit, withdrawal), currency
 * conversions and internal transfers are funding moves, not events, so skipped —
 * otherwise a deposit that funds a same-day purchase would show a spurious +.
 */
const TX_CAT: Record<string, DayItem["cat"] | null> = {
  sell: "in",
  interest: "in",
  dividend: "in",
  redemption: "maturity",
  buy: "out",
  fee: "out",
  tax: "out",
  deposit: null,
  withdrawal: null,
  conversion: null,
  transfer: null,
};

interface DayItem {
  title: string;
  /** HUF magnitude (≥0); the category decides sign/colour. Undefined = marker. */
  amountHuf?: number;
  future: boolean;
  tag: string;
  cat: "coupon" | "maturity" | "tbsz" | "in" | "out";
  /** Set for asset buys/sells (instrument key) so same-asset round-trips net. */
  tradeKey?: string;
}

const CAT_COLOR: Record<DayItem["cat"], string> = {
  coupon: "#22d3ee",
  maturity: "#6366f1",
  tbsz: "#fbbf24",
  in: "#34d399",
  out: "#fb7185",
};

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (y: number, m0: number, d: number) =>
  `${y}-${pad(m0 + 1)}-${pad(d)}`;

interface DayAgg {
  inflow: number;
  outflow: number;
  /** A day has an amountless marker (e.g. a TBSZ milestone). */
  hasMarker: boolean;
}

/**
 * Aggregate a day's items into gross in/out. Trades are netted PER INSTRUMENT
 * first, so a same-asset round-trip cancels but a cross-asset rebalance keeps
 * both legs. Income/costs are never washed.
 */
function dayAggregate(items: DayItem[]): DayAgg {
  const tradeNet = new Map<string, number>();
  let inflow = 0;
  let outflow = 0;
  let hasMarker = false;
  for (const it of items) {
    if (it.amountHuf == null) {
      if (it.cat === "tbsz") hasMarker = true;
      continue;
    }
    const signed = it.cat === "out" ? -it.amountHuf : it.amountHuf;
    if (it.tradeKey)
      tradeNet.set(it.tradeKey, (tradeNet.get(it.tradeKey) ?? 0) + signed);
    else if (signed >= 0) inflow += signed;
    else outflow += -signed;
  }
  for (const v of tradeNet.values()) {
    if (v > 0) inflow += v;
    else outflow += -v;
  }
  return { inflow, outflow, hasMarker };
}

export default function Calendar() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);
  const privacy = usePortfolio((s) => s.privacy);
  const summary = usePortfolioSummary();

  // Stable for the component's lifetime: a fresh Date per render would defeat
  // every useMemo below (full-year rescan on each click).
  const [today] = useState(() => new Date());
  const todayIso = isoDay(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );

  // Fixed annual view: the whole year at once, navigable by year.
  const [year, setYear] = useState(today.getFullYear());
  const [selected, setSelected] = useState<string | null>(todayIso);

  const instMap = useMemo(
    () => new Map(instruments.map((i) => [i.key, i])),
    [instruments],
  );

  // Historical conversion rates, so past foreign-currency flows are sized at
  // the rate of their day instead of today's.
  const fxHistory = useMemo(() => buildFxHistory(transactions), [transactions]);

  // Build a per-day item map across past transactions + future cash-flows + TBSZ.
  const byDay = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    const push = (date: string, item: DayItem) => {
      // Local day, not a string prefix — imported dates serialise as UTC and
      // can sit one day behind their local calendar day.
      const d = new Date(date);
      const key = Number.isNaN(d.getTime())
        ? date.slice(0, 10)
        : isoDay(d.getFullYear(), d.getMonth(), d.getDate());
      const arr = map.get(key);
      if (arr) arr.push(item);
      else map.set(key, [item]);
    };

    // Past transactions. Skip mirror/internal entries: the treasury export
    // duplicates every bond settlement's cash side as a `pénzszámla kifizetés`
    // (flagged internal), and Lightyear marks own-account transfers IT-. Counting
    // them would double the day's flow (e.g. a 6,2M buy showing as −12,4M).
    for (const t of transactions) {
      if (t.internal || isInternalTransfer(t)) continue;
      const cat = TX_CAT[t.type] ?? null;
      if (!cat) continue;
      const raw = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
      if (raw === 0) continue;
      const huf =
        t.currency === "HUF"
          ? raw
          : raw * histFxRate(fxHistory, t.currency, t.date, fx);
      const inst = t.instrumentKey ? instMap.get(t.instrumentKey) : undefined;
      const isTrade = t.type === "buy" || t.type === "sell";
      push(t.date, {
        title: inst?.name ?? txTypeLabel[t.type],
        amountHuf: huf,
        future: false,
        tag: txTypeLabel[t.type],
        cat,
        tradeKey: isTrade ? t.instrumentKey : undefined,
      });
    }

    // Future bond cash-flows (coupons + redemptions)
    for (const cf of futureBondCashflows(summary, today, transactions)) {
      push(cf.date, {
        title: cf.title,
        amountHuf: cf.amountHuf,
        future: true,
        tag: cf.kind === "coupon" ? "kamat" : "lejárat",
        cat: cf.kind,
      });
    }

    // TBSZ milestones (markers, no cash amount)
    for (const a of accounts) {
      if (a.kind !== "tbsz" || !a.tbszYear) continue;
      const st = tbszStatus(a.tbszYear, today);
      for (const ms of st.milestones) {
        push(ms.date, {
          title: `TBSZ ${a.tbszYear} — ${ms.label}`,
          future: !ms.done,
          tag: "TBSZ",
          cat: "tbsz",
        });
      }
    }

    return map;
  }, [transactions, instMap, fx, fxHistory, summary, accounts, today]);

  // Largest single-day gross flow across the WHOLE year — normalises bubble
  // sizes so they're comparable from month to month.
  const maxGross = useMemo(() => {
    let mx = 0;
    for (let m = 0; m < 12; m++) {
      const days = new Date(year, m + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const items = byDay.get(isoDay(year, m, d));
        if (!items) continue;
        const { inflow, outflow } = dayAggregate(items);
        mx = Math.max(mx, inflow + outflow);
      }
    }
    return mx;
  }, [byDay, year]);

  // This year's expected (future) inflow total.
  const yearExpected = useMemo(() => {
    let sum = 0;
    for (let m = 0; m < 12; m++) {
      const days = new Date(year, m + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const items = byDay.get(isoDay(year, m, d));
        if (!items) continue;
        for (const it of items)
          if (it.future && it.amountHuf != null) sum += it.amountHuf;
      }
    }
    return sum;
  }, [byDay, year]);

  // Interest actually credited this (calendar) year — the KPI "eddig kapott".
  const yearInterest = useMemo(() => {
    let sum = 0;
    for (const t of transactions) {
      if (t.type !== "interest") continue;
      const d = new Date(t.date);
      if (Number.isNaN(d.getTime()) || d.getFullYear() !== year) continue;
      const raw = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
      sum +=
        t.currency === "HUF"
          ? raw
          : raw * histFxRate(fxHistory, t.currency, t.date, fx);
    }
    return sum;
  }, [transactions, year, fxHistory, fx]);

  // The nearest upcoming (future) inflow day, for the KPI + the pulsing marker.
  const nextEvent = useMemo(() => {
    let best: { key: string; daysUntil: number; amountHuf: number } | null =
      null;
    for (const [key, items] of byDay) {
      if (key <= todayIso) continue;
      const inflow = items.reduce(
        (s, it) =>
          it.future && it.amountHuf != null && it.cat !== "out"
            ? s + it.amountHuf
            : s,
        0,
      );
      if (inflow <= 0) continue;
      if (!best || key < best.key) {
        const daysUntil = Math.round(
          (Date.parse(key) - Date.parse(todayIso)) / 86_400_000,
        );
        best = { key, daysUntil, amountHuf: inflow };
      }
    }
    return best;
  }, [byDay, todayIso]);

  // Per-month inflow (realised + expected) for the year cashflow mini-chart.
  const monthlyInflow = useMemo(() => {
    const out: { month: number; past: number; future: number }[] = [];
    for (let m = 0; m < 12; m++) {
      const days = new Date(year, m + 1, 0).getDate();
      let past = 0;
      let future = 0;
      for (let d = 1; d <= days; d++) {
        const items = byDay.get(isoDay(year, m, d));
        if (!items) continue;
        for (const it of items) {
          if (it.amountHuf == null || it.cat === "out") continue;
          if (it.future) future += it.amountHuf;
          else past += it.amountHuf;
        }
      }
      out.push({ month: m, past, future });
    }
    return out;
  }, [byDay, year]);

  const selectedItems = selected ? (byDay.get(selected) ?? []) : [];

  return (
    <div>
      <PageHeader
        title="Naptár"
        subtitle="Befektetési mozgások és várható kifizetések az egész évre (a saját pénz be-/kiutalása nélkül)."
      />

      <Card className="p-5 sm:p-6">
        {/* Year nav */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">{year}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost px-2 py-1.5"
              onClick={() => setYear((y) => y - 1)}
              title="Előző év"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => setYear(today.getFullYear())}
            >
              Idei
            </button>
            <button
              className="btn-ghost px-2 py-1.5"
              onClick={() => setYear((y) => y + 1)}
              title="Következő év"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Year KPI strip */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            icon={<TrendingUp className="h-4 w-4" />}
            label="Idei várható bevétel"
            value={yearExpected}
            tone="positive"
            privacy={privacy}
          />
          <KpiTile
            icon={<Coins className="h-4 w-4" />}
            label="Idén kapott kamat"
            value={yearInterest}
            privacy={privacy}
          />
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <CalendarClock className="h-4 w-4" />
              Legközelebbi esemény
            </div>
            {nextEvent ? (
              <>
                <div className="amt mt-1 text-lg font-semibold tabular-nums text-[var(--color-positive)]">
                  +{formatMoney(nextEvent.amountHuf)}
                </div>
                <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {formatDate(nextEvent.key)} ·{" "}
                  {nextEvent.daysUntil === 0
                    ? "ma"
                    : `${nextEvent.daysUntil} nap múlva`}
                </div>
              </>
            ) : (
              <div className="mt-1 text-sm text-[var(--color-muted)]">
                Nincs várható bevétel
              </div>
            )}
          </div>
        </div>

        {/* 12 months at once */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {MONTHS.map((_, m) => (
            <MonthGrid
              key={m}
              m={m}
              year={year}
              todayIso={todayIso}
              byDay={byDay}
              maxGross={maxGross}
              selected={selected}
              onSelect={setSelected}
              privacy={privacy}
              nextEventKey={nextEvent?.key ?? null}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--color-muted)]">
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: "#34d399" }}
            />
            Pénz be
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: "#fb7185" }}
            />
            Pénz ki
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: "#6366f1" }}
            />
            Átrendezés (be ≈ ki)
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: CAT_COLOR.tbsz }}
            />
            TBSZ mérföldkő
          </span>
          <span>
            A cella színe a nap jellegét mutatja (a halványabb kör = várható) ·
            a kör mérete az összeggel arányos · a hónap fejlécében a sáv a be/ki
            arány, a zöld szám a várható bevétel.
          </span>
        </div>
        {/* Éves bevétel-idővonal: a 12 hónap egymás mellett */}
        <YearInflowChart
          data={monthlyInflow}
          todayMonth={year === today.getFullYear() ? today.getMonth() : -1}
          privacy={privacy}
        />
      </Card>

      {/* Forward 12-month cashflow forecast (coupons + maturities) */}
      <CashflowForecast />

      {/* Selected day detail */}
      {selected && (
        <Card className="mt-4 p-5 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold">{formatDate(selected)}</h3>
          {selectedItems.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">
              Nincs tétel ezen a napon.
            </p>
          ) : (
            <div className="space-y-2">
              {selectedItems
                .slice()
                .sort((a, b) => (b.amountHuf ?? 0) - (a.amountHuf ?? 0))
                .map((it, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: CAT_COLOR[it.cat] }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {it.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <Badge tone="neutral">{it.tag}</Badge>
                        {it.future && <Badge tone="warning">várható</Badge>}
                      </div>
                    </div>
                    {it.amountHuf != null && (
                      <div
                        className={`amt shrink-0 text-sm font-semibold tabular-nums ${
                          it.cat === "out"
                            ? "text-[var(--color-negative)]"
                            : "text-[var(--color-positive)]"
                        }`}
                      >
                        {it.cat === "out" ? "−" : "+"}
                        {formatMoney(it.amountHuf)}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** One year-KPI stat tile: label + count-up amount (masked in privacy mode). */
function KpiTile({
  icon,
  label,
  value,
  tone,
  privacy,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: "positive";
  privacy: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        {icon}
        {label}
      </div>
      <div
        className={`amt mt-1 text-lg font-semibold tabular-nums ${
          tone === "positive" ? "text-[var(--color-positive)]" : ""
        }`}
      >
        {privacy ? (
          "•••"
        ) : (
          <AnimatedAmount value={value} format={(n) => formatMoney(n)} />
        )}
      </div>
    </div>
  );
}

/**
 * Year income timeline: one bar per month (realised inflow solid, expected
 * inflow lighter, stacked), a single positive hue — magnitude over time. The
 * current month is ringed; hovering a bar shows its month + total.
 */
function YearInflowChart({
  data,
  todayMonth,
  privacy,
}: {
  data: { month: number; past: number; future: number }[];
  todayMonth: number;
  privacy: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.past + d.future), 1);
  const hasAny = data.some((d) => d.past + d.future > 0);
  if (!hasAny) return null;
  const pos = "var(--color-positive)";
  return (
    <div className="mt-5 border-t border-[var(--color-border)] pt-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-muted)]">
        Havi bevétel az évben
      </h3>
      <div className="flex h-32 items-end gap-1 sm:gap-1.5">
        {data.map((d) => {
          const total = d.past + d.future;
          const isNow = d.month === todayMonth;
          const active = hover === d.month;
          return (
            <div
              key={d.month}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
              onMouseEnter={() => setHover(d.month)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="relative flex h-full w-full flex-col justify-end">
                {active && total > 0 && (
                  <div className="amt pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-medium tabular-nums shadow-xl">
                    {privacy ? "•••" : `+${formatMoney(total)}`}
                  </div>
                )}
                {/* Expected (future) segment — lighter, sits on top. */}
                {d.future > 0 && (
                  <div
                    className="w-full rounded-t"
                    style={{
                      height: `${(d.future / max) * 100}%`,
                      background: pos,
                      opacity: active ? 0.55 : 0.4,
                    }}
                  />
                )}
                {/* Realised segment — solid, anchored to the baseline. */}
                {d.past > 0 && (
                  <div
                    className={`w-full ${d.future > 0 ? "mt-0.5" : "rounded-t"}`}
                    style={{
                      height: `${(d.past / max) * 100}%`,
                      background: pos,
                      opacity: active ? 1 : 0.85,
                    }}
                  />
                )}
              </div>
              <span
                className={`text-[10px] tabular-nums ${
                  isNow
                    ? "font-semibold text-[var(--color-positive)]"
                    : "text-[var(--color-muted)]"
                }`}
              >
                {MONTHS[d.month].slice(0, 3)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One compact month grid. Bubbles reuse the day-aggregate logic but are
// smaller and label-less (the number would not fit) — click for the detail.
// Top-level component (not nested in Calendar), so its identity is stable and
// React doesn't remount all 12 grids on every parent render.
function MonthGrid({
  m,
  year,
  todayIso,
  byDay,
  maxGross,
  selected,
  onSelect,
  privacy,
  nextEventKey,
}: {
  m: number;
  year: number;
  todayIso: string;
  byDay: Map<string, DayItem[]>;
  maxGross: number;
  selected: string | null;
  onSelect: (key: string) => void;
  privacy: boolean;
  nextEventKey: string | null;
}) {
  // Hover tooltip: the day under the cursor + the rect to anchor a floating card
  // (a real card beats the browser's title tooltip).
  const [hover, setHover] = useState<{ key: string; rect: DOMRect } | null>(
    null,
  );
  const first = new Date(year, m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const isCurrentMonth = todayIso.startsWith(isoDay(year, m, 1).slice(0, 7));

  // Month totals for the header bar + expected-income badge.
  let monthIn = 0;
  let monthOut = 0;
  let monthFutureIn = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const items = byDay.get(isoDay(year, m, d));
    if (!items) continue;
    const a = dayAggregate(items);
    monthIn += a.inflow;
    monthOut += a.outflow;
    for (const it of items)
      if (it.future && it.amountHuf != null && it.cat !== "out")
        monthFutureIn += it.amountHuf;
  }
  const monthGross = monthIn + monthOut;

  return (
    <div
      className={`rounded-xl border p-2 transition ${
        isCurrentMonth
          ? "border-[var(--color-brand)]/60 bg-gradient-to-b from-[var(--color-brand)]/10 to-transparent ring-1 ring-[var(--color-brand)]/25"
          : "border-[var(--color-border)]/60"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-1">
        <span
          className={`text-xs font-semibold capitalize ${
            isCurrentMonth ? "text-[var(--color-brand)]" : ""
          }`}
        >
          {MONTHS[m]}
        </span>
        {!privacy && monthFutureIn > 0 && (
          <span className="rounded-full bg-[var(--color-positive)]/15 px-1.5 py-px text-[9px] font-semibold tabular-nums text-[var(--color-positive)]">
            +{formatCompact(monthFutureIn)}
          </span>
        )}
      </div>
      {/* Month activity bar: green = money in, red = money out (proportional). */}
      <div className="mb-1.5 flex h-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
        {monthGross > 0 && (
          <>
            <span
              style={{ width: `${(monthIn / monthGross) * 100}%` }}
              className="bg-[var(--color-positive)]"
            />
            <span
              style={{ width: `${(monthOut / monthGross) * 100}%` }}
              className="bg-[var(--color-negative)]"
            />
          </>
        )}
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-[var(--color-muted)]">
        {WEEKDAYS.map((w, wi) => (
          <div key={wi} className="py-0.5">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />;
          const key = isoDay(year, m, d);
          const items = byDay.get(key);
          const isToday = key === todayIso;
          const isSel = key === selected;
          const isFuture = key > todayIso;
          const agg = items ? dayAggregate(items) : null;
          const has = !!items && items.length > 0;
          const gross = agg ? agg.inflow + agg.outflow : 0;
          const net = agg ? agg.inflow - agg.outflow : 0;
          // Area ∝ amount → diameter ∝ √. The bubbles deliberately overflow the
          // 22px cell (they sit behind the day number, semi-transparent), so a
          // big flow reads as a bold glowing blob. 14px floor keeps small
          // amounts visible next to the big buys.
          const diam =
            gross > 0 && maxGross > 0
              ? 14 + 34 * Math.sqrt(gross / maxGross)
              : 0;
          const tol = gross * 0.05;
          // The day's dominant colour: net inflow green, net outflow red, a
          // balanced rebalance indigo, an amount-less day (TBSZ) amber.
          const color =
            gross === 0 && agg?.hasMarker
              ? CAT_COLOR.tbsz
              : net > tol
                ? CAT_COLOR.in
                : net < -tol
                  ? CAT_COLOR.out
                  : CAT_COLOR.maturity;
          const isNext = key === nextEventKey;
          // A glossy sphere: a light highlight top-left, the hue in the body, a
          // darker rim — reads as a 3D blob rather than a flat disc.
          const sphere = (c: string) =>
            `radial-gradient(circle at 35% 28%, color-mix(in srgb, ${c}, white 48%), ${c} 58%, color-mix(in srgb, ${c}, black 22%))`;
          // Event days are tinted in their OWN category colour (no frame — the
          // tint + bubble carry it); the clicked day keeps a ring highlight.
          const style: CSSProperties = isSel
            ? {
                background: `${color}33`,
                borderColor: color,
                boxShadow: `0 0 0 1px ${color}80`,
              }
            : has
              ? { background: `${color}1f`, borderColor: "transparent" }
              : {};
          const cellTone = isSel
            ? ""
            : has
              ? ""
              : "border-transparent hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-surface-2)]/40";
          return (
            <button
              key={i}
              onClick={() => onSelect(key)}
              onMouseEnter={(e) =>
                has
                  ? setHover({
                      key,
                      rect: e.currentTarget.getBoundingClientRect(),
                    })
                  : undefined
              }
              onMouseLeave={() => setHover((h) => (h?.key === key ? null : h))}
              style={style}
              className={`relative flex h-[22px] items-center justify-center rounded border text-[10px] transition ${cellTone}`}
            >
              <span
                className={`relative z-10 tabular-nums ${
                  isToday
                    ? "grid h-4 w-4 place-items-center rounded-full bg-[var(--color-brand)] text-[9px] font-semibold text-white"
                    : has
                      ? "font-semibold text-[var(--color-text)]"
                      : "text-[var(--color-muted)]"
                }`}
              >
                {d}
              </span>
              {/* Pulsing ring on the nearest upcoming inflow day. */}
              {isNext && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    className="cal-ping rounded-full"
                    style={{
                      width: 20,
                      height: 20,
                      border: `2px solid ${color}`,
                    }}
                  />
                </span>
              )}
              {diam > 0 && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    className="shrink-0 rounded-full"
                    style={{
                      width: diam,
                      height: diam,
                      background: sphere(color),
                      opacity: isFuture ? 0.62 : 1,
                      boxShadow: `0 0 ${Math.round(diam / 2)}px ${color}${isFuture ? "40" : "80"}`,
                    }}
                  />
                </span>
              )}
              {diam === 0 && agg?.hasMarker && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    className="shrink-0 rounded-full"
                    style={{
                      width: 16,
                      height: 16,
                      background: sphere(CAT_COLOR.tbsz),
                      boxShadow: `0 0 8px ${CAT_COLOR.tbsz}80`,
                    }}
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {hover && (
        <DayTooltip
          rect={hover.rect}
          items={byDay.get(hover.key) ?? []}
          date={hover.key}
          privacy={privacy}
        />
      )}
    </div>
  );
}

/** Floating card shown while hovering a day cell — the day's items at a glance. */
function DayTooltip({
  rect,
  items,
  date,
  privacy,
}: {
  rect: DOMRect;
  items: DayItem[];
  date: string;
  privacy: boolean;
}) {
  if (items.length === 0) return null;
  const sorted = [...items].sort(
    (a, b) => (b.amountHuf ?? 0) - (a.amountHuf ?? 0),
  );
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 w-56 -translate-x-1/2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 shadow-xl"
      style={{
        left: Math.min(
          Math.max(rect.left + rect.width / 2, 120),
          window.innerWidth - 120,
        ),
        top: rect.bottom + 8,
      }}
    >
      <div className="mb-1.5 text-xs font-semibold text-[var(--color-muted)]">
        {formatDate(date)}
      </div>
      <div className="space-y-1">
        {sorted.map((it, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: CAT_COLOR[it.cat] }}
            />
            <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">
              {it.title}
            </span>
            {it.amountHuf != null && (
              <span
                className={`amt shrink-0 font-medium tabular-nums ${
                  it.cat === "out"
                    ? "text-[var(--color-negative)]"
                    : "text-[var(--color-positive)]"
                }`}
              >
                {privacy
                  ? "•••"
                  : `${it.cat === "out" ? "−" : "+"}${formatCompact(it.amountHuf)}`}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
