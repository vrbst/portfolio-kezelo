import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Coins,
  TrendingUp,
  Landmark,
  Receipt,
  Banknote,
  Globe2,
  Percent,
} from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import {
  computeIncomeByYear,
  computeReturns,
  fxImpact,
  buildValueSeries,
  type YearIncome,
} from "../lib/portfolio";
import {
  PageHeader,
  Card,
  StatCard,
  EmptyState,
  AnimatedAmount,
  Sparkline,
} from "../components/ui";
import { formatMoney, formatPercent, formatCompact } from "../lib/format";

export default function Income() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const historyFile = usePortfolio((s) => s.historyFile);
  const summary = usePortfolioSummary();

  // FX vs. market decomposition of the unrealized P/L (non-HUF holdings).
  const fxi = useMemo(() => fxImpact(summary), [summary]);

  // Estimated annual fund cost from the user-entered TER per instrument.
  const terRows = useMemo(() => {
    const rows: { key: string; name: string; valueHuf: number; ter: number }[] =
      [];
    for (const acc of summary.accounts) {
      for (const h of acc.holdings) {
        const ter = h.instrument?.terPct;
        if (!ter || !(h.marketValueHuf ?? 0)) continue;
        const existing = rows.find((r) => r.key === h.instrumentKey);
        if (existing) existing.valueHuf += h.marketValueHuf ?? 0;
        else
          rows.push({
            key: h.instrumentKey,
            name: h.instrument?.name ?? h.instrumentKey,
            valueHuf: h.marketValueHuf ?? 0,
            ter,
          });
      }
    }
    return rows.sort((a, b) => b.valueHuf * b.ter - a.valueHuf * a.ter);
  }, [summary]);
  const terAnnualHuf = terRows.reduce((s, r) => s + r.valueHuf * r.ter, 0);

  const instMap = useMemo(
    () => new Map(instruments.map((i) => [i.key, i])),
    [instruments],
  );

  const years = useMemo(
    () => computeIncomeByYear(accounts, transactions, instMap, fx),
    [accounts, transactions, instMap, fx],
  );

  const returns = useMemo(
    () =>
      computeReturns(accounts, transactions, instMap, prices, fx, historyFile),
    [accounts, transactions, instMap, prices, fx, historyFile],
  );

  // Portfolio profit (value − invested) over time → the Teljesítmény sparkline.
  const profitSpark = useMemo(() => {
    const series = buildValueSeries(
      accounts,
      transactions,
      instMap,
      prices,
      fx,
      historyFile,
    );
    return series.slice(-40).map((p) => p.value - p.invested);
  }, [accounts, transactions, instMap, prices, fx, historyFile]);
  const sparkUp =
    profitSpark.length > 1 &&
    profitSpark[profitSpark.length - 1] >= profitSpark[0];

  const total = useMemo(
    () =>
      years.reduce(
        (acc, y) => ({
          realizedPlHuf: acc.realizedPlHuf + y.realizedPlHuf,
          interestHuf: acc.interestHuf + y.interestHuf,
          dividendHuf: acc.dividendHuf + y.dividendHuf,
          feesHuf: acc.feesHuf + y.feesHuf,
          taxHuf: acc.taxHuf + y.taxHuf,
        }),
        {
          realizedPlHuf: 0,
          interestHuf: 0,
          dividendHuf: 0,
          feesHuf: 0,
          taxHuf: 0,
        },
      ),
    [years],
  );

  if (transactions.length === 0) {
    return (
      <div>
        <PageHeader title="Realizált hozam" />
        <EmptyState
          title="Még nincsenek adatok"
          description="Importálj kivonatokat, és itt jelenik meg a realizált hozamod évenként."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás
            </Link>
          }
        />
      </div>
    );
  }

  const net =
    total.realizedPlHuf +
    total.interestHuf +
    total.dividendHuf -
    total.feesHuf -
    total.taxHuf;

  return (
    <div>
      <PageHeader
        title="Hozam"
        subtitle="Teljesítmény-mutatók és a realizált eredmény évenként."
      />

      <Card className="mb-6 p-6">
        <h2 className="mb-1 text-lg font-semibold">Teljesítmény</h2>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          Évesített hozam-mutatók ({returns.days} nap adat alapján).
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Metric
            label="XIRR — pénzsúlyozott"
            pct={returns.xirrPct}
            hint="A te pénzed tényleges évesített hozama, a be- és kifizetések időzítését is figyelembe véve."
          />
          <Metric
            label="TWR — idősúlyozott"
            pct={returns.twrPct}
            sub={
              returns.twrCumulativePct != null
                ? `${formatPercent(returns.twrCumulativePct)} a teljes időszakban`
                : undefined
            }
            spark={profitSpark}
            sparkStroke={
              sparkUp ? "var(--color-positive)" : "var(--color-negative)"
            }
            hint="A befektetéseid teljesítménye, a befizetések időzítésétől megtisztítva — benchmarkhoz."
          />
          <Metric
            label="Egyszerű hozam"
            pct={returns.simplePct}
            hint="Jelenlegi érték a befektetett tőkéhez képest. A befizetések időzítése torzítja."
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Realizált árfolyameredmény"
          numericValue={total.realizedPlHuf}
          format={(n) => formatMoney(n, "HUF", { sign: true })}
          icon={<TrendingUp className="h-5 w-5" />}
          index={0}
          accent
        />
        <StatCard
          label="Kapott kamat"
          numericValue={total.interestHuf}
          format={(n) => formatMoney(n)}
          icon={<Landmark className="h-5 w-5" />}
          index={1}
        />
        <StatCard
          label="Osztalék"
          numericValue={total.dividendHuf}
          format={(n) => formatMoney(n)}
          icon={<Coins className="h-5 w-5" />}
          index={2}
        />
        <StatCard
          label="Fizetett díjak"
          numericValue={total.feesHuf}
          format={(n) => formatMoney(n)}
          icon={<Receipt className="h-5 w-5" />}
          index={3}
        />
      </div>

      {/* Nettó pénzbeáramlás — a "amit a befektetéseid ténylegesen termeltek"
          szám, hero-kiemeléssel. */}
      <div className="relative mt-4 overflow-hidden rounded-2xl border border-[var(--color-brand)]/30 bg-[var(--color-surface)] p-5 ring-1 ring-[var(--color-brand)]/20 sm:p-6">
        <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-[var(--color-brand)]/20 blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-brand)]/15 text-[var(--color-brand)]">
              <Banknote className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-medium">Nettó pénzbeáramlás</div>
              <div className="text-xs text-[var(--color-muted)]">
                realizált + kamat + osztalék − díj − adó
              </div>
            </div>
          </div>
          <div
            className={`amt text-2xl font-bold tracking-tight tabular-nums sm:text-3xl ${
              net >= 0
                ? "text-[var(--color-positive)]"
                : "text-[var(--color-negative)]"
            }`}
          >
            <AnimatedAmount
              value={net}
              format={(n) => formatMoney(n, "HUF", { sign: true })}
            />
          </div>
        </div>
      </div>

      {/* Devizahatás-felbontás + költség-analitika */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Math.abs(fxi.valueHuf) > 1 && (
          <Card className="p-6">
            <div className="mb-1 flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-[var(--color-brand)]" />
              <h2 className="text-lg font-semibold">Devizahatás</h2>
            </div>
            <p className="mb-4 text-sm text-[var(--color-muted)]">
              A külföldi devizás papírok nem realizált hozamából mennyi a piac
              és mennyi az árfolyammozgás (a vételi átlagárfolyamhoz képest).
            </p>
            <div className="space-y-3 text-sm">
              <FxDivergingRow
                label="Piaci árváltozás"
                value={fxi.marketHuf}
                max={Math.max(Math.abs(fxi.marketHuf), Math.abs(fxi.fxHuf), 1)}
              />
              <FxDivergingRow
                label="Árfolyamhatás (deviza)"
                value={fxi.fxHuf}
                max={Math.max(Math.abs(fxi.marketHuf), Math.abs(fxi.fxHuf), 1)}
              />
              <div className="flex items-baseline justify-between gap-3 border-t border-[var(--color-border)] pt-2">
                <span className="text-[var(--color-muted)]">
                  Összesen (nem realizált)
                </span>
                <span
                  className={`amt font-semibold tabular-nums ${
                    fxi.totalHuf >= 0
                      ? "text-[var(--color-positive)]"
                      : "text-[var(--color-negative)]"
                  }`}
                >
                  {formatMoney(fxi.totalHuf, "HUF", { sign: true })}
                </span>
              </div>
            </div>
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Ha az árfolyamhatás dominál, a hozamod nagy része az EUR/HUF
              mozgásból jön — ez visszafordulhat.
            </p>
          </Card>
        )}

        <Card className="p-6">
          <div className="mb-1 flex items-center gap-2">
            <Percent className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Költségek</h2>
          </div>
          <p className="mb-4 text-sm text-[var(--color-muted)]">
            Eddig kifizetett díjak és a tartás becsült éves alapkezelési
            költsége (TER).
          </p>
          <div className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[var(--color-muted)]">
                Fizetett díjak összesen
              </span>
              <span className="amt font-semibold tabular-nums">
                {formatMoney(total.feesHuf)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[var(--color-muted)]">
                Levont adó összesen
              </span>
              <span className="amt font-semibold tabular-nums">
                {formatMoney(total.taxHuf)}
              </span>
            </div>
            {terRows.length > 0 ? (
              <>
                <div className="flex items-baseline justify-between gap-3 border-t border-[var(--color-border)] pt-2">
                  <span className="text-[var(--color-muted)]">
                    Becsült ETF-költség (TER)
                  </span>
                  <span className="amt font-semibold tabular-nums">
                    ~{formatMoney(terAnnualHuf)} / év
                  </span>
                </div>
                <ul className="space-y-1 text-xs text-[var(--color-muted)]">
                  {terRows.map((r) => (
                    <li key={r.key} className="flex justify-between gap-3">
                      <span className="truncate">
                        {r.name} ({(r.ter * 100).toFixed(2)}%)
                      </span>
                      <span className="amt shrink-0 tabular-nums">
                        ~{formatMoney(r.valueHuf * r.ter)} / év
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-muted)]">
                Az ETF-ek éves költségének becsléséhez add meg a TER-t a
                Beállítások → Árfolyamok szekcióban (pl. VWCE: 0,22%).
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Évenkénti hozam-bontás: diverging stacked oszlopok a tábla fölé */}
      <YearReturnChart years={years} />

      <Card className="mt-4 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-3 font-medium">Év</th>
                <th className="px-4 py-3 text-right font-medium">
                  Árfolyameredmény
                </th>
                <th className="px-4 py-3 text-right font-medium">Kamat</th>
                <th className="px-4 py-3 text-right font-medium">Osztalék</th>
                <th className="px-4 py-3 text-right font-medium">Díjak</th>
                <th className="px-4 py-3 text-right font-medium">Adó</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr
                  key={y.year}
                  className="border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40"
                >
                  <td className="px-4 py-3 font-medium">{y.year}</td>
                  <td
                    className={`amt px-4 py-3 text-right tabular-nums ${
                      y.realizedPlHuf < 0
                        ? "text-[var(--color-negative)]"
                        : "text-[var(--color-positive)]"
                    }`}
                  >
                    {formatMoney(y.realizedPlHuf, "HUF", { sign: true })}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums">
                    {formatMoney(y.interestHuf)}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums">
                    {formatMoney(y.dividendHuf)}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                    {formatMoney(y.feesHuf)}
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]">
                    {formatMoney(y.taxHuf)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
        Az XIRR (pénzsúlyozott) a saját pénzed évesített hozama; a TWR
        (idősúlyozott) a befektetések teljesítménye a befizetések időzítésétől
        függetlenül. A mutatók az állampapírokat a visszaváltási díj nélkül,
        felhalmozott kamattal értékelik (lejáratig tartást feltételezve) — a
        dashboard összértéke ennél óvatosabb: a ma visszaváltható összeget
        mutatja. Friss portfóliónál az évesítés még zajos lehet. A realizált
        eredmény átlagos bekerülési áron, a vételkori árfolyamon számol. A díjak
        tájékoztató jellegűek (a vétel díja a bekerülésben is benne van). A
        lakossági állampapír kamata és a TBSZ a lekötési időszak alatt
        adómentes.
      </p>
    </div>
  );
}

/** A label + signed amount with a diverging bar from the centre (right = +,
 * left = −), sized against `max`. Shows at a glance which side a factor pulls. */
function FxDivergingRow({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  const frac = Math.min(Math.abs(value) / max, 1) * 50; // half-width max
  const positive = value >= 0;
  const color = positive ? "var(--color-positive)" : "var(--color-negative)";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[var(--color-muted)]">{label}</span>
        <span className="amt font-semibold tabular-nums" style={{ color }}>
          {formatMoney(value, "HUF", { sign: true })}
        </span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)]">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border)]" />
        <span
          className="absolute inset-y-0 rounded-full"
          style={{
            background: color,
            width: `${frac}%`,
            left: positive ? "50%" : `${50 - frac}%`,
          }}
        />
      </div>
    </div>
  );
}

