import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Send, RefreshCw, Coins } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useValueSeries,
  useDayChange,
  useGoalProgress,
  useActiveAlerts,
} from "../lib/store";
import { computeReturns } from "../lib/portfolio";
import { upcomingEvents } from "../lib/events";
import { tbszStatus } from "../lib/tbsz";
import { Card } from "./ui";
import {
  loadAiKey,
  loadAiModel,
  modelLabel,
  buildAiPortfolioContext,
  streamClaude,
  loadSpend,
  ANALYSIS_PROMPT,
  type ChatTurn,
  type AiSpend,
} from "../lib/ai";

const CACHE = "pf-ai-analysis";

type Cached = { text: string; at: string };

function loadCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

function saveCache(c: Cached) {
  try {
    localStorage.setItem(CACHE, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

const usd = (n: number) =>
  n < 0.01 ? `${(n * 100).toFixed(2)} cent` : `$${n.toFixed(2)}`;

/**
 * AI insights card: one-click portfolio analysis + a multi-turn chat, both built
 * on the same rich context (snapshot + goals + alerts + trend + upcoming events
 * + TBSZ). Responses stream token-by-token; each call's estimated cost is added
 * to a local monthly spend counter. The Claude API key is read from
 * localStorage; without it we just point the user to Settings.
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

  // Richer signals, reused from the same hooks the dashboard uses.
  const series = useValueSeries();
  const dayChange = useDayChange();
  const goals = useGoalProgress();
  const alerts = useActiveAlerts();

  const apiKey = loadAiKey();
  const model = loadAiModel();

  const context = useMemo(() => {
    const returns = computeReturns(
      accounts,
      transactions,
      new Map(instruments.map((i) => [i.key, i])),
      prices,
      fx,
      historyFile,
    );
    const events = upcomingEvents(summary, undefined, transactions);
    const years = new Set<number>();
    for (const a of accounts)
      if (a.kind === "tbsz" && a.tbszYear) years.add(a.tbszYear);
    const tbsz = [...years].sort().map((y) => tbszStatus(y));
    return buildAiPortfolioContext(summary, fx, returns, {
      dayChange,
      series,
      goals,
      alerts,
      events,
      tbsz,
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
  ]);

  const [analysis, setAnalysis] = useState<Cached | null>(loadCache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [qLoading, setQLoading] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  const [spend, setSpend] = useState<AiSpend>(loadSpend);
  const chatEndRef = useRef<HTMLDivElement>(null);

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    try {
      let acc = "";
      const at = new Date().toISOString();
      const { text } = await streamClaude({
        key: apiKey,
        context,
        messages: [{ role: "user", content: ANALYSIS_PROMPT }],
        model,
        onText: (delta) => {
          acc += delta;
          setAnalysis({ text: acc, at });
        },
      });
      const c = { text, at };
      setAnalysis(c);
      saveCache(c);
      setSpend(loadSpend());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function ask() {
    const q = question.trim();
    if (!q || qLoading) return;
    setQuestion("");
    setQError(null);
    // History up to and including the new question; the assistant turn is
    // appended empty and filled as the stream arrives.
    const history: ChatTurn[] = [...chat, { role: "user", content: q }];
    setChat([...history, { role: "assistant", content: "" }]);
    setQLoading(true);
    queueMicrotask(() =>
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" }),
    );
    try {
      await streamClaude({
        key: apiKey,
        context,
        messages: history,
        model,
        maxTokens: 1500,
        onText: (delta) => {
          setChat((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last?.role === "assistant")
              next[next.length - 1] = {
                role: "assistant",
                content: last.content + delta,
              };
            return next;
          });
        },
      });
      setSpend(loadSpend());
    } catch (e) {
      setQError((e as Error).message);
      // Drop the empty assistant turn so the failed exchange doesn't linger.
      setChat((prev) =>
        prev.length && prev[prev.length - 1].content === ""
          ? prev.slice(0, -1)
          : prev,
      );
    } finally {
      setQLoading(false);
      queueMicrotask(() =>
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" }),
      );
    }
  }

  const bubble = `amt whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4 text-sm leading-relaxed ${
    privacy ? "select-none" : ""
  }`;

  return (
    <Card className="p-6">
      {apiKey && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <span
            className="flex items-center gap-1 text-xs text-[var(--color-muted)]"
            title="Becsült költség ebben a hónapban (a tokenhasználatból számolva). Ez nem a maradék kredit."
          >
            <Coins className="h-3.5 w-3.5" />
            {usd(spend.monthUsd)} / hó
          </span>
          <span className="text-xs text-[var(--color-muted)]">
            {modelLabel(model)}
          </span>
        </div>
      )}

      {!apiKey ? (
        <p className="text-sm text-[var(--color-muted)]">
          Az AI funkciókhoz add meg a saját Claude API-kulcsodat a{" "}
          <Link
            to="/settings"
            className="text-[var(--color-brand)] hover:underline"
          >
            Beállításokban
          </Link>
          . A kulcs csak ezen az eszközön tárolódik.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-[var(--color-muted)]">
            Tömör értékelés a portfóliódról — diverzifikáció, deviza-kitettség,
            hozam, célok és megfontolandó szempontok. Csak aggregált adatok
            kerülnek elküldésre, tranzakciók soha.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              className="btn-primary"
              onClick={runAnalysis}
              disabled={loading}
            >
              {loading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {analysis ? "Új elemzés" : "Elemzés indítása"}
            </button>
            {analysis && !loading && (
              <span className="text-xs text-[var(--color-muted)]">
                Frissítve: {formatWhen(analysis.at)}
              </span>
            )}
          </div>

          {error && (
            <p className="mt-3 text-sm text-[var(--color-negative)]">{error}</p>
          )}

          {analysis && <div className={`mt-4 ${bubble}`}>{analysis.text}</div>}

          <div className="mt-6 border-t border-[var(--color-border)] pt-5">
            <label className="mb-2 block text-sm font-medium">
              Beszélgess a portfóliódról
            </label>

            {chat.length > 0 && (
              <div className="mb-3 max-h-96 space-y-3 overflow-y-auto pr-1">
                {chat.map((t, i) => (
                  <div
                    key={i}
                    className={
                      t.role === "user"
                        ? "flex justify-end"
                        : "flex justify-start"
                    }
                  >
                    <div
                      className={
                        t.role === "user"
                          ? "max-w-[85%] rounded-xl bg-[var(--color-brand)]/15 px-3 py-2 text-sm"
                          : `max-w-[95%] ${bubble} !p-3`
                      }
                    >
                      {t.content ||
                        (qLoading && i === chat.length - 1 ? (
                          <RefreshCw className="h-4 w-4 animate-spin text-[var(--color-muted)]" />
                        ) : (
                          ""
                        ))}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                placeholder="pl. Jó úton vagyok a céljaimhoz? Mekkora a dollárkitettségem?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !qLoading) ask();
                }}
              />
              <button
                className="btn-ghost"
                onClick={ask}
                disabled={qLoading || !question.trim()}
              >
                {qLoading ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Kérdez
              </button>
            </div>

            {chat.length > 0 && !qLoading && (
              <button
                className="mt-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
                onClick={() => {
                  setChat([]);
                  setQError(null);
                }}
              >
                Beszélgetés törlése
              </button>
            )}

            {qError && (
              <p className="mt-3 text-sm text-[var(--color-negative)]">
                {qError}
              </p>
            )}
          </div>
        </>
      )}
    </Card>
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
