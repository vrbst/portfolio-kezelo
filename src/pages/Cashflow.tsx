import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, Card, StatCard, EmptyState, Amt } from "../components/ui";
import CashflowChart from "../components/CashflowChart";
import InfoTip from "../components/InfoTip";
import {
  useCashflow,
  useCashflowSettings,
  usePortfolio,
  usePortfolioSummary,
  useReservedCash,
} from "../lib/store";
import {
  cashflowAverage,
  cashflowCategories,
  cashflowTotals,
  emergencyReserve,
  excludeKey,
  isFixBond,
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
  const accounts = usePortfolio((s) => s.accounts);
  const summary = usePortfolioSummary();
  const goalHeld = useReservedCash();
  // The securities one can pick as the reserve: each held one once, the Fix bond first.
  const holdingOptions = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string }>();
    for (const a of summary.accounts)
      for (const h of a.holdings)
        if (!byKey.has(h.instrumentKey)) byKey.set(h.instrumentKey, { key: h.instrumentKey, name: h.instrument?.name ?? h.instrumentKey });
    const fix = (n: string) => (isFixBond(n) ? 0 : 1);
    return [...byKey.values()].sort((x, y) => fix(x.name) - fix(y.name) || x.name.localeCompare(y.name, "hu"));
  }, [summary]);
  const reserve = useMemo(
    () => emergencyReserve(summary, months, settings, goalHeld),
    [summary, months, settings, goalHeld],
  );

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

      <Card className="mt-6 p-4" id="vesztartalek">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          Vésztartalék
          <InfoTip>
            Hány havi kiadásnak megfelelő készpénzt akarsz tartalékban tartani. A cél az átlagos havi kiadásodból
            (a kizárt kategóriák és az átlag kezdete szerint) számolódik. A kijelölt számlák készpénze adja a
            tartalékot, ami a célokra félretett pénz után marad. Ez a rész nem számít parlagon álló készpénznek.
          </InfoTip>
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label htmlFor="cf-reserve" className="text-sm">
            Tartalék
          </label>
          <select
            id="cf-reserve"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value={settings.reserveMonths ?? 0}
            onChange={(e) =>
              saveCashflowSettings({ ...settings, reserveMonths: Number(e.target.value) || undefined })
            }
          >
            <option value={0}>Nincs</option>
            {[...new Set([3, 6, 9, 12, 18, 24, ...(settings.reserveMonths ? [settings.reserveMonths] : [])])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n} havi kiadás
                </option>
              ))}
          </select>
        </div>
        {settings.reserveMonths && (
          <>
            <fieldset className="mt-3">
              <legend className="mb-1 text-xs text-[var(--color-muted)]">
                Melyik értékpapírok a tartalék? (az értékük számít)
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {holdingOptions.length === 0 && (
                  <span className="text-sm text-[var(--color-muted)]">Nincs értékpapír a portfólióban.</span>
                )}
                {holdingOptions.map((h) => (
                  <label key={h.key} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={(settings.reserveHoldings ?? []).includes(h.key)}
                      onChange={(e) =>
                        saveCashflowSettings({
                          ...settings,
                          reserveHoldings: e.target.checked
                            ? [...(settings.reserveHoldings ?? []), h.key]
                            : (settings.reserveHoldings ?? []).filter((x) => x !== h.key),
                        })
                      }
                    />
                    <span className="priv">{h.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="mt-3">
              <legend className="mb-1 text-xs text-[var(--color-muted)]">
                Készpénz is a tartalék? Melyik számlák (csak a papírok után hiányzó részre)
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={(settings.reserveAccounts ?? []).includes(a.id)}
                      onChange={(e) =>
                        saveCashflowSettings({
                          ...settings,
                          reserveAccounts: e.target.checked
                            ? [...(settings.reserveAccounts ?? []), a.id]
                            : (settings.reserveAccounts ?? []).filter((x) => x !== a.id),
                        })
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-3 text-sm" data-testid="reserve-status">
              {reserve.target ? (
                <>
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>
                      Cél: <Amt>{formatMoney(reserve.target.target)}</Amt>
                      <span className="text-[var(--color-muted)]">
                        {" "}
                        ({settings.reserveMonths} × <Amt>{formatMoney(reserve.target.monthlyExpense)}</Amt>, {reserve.target.months} lezárt hónap)
                      </span>
                    </span>
                    <span>
                      Megvan: <Amt>{formatMoney(reserve.held)}</Amt>
                      <span className="text-[var(--color-muted)]">
                        {" "}
                        (papírban <Amt>{formatMoney(reserve.heldHoldings)}</Amt>, készpénzben{" "}
                        <Amt>{formatMoney(reserve.heldCash)}</Amt>)
                      </span>
                    </span>
                  </div>
                  <div
                    className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-border)]"
                    role="progressbar"
                    aria-label="Vésztartalék"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, Math.round((reserve.held / reserve.target.target) * 100))}
                  >
                    <div
                      className="h-full bg-[var(--color-brand)]"
                      style={{ width: `${Math.min(100, (reserve.held / reserve.target.target) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {(settings.reserveAccounts ?? []).length === 0 && (settings.reserveHoldings ?? []).length === 0
                      ? "Jelölj ki legalább egy értékpapírt vagy számlát."
                      : reserve.held >= reserve.target.target
                        ? "A tartalék megvan."
                        : <>Hiányzik: <Amt>{formatMoney(reserve.target.target - reserve.held)}</Amt></>}
                  </p>
                </>
              ) : (
                <p className="text-xs text-[var(--color-muted)]">
                  Még nincs lezárt hónap az átlaghoz, ezért a cél sem számolható.
                </p>
              )}
            </div>
          </>
        )}
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
