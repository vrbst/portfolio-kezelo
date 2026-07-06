import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  TrendingUp,
  Sparkles,
  RefreshCw,
  Plus,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import {
  detectRecurringSavings,
  projectForecast,
  projectMonteCarlo,
  deflateResult,
  forecastMilestones,
  loadForecastSettings,
  saveForecastSettings,
  type ForecastSettings,
  type PlannedExpense,
  type ScenarioKey,
  type ReinvestTarget,
} from "../lib/forecast";
import { PREFS_EVENT } from "../lib/prefs";
import { loadAiKey, loadAiModel, callClaude, FORECAST_PROMPT } from "../lib/ai";
import ForecastChart from "../components/ForecastChart";
import AllocationTargets from "../components/AllocationTargets";
import { PageHeader, Card, EmptyState, Badge } from "../components/ui";
import { formatMoney } from "../lib/format";

const huf = (n: number) => Math.round(n).toLocaleString("hu-HU");

const HORIZONS = [
  { months: 60, label: "5 év" },
  { months: 120, label: "10 év" },
  { months: 180, label: "15 év" },
  { months: 240, label: "20 év" },
  { months: 360, label: "30 év" },
];

const SCEN_META: { key: ScenarioKey; label: string }[] = [
  { key: "pess", label: "Pesszimista" },
  { key: "real", label: "Reális" },
  { key: "opt", label: "Optimista" },
];

const REINVEST_OPTIONS: { value: ReinvestTarget; label: string }[] = [
  { value: "growth", label: "Növekedési eszköz (pl. VWCE)" },
  { value: "bond", label: "Új állampapír (fix hozam)" },
  { value: "cash", label: "Készpénz (nem fialtatom)" },
];

function reinvestContextLabel(t: ReinvestTarget, bondRate: number): string {
  if (t === "growth")
    return "növekedési eszközbe (pl. VWCE, a scenario-hozammal)";
  if (t === "bond")
    return `új állampapírba, ${(bondRate * 100).toFixed(1)}% éves hozammal`;
  return "készpénzben marad (nem fialódik, kiadásokra elérhető)";
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `exp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}. ${m}.`;
}

