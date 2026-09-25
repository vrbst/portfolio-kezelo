import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  TrendingUp,
  Sparkles,
  RefreshCw,
  Plus,
  Trash2,
  RotateCcw,
  AlertTriangle,
  Target,
  SlidersHorizontal,
  History,
} from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useValueSeries,
} from "../lib/store";
import {
  detectRecurringSavings,
  projectForecast,
  projectMonteCarlo,
  deflateResult,
  forecastMilestones,
  loadForecastSettings,
  saveForecastSettings,
  loadForecastSnapshots,
  recordForecastSnapshot,
  firstReach,
  probAtLeast,
  requiredMonthlySaving,
  monthsUntil,
  backtest,
  EVENT_COLORS,
  EVENT_LABELS,
  type ForecastAssumptions,
  type ForecastResult,
  type BacktestPoint,
  type ForecastSettings,
  type ValueSample,
  type PlannedExpense,
  type ScenarioKey,
  type ReinvestTarget,
} from "../lib/forecast";
import { PREFS_EVENT } from "../lib/prefs";
import { loadAiKey, loadAiModel, callClaude, FORECAST_PROMPT } from "../lib/ai";
import ForecastChart, {
  type HistoryPoint,
  type PastForecast,
} from "../components/ForecastChart";
import type { ValuePoint } from "../lib/portfolio";
import { loadSavingsGoals } from "../lib/savings";
import {
  PageHeader,
  Card,
  EmptyState,
  Badge,
  AmountInput,
} from "../components/ui";
import { formatMoney } from "../lib/format";

const huf = (n: number) => Math.round(n).toLocaleString("hu-HU");
const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

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

const MONTH_NAMES = [
  "január", "február", "március", "április", "május", "június",
  "július", "augusztus", "szeptember", "október", "november", "december",
];

