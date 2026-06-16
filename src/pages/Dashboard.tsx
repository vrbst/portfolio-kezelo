import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import {
  Wallet,
  TrendingUp,
  PiggyBank,
  Coins,
  ArrowRight,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import {
  accountReturn,
  isEmptyAccount,
  buildValueSeries,
  allocationByClass,
  allocationByCurrency,
} from "../lib/portfolio";
import { upcomingEvents, type EventKind } from "../lib/events";
import ValueChart from "../components/ValueChart";
import HoldingsPanel from "../components/HoldingsPanel";
import AlertsPanel from "../components/AlertsPanel";
import LivePricesPanel from "../components/LivePricesPanel";
import {
  PageHeader,
  StatCard,
  Card,
  EmptyState,
  Delta,
  Badge,
  Amt,
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

const COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#22d3ee",
  "#34d399",
  "#fbbf24",
  "#fb7185",
];

type RangeKey = "1m" | "3m" | "6m" | "1y" | "ytd" | "max";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "1m", label: "1H" },
  { key: "3m", label: "3H" },
  { key: "6m", label: "6H" },
  { key: "1y", label: "1É" },
  { key: "ytd", label: "Idei" },
  { key: "max", label: "Max" },
];

/** Earliest YYYY-MM-DD to keep for a range (null = everything). */
function rangeCutoff(key: RangeKey, now = new Date()): string | null {
  if (key === "max") return null;
  const d = new Date(now);
  if (key === "ytd") return `${d.getFullYear()}-01-01`;
  const days = key === "1m" ? 30 : key === "3m" ? 90 : key === "6m" ? 180 : 365;
  d.setDate(d.getDate() - days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function Dashboard() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const historyFile = usePortfolio((s) => s.historyFile);
  const summary = usePortfolioSummary();
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const pricesLoading = usePortfolio((s) => s.pricesLoading);
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt);
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);
  const privacy = usePortfolio((s) => s.privacy);
  const togglePrivacy = usePortfolio((s) => s.togglePrivacy);

  const valueSeries = useMemo(
    () =>
      buildValueSeries(
        accounts,
        transactions,
        new Map(instruments.map((i) => [i.key, i])),
        prices,
        fx,
        historyFile,
      ),
    [accounts, transactions, instruments, prices, fx, historyFile],
  );

  const [range, setRange] = useState<RangeKey>("max");

  // Which ranges actually contain ≥2 points (others are disabled, not silent).
  const rangeAvail = useMemo(() => {
    const map = {} as Record<RangeKey, boolean>;
    for (const r of RANGES) {
      const cutoff = rangeCutoff(r.key);
      map[r.key] =
        !cutoff || valueSeries.filter((p) => p.date >= cutoff).length >= 2;
    }
    return map;
  }, [valueSeries]);

  const rangedSeries = useMemo(() => {
    const cutoff = rangeCutoff(range);
    if (!cutoff) return valueSeries;
    const f = valueSeries.filter((p) => p.date >= cutoff);
    return f.length >= 2 ? f : valueSeries;
  }, [valueSeries, range]);

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

  const events = useMemo(() => upcomingEvents(summary).slice(0, 12), [summary]);

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

  return (
    <div>
      <PageHeader
        title="Áttekintés"
        subtitle="A teljes portfóliód egy helyen."
        action={
          <div className="flex items-center gap-3 text-sm">
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
            <button
              className="btn-ghost"
              onClick={togglePrivacy}
              title={privacy ? "Összegek megjelenítése" : "Összegek elrejtése"}
            >
              {privacy ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">
                {privacy ? "Megmutat" : "Elrejt"}
              </span>
            </button>
            <button
              className="btn-ghost"
              onClick={() => refreshPrices()}
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
              Árfolyamok
            </button>
          </div>
        }
      />

      <AlertsPanel />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Teljes érték"
          value={formatMoney(summary.totalValueHuf)}
          sub={eurEquivalent(summary.totalValueHuf, eurHuf)}
          icon={<Wallet className="h-5 w-5" />}
          index={0}
          accent
        />
        <StatCard
          label="Teljes hozam"
          value={formatMoney(summary.totalPlHuf, "HUF", { sign: true })}
          sub={eurEquivalent(summary.totalPlHuf, eurHuf, { sign: true })}
          deltaPct={summary.totalReturnPct}
          icon={<TrendingUp className="h-5 w-5" />}
          index={1}
        />
        <StatCard
          label="Befektetett tőke"
          value={formatMoney(summary.netDepositedHuf)}
          icon={<PiggyBank className="h-5 w-5" />}
          index={2}
        />
        <StatCard
          label="Realizált eredmény"
          value={formatMoney(
            summary.totalPlHuf - summary.unrealizedPlHuf,
            "HUF",
            {
              sign: true,
            },
          )}
          sub={
            summary.interestHuf > 0.5
              ? `ebből kamat: ${formatMoney(summary.interestHuf, "HUF", {
                  sign: true,
                })}`
              : undefined
          }
          icon={<Coins className="h-5 w-5" />}
          index={3}
        />
      </div>

      <LivePricesPanel />

      <div className="mt-4 flex flex-col gap-4 xl:flex-row">
        {/* Bal fő-oszlop: grafikon + eszközeim */}
        <div className="min-w-0 flex-1 space-y-4">
          {valueSeries.length > 1 && (
            <Card className="p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Érték az időben</h2>
                  <p className="text-sm text-[var(--color-muted)]">
                    Portfólió érték (kitöltött) vs. befektetett tőke
                    (szaggatott)
                  </p>
                </div>
                <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
                  {RANGES.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setRange(r.key)}
                      disabled={!rangeAvail[r.key]}
                      className={`rounded-md px-2.5 py-1 transition disabled:cursor-not-allowed disabled:opacity-30 ${
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
              <ValueChart data={rangedSeries} />
            </Card>
          )}

          <HoldingsPanel />
        </div>

        {/* Jobb oldalsáv: allokáció + számlák + események */}
        <div className="w-full space-y-4 xl:w-[400px] xl:shrink-0">
          {/* Allocation donut */}
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
                  >
                    {allocation.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v) =>
                      privacy ? "•••" : formatMoney(Number(v))
                    }
                    contentStyle={tooltipStyle}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xs text-[var(--color-muted)]">
                  Összesen
                </span>
                <span className="amt text-xl font-semibold">
                  {formatMoney(summary.totalValueHuf)}
                </span>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {allocation.map((a, i) => (
                <div key={a.name} className="flex items-center gap-2 text-sm">
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

          {/* Accounts breakdown */}
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
            <div className="space-y-3">
              {summary.accounts.map((a) => (
                <Link key={a.account.id} to={`/accounts/${a.account.id}`}>
                  <div className="card-hover flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {a.account.name}
                        </span>
                        <Badge tone="neutral">
                          {accountKindLabel(a.account)}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {a.holdings.length} pozíció · készpénz{" "}
                        <Amt>{formatMoney(a.cashValueHuf)}</Amt>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="amt font-semibold tabular-nums">
                        {formatMoney(a.totalValueHuf)}
                      </div>
                      {isEmptyAccount(a) ? (
                        <Badge tone="neutral">üres</Badge>
                      ) : (
                        accountReturn(a) != null && (
                          <Delta pct={accountReturn(a)} className="text-xs" />
                        )
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </Card>

          {events.length > 0 && (
            <Card className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <CalendarClock className="h-5 w-5 text-[var(--color-brand)]" />
                <h2 className="text-lg font-semibold">Közelgő események</h2>
              </div>
              <div className="space-y-2">
                {events.map((e, i) => {
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
                      key={i}
                      to={`/accounts/${e.accountId}`}
                      className="block card-hover rounded-xl"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={i}>{inner}</div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

const EVENT_ICON: Record<EventKind, typeof CalendarClock> = {
  tbsz: CalendarClock,
  maturity: Landmark,
  coupon: CoinsIcon,
};

const tooltipStyle = {
  background: "#141a2e",
  border: "1px solid #232b45",
  borderRadius: 12,
  color: "#e8ecf8",
} as const;