export default function Forecast() {
  const summary = usePortfolioSummary();
  const transactions = usePortfolio((s) => s.transactions);
  const fx = usePortfolio((s) => s.fx);
  const privacy = usePortfolio((s) => s.privacy);

  const [settings, setSettings] =
    useState<ForecastSettings>(loadForecastSettings);
  // Persist only real user edits: the mount and a sync pull both set state
  // that is already stored — re-saving those would stamp them as "newer"
  // than the other device's copy for nothing.
  const skipPersist = useRef(true);
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    saveForecastSettings(settings);
  }, [settings]);

  // A sync pull may bring newer settings from another device — reload them.
  useEffect(() => {
    const onPrefs = (e: Event) => {
      if ((e as CustomEvent<{ source?: string }>).detail?.source === "remote") {
        skipPersist.current = true;
        setSettings(loadForecastSettings());
      }
    };
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);

  const detected = useMemo(
    () => detectRecurringSavings(transactions, fx),
    [transactions, fx],
  );

  const monthlySaving = settings.monthlySavingOverride ?? detected.monthlyHuf;

  const nominal = useMemo(() => {
    const assumptions = {
      annualReturn: settings.annualReturn,
      monthlySavingHuf: monthlySaving,
      reinvestTarget: settings.reinvestTarget,
      reinvestBondRate: settings.reinvestBondRate,
      months: settings.months,
    };
    return settings.engine === "mc"
      ? projectMonteCarlo(summary, assumptions, settings.expenses, {
          sigma: settings.mcSigma,
        })
      : projectForecast(summary, assumptions, settings.expenses);
  }, [summary, settings, monthlySaving]);

  // Real-value view: everything the user sees is deflated to today's forint.
  const result = useMemo(
    () =>
      settings.realMode
        ? deflateResult(nominal, settings.inflationPct)
        : nominal,
    [nominal, settings.realMode, settings.inflationPct],
  );

  const milestones = useMemo(() => forecastMilestones(result), [result]);
  const last = result.points[result.points.length - 1];

  const isMc = settings.engine === "mc";
  const bandLabels = isMc
    ? { low: "Kedvezőtlen (p10)", mid: "Medián", high: "Kedvező (p90)" }
    : { low: "Pesszimista", mid: "Reális", high: "Optimista" };

  // --- AI narrative ---------------------------------------------------------
  const apiKey = loadAiKey();
  const model = loadAiModel();
  const [narrative, setNarrative] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const aiContext = useMemo(() => {
    const ret = settings.annualReturn;
    const ms = milestones
      .map(
        (m) =>
          `+${m.years} év (${m.point.month}): reális ${huf(m.point.real)} Ft (sáv ${huf(m.point.pess)}–${huf(m.point.opt)}), ebből befektetett tőke ${huf(m.point.contributed)} Ft`,
      )
      .join("\n");
    const exp = settings.expenses.length
      ? settings.expenses
          .map(
            (e) =>
              `${e.date}: ${huf(e.amountHuf)} Ft${e.note ? ` (${e.note})` : ""}`,
          )
          .join("; ")
      : "nincs";
    return [
      `Jelenlegi összérték: ${huf(result.startValueHuf)} Ft`,
      `Felismert havi rendszeres megtakarítás: ${huf(monthlySaving)} Ft`,
      `Feltételezett éves hozam — pesszimista ${(ret.pess * 100).toFixed(1)}%, reális ${(ret.real * 100).toFixed(1)}%, optimista ${(ret.opt * 100).toFixed(1)}%`,
      `Kötvény-kamatok és lejáró tőke iránya: ${reinvestContextLabel(settings.reinvestTarget, settings.reinvestBondRate)}`,
      settings.engine === "mc"
        ? `Számítás: Monte Carlo szimuláció (500 útvonal, szórás ${(settings.mcSigma * 100).toFixed(0)}%/év); a sáv a 10–90. percentilis, a középérték a medián`
        : null,
      settings.realMode
        ? `Minden érték MAI FORINTBAN értendő (${(settings.inflationPct * 100).toFixed(1)}% éves inflációval deflálva)`
        : null,
      `Horizont: ${Math.round(settings.months / 12)} év`,
      `Kötvény-cashflow a horizonton: kamat ${huf(result.couponHuf)} Ft, lejáró tőke ${huf(result.maturityHuf)} Ft`,
      `Betervezett kiadások: ${exp} (összesen ${huf(result.expenseHuf)} Ft)`,
      "",
      "Mérföldkövek:",
      ms,
    ]
      .filter((l): l is string => l != null)
      .join("\n");
  }, [result, milestones, monthlySaving, settings]);

  async function runNarrative() {
    setAiLoading(true);
    setAiError(null);
    try {
      const text = await callClaude({
        key: apiKey,
        context: aiContext,
        prompt: FORECAST_PROMPT,
        model,
        maxTokens: 700,
      });
      setNarrative(text);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  }

  // Draft strings for the numeric inputs: while typing we show the raw text
  // (no re-formatting → no caret jumps), and an empty field doesn't commit 0.
  const [savingDraft, setSavingDraft] = useState<string | null>(null);
  const [rateDraft, setRateDraft] = useState<Partial<Record<string, string>>>(
    {},
  );

  // --- expense editor -------------------------------------------------------
  const [expDate, setExpDate] = useState("");
  const [expAmount, setExpAmount] = useState("");
  const [expNote, setExpNote] = useState("");

  function addExpense() {
    // Accept "1 500 000" and a comma decimal ("1,5") too.
    const amount = Number(expAmount.replace(/\s/g, "").replace(",", "."));
    if (!expDate || !Number.isFinite(amount) || amount <= 0) return;
    const e: PlannedExpense = {
      id: newId(),
      date: expDate,
      amountHuf: amount,
      note: expNote.trim() || undefined,
    };
    setSettings((s) => ({
      ...s,
      expenses: [...s.expenses, e].sort((a, b) => a.date.localeCompare(b.date)),
    }));
    setExpDate("");
    setExpAmount("");
    setExpNote("");
  }

  function removeExpense(id: string) {
    setSettings((s) => ({
      ...s,
      expenses: s.expenses.filter((e) => e.id !== id),
    }));
  }

  if (transactions.length === 0 || summary.totalValueHuf <= 0) {
    return (
      <div>
        <PageHeader title="Előrejelzés" />
        <EmptyState
          title="Még nincs mit előrevetíteni"
          description="Importáld a kivonataidat, és a meglévő portfóliódból, kötvény-hozamaidból és a felismert havi megtakarításodból megbecsüljük a jövőbeli vagyonodat."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás indítása
            </Link>
          }
        />
      </div>
    );
  }

  const overriding = settings.monthlySavingOverride != null;

  return (
    <div>
      <PageHeader
        title="Előrejelzés"
        subtitle="A meglévő vagyonodból, a kötvényeid ismert hozamából és a felismert havi megtakarításból vetített jövőkép. Becslés, nem ígéret."
      />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Havi megtakarítás */}
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Havi megtakarítás</h2>
          </div>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {overriding ? (
              "Kézzel megadott havi összeg."
            ) : (
              <>
                Felismerve az eddigi befizetésekből
                {detected.monthsUsed > 0
                  ? ` (${detected.monthsUsed} hónap alapján)`
                  : ""}
                . Az egyszeri nagy tételeket kihagytuk.
              </>
            )}
          </p>

          <div className="mt-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-right text-sm tabular-nums"
                value={savingDraft ?? huf(monthlySaving)}
                onFocus={() => setSavingDraft(String(monthlySaving))}
                onChange={(e) => {
                  setSavingDraft(e.target.value);
                  const n = Number(e.target.value.replace(/\D/g, ""));
                  if (e.target.value.trim() !== "" && Number.isFinite(n)) {
                    setSettings((s) => ({ ...s, monthlySavingOverride: n }));
                  }
                }}
                onBlur={() => setSavingDraft(null)}
              />
              <span className="text-sm text-[var(--color-muted)]">Ft / hó</span>
              {overriding && (
                <button
                  className="btn-ghost ml-auto"
                  title="Vissza a felismert értékhez"
                  onClick={() =>
                    setSettings((s) => ({ ...s, monthlySavingOverride: null }))
                  }
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {detected.oneOffs.length > 0 && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <p className="text-xs font-medium text-[var(--color-muted)]">
                Kihagyott egyszeri befizetések
              </p>
              <ul className="mt-1.5 space-y-1 text-xs tabular-nums text-[var(--color-muted)]">
                {detected.oneOffs.map((o) => (
                  <li key={o.month} className="flex justify-between gap-3">
                    <span>{formatMonthLabel(o.month)}</span>
                    <span className="amt">{huf(o.huf)} Ft</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {/* Feltételezések */}
        <Card className="p-5">
          <h2 className="text-lg font-semibold">Feltételezések</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Éves várható hozam a növekedési eszközökre (ETF/részvény). A
            kötvények a saját ismert hozamukkal számolnak.
          </p>

          <div className="mt-3 inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
            {(
              [
                ["det", "Determinisztikus"],
                ["mc", "Monte Carlo"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSettings((s) => ({ ...s, engine: key }))}
                className={`rounded-md px-2.5 py-1 transition ${
                  settings.engine === key
                    ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3 space-y-2">
            {(isMc
              ? SCEN_META.filter((sc) => sc.key === "real")
              : SCEN_META
            ).map((sc) => (
              <div key={sc.key} className="flex items-center gap-2">
                <span className="w-28 text-sm text-[var(--color-muted)]">
                  {isMc ? "Várható hozam" : sc.label}
                </span>
                <input
                  type="number"
                  step="0.5"
                  className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={
                    rateDraft[sc.key] ??
                    String(+(settings.annualReturn[sc.key] * 100).toFixed(1))
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    setRateDraft((d) => ({ ...d, [sc.key]: v }));
                    const p = Number(v.replace(",", "."));
                    // Only commit parseable, non-empty input — clearing the
                    // field must not zero the scenario rate.
                    if (v.trim() !== "" && Number.isFinite(p)) {
                      setSettings((s) => ({
                        ...s,
                        annualReturn: { ...s.annualReturn, [sc.key]: p / 100 },
                      }));
                    }
                  }}
                  onBlur={() =>
                    setRateDraft((d) => ({ ...d, [sc.key]: undefined }))
                  }
                />
                <span className="text-sm text-[var(--color-muted)]">
                  % / év
                </span>
              </div>
            ))}
            {isMc && (
              <div className="flex items-center gap-2">
                <span className="w-28 text-sm text-[var(--color-muted)]">
                  Szórás (σ)
                </span>
                <input
                  type="number"
                  step="1"
                  className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={
                    rateDraft["sigma"] ??
                    String(+(settings.mcSigma * 100).toFixed(1))
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    setRateDraft((d) => ({ ...d, sigma: v }));
                    const p = Number(v.replace(",", "."));
                    if (v.trim() !== "" && Number.isFinite(p) && p >= 0) {
                      setSettings((s) => ({ ...s, mcSigma: p / 100 }));
                    }
                  }}
                  onBlur={() =>
                    setRateDraft((d) => ({ ...d, sigma: undefined }))
                  }
                />
                <span className="text-sm text-[var(--color-muted)]">
                  % / év
                </span>
              </div>
            )}
          </div>
          {isMc && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              500 szimulált útvonal; a sáv a 10–90. percentilis, a kiemelt vonal
              a medián. Globális részvény-ETF-re a ~15–18% szórás tipikus.
            </p>
          )}

          <div className="mt-4 border-t border-[var(--color-border)] pt-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.realMode}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, realMode: e.target.checked }))
                }
              />
              Mai forintban (infláció-korrigált)
            </label>
            {settings.realMode && (
              <div className="mt-2 flex items-center gap-2">
                <span className="w-28 text-sm text-[var(--color-muted)]">
                  Infláció
                </span>
                <input
                  type="number"
                  step="0.5"
                  className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={
                    rateDraft["infl"] ??
                    String(+(settings.inflationPct * 100).toFixed(1))
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    setRateDraft((d) => ({ ...d, infl: v }));
                    const p = Number(v.replace(",", "."));
                    if (v.trim() !== "" && Number.isFinite(p) && p >= 0) {
                      setSettings((s) => ({ ...s, inflationPct: p / 100 }));
                    }
                  }}
                  onBlur={() =>
                    setRateDraft((d) => ({ ...d, infl: undefined }))
                  }
                />
                <span className="text-sm text-[var(--color-muted)]">
                  % / év
                </span>
              </div>
            )}
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-[var(--color-muted)]">
              Kötvény-kamatok és lejáró tőke ide kerül
            </p>
            <select
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm"
              value={settings.reinvestTarget}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  reinvestTarget: e.target.value as ReinvestTarget,
                }))
              }
            >
              {REINVEST_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {settings.reinvestTarget === "bond" && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-[var(--color-muted)]">
                  Állampapír hozam
                </span>
                <input
                  type="number"
                  step="0.5"
                  className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={+(settings.reinvestBondRate * 100).toFixed(1)}
                  onChange={(e) => {
                    const p = Number(e.target.value);
                    setSettings((s) => ({
                      ...s,
                      reinvestBondRate: Number.isFinite(p) ? p / 100 : 0,
                    }));
                  }}
                />
                <span className="text-sm text-[var(--color-muted)]">
                  % / év
                </span>
              </div>
            )}
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-[var(--color-muted)]">
              Időtáv
            </p>
            <div className="inline-flex flex-wrap rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
              {HORIZONS.map((h) => (
                <button
                  key={h.months}
                  onClick={() =>
                    setSettings((s) => ({ ...s, months: h.months }))
                  }
                  className={`rounded-md px-2.5 py-1 transition ${
                    settings.months === h.months
                      ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/* Betervezett kiadások */}
        <Card className="p-5">
          <h2 className="text-lg font-semibold">Betervezett kiadások</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Ismert jövőbeli kiadások (pl. egy tervezett vásárlás). A megadott
            dátumkor levonjuk a vagyonból.
          </p>

          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              <input
                type="date"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
              />
              <input
                type="text"
                inputMode="numeric"
                placeholder="Összeg (Ft)"
                className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                value={expAmount}
                onChange={(e) => setExpAmount(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Megjegyzés (opcionális)"
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                value={expNote}
                onChange={(e) => setExpNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addExpense();
                }}
              />
              <button className="btn-ghost" onClick={addExpense}>
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {settings.expenses.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-3 text-sm">
              {settings.expenses.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="text-[var(--color-muted)] tabular-nums">
                    {e.date}
                  </span>
                  <span className="amt font-medium tabular-nums">
                    {huf(e.amountHuf)} Ft
                  </span>
                  {e.note && (
                    <span className="truncate text-xs text-[var(--color-muted)]">
                      {e.note}
                    </span>
                  )}
                  <button
                    className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                    onClick={() => removeExpense(e.id)}
                    title="Törlés"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Cél-allokáció + DCA-segéd */}
        <AllocationTargets />
      </div>

      {/* Grafikon */}
      <Card className="mt-4 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Vagyon-előrejelzés</h2>
              {isMc && <Badge tone="brand">Monte Carlo</Badge>}
              {settings.realMode && <Badge tone="neutral">mai forintban</Badge>}
            </div>
            <p className="text-sm text-[var(--color-muted)]">
              {isMc
                ? "Medián pálya (kiemelt), 10–90. percentilis sáv, és a befektetett tőke (szaggatott)."
                : "Reális pálya (kiemelt), pesszimista–optimista sáv, és a befektetett tőke (szaggatott)."}
            </p>
          </div>
          {last && (
            <div className="text-right">
              <div className="text-xs text-[var(--color-muted)]">
                {Math.round(settings.months / 12)} év múlva (
                {isMc ? "medián" : "reális"}
                {settings.realMode ? ", mai Ft" : ""})
              </div>
              <div className="amt text-xl font-semibold tabular-nums">
                {privacy ? "•••" : formatMoney(last.real)}
              </div>
            </div>
          )}
        </div>
        <ForecastChart points={result.points} centerLabel={bandLabels.mid} />
      </Card>

      {/* Mérföldkövek */}
      <Card className="mt-4 p-5">
        <h2 className="text-lg font-semibold">Mérföldkövek</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                <th className="py-2 pr-3 font-medium">Idő</th>
                <th className="py-2 pr-3 text-right font-medium">
                  {bandLabels.low}
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  {bandLabels.mid}
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  {bandLabels.high}
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Befektetett tőke
                </th>
                <th className="py-2 text-right font-medium">
                  Hozam ({bandLabels.mid.toLowerCase()})
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {milestones.map((m) => {
                const gain = m.point.real - m.point.contributed;
                return (
                  <tr
                    key={m.years}
                    className="border-b border-[var(--color-border)]/50"
                  >
                    <td className="py-2 pr-3">+{m.years} év</td>
                    <td className="amt py-2 pr-3 text-right text-[var(--color-muted)]">
                      {privacy ? "•••" : huf(m.point.pess)}
                    </td>
                    <td className="amt py-2 pr-3 text-right font-semibold">
                      {privacy ? "•••" : huf(m.point.real)}
                    </td>
                    <td className="amt py-2 pr-3 text-right text-[var(--color-muted)]">
                      {privacy ? "•••" : huf(m.point.opt)}
                    </td>
                    <td className="amt py-2 pr-3 text-right text-[var(--color-muted)]">
                      {privacy ? "•••" : huf(m.point.contributed)}
                    </td>
                    <td
                      className={`amt py-2 text-right ${
                        gain >= 0
                          ? "text-[var(--color-positive)]"
                          : "text-[var(--color-negative)]"
                      }`}
                    >
                      {privacy ? "•••" : `${gain >= 0 ? "+" : ""}${huf(gain)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          A kötvények a horizonton belül{" "}
          <span className="amt">{huf(result.couponHuf)} Ft</span> kamatot és{" "}
          <span className="amt">{huf(result.maturityHuf)} Ft</span> lejáró tőkét
          hoznak — ez ide kerül:{" "}
          {reinvestContextLabel(
            settings.reinvestTarget,
            settings.reinvestBondRate,
          )}
          .
        </p>
      </Card>

      {/* AI narratíva */}
      <Card className="mt-4 p-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">AI értékelés</h2>
        </div>
        {!apiKey ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Szöveges értékeléshez add meg a Claude API-kulcsodat a{" "}
            <Link
              to="/settings"
              className="text-[var(--color-brand)] hover:underline"
            >
              Beállításokban
            </Link>
            . Csak az összesített előrejelzés-számokat küldjük el, tranzakciókat
            soha.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              A fenti előrejelzés számai alapján — mit tesz hozzá a havi
              megtakarítás, mekkora a bizonytalanság, hogyan hatnak a kiadások.
            </p>
            <button
              className="btn-primary mt-3"
              onClick={runNarrative}
              disabled={aiLoading}
            >
              {aiLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {narrative ? "Új értékelés" : "Értékelés kérése"}
            </button>
            {aiError && (
              <p className="mt-3 text-sm text-[var(--color-negative)]">
                {aiError}
              </p>
            )}
            {narrative && (
              <div
                className={`amt mt-4 whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4 text-sm leading-relaxed ${
                  privacy ? "select-none" : ""
                }`}
              >
                {narrative}
              </div>
            )}
          </>
        )}
      </Card>

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        <Badge tone="neutral">becslés</Badge> A jövőbeli hozam feltételezés — a
        tényleges eredmény ettől eltérhet. A kötvények a jelenlegi értéküktől a
        lejáratkori névértékig kamatozódnak, a felismert havi megtakarítás pedig
        a múltbeli befizetéseidből adódik. A tervezési beállítások és a
        cél-allokáció a felhő-szinkronnal együtt szinkronizálódnak az eszközeid
        között.
      </p>
    </div>
  );
}
