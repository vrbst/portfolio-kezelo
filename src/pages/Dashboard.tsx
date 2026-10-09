import InfoTip from "../components/InfoTip";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { motion, useReducedMotion } from "motion/react";
import {
  Wallet,
  TrendingUp,
  PiggyBank,
  Coins,
  ArrowRight,
  ChevronRight,
  RefreshCw,
  Target,
} from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useGoalProgress,
  useValueSeries,
  useDayChange,
  useValuedInstruments,
} from "../lib/store";
import {
  accountReturn,
  isEmptyAccount,
  buildValueSeries,
  allocationByClass,
  allocationByCurrency,
  type ValuePoint,
  type AccountSummary,
} from "../lib/portfolio";
import { upcomingEvents, type EventKind } from "../lib/events";
import ValueChart, { type ChartMode } from "../components/ValueChart";
import {
  RANGES,
  effectiveRange,
  loadChartMode,
  profitBase,
  rangeAvailability,
  saveChartMode,
  sliceRange,
  type RangeKey,
} from "../lib/chartRange";
import HoldingsPanel, { HOLDINGS_PANEL_ID } from "../components/HoldingsPanel";
import AlertsPanel from "../components/AlertsPanel";
import LivePricesPanel from "../components/LivePricesPanel";
import NewsCard from "../components/NewsCard";
import NewsBanner from "../components/NewsBanner";
import DayChangeBreakdown from "../components/DayChangeBreakdown";
import PrivacyToggle from "../components/PrivacyToggle";
import { useIsMobile } from "../lib/useIsMobile";
import {
  PageHeader,
  StatCard,
  Card,
  EmptyState,
  Delta,
  Badge,
  Amt,
  Sparkline,
  AnimatedAmount,
  NoCardEnter,
} from "../components/ui";
import {
  formatMoney,
  formatPercent,
  formatDateTime,
  formatDate,
  eurEquivalent,
} from "../lib/format";
import { accountKindLabel, assetClassLabel } from "../lib/labels";
import { CalendarClock, Landmark, Coins as CoinsIcon } from "lucide-react";
import { SERIES_COLORS } from "../lib/skin";

const COLORS = SERIES_COLORS;