/**
 * Per-year return breakdown as a diverging stacked bar chart: income
 * (realised + interest + dividend) above the zero line, costs (fees + tax)
 * below. One positive hue, one indigo, one negative — the zero line + gaps do
 * the separating (validated adjacent-pairs; see the palette check).
 */
function YearReturnChart({ years }: { years: YearIncome[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = years.filter(
    (y) =>
      Math.abs(y.realizedPlHuf) +
        y.interestHuf +
        y.dividendHuf +
        y.feesHuf +
        y.taxHuf >
      0,
  );
  if (rows.length === 0) return null;

  // Positive stack = income; negative stack = costs (+ a negative realised P/L).
  const posOf = (y: YearIncome) =>
    Math.max(0, y.realizedPlHuf) + y.interestHuf + y.dividendHuf;
  const negOf = (y: YearIncome) =>
    Math.max(0, -y.realizedPlHuf) + y.feesHuf + y.taxHuf;
  const max = Math.max(...rows.map((y) => Math.max(posOf(y), negOf(y))), 1);

  const GREEN = "var(--color-positive)";
  const INDIGO = "var(--color-brand)";
  const PINK = "var(--color-negative)";
  const seg = (v: number, color: string, key: string) =>
    v > 0 ? (
      <div
        key={key}
        className="w-full first:rounded-t last:rounded-b"
        style={{
          height: `${(v / max) * 50}%`,
          background: color,
          marginBottom: 1,
        }}
      />
    ) : null;

  return (
    <Card className="mt-6 p-5 sm:p-6">
      <h2 className="mb-1 text-lg font-semibold">Éves hozam-bontás</h2>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Bevétel a nullvonal fölött (realizált + kamat + osztalék), költség
        alatta (díj + adó).
      </p>
      <div className="flex items-stretch gap-4 sm:gap-8">
        {rows.map((y) => {
          const active = hover === y.year;
          return (
            <div
              key={y.year}
              className="flex w-24 flex-col items-center gap-2 sm:w-28"
              onMouseEnter={() => setHover(y.year)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="relative h-48 w-full">
                {active && (
                  <div className="amt pointer-events-none absolute -top-1 left-1/2 z-10 w-44 -translate-x-1/2 -translate-y-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs shadow-xl">
                    <div className="mb-1 font-semibold">{y.year}</div>
                    <TipLine
                      label="Realizált"
                      value={y.realizedPlHuf}
                      dot={INDIGO}
                    />
                    <TipLine label="Kamat" value={y.interestHuf} dot={GREEN} />
                    {y.dividendHuf > 0 && (
                      <TipLine
                        label="Osztalék"
                        value={y.dividendHuf}
                        dot={GREEN}
                      />
                    )}
                    <TipLine label="Díjak" value={-y.feesHuf} dot={PINK} />
                    {y.taxHuf > 0 && (
                      <TipLine label="Adó" value={-y.taxHuf} dot={PINK} />
                    )}
                  </div>
                )}
                {/* Top half: income (grows down from the middle) */}
                <div className="absolute inset-x-0 top-0 flex h-1/2 flex-col justify-end">
                  {seg(Math.max(0, y.realizedPlHuf), INDIGO, "r+")}
                  {seg(y.dividendHuf, GREEN, "d")}
                  {seg(y.interestHuf, GREEN, "i")}
                </div>
                {/* Zero line */}
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--color-border)]" />
                {/* Bottom half: costs (grows down from the middle) */}
                <div className="absolute inset-x-0 top-1/2 flex h-1/2 flex-col justify-start">
                  {seg(Math.max(0, -y.realizedPlHuf), INDIGO, "r-")}
                  {seg(y.feesHuf, PINK, "f")}
                  {seg(y.taxHuf, PINK, "t")}
                </div>
              </div>
              <span className="text-xs font-medium tabular-nums">{y.year}</span>
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--color-muted)]">
        <LegendDot color={GREEN} label="Kamat / osztalék" />
        <LegendDot color={INDIGO} label="Realizált árfolyam" />
        <LegendDot color={PINK} label="Díj / adó" />
      </div>
    </Card>
  );
}

function TipLine({
  label,
  value,
  dot,
}: {
  label: string;
  value: number;
  dot: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: dot }}
        />
        {label}
      </span>
      <span
        className={`amt tabular-nums ${
          value >= 0
            ? "text-[var(--color-positive)]"
            : "text-[var(--color-negative)]"
        }`}
      >
        {formatCompact(value)}
      </span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function Metric({
  label,
  pct,
  sub,
  hint,
  spark,
  sparkStroke,
}: {
  label: string;
  pct?: number;
  sub?: string;
  hint?: string;
  /** Optional trend line drawn under the number. */
  spark?: number[];
  sparkStroke?: string;
}) {
  const color =
    pct == null
      ? "text-[var(--color-muted)]"
      : pct >= 0
        ? "text-[var(--color-positive)]"
        : "text-[var(--color-negative)]";
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {pct == null ? (
          "—"
        ) : (
          <AnimatedAmount value={pct} format={(n) => formatPercent(n)} />
        )}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">{sub}</div>
      )}
      {spark && spark.length >= 2 && (
        <div className="mt-2 h-8 w-full">
          <Sparkline
            data={spark}
            stroke={sparkStroke}
            className="h-full w-full"
          />
        </div>
      )}
      {hint && (
        <div className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
          {hint}
        </div>
      )}
    </div>
  );
}
