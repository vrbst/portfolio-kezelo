import { useEffect, useRef, useState } from "react";
import { Brain, RefreshCw, Send, Square, Trash2 } from "lucide-react";
import { Card } from "./ui";
import { askBridgeChat } from "../lib/aiBridge";
import {
  MAX_QUESTIONS,
  MAX_QUESTION_CHARS,
  historyOf,
  loadConversation,
  newConversation,
  questionCount,
  saveConversation,
  formatWhen,
  type Conversation,
  type DisplayTurn,
} from "../lib/aiChat";

/**
 * The AI chat: it runs on the my-claude-hub (the subscription) through the local bridge, so the
 * parent renders it only where the bridge answers (this machine). The first question freezes the
 * portfolio snapshot for the conversation; each question carries the turns so far.
 */
export default function BridgeChat({
  context,
  suggestions,
  privacy,
}: {
  /** The live snapshot; a conversation freezes its own copy when it starts. */
  context: string;
  suggestions: string[];
  privacy: boolean;
}) {
  const [conv, setConv] = useState<Conversation | null>(loadConversation);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveConversation(conv), [conv]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conv?.turns.length, running]);
  // Leaving the page drops the wait (the hub may still finish the call).
  useEffect(() => () => abort.current?.abort(), []);

  const asked = questionCount(conv);
  const atLimit = asked >= MAX_QUESTIONS;
  const started = !!conv && conv.turns.length > 0;

  async function ask(q0?: string) {
    const q = (q0 ?? question).trim().slice(0, MAX_QUESTION_CHARS);
    if (!q || running || atLimit) return;
    setQuestion("");
    setError(null);
    const base = started && conv ? conv : newConversation(context);
    const shown: Conversation = { ...base, turns: [...base.turns, { role: "user", text: q }] };
    setConv(shown);
    setRunning(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const answer = await askBridgeChat(
        { question: q, history: historyOf(base), context: base.context },
        ctl.signal,
      );
      setConv({ ...shown, turns: [...shown.turns, { role: "assistant", text: answer }] });
    } catch (e) {
      // Nothing was answered: drop the question from the history and give it back to edit.
      setConv(base.turns.length ? base : null);
      setQuestion(q);
      setError((e as Error).message);
    } finally {
      setRunning(false);
      abort.current = null;
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Beszélgess a portfóliódról</h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            Az előfizetésből, a helyi hubon át · webes kereséssel
            {started && conv ? ` · pillanatkép: ${formatWhen(conv.startedAt)} · ${asked}/${MAX_QUESTIONS} kérdés` : ""}
          </p>
        </div>
        {started && !running && (
          <button
            className="btn-ghost text-xs"
            onClick={() => {
              setConv(null);
              setError(null);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Új beszélgetés
          </button>
        )}
      </div>

      <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
        {conv?.turns.map((t, i) => (
          <Bubble key={i} turn={t} privacy={privacy} />
        ))}
        {running && (
          <div className="flex justify-start">
            <div className="max-w-[95%] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 text-sm">
              <div className="flex items-center gap-2 text-[var(--color-muted)]">
                <Brain className="h-4 w-4 animate-pulse text-[var(--color-brand)]" />
                Gondolkodik… (akár pár perc)
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {!started && !running && (
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

      {atLimit ? (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Elérted a beszélgetésenkénti {MAX_QUESTIONS} kérdést. Indíts új beszélgetést (a hosszú előzmény minden
          kérdésnél lassabb).
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            placeholder="Kérdezz a portfóliódról…"
            value={question}
            maxLength={MAX_QUESTION_CHARS}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !running) void ask();
            }}
          />
          {running ? (
            <button className="btn-ghost" onClick={() => abort.current?.abort()}>
              <Square className="h-4 w-4" />
              Leállítás
            </button>
          ) : (
            <button className="btn-ghost" onClick={() => void ask()} disabled={!question.trim()}>
              <Send className="h-4 w-4" />
              Kérdez
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-[var(--color-negative)]">{error}</p>}
    </Card>
  );
}

function Bubble({ turn, privacy }: { turn: DisplayTurn; privacy: boolean }) {
  if (turn.role === "user")
    return (
      <div className="flex justify-end">
        <div className="amt max-w-[85%] rounded-xl bg-[var(--color-brand)]/15 px-3 py-2 text-sm">{turn.text}</div>
      </div>
    );
  return (
    <div className="flex justify-start">
      <div
        className={`amt max-w-[95%] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 text-sm leading-relaxed ${privacy ? "select-none" : ""}`}
      >
        <div className="whitespace-pre-wrap">{turn.text}</div>
      </div>
    </div>
  );
}
