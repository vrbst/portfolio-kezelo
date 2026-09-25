import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Sparkles,
  Send,
  RefreshCw,
  Coins,
  Square,
  Wrench,
  Globe,
  Brain,
  Layers,
  Euro,
  TrendingUp,
  Target,
  CalendarClock,
  PieChart,
  Landmark,
  Info,
  History,
  ExternalLink,
  Trash2,
} from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useValueSeries,
  useDayChange,
  useGoalProgress,
  useActiveAlerts,
  useSavingsGoals,
} from "../lib/store";
import {
  computeReturns,
  futureBondCashflows,
  isInternalTransfer,
  toHuf,
} from "../lib/portfolio";
import { upcomingEvents } from "../lib/events";
import { tbszStatus } from "../lib/tbsz";
import { computeSavingsProgress, savingsGoalExpenses } from "../lib/savings";
import { effectiveMonthKey } from "../lib/goals";
import { forecastMilestones, projectFromSettings } from "../lib/forecast";
import {
  computeDrift,
  includedClasses,
  loadAllocationSettings,
} from "../lib/allocation";
import { Card } from "./ui";
import {
  loadAiKey,
  loadAiModel,
  modelLabel,
  modelInfo,
  buildAiPortfolioContext,
  runClaude,
  loadSpend,
  loadAiLimits,
  loadAiToggles,
  saveAiToggles,
  type AiSpend,
  type AiToggles,
} from "../lib/ai";
import { CLIENT_TOOLS, runTool, toolLabel, type ToolEnv } from "../lib/aiTools";
import {
  ANALYSIS_SCHEMA,
  STRUCTURED_ANALYSIS_PROMPT,
  loadAnalyses,
  loadLegacyAnalysis,
  parseAnalysis,
  previousForPrompt,
  saveAnalysis,
  type Status,
  type StoredAnalysis,
  type Topic,
} from "../lib/aiAnalysis";
import {
  loadConversation,
  newConversation,
  questionCount,
  saveConversation,
  type Conversation,
  type DisplayTurn,
} from "../lib/aiChat";

const usd = (n: number) =>
  n < 0.01 ? `${(n * 100).toFixed(2)} cent` : `$${n.toFixed(2)}`;

const STATUS_META: Record<Status, { label: string; color: string }> = {
  rendben: { label: "Rendben", color: "var(--color-positive)" },
  figyelj: { label: "Figyelj", color: "var(--color-warning)" },
  teendo: { label: "Teendő", color: "var(--color-negative)" },
};

const TOPIC_ICON: Record<Topic, typeof Layers> = {
  koncentracio: Layers,
  deviza: Euro,
  hozam: TrendingUp,
  celok: Target,
  penzaramlas: CalendarClock,
  allokacio: PieChart,
  tbsz: Landmark,
  egyeb: Info,
};

/**
 * AI page: a structured one-click analysis (topic cards + "what changed") and
 * a chat, both on a rich portfolio snapshot. Optional, off-by-default tool use
 * (the app's own functions) and web search. Spend is guarded by the limits in
 * Settings (monthly, per question, tool rounds, questions per conversation).
 */
