import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, Card, StatCard, EmptyState, Amt } from "../components/ui";
import CashflowChart from "../components/CashflowChart";
import InfoTip from "../components/InfoTip";
import { useCashflow, useCashflowSettings } from "../lib/storeHooks";
import {
  cashflowAverage,
  cashflowCategories,
  cashflowTotals,
  excludeKey,
  monthLabel,
  saveCashflowSettings,
} from "../lib/cashflow";
import { formatMoney, formatPercent } from "../lib/format";

const RANGES = [
  { n: 6, label: "6 hónap" },
  { n: 12, label: "12 hónap" },
  { n: 24, label: "24 hónap" },
  { n: 0, label: "Mind" },
] as const;

export default function Cashflow() {
  const months = useCashflow();
  const settings = useCashflowSettings();
  const [range, setRange] = useState<number>(12);

  const totals = useMemo(() => cashflowTotals(months, settings), [months, settings]);
  const shown = range > 0 ? totals.slice(-range) : totals;
  const average = useMemo(
    () => cashflowAverage(totals, range > 0 ? range : 1200, settings.since),
    [totals, range, settings.since],
  );
  // The months a stage can start at: any complete one (the running month has no average yet).
  const startOptions = useMemo(() => totals.filter((t) => t.complete).map((t) => t.month).reverse(), [totals]);

  const categories = useMemo(() => {
    const keep = new Set(shown.map((t) => t.month));
    return cashflowCategories(months.filter((m) => keep.has(m.month)));
  }, [months, shown]);
  const excluded = new Set(settings.excluded);

  if (months.length === 0) {
    return (
      <div>
        <PageHeader title="Pénzáramlás" />
        <EmptyState
          title="Még nincs bevétel- és kiadásadat"
          description="Az 1Money-ban készíts CSV-exportot, és töltsd fel az Importálás oldalon. Csak havi összegek kerülnek be, egyes tételek nem."
          action={
            <Link to="/import" className="btn-primary">
              Importálás
            </Link>
          }
        />
      </div>
    );
  }

  const toggle = (kind: "income" | "expense", name: string) => {
    const key = excludeKey(kind, name);
    saveCashflowSettings({
      ...settings,
      excluded: excluded.has(key)
        ? settings.excluded.filter((x) => x !== key)
        : [...settings.excluded, key],
    });
  };

  const last = totals[totals.length - 1];
  return (
    <div>
      <PageHeader
        title="Pénzáramlás"
        info="Havi bevétel és kiadás az 1Money-exportból. Csak összegek vannak itt kategóriánként, egyes tételek, számlák és megjegyzések nem. Az átlag csak a lezárt hónapokból számol."
        subtitle={`${monthLabel(totals[0].month, true)} – ${monthLabel(last.month, true)}${last.complete ? "" : " (az utolsó hónap még nem teljes)"}`}
        action={
          <div className="flex gap-1" role="group" aria-label="Időszak">
            {RANGES.map((r) => (
              <button
                key={r.n}
                className={r.n === range ? "btn-primary" : "btn-ghost"}
                aria-pressed={r.n === range}
                onClick={() => setRange(r.n)}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      <Card className="mb-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="cf-since" className="flex items-center gap-1.5 text-sm font-medium">
            Az átlag kezdete
            <InfoTip>
              Az új élethelyzet (pl. a hitel megszűnése) előtti hónapok kimaradnak az átlagokból és a javaslatból, a
              grafikonon viszont ott maradnak. Ha nincs határ, a legutóbbi lezárt hónapok átlaga számít.
            </InfoTip>
          </label>
          <select
            id="cf-since"
            className="max-w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value={settings.since ?? ""}
            onChange={(e) => saveCashflowSettings({ ...settings, since: e.target.value || undefined })}
          >
            <option value="">Nincs határ</option>
            {settings.since && !startOptions.includes(settings.since) && (
              <option value={settings.since}>{monthLabel(settings.since, true)}</option>
            )}
            {startOptions.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m, true)}
              </option>
            ))}
          </select>
          {settings.since && (
            <button className="btn-ghost" onClick={() => saveCashflowSettings({ ...settings, since: undefined })}>
              Nincs határ
            </button>
          )}
        </div>
      </Card>

      {average ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Havi bevétel (átlag)"
            value={<Amt>{formatMoney(average.income)}</Amt>}
            sub={`${average.months} lezárt hónap${settings.since ? ` (kezdet: ${monthLabel(settings.since, true)})` : ""}`}
          />
          <StatCard label="Havi kiadás (átlag)" value={<Amt>{formatMoney(average.expense)}</Amt>} index={1} />
          <StatCard label="Havi megtakarítás (átlag)" value={<Amt>{formatMoney(average.saving)}</Amt>} index={2} />
          <StatCard
            label="Megtakarítási ráta"
            value={average.rate == null ? "—" : formatPercent(average.rate, 0)}
            sub="a bevétel hányadrésze"
            index={3}
          />
        </div>
      ) : (
        <Card className="p-4 text-sm text-[var(--color-muted)]">
          Még nincs lezárt hónap az időszakban, ezért átlag sincs.
        </Card>
      )}

      {average && average.excludedIncome > 0 && (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          A kizárt bevételek (pl. egyszeri eladások) havi átlagban{" "}
          <Amt>{formatMoney(average.excludedIncome)}</Amt>: ez valódi pénz, csak nem rendszeres, ezért nincs benne a
          havi bevételben és a megtakarításban.
        </p>
      )}

      <Card className="mt-6 p-4">
        <h2 className="mb-3 text-lg font-semibold">Havi bevétel és kiadás</h2>
        <CashflowChart data={shown} />
        <div className="mt-2 flex gap-4 text-xs text-[var(--color-muted)]">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-positive)" }} />
            Bevétel
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-negative)" }} />
            Kiadás
          </span>
        </div>
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-lg font-semibold">Kategóriák</h2>
          <p className="text-xs text-[var(--color-muted)]">
            A kihúzott kategória nem számít bele az átlagokba (pl. a befektetésnek könyvelt kiadás vagy egy visszatérítés).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-2 font-medium">Számít</th>
                <th className="px-4 py-2 font-medium">Kategória</th>
                <th className="px-4 py-2 font-medium">Fajta</th>
                <th className="px-4 py-2 text-right font-medium">Összesen</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr
                  key={`${c.kind}:${c.name}`}
                  className={`border-b border-[var(--color-border)]/50 last:border-0 ${excluded.has(excludeKey(c.kind, c.name)) ? "opacity-50" : ""}`}
                >
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={!excluded.has(excludeKey(c.kind, c.name))}
                      onChange={() => toggle(c.kind, c.name)}
                      aria-label={`${c.name} (${c.kind === "income" ? "bevétel" : "kiadás"}) beleszámít az átlagokba`}
                    />
                  </td>
                  <td className="priv px-4 py-2">{c.name}</td>
                  <td className="px-4 py-2 text-[var(--color-muted)]">
                    {c.kind === "income" ? "Bevétel" : "Kiadás"}
                  </td>
                  <td className="amt px-4 py-2 text-right tabular-nums">{formatMoney(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-6 p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.remind}
            onChange={(e) => saveCashflowSettings({ ...settings, remind: e.target.checked })}
          />
          Havi teendő: szóljon, ha az előző hónap 1Money-exportja hiányzik
        </label>
      </Card>
    </div>
  );
}
