import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { futureBondCashflows, isInternalTransfer } from "../lib/portfolio";
import { tbszStatus } from "../lib/tbsz";
import { PageHeader, Card, Badge } from "../components/ui";
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

  const today = new Date();
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

  // Build a per-day item map across past transactions + future cash-flows + TBSZ.
  const byDay = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    const push = (date: string, item: DayItem) => {
      const key = date.slice(0, 10);
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
      const huf = t.currency === "HUF" ? raw : raw * (fx[t.currency] ?? 0);
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
    for (const cf of futureBondCashflows(summary, today)) {
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
  }, [transactions, instMap, fx, summary, accounts, today]);

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

  const selectedItems = selected ? (byDay.get(selected) ?? []) : [];

  // One compact month grid. Bubbles reuse the day-aggregate logic but are
  // smaller and label-less (the number would not fit) — click for the detail.
  function MonthGrid({ m }: { m: number }) {
    const first = new Date(year, m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const isCurrentMonth =
      year === today.getFullYear() && m === today.getMonth();
    return (
      <div
        className={`rounded-xl border p-2 ${
          isCurrentMonth
            ? "border-[var(--color-brand)]/40 bg-[var(--color-surface-2)]/30"
            : "border-[var(--color-border)]/60"
        }`}
      >
        <div className="mb-1 text-xs font-semibold capitalize">{MONTHS[m]}</div>
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
            const gross = agg ? agg.inflow + agg.outflow : 0;
            const net = agg ? agg.inflow - agg.outflow : 0;
            // Area ∝ amount → diameter ∝ √. Smaller scale for the mini grid.
            const diam =
              gross > 0 && maxGross > 0
                ? 6 + 13 * Math.sqrt(gross / maxGross)
                : 0;
            const tol = gross * 0.05;
            const color =
              net > tol ? "#34d399" : net < -tol ? "#fb7185" : "#6366f1";
            const parts: string[] = [];
            if (agg && agg.inflow > 0.5)
              parts.push(`Be +${formatCompact(agg.inflow)}`);
            if (agg && agg.outflow > 0.5)
              parts.push(`Ki −${formatCompact(agg.outflow)}`);
            const title =
              !privacy && parts.length ? parts.join(" · ") : undefined;
            return (
              <button
                key={i}
                onClick={() => setSelected(key)}
                title={title}
                className={`relative flex h-[22px] items-center justify-center rounded border text-[10px] transition ${
                  isSel
                    ? "border-[var(--color-brand)]/60 ring-1 ring-[var(--color-brand)]/40"
                    : "border-transparent hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-surface-2)]/40"
                }`}
              >
                <span
                  className={`relative z-10 tabular-nums ${
                    isToday
                      ? "grid h-4 w-4 place-items-center rounded-full bg-[var(--color-brand)] text-[9px] font-semibold text-white"
                      : "text-[var(--color-muted)]"
                  }`}
                >
                  {d}
                </span>
                {diam > 0 && (
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span
                      className="rounded-full"
                      style={{
                        width: diam,
                        height: diam,
                        background: `${color}${isFuture ? "70" : "cc"}`,
                      }}
                    />
                  </span>
                )}
                {diam === 0 && agg?.hasMarker && (
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span
                      className="h-2 w-2 rounded-full border-2"
                      style={{ borderColor: CAT_COLOR.tbsz }}
                    />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

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

        {yearExpected > 0 && (
          <p className="mb-3 text-sm text-[var(--color-muted)]">
            Várható bevétel ebben az évben:{" "}
            <span className="amt font-semibold text-[var(--color-positive)]">
              {formatMoney(yearExpected)}
            </span>
          </p>
        )}

        {/* 12 months at once */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {MONTHS.map((_, m) => (
            <MonthGrid key={m} m={m} />
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
              className="h-3.5 w-3.5 rounded-full border-2"
              style={{ borderColor: CAT_COLOR.tbsz }}
            />
            TBSZ mérföldkő
          </span>
          <span>A kör mérete az összeggel arányos · halványabb = várható.</span>
        </div>
      </Card>

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