/** "2026-06" → "2026. júniusi" (every Hungarian month name takes "-i"). */
function monthAdjective(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}. ${MONTH_NAMES[m - 1]}i`;
}

/**
 * One planned-expense row's text: date + amount never wrap inside themselves;
 * on a phone the note drops to its own line instead of squeezing them.
 */
function ExpenseText({
  date,
  amount,
  note,
}: {
  date: string;
  amount: string;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2">
      <div className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
        <span className="text-[var(--color-muted)] tabular-nums">{date}</span>
        <span className="amt font-medium tabular-nums">{amount} Ft</span>
      </div>
      {note && (
        <span className="priv min-w-0 truncate text-xs text-[var(--color-muted)]">
          {note}
        </span>
      )}
    </div>
  );
}

function currentMonthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * A "% / év" field over a fraction. While typing it shows the raw text (no
 * re-formatting → no caret jumps); only a parseable, non-empty value within
 * [min, ∞) is committed, so clearing the field never zeroes the setting.
 */
function PctInput({
  value,
  onCommit,
  min = -Infinity,
  step = 0.5,
}: {
  value: number;
  onCommit: (fraction: number) => void;
  min?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <input
        type="number"
        step={step}
        className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
        value={draft ?? String(+(value * 100).toFixed(1))}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const p = Number(v.replace(",", "."));
          if (v.trim() !== "" && Number.isFinite(p) && p >= min)
            onCommit(p / 100);
        }}
        onBlur={() => setDraft(null)}
      />
      <span className="text-sm text-[var(--color-muted)]">% / év</span>
    </>
  );
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

  // Medium-term goals become planned expenses on their target date: the goal
  // amount leaves the portfolio then (a planned purchase). Reloaded on any pref
  // change so adding/editing a goal updates the projection immediately.
  const [savingsGoals, setSavingsGoals] = useState(loadSavingsGoals);
  useEffect(() => {
    const onPrefs = () => setSavingsGoals(loadSavingsGoals());
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);
  const goalExpenses = useMemo<PlannedExpense[]>(
    () =>
      savingsGoals
        .filter(
          (g) => /^\d{4}-\d{2}-\d{2}/.test(g.targetDate) && g.targetHuf > 0,
        )
        .map((g) => ({
          id: `goal:${g.id}`,
          date: g.targetDate,
          amountHuf: g.targetHuf,
          note: g.name,
        })),
    [savingsGoals],
  );
  const allExpenses = useMemo(
    () =>
      [...settings.expenses, ...goalExpenses].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
    [settings.expenses, goalExpenses],
  );

  const assumptions = useMemo<ForecastAssumptions>(
    () => ({
      annualReturn: settings.annualReturn,
      monthlySavingHuf: monthlySaving,
      savingGrowth: settings.savingGrowth,
      reinvestTarget: settings.reinvestTarget,
      reinvestBondRate: settings.reinvestBondRate,
      months: settings.months,
      withdrawal: settings.withdrawal,
      withdrawalIndex: settings.inflationPct,
    }),
    [settings, monthlySaving],
  );

  // Deterministic run in the SHOWN forint (nominal or today's) — the target
  // finder and the sensitivity table vary one input of it at a time.
  const runDet = useMemo(
    () =>
      (
        over: Partial<ForecastAssumptions>,
        expenses: PlannedExpense[] = allExpenses,
      ): ForecastResult => {
        const r = projectForecast(summary, { ...assumptions, ...over }, expenses);
        return settings.realMode ? deflateResult(r, settings.inflationPct) : r;
      },
    [summary, assumptions, allExpenses, settings.realMode, settings.inflationPct],
  );

  const nominal = useMemo(() => {
    return settings.engine === "mc"
      ? projectMonteCarlo(summary, assumptions, allExpenses, {
          sigma: settings.mcSigma,
        })
      : projectForecast(summary, assumptions, allExpenses);
  }, [summary, settings.engine, settings.mcSigma, assumptions, allExpenses]);

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
  const hasData = transactions.length > 0 && summary.totalValueHuf > 0;

  // --- actual past values leading into the forecast -------------------------
  const valueSeries = useValueSeries();
  const startTs = result.points[0]?.ts;
  const past = useMemo<{
    points: HistoryPoint[];
    backtestNow?: BacktestPoint;
    backtestFrom?: number;
  }>(() => {
    if (startTs == null) return { points: [] };
    const back = Math.max(12, Math.round(settings.months / 4));
    const from = new Date(startTs);
    from.setMonth(from.getMonth() - back);
    const fromKey = currentMonthKey(from);
    const curKey = currentMonthKey(new Date(startTs));
    // Last sample of every completed month in the window.
    const byMonth = new Map<string, ValuePoint>();
    for (const p of valueSeries) {
      const k = p.date.slice(0, 7);
      if (k < fromKey || k >= curKey) continue;
      byMonth.set(k, p);
    }
    const dayTs = (date: string) => {
      const [y, m, d] = date.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    };

    // Backtest from the month-end after the last one-off lump (the initial
    // funding would swamp any return comparison), or the window start.
    const months = [...byMonth.keys()];
    const lastOneOff = detected.oneOffs.at(-1)?.month;
    const startKey =
      lastOneOff && byMonth.has(lastOneOff) ? lastOneOff : months[0];
    const samples: ValueSample[] = months
      .filter((k) => startKey != null && k >= startKey)
      .map((k) => byMonth.get(k)!)
      .map((p) => ({ ts: dayTs(p.date), value: p.value, invested: p.invested }));
    const today = valueSeries.at(-1);
    if (today && samples.length)
      samples.push({
        ts: dayTs(today.date),
        value: today.value,
        invested: today.invested,
      });
    const bt = backtest(samples, settings.annualReturn);
    // The last backtest point sits on today's value → joins at the "ma" point.
    if (bt.length) bt[bt.length - 1] = { ...bt[bt.length - 1], ts: startTs };
    const btByTs = new Map(bt.map((b) => [b.ts, b]));

    // Today's-forint view: a past forint is worth more today.
    const f = (ts: number) =>
      settings.realMode
        ? Math.pow(1 + settings.inflationPct, (startTs - ts) / YEAR_MS)
        : 1;
    const out: HistoryPoint[] = [...byMonth.values()].map((p) => {
      const ts = dayTs(p.date);
      const b = btByTs.get(ts);
      return {
        ts,
        actual: p.value * f(ts),
        bt: b && {
          pess: b.pess * f(ts),
          real: b.real * f(ts),
          opt: b.opt * f(ts),
        },
      };
    });
    const last = btByTs.get(startTs);
    return { points: out, backtestNow: last, backtestFrom: bt[0]?.ts };
  }, [
    valueSeries,
    startTs,
    settings.months,
    settings.realMode,
    settings.inflationPct,
    settings.annualReturn,
    detected.oneOffs,
  ]);

  // --- target finder --------------------------------------------------------
  const targetHuf = settings.targetHuf ?? 0;
  const target = useMemo(() => {
    if (!hasData || targetHuf <= 0) return null;
    const rawIdx = settings.targetMonth
      ? monthsUntil(settings.targetMonth)
      : NaN;
    const idx = Number.isFinite(rawIdx) && rawIdx > 0 ? rawIdx : null;
    const reach = {
      pess: firstReach(result, "pess", targetHuf),
      real: firstReach(result, "real", targetHuf),
      opt: firstReach(result, "opt", targetHuf),
    };
    let valueAtDate: number | null = null;
    let required: number | null = null;
    if (idx != null) {
      const months = Math.max(settings.months, idx);
      const valueAt = (saving: number) =>
        runDet({ monthlySavingHuf: saving, months }).points[idx].real;
      valueAtDate = valueAt(monthlySaving);
      required = requiredMonthlySaving(valueAt, targetHuf);
    }
    const probIdx = idx ?? settings.months;
    const prob =
      settings.engine === "mc" && probIdx <= settings.months
        ? probAtLeast(result, probIdx, targetHuf)
        : null;
    return { idx, reach, valueAtDate, required, prob };
  }, [
    hasData,
    targetHuf,
    settings.targetMonth,
    settings.months,
    settings.engine,
    result,
    runDet,
    monthlySaving,
  ]);

  // --- sensitivity: what moves the end value the most ----------------------
  const sensitivity = useMemo(() => {
    if (!hasData) return [];
    const n = settings.months;
    const base = runDet({}).points[n].real;
    const endOf = (over: Partial<ForecastAssumptions>, i = n) =>
      runDet(over).points[i].real - base;
    const bump = monthlySaving > 0 ? Math.round(monthlySaving * 0.1) : 20_000;
    const ret = settings.annualReturn;
    const rows = [
      {
        label: `Havi megtakarítás +${huf(bump)} Ft`,
        delta: endOf({ monthlySavingHuf: monthlySaving + bump }),
      },
      {
        label: "Évi +2% emelés a havi összegen",
        delta: endOf({ savingGrowth: settings.savingGrowth + 0.02 }),
      },
      {
        label: "Hozam +1 százalékpont",
        delta: endOf({ annualReturn: { ...ret, real: ret.real + 0.01 } }),
      },
      {
        label: "Hozam −1 százalékpont",
        delta: endOf({ annualReturn: { ...ret, real: ret.real - 0.01 } }),
      },
      {
        label: "2 évvel tovább hagyod",
        delta: endOf({ months: n + 24 }, n + 24),
      },
    ];
    if (allExpenses.length > 0)
      rows.push({
        label: "Betervezett kiadások nélkül",
        delta: runDet({}, []).points[n].real - base,
      });
    return rows
      .filter((r) => Math.abs(r.delta) >= 1)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [
    hasData,
    runDet,
    monthlySaving,
    settings.months,
    settings.annualReturn,
    settings.savingGrowth,
    allExpenses,
  ]);
  const sensMax = Math.max(1, ...sensitivity.map((r) => Math.abs(r.delta)));

  // --- forecast vs. reality -------------------------------------------------
  const [snapshots, setSnapshots] = useState(loadForecastSnapshots);
  useEffect(() => {
    const onPrefs = () => setSnapshots(loadForecastSnapshots());
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);
  // Once a month: store the nominal deterministic projection to compare with
  // reality later. Waits for loaded data so an empty portfolio isn't recorded.
  useEffect(() => {
    if (!hasData) return;
    const month = currentMonthKey();
    if (loadForecastSnapshots().some((s) => s.month === month)) return;
    const nominalDet = projectForecast(
      summary,
      { ...assumptions, months: Math.max(24, assumptions.months) },
      allExpenses,
    );
    // The pref event it fires reloads `snapshots` via the listener above.
    recordForecastSnapshot(nominalDet);
  }, [hasData, summary, assumptions, allExpenses]);
  const comparisons = useMemo(() => {
    const curKey = currentMonthKey();
    return snapshots
      .filter((s) => s.month < curKey)
      .map((s) => {
        const p = s.points.find((x) => x[0] === curKey);
        return p ? { month: s.month, pess: p[1], real: p[2], opt: p[3] } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .reverse()
      .slice(0, 6);
  }, [snapshots]);

  // Earlier saved forecasts as lines over the past: from the month they were
  // saved up to now (the "reális" path, nominal → today's Ft in real mode).
  const pastForecasts = useMemo<PastForecast[]>(() => {
    if (startTs == null) return [];
    const curKey = currentMonthKey(new Date(startTs));
    const monthTs = (key: string) => {
      const [y, m] = key.split("-").map(Number);
      return new Date(y, m - 1, 1).getTime();
    };
    const f = (ts: number) =>
      settings.realMode
        ? Math.pow(1 + settings.inflationPct, (startTs - ts) / YEAR_MS)
        : 1;
    return snapshots
      .filter((s) => s.month < curKey)
      .slice(-6)
      .map((s) => {
        const t0 = monthTs(s.month);
        return {
          label: `${monthAdjective(s.month)} előrejelzés`,
          points: [
            { ts: t0, value: s.startValueHuf * f(t0) },
            ...s.points
              .filter((p) => p[0] <= curKey)
              .map((p) => {
                const ts = monthTs(p[0]);
                return { ts, value: p[2] * f(ts) };
              }),
          ],
        };
      });
  }, [snapshots, startTs, settings.realMode, settings.inflationPct]);

  // --- shortfall warning ----------------------------------------------------
  const shortfallMonth = result.shortfall.real ?? result.shortfall.pess;

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
    const exp = allExpenses.length
      ? allExpenses
          .map(
            (e) =>
              `${e.date}: ${huf(e.amountHuf)} Ft${e.note ? ` (${e.note})` : ""}`,
          )
          .join("; ")
      : "nincs";
    return [
      `Jelenlegi összérték: ${huf(result.startValueHuf)} Ft`,
      `Havi rendszeres megtakarítás: ${huf(monthlySaving)} Ft${settings.savingGrowth ? `, évente ${pct(settings.savingGrowth)}-kal emelve` : ""}`,
      settings.withdrawal.enabled && settings.withdrawal.monthlyHuf > 0
        ? `Rendszeres kivét ${settings.withdrawal.start}-tól: havi ${huf(settings.withdrawal.monthlyHuf)} Ft (mai forintban, évente ${pct(settings.inflationPct)} inflációval emelve); ettől a havi megtakarítás megszűnik. Összes kivét a horizonton: ${huf(result.withdrawalHuf)} Ft`
        : null,
      shortfallMonth
        ? `FIGYELEM: a likvid rész (kötvények nélkül) ${shortfallMonth}-ban elfogy — a kiadások/kivét nem fedezhetők kötvény-eladás nélkül${result.shortfallProb != null ? ` (a szimulációk ${pct(result.shortfallProb, 0)}-ában fogy el valamikor)` : ""}`
        : null,
      target
        ? `Célösszeg: ${huf(targetHuf)} Ft${settings.targetMonth ? ` ${settings.targetMonth}-ig` : ""}; reális pályán elérve: ${target.reach.real ?? "a horizonton belül nem"}${target.required != null ? `; a határidőre szükséges havi megtakarítás: ${huf(target.required)} Ft` : ""}${target.prob != null ? `; valószínűség: ${pct(target.prob, 0)}` : ""}`
        : null,
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
  }, [
    result,
    milestones,
    monthlySaving,
    settings,
    allExpenses,
    shortfallMonth,
    target,
    targetHuf,
  ]);

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

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Bal oszlop: a két rövidebb kártya egymás alatt; a kiadások kártya
            kitölti a maradékot a magasabb Feltételezésekig, a lista görgethető. */}
        <div className="flex min-h-0 flex-col gap-4">
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
                  Az utolsó{" "}
                  {detected.monthsUsed > 0 ? `${detected.monthsUsed} ` : ""}
                  lezárt hónap átlagos nettó befizetése. A befizetés nélküli
                  hónapok 0-val számítanak, az egyszeri nagy tételeket
                  kihagytuk.
                </>
              )}
            </p>

            <div className="mt-3">
              <div className="flex items-center gap-2">
                <AmountInput
                  className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-right text-sm tabular-nums"
                  value={savingDraft ?? String(Math.round(monthlySaving))}
                  onValueChange={(digits) => {
                    setSavingDraft(digits);
                    if (digits !== "") {
                      setSettings((s) => ({
                        ...s,
                        monthlySavingOverride: Number(digits),
                      }));
                    }
                  }}
                  onBlur={() => setSavingDraft(null)}
                />
                <span className="text-sm text-[var(--color-muted)]">
                  Ft / hó
                </span>
                {overriding && (
                  <button
                    className="btn-ghost ml-auto"
                    title="Vissza a felismert értékhez"
                    onClick={() =>
                      setSettings((s) => ({
                        ...s,
                        monthlySavingOverride: null,
                      }))
                    }
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-[var(--color-muted)]">
                  Évente emelem
                </span>
                <PctInput
                  value={settings.savingGrowth}
                  min={-50}
                  onCommit={(v) =>
                    setSettings((s) => ({ ...s, savingGrowth: v }))
                  }
                />
              </div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Ha a fizetéseddel együtt a félretett összeg is nő (pl. az
                inflációval), az előrejelzés 12 havonta ennyivel emeli.
              </p>
            </div>

            {detected.oneOffs.length > 0 && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-3">
                <p className="text-xs font-medium text-[var(--color-muted)]">
                  Kihagyott egyszeri tételek
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

          {/* Betervezett kiadások — kitölti a bal oszlop maradékát */}
          <Card className="flex min-h-0 flex-1 flex-col p-5">
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
                <AmountInput
                  placeholder="Összeg (Ft)"
                  className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={expAmount}
                  onValueChange={setExpAmount}
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

            {(settings.expenses.length > 0 || goalExpenses.length > 0) && (
              // A lista kitölti a maradékot; ha sok tétel van, görgethető.
              <ul className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto border-t border-[var(--color-border)] pt-3 text-sm">
                {settings.expenses.map((e) => (
                  <li key={e.id} className="flex items-center gap-2">
                    <ExpenseText
                      date={e.date}
                      amount={huf(e.amountHuf)}
                      note={e.note}
                    />
                    <button
                      className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                      onClick={() => removeExpense(e.id)}
                      title="Törlés"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
                {/* Középtávú célokból származó, automatikus kiadások — itt csak
                    olvashatók, a Középtávú célok kártyán szerkeszthetők. */}
                {goalExpenses.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 opacity-80">
                    <ExpenseText
                      date={e.date}
                      amount={huf(e.amountHuf)}
                      note={e.note}
                    />
                    <Badge tone="brand">cél</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Rendszeres kivét (pl. nyugdíjas évek) */}
          <Card className="p-5">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={settings.withdrawal.enabled}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    withdrawal: { ...s.withdrawal, enabled: e.target.checked },
                  }))
                }
              />
              <h2 className="text-lg font-semibold">Rendszeres kivét</h2>
            </label>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Egy adott hónaptól havonta kiveszel (pl. nyugdíj mellé). Ettől
              kezdve a havi megtakarítás megszűnik, a kivét pedig évente az
              inflációval ({pct(settings.inflationPct)}) nő.
            </p>
            {settings.withdrawal.enabled && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="month"
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                  value={settings.withdrawal.start}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      withdrawal: { ...s.withdrawal, start: e.target.value },
                    }))
                  }
                />
                <AmountInput
                  placeholder="Havi összeg"
                  className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={
                    settings.withdrawal.monthlyHuf
                      ? String(settings.withdrawal.monthlyHuf)
                      : ""
                  }
                  onValueChange={(digits) =>
                    setSettings((s) => ({
                      ...s,
                      withdrawal: {
                        ...s.withdrawal,
                        monthlyHuf: digits ? Number(digits) : 0,
                      },
                    }))
                  }
                />
                <span className="text-sm text-[var(--color-muted)]">
                  Ft / hó (mai Ft)
                </span>
              </div>
            )}
          </Card>
        </div>

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
            <div className="mt-2 flex items-center gap-2">
              <span className="w-28 text-sm text-[var(--color-muted)]">
                Infláció
              </span>
              <PctInput
                value={settings.inflationPct}
                min={0}
                onCommit={(v) =>
                  setSettings((s) => ({ ...s, inflationPct: v }))
                }
              />
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              A mai forintos nézet és a rendszeres kivét emelése is ezzel
              számol.
            </p>
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
                <PctInput
                  value={settings.reinvestBondRate}
                  min={0}
                  onCommit={(v) =>
                    setSettings((s) => ({ ...s, reinvestBondRate: v }))
                  }
                />
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
        {shortfallMonth && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
            <p>
              {isMc && result.shortfallProb != null ? (
                <>
                  A szimulációk{" "}
                  <strong>{pct(result.shortfallProb, 0)}</strong>-ában
                  valamikor elfogy a likvid pénz (a kötvényeken kívüli rész) —
                  a mediánpályán {formatMonthLabel(shortfallMonth)}-kor.
                </>
              ) : (
                <>
                  A {result.shortfall.real ? "reális" : "pesszimista"} pályán{" "}
                  <strong>{formatMonthLabel(shortfallMonth)}</strong>-kor
                  elfogy a likvid pénz (a kötvényeken kívüli rész).
                </>
              )}{" "}
              Onnantól a kiadások és a kivét csak a kötvények idő előtti
              eladásával fedezhetők — érdemes csökkenteni vagy későbbre tenni
              őket.
            </p>
          </div>
        )}
        <ForecastChart
          points={result.points}
          centerLabel={bandLabels.mid}
          history={past.points}
          events={result.events}
          backtestNow={past.backtestNow}
          pastForecasts={pastForecasts}
          showPast={settings.showPastForecast}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
          {past.points.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 bg-[#e8ecf8]/70" />
              Tényleges múlt
            </span>
          )}
          {settings.showPastForecast && past.backtestNow && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 border-t-2 border-dashed border-[#a5b4fc]" />
              Visszateszt
            </span>
          )}
          {settings.showPastForecast && pastForecasts.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 bg-[#fbbf24]" />
              Korábbi előrejelzések
            </span>
          )}
          {(Object.keys(EVENT_COLORS) as (keyof typeof EVENT_COLORS)[])
            .filter((k) => result.events.some((e) => e.kind === k))
            .map((k) => (
              <span key={k} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: EVENT_COLORS[k] }}
                />
                {EVENT_LABELS[k]}
              </span>
            ))}
          {past.points.length > 0 && (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={settings.showPastForecast}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    showPastForecast: e.target.checked,
                  }))
                }
              />
              Múltbeli előrejelzés
            </label>
          )}
        </div>
        {settings.showPastForecast &&
          (past.backtestNow && past.backtestFrom != null ? (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              <strong>Visszateszt</strong>{" "}
              {new Date(past.backtestFrom).toLocaleDateString("hu-HU")}-tól:
              a ténylegesen befizetett összegekkel és a feltételezett hozammal
              (a teljes vagyonra) mára{" "}
              <span className="amt">
                {privacy ? "•••" : formatMoney(past.backtestNow.real)}
              </span>{" "}
              lenne a reális pályán (sáv{" "}
              <span className="amt">
                {privacy
                  ? "•••"
                  : `${formatMoney(past.backtestNow.pess)} – ${formatMoney(past.backtestNow.opt)}`}
              </span>
              ), a valóság{" "}
              <span className="amt">
                {privacy ? "•••" : formatMoney(result.points[0].real)}
              </span>
              .
              {pastForecasts.length === 0 &&
                " A havonta mentett előrejelzések a következő hónaptól sárga vonalként jelennek meg."}
            </p>
          ) : (
            pastForecasts.length === 0 && (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Visszateszthez legalább egy lezárt hónap kell a nagy egyszeri
                befizetések után; a havonta mentett előrejelzések a következő
                hónaptól jelennek meg.
              </p>
            )
          ))}
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Célösszeg-kereső */}
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Célösszeg</h2>
          </div>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Mikor éred el, mennyi kell hozzá havonta
            {isMc ? ", és mekkora eséllyel jön össze" : ""}?
            {settings.realMode ? " (mai forintban)" : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <AmountInput
              placeholder="Célösszeg (Ft)"
              className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-right text-sm tabular-nums"
              value={settings.targetHuf ? String(settings.targetHuf) : ""}
              onValueChange={(digits) =>
                setSettings((s) => ({
                  ...s,
                  targetHuf: digits ? Number(digits) : null,
                }))
              }
            />
            <input
              type="month"
              title="Határidő (opcionális)"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
              value={settings.targetMonth}
              onChange={(e) =>
                setSettings((s) => ({ ...s, targetMonth: e.target.value }))
              }
            />
            {settings.targetMonth && (
              <button
                className="btn-ghost"
                title="Határidő törlése"
                onClick={() => setSettings((s) => ({ ...s, targetMonth: "" }))}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>

          {target && (
            <dl className="mt-4 space-y-2 border-t border-[var(--color-border)] pt-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-muted)]">
                  Elérve ({bandLabels.mid.toLowerCase()})
                </dt>
                <dd className="font-semibold tabular-nums">
                  {target.reach.real
                    ? formatMonthLabel(target.reach.real)
                    : "a horizonton belül nem"}
                </dd>
              </div>
              <div className="flex justify-between gap-3 text-xs">
                <dt className="text-[var(--color-muted)]">
                  {bandLabels.high} / {bandLabels.low.toLowerCase()}
                </dt>
                <dd className="tabular-nums text-[var(--color-muted)]">
                  {target.reach.opt ? formatMonthLabel(target.reach.opt) : "—"}{" "}
                  /{" "}
                  {target.reach.pess
                    ? formatMonthLabel(target.reach.pess)
                    : "—"}
                </dd>
              </div>
              {target.idx != null && target.valueAtDate != null && (
                <>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--color-muted)]">
                      Várható érték {formatMonthLabel(settings.targetMonth)}
                      -kor (reális)
                    </dt>
                    <dd className="amt tabular-nums">
                      {privacy ? "•••" : `${huf(target.valueAtDate)} Ft`}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--color-muted)]">
                      Ehhez szükséges havi megtakarítás
                    </dt>
                    <dd
                      className={`amt font-semibold tabular-nums ${
                        target.required != null &&
                        target.required <= monthlySaving
                          ? "text-[var(--color-positive)]"
                          : "text-[var(--color-warning)]"
                      }`}
                    >
                      {privacy
                        ? "•••"
                        : target.required == null
                          ? "nem elérhető"
                          : target.required === 0
                            ? "már most is elég"
                            : `${huf(target.required)} Ft / hó`}
                    </dd>
                  </div>
                  {settings.savingGrowth !== 0 && target.required ? (
                    <p className="text-xs text-[var(--color-muted)]">
                      Kezdő összeg, évente {pct(settings.savingGrowth)}-kal
                      emelve.
                    </p>
                  ) : null}
                </>
              )}
              {target.prob != null && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-muted)]">
                    Esély{" "}
                    {target.idx != null
                      ? `${formatMonthLabel(settings.targetMonth)}-ig`
                      : "a horizont végéig"}
                  </dt>
                  <dd className="font-semibold tabular-nums">
                    {pct(target.prob, 0)}
                  </dd>
                </div>
              )}
              {isMc && target.idx != null && target.idx > settings.months && (
                <p className="text-xs text-[var(--color-muted)]">
                  Az esélyhez növeld az időtávot a határidőig.
                </p>
              )}
            </dl>
          )}
        </Card>

        {/* Érzékenység */}
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Mi számít a legtöbbet?</h2>
          </div>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Mennyivel változna a vagyonod {Math.round(settings.months / 12)} év
            múlva (reális pálya{settings.realMode ? ", mai Ft" : ""}), ha egy
            dolgot módosítasz.
          </p>
          <ul className="mt-3 space-y-2.5 text-sm">
            {sensitivity.map((r) => (
              <li key={r.label}>
                <div className="flex justify-between gap-3">
                  <span>{r.label}</span>
                  <span
                    className={`amt tabular-nums ${
                      r.delta >= 0
                        ? "text-[var(--color-positive)]"
                        : "text-[var(--color-negative)]"
                    }`}
                  >
                    {privacy
                      ? "•••"
                      : `${r.delta >= 0 ? "+" : ""}${huf(r.delta)} Ft`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)]">
                  <div
                    className={`h-1.5 rounded-full ${
                      r.delta >= 0
                        ? "bg-[var(--color-positive)]"
                        : "bg-[var(--color-negative)]"
                    }`}
                    style={{
                      width: `${(Math.abs(r.delta) / sensMax) * 100}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

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

      {/* Előrejelzés vs. valóság */}
      <Card className="mt-4 p-5">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Előrejelzés vs. valóság</h2>
        </div>
        {comparisons.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Havonta automatikusan elmentjük az előrejelzést. Jövő hónaptól itt
            látod, mennyire jött be: mit vártunk mára, és mennyi lett valójában.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Mire számított a korábbi hónapokban mentett előrejelzés mára
              (névleges Ft), és mennyi a vagyonod most:{" "}
              <span className="amt font-medium text-[var(--color-text)]">
                {privacy ? "•••" : `${huf(summary.totalValueHuf)} Ft`}
              </span>
              .
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                    <th className="py-2 pr-3 font-medium">Mentve</th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Várt (reális)
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">Sáv</th>
                    <th className="py-2 text-right font-medium">Eltérés</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {comparisons.map((c) => {
                    const diff = summary.totalValueHuf - c.real;
                    const inBand =
                      summary.totalValueHuf >= c.pess &&
                      summary.totalValueHuf <= c.opt;
                    return (
                      <tr
                        key={c.month}
                        className="border-b border-[var(--color-border)]/50"
                      >
                        <td className="py-2 pr-3">
                          {formatMonthLabel(c.month)}
                        </td>
                        <td className="amt py-2 pr-3 text-right">
                          {privacy ? "•••" : huf(c.real)}
                        </td>
                        <td className="amt py-2 pr-3 text-right text-[var(--color-muted)]">
                          {privacy ? "•••" : `${huf(c.pess)}–${huf(c.opt)}`}
                        </td>
                        <td className="py-2 text-right">
                          <span
                            className={`amt ${
                              diff >= 0
                                ? "text-[var(--color-positive)]"
                                : "text-[var(--color-negative)]"
                            }`}
                          >
                            {privacy
                              ? "•••"
                              : `${diff >= 0 ? "+" : ""}${huf(diff)}`}
                          </span>{" "}
                          {c.real > 0 && (
                            <span className="text-xs text-[var(--color-muted)]">
                              ({diff >= 0 ? "+" : ""}
                              {((diff / c.real) * 100).toFixed(1)}%)
                            </span>
                          )}
                          {!inBand && (
                            <span className="ml-1.5">
                              <Badge tone="warning">sávon kívül</Badge>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Az eltérés a piacból és abból is adódik, ha többet vagy kevesebbet
              tettél félre, mint amivel az előrejelzés számolt.
            </p>
          </>
        )}
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
