import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarPlus,
  TrendingUp,
  Coins,
  Sun,
  Maximize2,
} from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useSavingsGoals,
  useGoalProgress,
} from "../lib/store";
import {
  buildFxHistory,
  futureBondCashflows,
  histFxRate,
  isInternalTransfer,
} from "../lib/portfolio";
import { tbszStatus } from "../lib/tbsz";
import { lastWorkingDayOfMonth } from "../lib/goals";
import { loadForecastSettings, type PlannedExpense } from "../lib/forecast";
import { PREFS_EVENT } from "../lib/prefs";
import { buildIcs, downloadIcs, type IcsEvent } from "../lib/ics";
import { PageHeader, Card, AnimatedAmount } from "../components/ui";
import { formatMoney, formatCompact, formatDate } from "../lib/format";
import { txTypeLabel, instrumentTypeLabel } from "../lib/labels";
import {
  CAT_COLOR,
  MARKER_LABEL,
  MONTHS,
  WEEKDAYS,
  dayAggregate,
  dayColor,
  isoDay,
  sphere,
  type DayCat,
  type DayItem,
} from "../components/calendar/shared";
import IncomeTimeline, {
  type IncomeKind,
  type IncomeMonth,
} from "../components/calendar/IncomeTimeline";
import { DayPanel, DaySheet } from "../components/calendar/DayPanel";
import MonthZoomDialog from "../components/calendar/MonthZoomDialog";

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

/** Passive-income kind of a past transaction type (null = not income). */
const TX_INCOME: Record<string, IncomeKind | undefined> = {
  interest: "kamat",
  dividend: "osztalek",
  redemption: "lejarat",
};

/** A day is a "large one-off" above this multiple of the year's median day. */
const LARGE_FACTOR = 10;
const LARGE_MIN_HUF = 1_000_000;

const ymKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Planned expenses from the forecast settings, kept fresh on pref changes. */
function usePlannedExpenses(): PlannedExpense[] {
  const [list, setList] = useState(() => loadForecastSettings().expenses);
  useEffect(() => {
    const on = () => setList(loadForecastSettings().expenses);
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, []);
  return list;
}

export default function Calendar() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);
  const privacy = usePortfolio((s) => s.privacy);
  const dcaGoals = usePortfolio((s) => s.goals);
  const summary = usePortfolioSummary();
  const savingsGoals = useSavingsGoals();
  const goalProgress = useGoalProgress();
  const plannedExpenses = usePlannedExpenses();

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
  // null = auto (the nearest upcoming event, else today).
  const [picked, setPicked] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [zoom, setZoom] = useState<{ year: number; month: number } | null>(
    null,
  );
  const [hideLarge, setHideLarge] = useState(false);

  const instMap = useMemo(
    () => new Map(instruments.map((i) => [i.key, i])),
    [instruments],
  );

  // Historical conversion rates, so past foreign-currency flows are sized at
  // the rate of their day instead of today's.
  const fxHistory = useMemo(() => buildFxHistory(transactions), [transactions]);
  const txHuf = (t: (typeof transactions)[number]) => {
    const raw = Math.abs(t.grossAmount ?? t.netAmount ?? 0);
    return t.currency === "HUF"
      ? raw
      : raw * histFxRate(fxHistory, t.currency, t.date, fx);
  };

  const cashflows = useMemo(
    () => futureBondCashflows(summary, today, transactions),
    [summary, today, transactions],
  );

  // Build a per-day item map across past transactions, future cash-flows,
  // TBSZ milestones, goal deadlines, planned expenses and DCA deadlines.
  const byDay = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    const push = (date: string, item: DayItem) => {
      // Local day, not a string prefix — imported dates serialise as UTC and
      // can sit one day behind their local calendar day.
      const d = new Date(date.length === 10 ? `${date}T00:00:00` : date);
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
      const huf = txHuf(t);
      if (huf === 0) continue;
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
    for (const cf of cashflows) {
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

    // Medium-term goal deadlines (the target as a note, not a flow).
    for (const g of savingsGoals) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(g.targetDate)) continue;
      push(g.targetDate, {
        title: `Cél: ${g.name}`,
        noteHuf: g.targetHuf,
        future: g.targetDate.slice(0, 10) >= todayIso,
        tag: "cél",
        cat: "goal",
      });
    }

    // Planned expenses entered on the Forecast page.
    for (const e of plannedExpenses) {
      push(e.date, {
        title: e.note ? `Kiadás: ${e.note}` : "Betervezett kiadás",
        noteHuf: e.amountHuf,
        future: e.date.slice(0, 10) >= todayIso,
        tag: "kiadás",
        cat: "expense",
      });
    }

    // Recurring purchase (DCA) deadlines for the next 12 months: a buy on the
    // last working day already counts toward the NEXT month, so the deadline
    // is the working day before it. The current period is skipped once met.
    const doneNow = new Set(
      goalProgress.filter((p) => p.done).map((p) => p.goal.id),
    );
    for (const g of dcaGoals) {
      const what = g.instrumentKey
        ? (instMap.get(g.instrumentKey)?.ticker ??
          instMap.get(g.instrumentKey)?.name ??
          g.instrumentKey)
        : g.instrumentType
          ? instrumentTypeLabel[g.instrumentType]
          : "vásárlás";
      for (let k = 0; k < 12; k++) {
        const y = today.getFullYear();
        const m0 = today.getMonth() + k;
        const dt = new Date(y, m0, 1);
        // Only the last month of each period has a deadline.
        if ((dt.getMonth() + 1) % g.periodMonths !== 0) continue;
        if (k === 0 && doneNow.has(g.id)) continue;
        const d = new Date(
          dt.getFullYear(),
          dt.getMonth(),
          lastWorkingDayOfMonth(dt.getFullYear(), dt.getMonth()) - 1,
        );
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
        const key = isoDay(d.getFullYear(), d.getMonth(), d.getDate());
        if (key < todayIso) continue;
        push(key, {
          title: `Vásárlás határideje: ${what}`,
          noteHuf: g.amountHuf,
          future: true,
          tag: "havi vásárlás",
          cat: "dca",
        });
      }
    }

    return map;
    // txHuf is derived from fxHistory + fx (listed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    transactions,
    instMap,
    fx,
    fxHistory,
    cashflows,
    accounts,
    today,
    todayIso,
    savingsGoals,
    plannedExpenses,
    dcaGoals,
    goalProgress,
  ]);

  // Day gross flows of the viewed year, and the "large one-off" days: far above
  // the year's typical event day (e.g. the initial funding) — hideable so they
  // don't dwarf the ordinary days.
  const { maxGross, largeDays } = useMemo(() => {
    const grosses: { key: string; gross: number }[] = [];
    for (let m = 0; m < 12; m++) {
      const days = new Date(year, m + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const key = isoDay(year, m, d);
        const items = byDay.get(key);
        if (!items) continue;
        const { inflow, outflow } = dayAggregate(items);
        if (inflow + outflow > 0) grosses.push({ key, gross: inflow + outflow });
      }
    }
    const sorted = grosses.map((g) => g.gross).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const limit = Math.max(LARGE_MIN_HUF, median * LARGE_FACTOR);
    const largeDays = new Set(
      grosses.filter((g) => g.gross > limit).map((g) => g.key),
    );
    const maxGross = grosses
      .filter((g) => !(hideLarge && largeDays.has(g.key)))
      .reduce((mx, g) => Math.max(mx, g.gross), 0);
    return { maxGross, largeDays };
  }, [byDay, year, hideLarge]);

  // This year's expected (future) inflow total.
  const yearExpected = useMemo(() => {
    let sum = 0;
    for (const [key, items] of byDay) {
      if (!key.startsWith(`${year}-`)) continue;
      for (const it of items)
        if (it.future && it.amountHuf != null && it.cat !== "out")
          sum += it.amountHuf;
    }
    return sum;
  }, [byDay, year]);

  // Passive income (interest + dividends) realised in the viewed year, and in
  // the previous year up to the same day — the "tavalyhoz képest" delta.
  const passive = useMemo(() => {
    const md = todayIso.slice(5);
    let cur = 0;
    let prevYtd = 0;
    for (const t of transactions) {
      if (t.type !== "interest" && t.type !== "dividend") continue;
      const d = t.date.slice(0, 10);
      const y = Number(d.slice(0, 4));
      if (y === year) cur += txHuf(t);
      else if (y === year - 1 && d.slice(5) <= md) prevYtd += txHuf(t);
    }
    return { cur, prevYtd };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, year, fxHistory, fx, todayIso]);

  // Interest the portfolio "earns" per day: next 12 months' coupons / 365.
  const dailyInterest = useMemo(() => {
    const horizon = new Date(today);
    horizon.setFullYear(horizon.getFullYear() + 1);
    const lim = isoDay(
      horizon.getFullYear(),
      horizon.getMonth(),
      horizon.getDate(),
    );
    const coupons = cashflows
      .filter((c) => c.kind === "coupon" && c.date.slice(0, 10) < lim)
      .reduce((s, c) => s + c.amountHuf, 0);
    return coupons / 365;
  }, [cashflows, today]);

  // The nearest upcoming inflow day (KPI + pulsing marker + default day), and
  // the last one before today (the countdown ring's starting point).
  const { nextEvent, prevInflowKey } = useMemo(() => {
    let next: { key: string; daysUntil: number; amountHuf: number } | null =
      null;
    let prev: string | null = null;
    for (const [key, items] of byDay) {
      const inflow = items.reduce(
        (s, it) =>
          it.amountHuf != null &&
          !it.tradeKey &&
          (it.cat === "in" || it.cat === "coupon" || it.cat === "maturity")
            ? s + it.amountHuf
            : s,
        0,
      );
      if (inflow <= 0) continue;
      if (key > todayIso) {
        if (!next || key < next.key)
          next = { key, daysUntil: daysBetween(todayIso, key), amountHuf: inflow };
      } else if (key < todayIso && (!prev || key > prev)) prev = key;
    }
    return { nextEvent: next, prevInflowKey: prev };
  }, [byDay, todayIso]);

  const selected = picked ?? nextEvent?.key ?? todayIso;
  const selectedItems = byDay.get(selected) ?? [];
  const onSelect = (key: string) => {
    setPicked(key);
    // Phones get the bottom sheet; wide screens show the side panel.
    if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
  };

  // Passive-income timeline: 12 months back and 12 ahead (current included).
  const incomeMonths = useMemo<IncomeMonth[]>(() => {
    const zero = () => ({ kamat: 0, lejarat: 0, osztalek: 0 });
    const months: IncomeMonth[] = [];
    const index = new Map<string, IncomeMonth>();
    for (let k = -11; k <= 12; k++) {
      const key = ymKey(new Date(today.getFullYear(), today.getMonth() + k, 1));
      const m = { key, past: zero(), future: zero() };
      months.push(m);
      index.set(key, m);
    }
    for (const t of transactions) {
      if (t.internal || isInternalTransfer(t)) continue;
      const kind = TX_INCOME[t.type];
      const m = kind && index.get(t.date.slice(0, 7));
      if (m) m.past[kind] += txHuf(t);
    }
    for (const c of cashflows) {
      const m = index.get(c.date.slice(0, 7));
      if (m) m.future[c.kind === "coupon" ? "kamat" : "lejarat"] += c.amountHuf;
    }
    return months;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, cashflows, today, fxHistory, fx]);

  // Future dates as an .ics file for the phone's calendar.
  function exportIcs() {
    const events: IcsEvent[] = [];
    for (const [key, items] of byDay) {
      if (key < todayIso) continue;
      items.forEach((it, i) => {
        if (!it.future && it.cat !== "goal" && it.cat !== "expense") return;
        const amt = it.amountHuf ?? it.noteHuf;
        events.push({
          uid: `${key}-${it.cat}-${i}-${it.title.replace(/\W+/g, "").slice(0, 24)}`,
          date: key,
          title: `${it.title}${amt != null ? ` – ${formatMoney(amt)}` : ""}`,
          description: `${MARKER_LABEL[it.cat] ?? it.tag} · Portfólió-kezelő`,
          alarmDaysBefore: it.cat === "dca" ? 2 : 1,
        });
      });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    downloadIcs("portfolio-naptar.ics", buildIcs("Portfólió", events));
  }

  // Legend: only the marker kinds that actually appear.
  const markerKinds = useMemo(() => {
    const seen = new Set<DayCat>();
    for (const items of byDay.values())
      for (const it of items) if (it.amountHuf == null) seen.add(it.cat);
    return [...seen];
  }, [byDay]);

  const passiveDelta = passive.cur - passive.prevYtd;

  return (
    <div>
      <PageHeader
        title="Naptár"
        subtitle="Befektetési mozgások, várható kifizetések és határidők az egész évre (a saját pénz be-/kiutalása nélkül)."
      />

      <Card className="p-5 sm:p-6">
        {/* Year nav */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">{year}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost mr-1 px-2.5 py-1.5 text-xs"
              onClick={exportIcs}
              title="A jövőbeli kifizetések, lejáratok és határidők letöltése .ics fájlként (Google / Apple naptárba importálható)"
            >
              <CalendarPlus className="h-4 w-4" />
              <span className="hidden sm:inline">Exportálás naptárba</span>
            </button>
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
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            icon={<Coins className="h-4 w-4" />}
            label={`${year === today.getFullYear() ? "Idei" : year} passzív jövedelem`}
            value={passive.cur}
            tone="positive"
            privacy={privacy}
            foot={
              passive.prevYtd > 0 || passive.cur > 0 ? (
                <span
                  className={
                    passiveDelta >= 0
                      ? "text-[var(--color-positive)]"
                      : "text-[var(--color-negative)]"
                  }
                >
                  <span className="amt">
                    {privacy
                      ? "•••"
                      : `${passiveDelta >= 0 ? "+" : "−"}${formatCompact(Math.abs(passiveDelta))}`}
                  </span>{" "}
                  <span className="text-[var(--color-muted)]">
                    a tavalyi azonos időszakhoz
                  </span>
                </span>
              ) : undefined
            }
          />
          <KpiTile
            icon={<TrendingUp className="h-4 w-4" />}
            label={`${year === today.getFullYear() ? "Idén még" : `${year}-ben`} várható`}
            value={yearExpected}
            privacy={privacy}
            foot={
              <span className="text-[var(--color-muted)]">
                kamat + lejárat
              </span>
            }
          />
          <KpiTile
            icon={<Sun className="h-4 w-4" />}
            label="Naponta termelt kamat"
            value={dailyInterest}
            privacy={privacy}
            foot={
              <span className="amt text-[var(--color-muted)]">
                ≈ {privacy ? "•••" : formatMoney(dailyInterest * 30)} / hó
              </span>
            }
          />
          <NextEventTile
            next={nextEvent}
            prevKey={prevInflowKey}
            todayIso={todayIso}
            privacy={privacy}
            onClick={() => nextEvent && onSelect(nextEvent.key)}
          />
        </div>

        {/* Months + selected-day panel */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {MONTHS.map((_, m) => (
                <MonthGrid
                  key={m}
                  m={m}
                  year={year}
                  todayIso={todayIso}
                  byDay={byDay}
                  maxGross={maxGross}
                  hidden={hideLarge ? largeDays : undefined}
                  selected={selected}
                  onSelect={onSelect}
                  onZoom={() => setZoom({ year, month: m })}
                  privacy={privacy}
                  nextEventKey={nextEvent?.key ?? null}
                />
              ))}
            </div>

            {/* Legend */}
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--color-muted)]">
              <LegendDot color={CAT_COLOR.in} label="Pénz be" />
              <LegendDot color={CAT_COLOR.out} label="Pénz ki" />
              <LegendDot color={CAT_COLOR.maturity} label="Átrendezés (be ≈ ki)" />
              {markerKinds.map((k) => (
                <LegendDot
                  key={k}
                  color={CAT_COLOR[k]}
                  label={MARKER_LABEL[k] ?? k}
                />
              ))}
              {largeDays.size > 0 && (
                <label className="ml-auto flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={hideLarge}
                    onChange={(e) => setHideLarge(e.target.checked)}
                  />
                  Nagy egyszeri tételek elrejtése ({largeDays.size})
                </label>
              )}
            </div>
            <p className="mt-1.5 text-xs text-[var(--color-muted)]">
              A kör mérete az összeggel arányos (halványabb = várható) · a hónap
              nevére kattintva kinagyítod · a fejléc sávja a be/ki arány, a zöld
              szám a hónap várható bevétele.
            </p>
          </div>

          <div className="hidden lg:block">
            <DayPanel
              date={selected}
              items={selectedItems}
              todayIso={todayIso}
              privacy={privacy}
            />
          </div>
        </div>

        <IncomeTimeline
          months={incomeMonths}
          currentKey={ymKey(today)}
          privacy={privacy}
        />
      </Card>

      {sheetOpen && (
        <DaySheet
          date={selected}
          items={selectedItems}
          todayIso={todayIso}
          privacy={privacy}
          onClose={() => setSheetOpen(false)}
        />
      )}
      {zoom && (
        <MonthZoomDialog
          year={zoom.year}
          month={zoom.month}
          byDay={byDay}
          todayIso={todayIso}
          privacy={privacy}
          onMonth={(y, m) => setZoom({ year: y, month: m })}
          onSelect={onSelect}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/** One year-KPI stat tile: label + count-up amount (masked in privacy mode). */
function KpiTile({
  icon,
  label,
  value,
  tone,
  privacy,
  foot,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: "positive";
  privacy: boolean;
  foot?: ReactNode;
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
      {foot && <div className="mt-0.5 text-xs">{foot}</div>}
    </div>
  );
}

/**
 * The nearest inflow with a countdown ring: how much of the wait since the
 * previous inflow has already passed. Clicking selects that day.
 */
function NextEventTile({
  next,
  prevKey,
  todayIso,
  privacy,
  onClick,
}: {
  next: { key: string; daysUntil: number; amountHuf: number } | null;
  prevKey: string | null;
  todayIso: string;
  privacy: boolean;
  onClick: () => void;
}) {
  const total = next && prevKey ? daysBetween(prevKey, next.key) : 0;
  const elapsed = next && prevKey ? daysBetween(prevKey, todayIso) : 0;
  const frac = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <button
      onClick={onClick}
      disabled={!next}
      className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 text-left transition enabled:hover:border-[var(--color-positive)]/50"
    >
      {next && (
        <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0">
          <circle
            cx="26"
            cy="26"
            r={r}
            fill="none"
            stroke="var(--color-surface-2)"
            strokeWidth="5"
          />
          <circle
            cx="26"
            cy="26"
            r={r}
            fill="none"
            stroke="var(--color-positive)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${c * frac} ${c}`}
            transform="rotate(-90 26 26)"
          />
          <text
            x="26"
            y="25"
            textAnchor="middle"
            className="fill-[var(--color-text)] text-[13px] font-semibold"
          >
            {next.daysUntil}
          </text>
          <text
            x="26"
            y="36"
            textAnchor="middle"
            className="fill-[var(--color-muted)] text-[8px]"
          >
            nap
          </text>
        </svg>
      )}
      <div className="min-w-0">
        <div className="text-xs text-[var(--color-muted)]">
          Legközelebbi bevétel
        </div>
        {next ? (
          <>
            <div className="amt mt-0.5 text-lg font-semibold tabular-nums text-[var(--color-positive)]">
              {privacy ? "•••" : `+${formatMoney(next.amountHuf)}`}
            </div>
            <div className="text-xs text-[var(--color-muted)]">
              {formatDate(next.key)}
            </div>
          </>
        ) : (
          <div className="mt-1 text-sm text-[var(--color-muted)]">
            Nincs várható bevétel
          </div>
        )}
      </div>
    </button>
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
  hidden,
  selected,
  onSelect,
  onZoom,
  privacy,
  nextEventKey,
}: {
  m: number;
  year: number;
  todayIso: string;
  byDay: Map<string, DayItem[]>;
  maxGross: number;
  /** Large one-off days drawn without a bubble (just a ring). */
  hidden?: Set<string>;
  selected: string | null;
  onSelect: (key: string) => void;
  onZoom: () => void;
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
        <button
          onClick={onZoom}
          className={`group flex items-center gap-1 text-xs font-semibold capitalize hover:text-[var(--color-brand)] ${
            isCurrentMonth ? "text-[var(--color-brand)]" : ""
          }`}
          title="Hónap kinagyítása"
        >
          {MONTHS[m]}
          <Maximize2 className="h-3 w-3 opacity-0 transition group-hover:opacity-70" />
        </button>
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
          const isHidden = !!hidden?.has(key);
          // Area ∝ amount → diameter ∝ √. The bubbles deliberately overflow the
          // 22px cell (they sit behind the day number, semi-transparent), so a
          // big flow reads as a bold glowing blob. 14px floor keeps small
          // amounts visible next to the big buys.
          const diam =
            gross > 0 && maxGross > 0 && !isHidden
              ? 14 + 34 * Math.sqrt(gross / maxGross)
              : 0;
          const color = agg ? dayColor(agg) : CAT_COLOR.maturity;
          const isNext = key === nextEventKey;
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
              {/* A hidden large day: a thin ring in its colour instead. */}
              {isHidden && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    className="shrink-0 rounded-full"
                    style={{
                      width: 18,
                      height: 18,
                      border: `1.5px dashed ${color}`,
                    }}
                  />
                </span>
              )}
              {diam === 0 && !isHidden && agg?.marker && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    className="shrink-0 rounded-full"
                    style={{
                      width: 16,
                      height: 16,
                      background: sphere(CAT_COLOR[agg.marker]),
                      opacity: isFuture ? 0.8 : 1,
                      boxShadow: `0 0 8px ${CAT_COLOR[agg.marker]}80`,
                    }}
                  />
                </span>
              )}
              {/* Marker on a day that also has a flow: a small corner dot. */}
              {diam > 0 && agg?.marker && (
                <span
                  className="pointer-events-none absolute right-0 top-0 z-20 h-1.5 w-1.5 rounded-full"
                  style={{ background: CAT_COLOR[agg.marker] }}
                />
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
    (a, b) => (b.amountHuf ?? b.noteHuf ?? 0) - (a.amountHuf ?? a.noteHuf ?? 0),
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
        {sorted.map((it, i) => {
          const amt = it.amountHuf ?? it.noteHuf;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: CAT_COLOR[it.cat] }}
              />
              <span className="priv min-w-0 flex-1 truncate text-[var(--color-muted)]">
                {it.title}
              </span>
              {amt != null && (
                <span
                  className={`amt shrink-0 font-medium tabular-nums ${
                    it.amountHuf == null
                      ? "text-[var(--color-muted)]"
                      : it.cat === "out"
                        ? "text-[var(--color-negative)]"
                        : "text-[var(--color-positive)]"
                  }`}
                >
                  {privacy
                    ? "•••"
                    : `${it.amountHuf == null ? "" : it.cat === "out" ? "−" : "+"}${formatCompact(amt)}`}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
