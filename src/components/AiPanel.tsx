import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  RefreshCw,
  Square,
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
} from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useValueSeries,
  useDayChange,
  useGoalProgress,
  useActiveAlerts,
  useSavingsGoals,
  useGlideVersions,
  useGlideState,
  useValuedInstruments,
  usePlannedSales,
} from "../lib/store";
import {
  futureBondCashflows,
  toLocalDay,
  consolidatedHoldings,
} from "../lib/portfolio";
import { bondAdvice, bondMarket } from "../lib/bondSwitch";
import { Card } from "./ui";
import { modelLabel } from "../lib/ai";
import {
  loadAnalyses,
  loadLegacyAnalysis,
  newestAnalysis,
  type NightlyAnalysis,
  type Status,
  type StoredAnalysis,
  type Topic,
} from "../lib/aiAnalysis";
import { bridgeStatus, runBridgeAnalysis } from "../lib/aiBridge";
import { formatWhen } from "../lib/aiChat";
import BridgeChat from "./BridgeChat";
import { txDay } from "../lib/day";
import { buildFullAiContext } from "../lib/aiContext";
import { useOutlookFile } from "../lib/outlookStore";
import { useNightlyAnalysis } from "../lib/aiNightly";

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
  const outlook = useOutlookFile();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = useValuedInstruments();
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const historyFile = usePortfolio((s) => s.historyFile);
  const bondRates = usePortfolio((s) => s.bondRates);
  const privacy = usePortfolio((s) => s.privacy);
  const series = useValueSeries();
  const dayChange = useDayChange();
  const goals = useGoalProgress();
  const alerts = useActiveAlerts();
  const savingsGoals = useSavingsGoals();
  const sales = usePlannedSales();
  const glide = useGlideState(useGlideVersions());

  const cashflows = useMemo(
    () => futureBondCashflows(summary, new Date(), transactions, sales),
    [summary, transactions, sales],
  );
  const bonds = useMemo(() => {
    const today = toLocalDay(new Date());
    return {
      advice: bondAdvice(consolidatedHoldings(summary), bondRates, today, savingsGoals),
      market: bondMarket(bondRates, today),
    };
  }, [summary, bondRates, savingsGoals]);

  // The live snapshot. A conversation freezes its own copy when it starts.
  const context = useMemo(
    () =>
      buildFullAiContext({
        summary,
        dcaGoals: goals.map((g) => g.goal),
        accounts,
        transactions,
        instruments,
        prices,
        fx,
        historyFile,
        bondRates,
        series,
        dayChange,
        goals,
        alerts,
        savingsGoals,
        glide,
        outlook,
      }),
    [
      summary,
      accounts,
      transactions,
      instruments,
      prices,
      fx,
      historyFile,
      bondRates,
      series,
      dayChange,
      goals,
      alerts,
      savingsGoals,
      glide,
      outlook,
    ],
  );

  // ---- analysis -------------------------------------------------------------
  const [analyses] = useState<StoredAnalysis[]>(loadAnalyses);
  const [legacy] = useState(loadLegacyAnalysis);
  const [aRunning, setARunning] = useState(false);
  const [aError, setAError] = useState<string | null>(null);
  const aAbort = useRef<AbortController | null>(null);
  // The nightly one (made on the owner's machine, synced), one just made through the local
  // bridge, or this device's own older one — whichever is newest.
  const nightly = useNightlyAnalysis();
  const [bridged, setBridged] = useState<NightlyAnalysis | null>(null);
  const latest: StoredAnalysis | undefined = newestAnalysis(
    newestAnalysis(analyses.at(-1), nightly ?? undefined),
    bridged ?? undefined,
  );
  const latestIsNightly = !!nightly && latest === nightly;
  const latestIsBridged = !!bridged && latest === bridged;

  // "Új elemzés" runs on the my-claude-hub (the subscription) through a bridge that listens on
  // this machine only: the button exists only where the bridge answers.
  const [bridgeUp, setBridgeUp] = useState(false);
  // The chat also needs a bridge that knows it: an older process still running does not.
  const [chatUp, setChatUp] = useState(false);
  useEffect(() => {
    let live = true;
    const probe = () =>
      void bridgeStatus().then((st) => {
        if (!live) return;
        setBridgeUp(st !== null);
        setChatUp(st?.chat === true);
      });
    probe();
    window.addEventListener("focus", probe);
    return () => {
      live = false;
      window.removeEventListener("focus", probe);
    };
  }, []);

  async function runAnalysis() {
    setARunning(true);
    setAError(null);
    const ctl = new AbortController();
    aAbort.current = ctl;
    try {
      const r = await runBridgeAnalysis(ctl.signal);
      setBridged(r.analysis);
      if (r.uploadError) setAError(`Az elemzés kész, de nem került fel a szinkron-repóba: ${r.uploadError}`);
    } catch (e) {
      setAError((e as Error).message);
    } finally {
      setARunning(false);
      aAbort.current = null;
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
        `Mit érdemes kezdeni a ${txDay(big.date)}-i lejárattal?`,
      );
    if (bonds.advice.some((a) => a.verdict.kind === "switch"))
      s.push("Érdemes lecserélnem valamelyik állampapíromat egy most kaphatóra?");
    s.push("Mekkora a devizakockázatom, és kell-e vele foglalkoznom?");
    s.push("Mennyire koncentrált a portfólióm?");
    s.push("Mennyi most a lakossági állampapírok kamata?");
    return s.slice(0, 5);
  }, [savingsGoals, cashflows, bonds]);

  if (!latest && !bridgeUp)
    return (
      <Card className="p-6">
        <p className="text-sm text-[var(--color-muted)]">
          Az AI-elemzés és a beszélgetés azon a gépen érhető el, ahol fut a helyi híd (
          <code>npm run ai-bridge</code>). Itt egyelőre nincs mit mutatni.
        </p>
      </Card>
    );

  return (
    <div className="space-y-4">
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
                {formatWhen(latest.at)} · {modelLabel(latest.model)}
                {latestIsNightly
                  ? " · éjszakai, az előfizetésből"
                  : latestIsBridged
                    ? " · az előfizetésből"
                    : ` · ${usd(latest.costUsd)}`}
              </p>
            )}
          </div>
          {aRunning ? (
            <button className="btn-ghost" onClick={() => aAbort.current?.abort()}>
              <Square className="h-4 w-4" />
              Leállítás
            </button>
          ) : bridgeUp ? (
            <button className="btn-primary" onClick={runAnalysis}>
              <Sparkles className="h-4 w-4" />
              {latest || legacy ? "Új elemzés" : "Elemzés indítása"}
            </button>
          ) : null}
        </div>

        {aRunning && (
          <ThinkingBox text="" label="Elemzés készül a hubon (az előfizetésből, pár perc)…" />
        )}
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
                    <p className={`amt mt-2 whitespace-pre-line text-sm leading-relaxed text-[var(--color-muted)] ${privacy ? "select-none" : ""}`}>
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

      {/* Chat: through the local bridge, so only on the machine that runs it */}
      {chatUp && <BridgeChat context={context} suggestions={suggestions} privacy={privacy} />}
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