export default function AiPanel() {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const historyFile = usePortfolio((s) => s.historyFile);
  const privacy = usePortfolio((s) => s.privacy);
  const series = useValueSeries();
  const dayChange = useDayChange();
  const goals = useGoalProgress();
  const alerts = useActiveAlerts();
  const savingsGoals = useSavingsGoals();

  const apiKey = loadAiKey();
  const model = loadAiModel();
  const limits = loadAiLimits();

  const cashflows = useMemo(
    () => futureBondCashflows(summary, new Date(), transactions),
    [summary, transactions],
  );
  const goalExpenses = useMemo(
    () => savingsGoalExpenses(savingsGoals),
    [savingsGoals],
  );

  // The live snapshot. A conversation freezes its own copy when it starts.
  const context = useMemo(() => {
    const instMap = new Map(instruments.map((i) => [i.key, i]));
    const returns = computeReturns(
      accounts,
      transactions,
      instMap,
      prices,
      fx,
      historyFile,
    );
    const years = new Set<number>();
    for (const a of accounts)
      if (a.kind === "tbsz" && a.tbszYear) years.add(a.tbszYear);
    const { assumptions, result } = projectFromSettings(
      summary,
      transactions,
      fx,
      goalExpenses,
    );
    const alloc = loadAllocationSettings();
    const now = new Date();
    // The effective month: payday deposits count toward the next month.
    const monthKey = effectiveMonthKey(now);
    const yearAgo = new Date(now);
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const yearAgoIso = yearAgo.toISOString().slice(0, 10);
    const inYear = new Date(now);
    inYear.setFullYear(inYear.getFullYear() + 1);
    const inYearIso = inYear.toISOString().slice(0, 10);
    let thisMonthNet = 0;
    let last12 = 0;
    for (const t of transactions) {
      if (t.internal || isInternalTransfer(t)) continue;
      const huf = toHuf(Math.abs(t.grossAmount ?? t.netAmount ?? 0), t.currency, fx);
      if (effectiveMonthKey(t.date) === monthKey) {
        if (t.type === "deposit") thisMonthNet += huf;
        if (t.type === "withdrawal") thisMonthNet -= huf;
      }
      if ((t.type === "interest" || t.type === "dividend") && t.date.slice(0, 10) >= yearAgoIso)
        last12 += huf;
    }
    const next12 = cashflows.filter((c) => c.date.slice(0, 10) < inYearIso);
    return buildAiPortfolioContext(summary, fx, returns, {
      dayChange,
      series,
      goals,
      alerts,
      events: upcomingEvents(summary, undefined, transactions),
      tbsz: [...years].sort().map((y) => tbszStatus(y)),
      savings: computeSavingsProgress(
        savingsGoals,
        accounts,
        transactions,
        instMap,
        prices,
        fx,
      ),
      forecast: {
        monthlySavingHuf: assumptions.monthlySavingHuf,
        milestones: forecastMilestones(result)
          .filter((m) => [1, 5, 10].includes(m.years))
          .map((m) => ({
            years: m.years,
            real: m.point.real,
            pess: m.point.pess,
            opt: m.point.opt,
          })),
        shortfall: result.shortfall.real ?? result.shortfall.pess,
      },
      drift: alloc
        ? computeDrift(summary, alloc.targets, includedClasses(alloc))
        : undefined,
      budget: {
        monthlyHuf: assumptions.monthlySavingHuf,
        thisMonthNetHuf: thisMonthNet,
      },
      passive: {
        last12Huf: last12,
        next12CouponHuf: next12
          .filter((c) => c.kind === "coupon")
          .reduce((s, c) => s + c.amountHuf, 0),
        next12MaturityHuf: next12
          .filter((c) => c.kind === "maturity")
          .reduce((s, c) => s + c.amountHuf, 0),
      },
    });
  }, [
    summary,
    accounts,
    transactions,
    instruments,
    prices,
    fx,
    historyFile,
    series,
    dayChange,
    goals,
    alerts,
    savingsGoals,
    goalExpenses,
    cashflows,
  ]);

  const toolEnv: ToolEnv = {
    summary,
    transactions,
    instruments,
    prices,
    fx,
    history: historyFile,
    series,
    cashflows,
    goalExpenses,
  };

  const [spend, setSpend] = useState<AiSpend>(loadSpend);
  const [toggles, setToggles] = useState<AiToggles>(loadAiToggles);
  // Functional update: two quick toggles must not overwrite each other.
  const setToggle = (k: keyof AiToggles, v: boolean) =>
    setToggles((t) => {
      const next = { ...t, [k]: v };
      saveAiToggles(next);
      return next;
    });

  // ---- analysis -------------------------------------------------------------
  const [analyses, setAnalyses] = useState<StoredAnalysis[]>(loadAnalyses);
  const [legacy] = useState(loadLegacyAnalysis);
  const [aRunning, setARunning] = useState(false);
  const [aThinking, setAThinking] = useState("");
  const [aError, setAError] = useState<string | null>(null);
  const aAbort = useRef<AbortController | null>(null);
  const latest = analyses.at(-1);

  async function runAnalysis() {
    setARunning(true);
    setAError(null);
    setAThinking("");
    const ctl = new AbortController();
    aAbort.current = ctl;
    try {
      const prev = previousForPrompt(latest);
      const r = await runClaude({
        key: apiKey,
        model,
        context,
        messages: [
          {
            role: "user",
            content: prev
              ? `${STRUCTURED_ANALYSIS_PROMPT}\n\n${prev}`
              : STRUCTURED_ANALYSIS_PROMPT,
          },
        ],
        format: ANALYSIS_SCHEMA,
        signal: ctl.signal,
        onThinking: (d) => setAThinking((t) => (t + d).slice(-600)),
      });
      const data = parseAnalysis(r.text);
      if (!data) throw new Error("Nem sikerült értelmezni a választ. Próbáld újra.");
      setAnalyses(
        saveAnalysis({
          at: new Date().toISOString(),
          model,
          costUsd: r.costUsd,
          data,
        }),
      );
    } catch (e) {
      setAError((e as Error).message);
    } finally {
      setARunning(false);
      aAbort.current = null;
      setSpend(loadSpend());
    }
  }

  // ---- chat -------------------------------------------------------------------
  const [conv, setConv] = useState<Conversation | null>(loadConversation);
  const [question, setQuestion] = useState("");
  const [cRunning, setCRunning] = useState(false);
  const [cError, setCError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    text: string;
    thinking: string;
    activity: string[];
  } | null>(null);
  const cAbort = useRef<AbortController | null>(null);
  // Activity of the running answer (also mirrored into `pending` for display).
  const activityRef = useRef<string[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveConversation(conv), [conv]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conv?.turns.length, pending?.activity.length]);

  const asked = questionCount(conv);
  const atTurnLimit = asked >= limits.maxChatTurns;
  // Settings changed since the conversation began → they apply to the next one.
  const stale =
    !!conv &&
    conv.turns.length > 0 &&
    (conv.model !== model || conv.tools !== toggles.tools || conv.web !== toggles.web);

  async function ask(q0?: string) {
    const q = (q0 ?? question).trim();
    if (!q || cRunning || atTurnLimit) return;
    setQuestion("");
    setCError(null);
    // First question: freeze snapshot, model and tools for this conversation.
    const base =
      conv && conv.turns.length > 0
        ? conv
        : newConversation(model, toggles.tools, toggles.web, context);
    const userMsg = { role: "user" as const, content: q };
    const shown: Conversation = {
      ...base,
      turns: [...base.turns, { role: "user", text: q }],
    };
    setConv(shown);
    setCRunning(true);
    setPending({ text: "", thinking: "", activity: [] });
    activityRef.current = [];
    const ctl = new AbortController();
    cAbort.current = ctl;
    try {
      const r = await runClaude({
        key: apiKey,
        model: base.model,
        context: base.context,
        messages: [...base.api, userMsg],
        tools: base.tools ? CLIENT_TOOLS.map((t) => t.def) : undefined,
        onToolCall: (name, input) => runTool(name, input, toolEnv),
        web: base.web,
        maxTokens: 4000,
        signal: ctl.signal,
        onText: (d) => setPending((p) => p && { ...p, text: p.text + d }),
        onThinking: (d) =>
          setPending((p) => p && { ...p, thinking: (p.thinking + d).slice(-400) }),
        onActivity: (a) => {
          activityRef.current = [
            ...activityRef.current,
            a.kind === "search"
              ? `Webes keresés: ${String((a.input as { query?: string })?.query ?? "")}`
              : toolLabel(a.name, a.input),
          ];
          const activity = activityRef.current;
          setPending((p) => p && { ...p, activity });
        },
      });
      // Commit the whole exchange at once (append-only history).
      const turn: DisplayTurn = {
        role: "assistant",
        text: r.text,
        activity: activityRef.current.length ? activityRef.current : undefined,
        sources: r.sources.length ? r.sources.slice(0, 6) : undefined,
        costUsd: r.costUsd,
        note: r.note,
      };
      setConv({
        ...shown,
        api: [...base.api, userMsg, ...r.appended],
        turns: [...shown.turns, turn],
      });
      setPending(null);
    } catch (e) {
      // Nothing was appended to the API history: drop the unanswered question.
      setConv(base.turns.length ? base : null);
      setPending(null);
      setQuestion(q);
      setCError((e as Error).message);
    } finally {
      setCRunning(false);
      cAbort.current = null;
      setSpend(loadSpend());
    }
  }

  // Suggested questions, from what's actually in the portfolio.
  const suggestions = useMemo(() => {
    const s: string[] = [];
    for (const g of savingsGoals.slice(0, 2))
      s.push(`Jó úton vagyok a(z) ${g.name} céllal?`);
    const big = cashflows.find((c) => c.kind === "maturity");
    if (big)
      s.push(
        `Mit érdemes kezdeni a ${big.date.slice(0, 10)}-i lejárattal?`,
      );
    s.push("Mekkora a devizakockázatom, és kell-e vele foglalkoznom?");
    if (toggles.tools)
      s.push("Mi lenne, ha havonta 50 000 Ft-tal többet tennék félre?");
    else s.push("Mennyire koncentrált a portfólióm?");
    if (toggles.web) s.push("Mennyi most a lakossági állampapírok kamata?");
    return s.slice(0, 5);
  }, [savingsGoals, cashflows, toggles.tools, toggles.web]);

  if (!apiKey)
    return (
      <Card className="p-6">
        <p className="text-sm text-[var(--color-muted)]">
          Az AI funkciókhoz add meg a saját Claude API-kulcsodat a{" "}
          <Link to="/settings" className="text-[var(--color-brand)] hover:underline">
            Beállításokban
          </Link>
          . A kulcs csak ezen az eszközön tárolódik.
        </p>
      </Card>
    );

  const spendPct = Math.min(1, spend.monthUsd / Math.max(0.01, limits.monthlyUsd));

  return (
    <div className="space-y-4">
      {/* Status strip: model, monthly spend vs. limit, opt-in switches */}
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div className="min-w-44 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-muted)]">
            <span className="flex items-center gap-1" title="Becsült költség ebben a hónapban (a tokenhasználatból). Nem a maradék kredit.">
              <Coins className="h-3.5 w-3.5" />
              {usd(spend.monthUsd)} / {usd(limits.monthlyUsd)} ebben a hónapban
            </span>
            <span>{modelLabel(model)}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${spendPct * 100}%`,
                background:
                  spendPct >= 0.9
                    ? "var(--color-negative)"
                    : spendPct >= 0.6
                      ? "var(--color-warning)"
                      : "var(--color-positive)",
              }}
            />
          </div>
        </div>
        <Switch
          on={toggles.tools}
          onChange={(v) => setToggle("tools", v)}
          icon={<Wrench className="h-4 w-4" />}
          label="Eszközhasználat"
          hint="A modell a beszélgetésben lefuttathatja az app számításait (pl. előrejelzés más feltételekkel), és lekérheti a részleteket (pozíciók, tranzakciók, árfolyam-előzmény). Ilyenkor a kért konkrét adatok is elmennek."
        />
        <Switch
          on={toggles.web}
          onChange={(v) => setToggle("web", v)}
          icon={<Globe className="h-4 w-4" />}
          label="Webes keresés"
          hint={`Friss piaci információ a webről, forrásokkal. Keresésenként kb. 1 cent, kérdésenként legfeljebb ${limits.webSearchMaxUses} keresés.`}
        />
      </Card>

      {/* Analysis */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="h-5 w-5 text-[var(--color-brand)]" />
              Portfólió-elemzés
            </h2>
            {latest && !aRunning && (
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {formatWhen(latest.at)} · {modelLabel(latest.model)} ·{" "}
                {usd(latest.costUsd)}
              </p>
            )}
          </div>
          {aRunning ? (
            <button className="btn-ghost" onClick={() => aAbort.current?.abort()}>
              <Square className="h-4 w-4" />
              Leállítás
            </button>
          ) : (
            <button className="btn-primary" onClick={runAnalysis}>
              <Sparkles className="h-4 w-4" />
              {latest || legacy ? "Új elemzés" : "Elemzés indítása"}
            </button>
          )}
        </div>

        {aRunning && <ThinkingBox text={aThinking} label="Elemzés készül…" />}
        {aError && (
          <p className="mt-3 text-sm text-[var(--color-negative)]">{aError}</p>
        )}

        {latest && !aRunning && (
          <div className="mt-4 space-y-3">
            <div
              className="amt rounded-xl border p-4 text-sm font-medium leading-relaxed"
              style={{
                borderColor: `color-mix(in srgb, ${STATUS_META[latest.data.overall].color} 40%, transparent)`,
                background: `color-mix(in srgb, ${STATUS_META[latest.data.overall].color} 8%, transparent)`,
              }}
            >
              <StatusPill status={latest.data.overall} />
              <span className="ml-2">{latest.data.headline}</span>
            </div>
            {latest.data.changes && (
              <div className="amt flex gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 text-sm">
                <History className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand)]" />
                <span>
                  <span className="font-medium">Mi változott: </span>
                  {latest.data.changes}
                </span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {latest.data.sections.map((s, i) => {
                const Icon = TOPIC_ICON[s.topic];
                const c = STATUS_META[s.status].color;
                return (
                  <div
                    key={i}
                    className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4"
                    style={{ borderLeft: `3px solid ${c}` }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                        style={{
                          color: c,
                          background: `color-mix(in srgb, ${c} 14%, transparent)`,
                        }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-semibold">
                        {s.title}
                      </span>
                      <StatusPill status={s.status} />
                    </div>
                    <p className={`amt mt-2 text-sm leading-relaxed text-[var(--color-muted)] ${privacy ? "select-none" : ""}`}>
                      {s.text}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!latest && legacy && !aRunning && (
          <div className="amt mt-4 whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4 text-sm leading-relaxed">
            {legacy.text}
          </div>
        )}
      </Card>

      {/* Chat */}
      <Card className="p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Beszélgess a portfóliódról</h2>
          {conv && conv.turns.length > 0 && !cRunning && (
            <button
              className="btn-ghost text-xs"
              onClick={() => {
                setConv(null);
                setCError(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Új beszélgetés
            </button>
          )}
        </div>

        {conv && conv.turns.length > 0 && (
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            {modelLabel(conv.model)}
            {conv.tools ? " · eszközökkel" : ""}
            {conv.web ? " · webes kereséssel" : ""} · pillanatkép:{" "}
            {formatWhen(conv.startedAt)} · {asked}/{limits.maxChatTurns} kérdés
          </p>
        )}
        {stale && (
          <p className="mb-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs">
            A modell vagy a kapcsolók megváltoztak: az új beállítás az{" "}
            <strong>új beszélgetéstől</strong> érvényes (a mostani változatlan
            marad, hogy a korábbi körök érvényesek maradjanak).
          </p>
        )}

        <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
          {conv?.turns.map((t, i) => (
            <ChatBubble key={i} turn={t} privacy={privacy} />
          ))}
          {pending && (
            <div className="flex justify-start">
              <div className="amt max-w-[95%] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 text-sm leading-relaxed">
                <Activity items={pending.activity} />
                {pending.text ? (
                  <div className="whitespace-pre-wrap">{pending.text}</div>
                ) : (
                  <ThinkingBox text={pending.thinking} label="Gondolkodik…" compact />
                )}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {(!conv || conv.turns.length === 0) && !cRunning && (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-3 py-1.5 text-xs transition hover:border-[var(--color-brand)]/50 hover:text-[var(--color-text)]"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {atTurnLimit ? (
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Elérted a beszélgetésenkénti {limits.maxChatTurns} kérdést. Indíts
            új beszélgetést (a hosszú előzmény minden kérdésnél drágább).
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              placeholder="Kérdezz a portfóliódról…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !cRunning) ask();
              }}
            />
            {cRunning ? (
              <button className="btn-ghost" onClick={() => cAbort.current?.abort()}>
                <Square className="h-4 w-4" />
                Leállítás
              </button>
            ) : (
              <button className="btn-ghost" onClick={() => ask()} disabled={!question.trim()}>
                <Send className="h-4 w-4" />
                Kérdez
              </button>
            )}
          </div>
        )}
        {cError && (
          <p className="mt-3 text-sm text-[var(--color-negative)]">{cError}</p>
        )}
        <p className="mt-3 text-[11px] text-[var(--color-muted)]">
          Kérdésenként legfeljebb {usd(limits.perQuestionUsd)}
          {toggles.tools ? ` és ${limits.maxToolRounds} eszközkör` : ""}. A
          keretek a Beállításokban módosíthatók.
          {modelInfo(model).thinking ? "" : " Ez a modell nem gondolkodik válasz előtt."}
        </p>
      </Card>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const m = STATUS_META[status];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        color: m.color,
        background: `color-mix(in srgb, ${m.color} 15%, transparent)`,
      }}
    >
      {m.label}
    </span>
  );
}

function Switch({
  on,
  onChange,
  icon,
  label,
  hint,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  icon: ReactNode;
  label: string;
  hint: string;
}) {
  // One button for track + label: a <label> around a <button> would forward
  // the click and toggle twice.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={hint}
      className="flex items-center gap-2 text-sm"
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          on ? "bg-[var(--color-brand)]" : "bg-[var(--color-surface-2)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
      <span
        className={`flex items-center gap-1.5 ${on ? "" : "text-[var(--color-muted)]"}`}
      >
        {icon}
        {label}
      </span>
    </button>
  );
}

/** The model's live reasoning summary while it thinks. */
function ThinkingBox({
  text,
  label,
  compact,
}: {
  text: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "" : "mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4"}>
      <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Brain className="h-4 w-4 animate-pulse text-[var(--color-brand)]" />
        {label}
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      </div>
      {text && (
        <p className="mt-2 line-clamp-4 text-xs italic leading-relaxed text-[var(--color-muted)]/80">
          …{text.trim()}
        </p>
      )}
    </div>
  );
}

function Activity({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {items.map((a, i) => (
        <span
          key={i}
          className="priv inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]"
        >
          {a.startsWith("Webes") ? <Globe className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
          {a}
        </span>
      ))}
    </div>
  );
}

function ChatBubble({ turn, privacy }: { turn: DisplayTurn; privacy: boolean }) {
  if (turn.role === "user")
    return (
      <div className="flex justify-end">
        <div className="amt max-w-[85%] rounded-xl bg-[var(--color-brand)]/15 px-3 py-2 text-sm">
          {turn.text}
        </div>
      </div>
    );
  return (
    <div className="flex justify-start">
      <div className={`amt max-w-[95%] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 text-sm leading-relaxed ${privacy ? "select-none" : ""}`}>
        <Activity items={turn.activity ?? []} />
        <div className="whitespace-pre-wrap">{turn.text}</div>
        {turn.note && (
          <p className="mt-2 text-xs text-[var(--color-warning)]">{turn.note}</p>
        )}
        {turn.sources && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {turn.sources.map((s) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-56 items-center gap-1 truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-brand)] hover:underline"
                title={s.url}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{s.title || new URL(s.url).hostname}</span>
              </a>
            ))}
          </div>
        )}
        {turn.costUsd != null && (
          <div className="mt-1.5 text-right text-[10px] text-[var(--color-muted)]/70">
            {usd(turn.costUsd)}
          </div>
        )}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