/** Short Hungarian "how long ago" label for the live-price freshness pill. */
function relTime(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "az imént";
  const min = Math.round(ms / 60000);
  if (min < 1) return "az imént";
  if (min < 60) return `${min} perce`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} órája`;
  return `${Math.round(h / 24)} napja`;
}

export default function Dashboard() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = useValuedInstruments();
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const historyFile = usePortfolio((s) => s.historyFile);
  const summary = usePortfolioSummary();
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const pricesLoading = usePortfolio((s) => s.pricesLoading);
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt);
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>("holdings");

  const valueSeries = useValueSeries();

  // Last ~30 samples of total value → the hero card's sparkline trend.
  const valueSpark = useMemo(
    () => valueSeries.slice(-30).map((p) => p.value),
    [valueSeries],
  );
  const sparkUp =
    valueSpark.length > 1 && valueSpark[valueSpark.length - 1] >= valueSpark[0];

  // Change between the last two samples → the hero's "ma" pill (shared hook).
  const dayChange = useDayChange();

  // Per-account value trend for the account-card sparklines. Reuses the same
  // history-aware builder on each account alone (bridge off — inter-account
  // transit only matters for the whole-portfolio curve).
  const instMap = useMemo(
    () => new Map(instruments.map((i) => [i.key, i])),
    [instruments],
  );
  const accountSparks = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const a of summary.accounts) {
      if (isEmptyAccount(a)) continue;
      const s = buildValueSeries(
        [a.account],
        transactions,
        instMap,
        prices,
        fx,
        historyFile,
        new Date(),
        false,
      );
      if (s.length >= 2) out.set(a.account.id, s.slice(-24).map((p) => p.value));
    }
    return out;
  }, [summary.accounts, transactions, instMap, prices, fx, historyFile]);

  const goalProgress = useGoalProgress();
  const [activeSlice, setActiveSlice] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();

  const [wantedRange, setRange] = useState<RangeKey>("max");
  const [chartMode, setChartModeState] = useState<ChartMode>(loadChartMode);
  const setChartMode = (mode: ChartMode) => {
    setChartModeState(mode);
    saveChartMode(mode);
  };

  // Which ranges actually contain ≥2 points (others are disabled, not silent).
  const rangeAvail = useMemo(
    () => rangeAvailability(valueSeries),
    [valueSeries],
  );
  const range = effectiveRange(wantedRange, rangeAvail);

  const rangedSeries = useMemo(
    () => sliceRange(valueSeries, range),
    [valueSeries, range],
  );
  const rangedProfitBase = profitBase(rangedSeries, range);

  // Chart scrubbing: while hovering the value chart the hero card shows that
  // day's value and the market move since the range start (flows netted out).
  const [scrub, setScrub] = useState<ValuePoint | null>(null);
  const scrubDelta = useMemo(() => {
    const base = rangedSeries[0];
    if (!scrub || !base) return null;
    const flows = scrub.invested - base.invested;
    const abs = scrub.value - base.value - flows;
    // Relative to the capital at stake (start value + money added since) — the
    // start value alone can be near zero on "Max" and inflate the percentage.
    const stake = base.value + Math.max(0, flows);
    return { abs, pct: stake > 0 ? abs / stake : undefined };
  }, [scrub, rangedSeries]);

  const [allocMode, setAllocMode] = useState<"class" | "currency" | "account">(
    "class",
  );
  const allocation = useMemo(() => {
    if (allocMode === "account")
      return summary.accounts
        .filter((a) => a.totalValueHuf > 0)
        .map((a) => ({ name: a.account.name, value: a.totalValueHuf }))
        .sort((a, b) => b.value - a.value);
    if (allocMode === "currency")
      return allocationByCurrency(summary, fx).map((s) => ({
        name: s.key,
        value: s.value,
      }));
    return allocationByClass(summary).map((s) => ({
      name: assetClassLabel[s.key as keyof typeof assetClassLabel] ?? s.key,
      value: s.value,
    }));
  }, [summary, allocMode, fx]);

  const events = useMemo(
    () => upcomingEvents(summary, undefined, transactions).slice(0, 12),
    [summary, transactions],
  );

  // Equal-height columns on the xl two-column layout. Nested-flex min-content
  // makes this impossible to pin purely in CSS, so we measure both columns'
  // NATURAL heights and give both the larger one:
  //  - left: its cards, the Eszközeim list counted up to its 26rem cap;
  //  - right: the cards above the events card + EVENTS_MIN_PX for it (the
  //    events list is never squeezed shut).
  // The extra room goes into the Eszközeim list (left) and the events list
  // (right), both scrolling past it. Stacked below xl nothing is fixed.
  const leftColRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [colH, setColH] = useState<number | undefined>();
  useEffect(() => {
    const left = leftColRef.current;
    const rail = railRef.current;
    if (!left || !rail) return;
    const mq = window.matchMedia("(min-width: 1280px)");
    const gapOf = (n: Element) => parseFloat(getComputedStyle(n).rowGap) || 0;
    const update = () => {
      if (!mq.matches) return setColH(undefined);

      const holdings = left.querySelector<HTMLElement>(
        `#${HOLDINGS_PANEL_ID}`,
      );
      const body = holdings?.querySelector<HTMLElement>(
        "[data-holdings-body]",
      );
      const leftKids = [...left.children] as HTMLElement[];
      let leftNatural = gapOf(left) * Math.max(0, leftKids.length - 1);
      for (const c of leftKids) {
        if (c === holdings && body) {
          // Card chrome (header, borders) + the list at its natural height,
          // capped like below xl. scrollHeight ignores the stretched box.
          const chrome = holdings.offsetHeight - body.clientHeight;
          leftNatural +=
            chrome + Math.min(body.scrollHeight, HOLDINGS_BODY_MAX_PX);
        } else leftNatural += c.offsetHeight;
      }

      const eventsCard = rail.querySelector<HTMLElement>(
        `#${UPCOMING_EVENTS_ID}`,
      );
      const railKids = [...rail.children] as HTMLElement[];
      let railNatural = gapOf(rail) * Math.max(0, railKids.length - 1);
      for (const c of railKids)
        railNatural += c === eventsCard ? EVENTS_MIN_PX : c.offsetHeight;

      setColH(Math.ceil(Math.max(leftNatural, railNatural)));
    };
    // Re-measure when any card resizes (live quotes, rows unfolding) or cards
    // come and go as data loads. The stretched cards (holdings, events) are
    // measured by their content, so only the rest is observed by size.
    const ro = new ResizeObserver(update);
    const observeAll = () => {
      for (const col of [left, rail])
        for (const c of col.children)
          if (c.id !== HOLDINGS_PANEL_ID && c.id !== UPCOMING_EVENTS_ID)
            ro.observe(c);
      const table = left.querySelector(`#${HOLDINGS_PANEL_ID} table`);
      if (table) ro.observe(table);
      update();
    };
    const mo = new MutationObserver(observeAll);
    mo.observe(left, { childList: true });
    mo.observe(rail, { childList: true });
    observeAll();
    mq.addEventListener("change", update);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", update);
    };
  }, [isMobile]);

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title="Áttekintés" />
        <EmptyState
          title="Még nincsenek adatok"
          description="Importáld a Lightyear és Magyar Államkincstár kivonataidat, és itt megjelenik a teljes portfóliód."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás indítása
            </Link>
          }
        />
      </div>
    );
  }

  const heroCard = (
    <StatCard
      variant={isMobile ? "bare" : undefined}
      label={
        scrub ? `Érték · ${formatDate(scrub.date)}` : "Teljes érték"
      }
      numericValue={scrub ? scrub.value : summary.totalValueHuf}
      format={(n) => formatMoney(n)}
      sub={
        <>
          {eurEquivalent(
            scrub ? scrub.value : summary.totalValueHuf,
            eurHuf,
          )}
          {!scrub && dayChange?.eurPct != null && (
            <span
              className={`ml-1.5 ${
                dayChange.eurPct >= 0
                  ? "text-[var(--color-positive)]"
                  : "text-[var(--color-negative)]"
              }`}
              title="Mai változás EUR-ban"
            >
              {formatPercent(dayChange.eurPct)}
            </span>
          )}
        </>
      }
      delta={scrub ? scrubDelta?.abs : dayChange?.abs}
      deltaPct={scrub ? scrubDelta?.pct : dayChange?.pct}
      deltaNote={scrub ? "az időszak elejétől" : dayChange?.note}
      deltaDetail={
        !scrub && dayChange?.breakdown?.length ? (
          <DayChangeBreakdown change={dayChange} />
        ) : undefined
      }
      scrubbing={scrub != null}
      icon={<Wallet className="h-5 w-5" />}
      index={0}
      hero
      aurora
      flashOnChange
      sparkline={valueSpark}
      sparkStroke={
        sparkUp ? "var(--color-positive)" : "var(--color-negative)"
      }
    />
  );

  const returnCard = (
    <StatCard
      variant={isMobile ? "compact" : undefined}
      label="Teljes hozam"
      numericValue={summary.totalPlHuf}
      format={(n) => formatMoney(n, "HUF", { sign: true })}
      sub={eurEquivalent(summary.totalPlHuf, eurHuf, { sign: true })}
      deltaPct={summary.totalReturnPct}
      icon={<TrendingUp className="h-5 w-5" />}
      index={1}
    />
  );

  const investedCard = (
    <StatCard
      variant={isMobile ? "compact" : undefined}
      label="Befektetett tőke"
      numericValue={summary.netDepositedHuf}
      format={(n) => formatMoney(n)}
      icon={<PiggyBank className="h-5 w-5" />}
      index={2}
    />
  );

  const realizedCard = (
    <StatCard
      variant={isMobile ? "compact" : undefined}
      label="Realizált eredmény összesen"
      numericValue={summary.totalPlHuf - summary.unrealizedPlHuf}
      format={(n) => formatMoney(n, "HUF", { sign: true })}
      sub={
        summary.interestHuf > 0.5
          ? `kamattal, díjak után · ebből kamat: ${formatMoney(
              summary.interestHuf,
              "HUF",
              { sign: true },
            )}`
          : "kamattal, díjak után"
      }
      icon={<Coins className="h-5 w-5" />}
      index={3}
    />
  );

  const chartCard =
    valueSeries.length > 1 && (
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              {chartMode === "profit"
                ? "Hozam az időben"
                : "Érték az időben"}
              <InfoTip>
                {chartMode === "profit"
                  ? range === "max"
                    ? "Napi hozam (érték − befektetett tőke)."
                    : "Hozam az időszak eleje óta (érték − befektetett tőke, a kezdőnaphoz képest; a be- és kifizetések nem számítanak bele)."
                  : "Portfólió érték (kitöltött) vs. befektetett tőke (szaggatott)."}
              </InfoTip>
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
              {(
                [
                  { key: "value", label: "Érték" },
                  { key: "profit", label: "Hozam" },
                ] as const
              ).map((m) => (
                <button
                  key={m.key}
                  onClick={() => setChartMode(m.key)}
                  className={`rounded-md px-2.5 py-1 transition ${
                    chartMode === m.key
                      ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  disabled={!rangeAvail[r.key]}
                  title={r.title}
                  aria-label={r.title}
                  aria-pressed={range === r.key}
                  className={`rounded-md px-1.5 py-1 transition sm:px-2.5 disabled:cursor-not-allowed disabled:opacity-30 ${
                    range === r.key
                      ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ValueChart
          data={rangedSeries}
          mode={chartMode}
          profitBase={rangedProfitBase}
          onScrub={setScrub}
        />
      </Card>
    );

  const accountsCard = (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Számláim</h2>
        <Link
          to="/accounts"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-brand)] hover:underline"
        >
          Összes <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      {/* auto-fit: the cards always fill the row, however many accounts. Min
          20rem keeps the full name readable (wraps to a new row instead of
          cramming); min(100%,…) lets it shrink on a phone. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-3">
        {/* Empty accounts are noise here — the Számlák page still lists them. */}
        {summary.accounts
          .filter((a) => !isEmptyAccount(a))
          .map((a) => (
            <Link
              key={a.account.id}
              to={`/accounts/${a.account.id}`}
              className="block min-w-0"
            >
              <div className="card-hover h-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="truncate font-medium"
                    title={a.account.name}
                  >
                    {a.account.name}
                  </span>
                  <Badge tone="neutral">
                    {accountKindLabel(a.account)}
                  </Badge>
                </div>
                <div className="mt-2 flex items-end gap-3">
                  <div className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
                    <div>{a.holdings.length} pozíció</div>
                    <div>
                      készpénz <Amt>{formatMoney(a.cashValueHuf)}</Amt>
                    </div>
                  </div>
                  {accountSparks.has(a.account.id) && (
                    <div className="hidden h-8 w-16 shrink-0 sm:block">
                      <Sparkline
                        data={accountSparks.get(a.account.id)!}
                        stroke={
                          (accountReturn(a) ?? 0) >= 0
                            ? "var(--color-positive)"
                            : "var(--color-negative)"
                        }
                        className="h-full w-full"
                      />
                    </div>
                  )}
                  <div className="text-right">
                    <div className="amt font-semibold tabular-nums">
                      {formatMoney(a.totalValueHuf)}
                    </div>
                    {accountReturn(a) != null && (
                      <Delta pct={accountReturn(a)} className="text-xs" />
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))}
      </div>
    </Card>
  );

  const allocationCard = (
    <Card className="p-5">
      <h2 className="mb-3 text-lg font-semibold">Eszközallokáció</h2>
      <div className="mb-4 inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
        {(
          [
            ["class", "Eszköztípus"],
            ["currency", "Deviza"],
            ["account", "Számla"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            onClick={() => setAllocMode(mode)}
            className={`rounded-md px-2.5 py-1 transition ${
              allocMode === mode
                ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="relative h-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={allocation}
              dataKey="value"
              nameKey="name"
              innerRadius={70}
              outerRadius={100}
              paddingAngle={3}
              stroke="none"
              isAnimationActive={!reduceMotion}
              animationDuration={900}
              animationEasing="ease-out"
              onMouseEnter={(_, i) => setActiveSlice(i)}
              onMouseLeave={() => setActiveSlice(null)}
              onClick={(_, i) =>
                setActiveSlice((cur) => (cur === i ? null : i))
              }
            >
              {allocation.map((_, i) => (
                <Cell
                  key={i}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={
                    activeSlice == null || activeSlice === i ? 1 : 0.3
                  }
                  style={{ transition: "fill-opacity 0.2s" }}
                />
              ))}
            </Pie>
            {/* Pop-out ring for the active slice: the same data gives the
                same angles, only the active cell is painted. */}
            {activeSlice != null && (
              <Pie
                data={allocation}
                dataKey="value"
                nameKey="name"
                innerRadius={98}
                outerRadius={106}
                paddingAngle={3}
                stroke="none"
                isAnimationActive={false}
                style={{ pointerEvents: "none" }}
              >
                {allocation.map((_, i) => (
                  <Cell
                    key={i}
                    fill={
                      i === activeSlice
                        ? COLORS[i % COLORS.length]
                        : "transparent"
                    }
                  />
                ))}
              </Pie>
            )}
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
          {(() => {
            const slice =
              activeSlice != null ? allocation[activeSlice] : undefined;
            return (
              <>
                {/* Keyed: the new label swaps in at once and fades up, so
                    it can never lag behind the amount below it. */}
                <motion.span
                  key={slice?.name ?? "__total"}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="max-w-full truncate text-xs text-[var(--color-muted)]"
                >
                  {slice?.name ?? "Összesen"}
                </motion.span>
                <span
                  className={`amt donut-amount font-display font-semibold ${
                    slice ? "text-lg" : "text-xl"
                  }`}
                >
                  <AnimatedAmount
                    value={slice?.value ?? summary.totalValueHuf}
                    format={(n) => formatMoney(n)}
                    duration={0.35}
                  />
                </span>
                {slice && (
                  <span className="text-xs font-medium text-[var(--color-brand)]">
                    {formatPercent(
                      slice.value / summary.totalValueHuf,
                    ).replace("+", "")}
                  </span>
                )}
              </>
            );
          })()}
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {allocation.map((a, i) => (
          <div
            key={a.name}
            className={`flex cursor-default items-center gap-2 rounded-lg px-1 py-0.5 text-sm transition-colors ${
              activeSlice === i ? "bg-[var(--color-surface-2)]/60" : ""
            }`}
            onMouseEnter={() => setActiveSlice(i)}
            onMouseLeave={() => setActiveSlice(null)}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            <span className="flex-1 truncate text-[var(--color-muted)]">
              {a.name}
            </span>
            <span className="tabular-nums">
              {formatPercent(a.value / summary.totalValueHuf).replace(
                "+",
                "",
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );

  const goalsCard =
    goalProgress.length > 0 && (
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Target className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Célok</h2>
        </div>
        <div className="space-y-3">
          {goalProgress.map((p) => {
            const pct = Math.min(Math.max(p.ratio, 0), 1) * 100;
            const color = p.done
              ? "var(--color-positive)"
              : "var(--color-brand)";
            return (
              <Link
                key={p.goal.id}
                to="/goals"
                className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 card-hover"
              >
                <div className="relative h-12 w-12 shrink-0">
                  <div
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: `conic-gradient(${color} ${pct}%, var(--color-surface-2) 0)`,
                    }}
                  />
                  <div className="absolute inset-[3px] grid place-items-center rounded-full bg-[var(--color-surface)] text-[11px] font-semibold tabular-nums">
                    {Math.round(p.ratio * 100)}%
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {p.instrumentName}
                    </span>
                    {p.done && (
                      <Badge tone="positive">Teljesítve</Badge>
                    )}
                  </div>
                  <div className="amt mt-0.5 text-xs tabular-nums text-[var(--color-muted)]">
                    {formatMoney(p.investedHuf)} /{" "}
                    {formatMoney(p.targetHuf)}
                    {!p.done && p.remainingHuf > 0 && (
                      <> · még {formatMoney(p.remainingHuf)}</>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </Card>
    );

  const eventsCard =
    events.length > 0 && (
      <Card
        id={UPCOMING_EVENTS_ID}
        className="flex flex-col p-5 xl:min-h-0 xl:flex-1"
      >
        <div className="mb-4 flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Közelgő események</h2>
        </div>
        {/* Mobilon fix magasságú (max-h) és görgethető; xl-en a kártya
            flex-1-e adja a magasságot, a lista kitölti és görget. */}
        <div className="max-h-[17rem] min-h-0 space-y-2 overflow-y-auto pr-1 xl:max-h-none xl:flex-1">
          {events.map((e) => {
            const key = `${e.date}:${e.kind}:${e.title}`;
            const Icon = EVENT_ICON[e.kind];
            const inner = (
              <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-brand)]/15 text-[var(--color-brand)]">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {e.title}
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {formatDate(e.date)} ·{" "}
                    {e.daysUntil === 0
                      ? "ma"
                      : `${e.daysUntil} nap múlva`}
                    {e.detail ? ` · ${e.detail}` : ""}
                  </div>
                </div>
                {e.amountHuf != null && (
                  <div className="amt text-right text-sm font-semibold tabular-nums">
                    {e.kind === "coupon" ? "+" : ""}
                    {formatMoney(e.amountHuf)}
                  </div>
                )}
              </div>
            );
            return e.accountId ? (
              <Link
                key={key}
                to={`/accounts/${e.accountId}`}
                className="block card-hover rounded-xl"
              >
                {inner}
              </Link>
            ) : (
              <div key={key}>{inner}</div>
            );
          })}
        </div>
      </Card>
    );

  return (
    <div>
      <PageHeader
        title="Áttekintés"
        action={
          <div className="flex items-center gap-3 text-sm">
            {priceUpdatedAt && (
              <span
                className="hidden items-center gap-1.5 rounded-full border border-[var(--color-positive)]/30 bg-[var(--color-positive)]/10 px-2.5 py-1 text-xs text-[var(--color-positive)] sm:inline-flex"
                title={`Árfolyamok frissítve: ${formatDateTime(priceUpdatedAt)}`}
              >
                <span className="live-dot relative h-1.5 w-1.5 rounded-full bg-[var(--color-positive)]" />
                élő · {relTime(priceUpdatedAt)}
              </span>
            )}
            {eurHuf && (
              <span className="hidden text-[var(--color-muted)] sm:inline">
                EUR/HUF{" "}
                <span className="font-medium text-[var(--color-text)]">
                  {eurHuf.toLocaleString("hu-HU", {
                    maximumFractionDigits: 2,
                  })}
                </span>
              </span>
            )}
            <PrivacyToggle className="btn-ghost hidden md:inline-flex" />
            <button
              className="btn-ghost"
              onClick={() => refreshPrices()}
              aria-label="Árfolyamok frissítése"
              disabled={pricesLoading}
              title={
                priceUpdatedAt
                  ? `Árfolyamok frissítve: ${formatDateTime(priceUpdatedAt)}`
                  : "Árfolyamok frissítése"
              }
            >
              <RefreshCw
                className={`h-4 w-4 ${pricesLoading ? "animate-spin" : ""}`}
              />
              <span className="hidden sm:inline">Árfolyamok</span>
            </button>
          </div>
        }
      />

      <NewsBanner />
      <AlertsPanel compact={isMobile} />

      {isMobile ? (
        <div className="mt-1 flex flex-col gap-4">
          {heroCard}
          <div className="mobile-swipe -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1">
            {[returnCard, investedCard, realizedCard].map((c, i) => (
              <div key={i} className="w-[72%] shrink-0 snap-start">
                {c}
              </div>
            ))}
          </div>
          {chartCard}
          <MobileAccounts accounts={summary.accounts} />
          <div
            role="tablist"
            aria-label="Áttekintés részletei"
            className="mobile-segments sticky top-[calc(3rem+env(safe-area-inset-top))] z-20 -mx-4 flex gap-1.5 px-4 py-1.5"
          >
            {DASH_TABS.filter((t) => t.key !== "events" || events.length > 0).map(
              (t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={mobileTab === t.key}
                  onClick={() => setMobileTab(t.key)}
                  className={`min-w-0 flex-1 rounded-full border px-2 py-1.5 text-[13px] font-medium transition-colors ${
                    mobileTab === t.key
                      ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)]/40 text-[var(--color-muted)]"
                  }`}
                >
                  {t.label}
                </button>
              ),
            )}
          </div>
          <NoCardEnter>
            <div
              key={mobileTab === "holdings" ? "holdings-on" : "holdings-off"}
              role="tabpanel"
              hidden={mobileTab !== "holdings"}
            >
              <HoldingsPanel maxBodyHeight="26rem" />
            </div>
            <div
              key={mobileTab === "market" ? "market-on" : "market-off"}
              role="tabpanel"
              hidden={mobileTab !== "market"}
              className="flex-col gap-4 [&:not([hidden])]:flex"
            >
              <LivePricesPanel />
              <NewsCard />
            </div>
            <div
              key={mobileTab === "allocation" ? "allocation-on" : "allocation-off"}
              role="tabpanel"
              hidden={mobileTab !== "allocation"}
            >
              {allocationCard}
            </div>
            <div
              key={mobileTab === "events" ? "events-on" : "events-off"}
              role="tabpanel"
              hidden={mobileTab !== "events"}
            >
              {eventsCard}
            </div>
          </NoCardEnter>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4 xl:flex-row xl:items-start">
          {/* Bal fő-oszlop: kártyák + grafikon + eszközeim */}
          <div
            ref={leftColRef}
            className="flex min-w-0 flex-1 flex-col gap-4"
            style={colH ? { height: colH } : undefined}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
              {heroCard}
              {returnCard}
              {investedCard}
              {realizedCard}
            </div>

            {chartCard}

            {/* Számláim — közvetlenül az Eszközeim fölött */}
            {accountsCard}

            {/* Cap the holdings list so a long portfolio scrolls instead of
                stretching the column (and dragging the right rail down with it). */}
            <HoldingsPanel maxBodyHeight="26rem" fill />
          </div>

          {/* Jobb oldalsáv: élő árfolyamok → hírek → allokáció → események. Its height is
              sized with the left column (colH, measured above); overflow-hidden
              keeps the flex-1 events card inside that cap, its list scrolling — so
              the card ends flush with the Eszközeim card's bottom. */}
          <div
            ref={railRef}
            className="flex w-full flex-col gap-4 xl:w-[400px] xl:shrink-0 xl:overflow-hidden"
            style={colH ? { height: colH } : undefined}
          >
            <LivePricesPanel />
            <NewsCard />
            {allocationCard}

            {/* Havi célok (DCA) — kompakt haladás-gyűrűk. Csak ha van cél. */}
            {goalsCard}

            {/* Közelgő események — a jobb oszlop alján; xl-en kitölti a maradék
                magasságot, hogy az alja az Eszközeim aljához érjen. */}
            {eventsCard}
          </div>
        </div>
      )}
    </div>
  );
}

type MobileTab = "holdings" | "market" | "allocation" | "events";

const DASH_TABS: { key: MobileTab; label: string }[] = [
  { key: "holdings", label: "Eszközök" },
  { key: "market", label: "Piac" },
  { key: "allocation", label: "Allokáció" },
  { key: "events", label: "Események" },
];

function MobileAccounts({ accounts }: { accounts: AccountSummary[] }) {
  return (
    <Card className="overflow-hidden !p-0">
      <div className="flex items-center justify-between px-4 pb-1 pt-4">
        <h2 className="text-base font-semibold">Számláim</h2>
        <Link
          to="/accounts"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-brand)]"
        >
          Összes <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <div className="divide-y divide-[var(--color-border)]/60">
        {accounts
          .filter((a) => !isEmptyAccount(a))
          .map((a) => (
            <Link
              key={a.account.id}
              to={`/accounts/${a.account.id}`}
              className="mobile-row flex items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {a.account.name}
                </div>
                <div className="text-xs text-[var(--color-muted)]">
                  {accountKindLabel(a.account)} · {a.holdings.length} pozíció
                </div>
              </div>
              <div className="text-right">
                <div className="amt text-sm font-semibold tabular-nums">
                  {formatMoney(a.totalValueHuf)}
                </div>
                {accountReturn(a) != null && (
                  <Delta pct={accountReturn(a)} className="text-xs" />
                )}
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
            </Link>
          ))}
      </div>
    </Card>
  );
}

const UPCOMING_EVENTS_ID = "upcoming-events";
/** The Eszközeim list's height cap (26rem) — see its maxBodyHeight. */
const HOLDINGS_BODY_MAX_PX = 26 * 16;
/** Header + ~2 event rows: the events card is never squeezed below this. */
const EVENTS_MIN_PX = 260;

const EVENT_ICON: Record<EventKind, typeof CalendarClock> = {
  tbsz: CalendarClock,
  maturity: Landmark,
  coupon: CoinsIcon,
};
