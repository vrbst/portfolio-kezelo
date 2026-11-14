// One chat turn: the pending question + the portfolio snapshot + the recent
// turns → the AI (my-claude-hub, subscription) → Telegram messages. It runs as
// the scheduler's "chat" job, started by the handler (the answer takes minutes,
// the handler's own limit is 60 s). The pending question is always cleared, so
// a failed turn never blocks the next question; the user gets the reason.

import { analysisContext } from "../analysis/job";
import type { Context } from "../data";
import { HUB_CODE, QuotaExhaustedError, hubErrorCode } from "../hubClient";
import type { NewsEngine } from "../news/engine";
import { esc } from "../reports";
import { buildChatPrompt, CHAT_SCHEMA } from "./prompt";
import { activeHistory, appendExchange, loadChat, updateChat } from "./store";

export const CHAT_JOB = "chat";

export interface ChatDeps {
  engine: NewsEngine;
  /** .notify/chat.json */
  file: string;
  /** The user's investment preferences (from the assistant); absent in tests. */
  profile?: () => string;
}

/** Telegram allows 4096 characters; the text is cut at line ends well below that (escaping lengthens it). */
export function splitMessage(text: string, max = 3000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** The answer text of the engine's output ({answer} object, a JSON string of it, or plain text). */
export function answerOf(output: unknown): string {
  const take = (v: unknown): string | null =>
    v && typeof v === "object" && typeof (v as { answer?: unknown }).answer === "string"
      ? (v as { answer: string }).answer.trim()
      : null;
  const direct = take(output);
  if (direct) return direct;
  if (typeof output === "string") {
    try {
      const parsed = take(JSON.parse(output));
      if (parsed) return parsed;
    } catch {
      /* plain text */
    }
    if (output.trim()) return output.trim();
  }
  throw new Error("Az AI üres választ adott.");
}

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" }).format(d);

/** What the user reads when the AI could not answer (decided on the hub's error code, never on text). */
export function chatErrorText(e: unknown): string {
  const code = hubErrorCode(e);
  if (e instanceof QuotaExhaustedError)
    return `⏳ Elfogyott az előfizetés kerete${e.resetAt ? `, ${hhmm(e.resetAt)} körül nullázódik` : ""}. Kérdezz újra utána.`;
  if (code === HUB_CODE.unreachable || code === HUB_CODE.unavailable)
    return "⚠️ Most nem érem el az AI-t (a my-claude-hub nem válaszol). Próbáld újra később.";
  if (code === HUB_CODE.deadlineMissed)
    return "⏳ Az AI sora foglalt volt (épp egy hosszabb futás megy), a kérdésed nem fért bele az időbe. Kérdezd újra pár perc múlva.";
  if (code === HUB_CODE.timeout || code === HUB_CODE.connectionLost)
    return "⚠️ Az AI túl sokáig tartott, nem jött válasz. Kérdezd újra, esetleg szűkebben.";
  if (code === HUB_CODE.unauthorized || code === HUB_CODE.forbidden)
    return "🔑 A hub nem fogadja az app kulcsát (MY_CLAUDE_HUB_KEY a .notify/.env-ben).";
  return `⚠️ Nem sikerült válaszolni: ${(e as Error).message.slice(0, 200)}`;
}

/**
 * Answers the pending question; returns the HTML of the Telegram messages
 * (answer or error text). Never throws: the question is cleared either way.
 */
export async function runChat(chat: ChatDeps, ctx: Context, now = new Date()): Promise<string[]> {
  const st = loadChat(chat.file);
  const question = st.pending?.text;
  if (!question) return [];
  try {
    const prompt = buildChatPrompt({
      context: analysisContext(ctx),
      history: activeHistory(st, now),
      question,
      profile: chat.profile?.(),
    });
    // The engine is built with CHAT_SCHEMA (tg-app.ts); the prompt asks for that shape.
    const { output } = await chat.engine.run(prompt);
    const answer = answerOf(output);
    updateChat(chat.file, (cur) => ({
      history: appendExchange(cur, question, answer, now),
      ...(cur.pending && cur.pending.text !== question ? { pending: cur.pending } : {}),
    }));
    return splitMessage(answer).map(esc);
  } catch (e) {
    console.error("chat:", (e as Error).message);
    updateChat(chat.file, (cur) => ({
      history: cur.history,
      ...(cur.pending && cur.pending.text !== question ? { pending: cur.pending } : {}),
    }));
    return [esc(chatErrorText(e))];
  }
}

export { CHAT_SCHEMA };
