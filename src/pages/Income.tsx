import { useMemo } from "react";
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
} from "../lib/portfolio";
import { PageHeader, Card, StatCard, EmptyState } from "../components/ui";
import { formatMoney, formatPercent } from "../lib/format";

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
          label="Realizált eredmény"
          value={formatMoney(total.realizedPlHuf, "HUF", { sign: true })}
          icon={<TrendingUp className="h-5 w-5" />}
          index={0}
          accent
        />
        <StatCard
          label="Kapott kamat"
          value={formatMoney(total.interestHuf)}
          icon={<Landmark className="h-5 w-5" />}
          index={1}
        />
        <StatCard
          label="Osztalék"
          value={formatMoney(total.dividendHuf)}
          icon={<Coins className="h-5 w-5" />}
          index={2}
        />
        <StatCard
          label="Fizetett díjak"
          value={formatMoney(total.feesHuf)}
          icon={<Receipt className="h-5 w-5" />}
          index={3}
        />
      </div>

      <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-5 py-4">
        <Banknote className="h-5 w-5 text-[var(--color-brand)]" />
        <span className="text-sm text-[var(--color-muted)]">
          Nettó pénzbeáramlás (realizált + kamat + osztalék − díj − adó)
        </span>
        <span className="amt ml-auto text-lg font-semibold tabular-nums">
          {formatMoney(net, "HUF", { sign: true })}
        </span>
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
            <div className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--color-muted)]">
                  Piaci árváltozás
                </span>
                <span
                  className={`amt font-semibold tabular-nums ${
                    fxi.marketHuf >= 0
                      ? "text-[var(--color-positive)]"
                      : "text-[var(--color-negative)]"
                  }`}
                >
                  {formatMoney(fxi.marketHuf, "HUF", { sign: true })}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--color-muted)]">
                  Árfolyamhatás (deviza)
                </span>
                <span
                  className={`amt font-semibold tabular-nums ${
                    fxi.fxHuf >= 0
                      ? "text-[var(--color-positive)]"
                      : "text-[var(--color-negative)]"
                  }`}
                >
                  {formatMoney(fxi.fxHuf, "HUF", { sign: true })}
                </span>
              </div>
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

      <Card className="mt-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-3 font-medium">Év</th>
                <th className="px-4 py-3 text-right font-medium">Realizált</th>
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

function Metric({
  label,
  pct,
  sub,
  hint,
}: {
  label: string;
  pct?: number;
  sub?: string;
  hint?: string;
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
        {pct == null ? "—" : formatPercent(pct)}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">{sub}</div>
      )}
      {hint && (
        <div className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
          {hint}
        </div>
      )}
    </div>
  );
}
