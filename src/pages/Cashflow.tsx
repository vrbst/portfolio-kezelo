import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { PageHeader, Card, StatCard, EmptyState, Amt } from "../components/ui";
import CashflowChart from "../components/CashflowChart";
import CashflowItemList from "../components/CashflowItemList";
import InfoTip from "../components/InfoTip";
import { loadCashflowItems } from "../lib/cashflowItems";
import {
  useCashflow,
  useCashflowSettings,
  useCashflowSkips,
  usePortfolio,
  usePortfolioSummary,
  useReservedCash,
} from "../lib/store";
import {
  applySkips,
  cashflowAverage,
  cashflowCategories,
  saveCashflowSkips,
  type CashflowItem,
  cashflowTotals,
  emergencyReserve,
  excludeKey,
  isFixBond,
  monthsFrom,
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
  const rawMonths = useCashflow();
  const skips = useCashflowSkips();
  // What every figure uses: the monthly sums without the items the user took out.
  const months = useMemo(() => applySkips(rawMonths, skips), [rawMonths, skips]);
  const settings = useCashflowSettings();
  const [range, setRange] = useState<number>(12);

  // The single items live on this device only; reload after every import.
  const [items, setItems] = useState<CashflowItem[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadCashflowItems().then((all) => live && setItems(all));
    return () => {
      live = false;
    };
  }, [rawMonths]);
  const [open, setOpen] = useState<string[]>([]);
  const skippedIds = useMemo(() => new Set(skips.map((s) => s.id)), [skips]);

  const totals = useMemo(() => cashflowTotals(months, settings), [months, settings]);
  // Only the current life stage (from the start month on) is shown: chart and categories alike.
  const shown = useMemo(() => {
    const stage = monthsFrom(totals, settings.since);
    return range > 0 ? stage.slice(-range) : stage;
  }, [totals, range, settings.since]);
  const average = useMemo(
    () => cashflowAverage(totals, range > 0 ? range : 1200, settings.since),
    [totals, range, settings.since],
  );
  // The months a stage can start at: any complete one (the running month has no average yet).
  const startOptions = useMemo(() => totals.filter((t) => t.complete).map((t) => t.month).reverse(), [totals]);

  // The names come from the stored sums, the totals from the figures without the skipped items:
  // a category whose every item is taken out stays in the list (at 0) so it can be opened again.
  const categories = useMemo(() => {
    const keep = new Set(shown.map((t) => t.month));
    const key = (c: { kind: string; name: string }) => `${c.kind}:${c.name}`;
    const effective = new Map(cashflowCategories(months.filter((m) => keep.has(m.month))).map((c) => [key(c), c.total]));
    return cashflowCategories(rawMonths.filter((m) => keep.has(m.month)))
      .map((c) => ({ ...c, total: effective.get(key(c)) ?? 0 }))
      .sort((a, b) => b.total - a.total);
  }, [rawMonths, months, shown]);
  const shownMonths = useMemo(() => new Set(shown.map((t) => t.month)), [shown]);
  // Income first, then spending; each biggest first (cashflowCategories sorts by total).
  const sections = [
    { kind: "income" as const, title: "Bevételek", rows: categories.filter((c) => c.kind === "income") },
    { kind: "expense" as const, title: "Kiadások", rows: categories.filter((c) => c.kind === "expense") },
  ];
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

  if (rawMonths.length === 0) {
    return (
      <div>
        <PageHeader title="Pénzáramlás" />
        <EmptyState
          title="Még nincs bevétel- és kiadásadat"
          description="Az 1Money-ban készíts CSV-exportot, és töltsd fel az Importálás oldalon. A havi összegek szinkronizálódnak, az egyes tételek csak ezen az eszközön maradnak."
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

  const toggleItem = (it: CashflowItem) =>
    saveCashflowSkips(
      skippedIds.has(it.id)
        ? skips.filter((s) => s.id !== it.id)
        : [...skips, { id: it.id, month: it.month, kind: it.kind, category: it.category, huf: it.huf }],
    );
  const toggleOpen = (key: string) => setOpen((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));

  const last = shown[shown.length - 1];
  return (
    <div>
      <PageHeader
        title="Pénzáramlás"
        info="Havi bevétel és kiadás az 1Money-exportból. A kategóriák összegei és a kihúzott tételek szinkronizálódnak, az egyes tételek (számlával, megjegyzéssel) csak azon az eszközön vannak meg, ahol a CSV-t importáltad. A kategória nevére kattintva lenyílnak a tételei, és egyenként kihúzhatod őket. Az átlag csak a lezárt hónapokból számol. Ha megadod az átlag kezdetét, a grafikon és a kategóriák is csak az azóta eltelt hónapokat mutatják."
        subtitle={
          last
            ? `${monthLabel(shown[0].month, true)} – ${monthLabel(last.month, true)}${last.complete ? "" : " (az utolsó hónap még nem teljes)"}`
            : "Az átlag kezdete után még nincs hónap."
        }
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
              Az új élethelyzet (pl. a hitel megszűnése) előtti hónapok kimaradnak az átlagokból, a javaslatból, a
              grafikonból és a kategóriák listájából is, így könnyebb észrevenni, melyik tétel ugrik ki. Ha nincs
              határ, a legutóbbi lezárt hónapok átlaga számít.
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
        {sections.map((sec) => {
          const sectionTotal = sec.rows.reduce((t, c) => t + c.total, 0);
          return (
            <div key={sec.kind} className="overflow-x-auto" data-testid={`cf-${sec.kind}`}>
              <h3 className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold">
                {sec.title}
                {settings.since && (
                  <span className="ml-2 font-normal text-[var(--color-muted)]">
                    ({monthLabel(settings.since, true)} óta)
                  </span>
                )}
              </h3>
              {sec.rows.length === 0 ? (
                <p className="px-4 py-3 text-sm text-[var(--color-muted)]">Nincs tétel az időszakban.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-[var(--color-muted)]">
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="px-4 py-2 font-medium">Számít</th>
                      <th className="px-4 py-2 font-medium">Kategória</th>
                      <th className="px-4 py-2 text-right font-medium">Részesedés</th>
                      <th className="px-4 py-2 text-right font-medium">Összesen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.rows.map((c) => {
                      const key = `${c.kind}:${c.name}`;
                      const isOpen = open.includes(key);
                      const mine = (items ?? [])
                        .filter((i) => i.kind === c.kind && i.category === c.name && shownMonths.has(i.month))
                        .sort((a, b) => b.huf - a.huf);
                      const skippedHere = skips.filter(
                        (s) => s.kind === c.kind && s.category === c.name && shownMonths.has(s.month),
                      ).length;
                      return (
                        <Fragment key={key}>
                          <tr
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
                            <td className="px-4 py-2">
                              <button
                                className="flex items-center gap-1 text-left hover:underline"
                                aria-expanded={isOpen}
                                aria-label={`${c.name} (${c.kind === "income" ? "bevétel" : "kiadás"}) tételei`}
                                onClick={() => toggleOpen(key)}
                              >
                                <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                                <span className="priv">{c.name}</span>
                                {skippedHere > 0 && (
                                  <span className="ml-1 text-xs text-[var(--color-muted)]">({skippedHere} kihúzva)</span>
                                )}
                              </button>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-[var(--color-muted)]">
                              {sectionTotal > 0 ? formatPercent(c.total / sectionTotal, 0) : "—"}
                            </td>
                            <td className="amt px-4 py-2 text-right tabular-nums">{formatMoney(c.total)}</td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b border-[var(--color-border)]/50">
                              <td colSpan={4} className="p-0">
                                {mine.length > 0 ? (
                                  <CashflowItemList name={c.name} items={mine} skipped={skippedIds} onToggle={toggleItem} />
                                ) : (
                                  <p className="px-4 py-3 text-sm text-[var(--color-muted)]">
                                    {items === null
                                      ? "Betöltés…"
                                      : "A tételek ezen az eszközön nincsenek meg. Importáld itt is a CSV-t, hogy lásd őket."}
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </Card>

      {skips.length > 0 && (
        <Card className="mt-6 overflow-hidden" id="kihuzott">
          <h2 className="border-b border-[var(--color-border)] px-4 py-3 text-lg font-semibold">
            Kihúzott tételek ({skips.length})
          </h2>
          <ul>
            {[...skips]
              .sort((a, b) => b.month.localeCompare(a.month))
              .map((s) => (
                <li
                  key={s.id}
                  data-testid="cf-skip"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)]/50 px-4 py-2 text-sm last:border-0"
                >
                  <span className="tabular-nums text-[var(--color-muted)]">{monthLabel(s.month, true)}</span>
                  <span className="text-[var(--color-muted)]">{s.kind === "income" ? "Bevétel" : "Kiadás"}</span>
                  <span className="priv">{s.category}</span>
                  <span className="amt ml-auto tabular-nums">{formatMoney(s.huf)}</span>
                  <button
                    className="btn-ghost"
                    onClick={() => saveCashflowSkips(skips.filter((x) => x.id !== s.id))}
                    aria-label={`Visszavesz: ${s.category}, ${monthLabel(s.month, true)}`}
                  >
                    Visszavesz
                  </button>
                </li>
              ))}
          </ul>
        </Card>
      )}

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
