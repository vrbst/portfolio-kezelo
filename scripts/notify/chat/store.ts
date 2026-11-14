// The Telegram conversation about the portfolio (.notify/chat.json). A file of
// its own, not state.json: the tick rebuilds that one from its own copy and
// would drop a field a concurrent chat job had just written. The my-claude-hub
// has no session to resume, so every question carries the recent turns.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ChatState {
  history: ChatTurn[];
  /** The question the chat job has to answer (set by the handler, cleared by the job). */
  pending?: { text: string; at: string };
}

/** After this much silence the next question starts a new conversation. */
export const CHAT_IDLE_MS = 60 * 60_000;
/** Most turns kept (a question + its answer = 2). */
export const CHAT_MAX_TURNS = 20;
/** A pending question older than this is dead (the job crashed): a new one may replace it. */
export const CHAT_PENDING_TTL_MS = 25 * 60_000;
/** Longest question taken (the rest is cut). */
export const CHAT_QUESTION_MAX = 2000;

export function loadChat(file: string): ChatState {
  const base: ChatState = { history: [] };
  try {
    if (!existsSync(file)) return base;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ChatState>;
    return {
      history: Array.isArray(raw.history) ? raw.history : [],
      ...(raw.pending ? { pending: raw.pending } : {}),
    };
  } catch {
    return base;
  }
}

/** Read–modify–write, atomic (the handler and the job are separate processes). */
export function updateChat(file: string, change: (cur: ChatState) => ChatState): ChatState {
  const next = change(loadChat(file));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
  return next;
}

/** The turns that still count as this conversation at `now` (none after a long silence). */
export function activeHistory(st: ChatState, now: Date): ChatTurn[] {
  const last = st.history[st.history.length - 1];
  if (!last || now.getTime() - Date.parse(last.at) > CHAT_IDLE_MS) return [];
  return st.history;
}

export const pendingAlive = (st: ChatState, now: Date): boolean =>
  !!st.pending && now.getTime() - Date.parse(st.pending.at) < CHAT_PENDING_TTL_MS;

/** The new history after one finished exchange (older conversations and overflow dropped). */
export function appendExchange(st: ChatState, question: string, answer: string, now: Date): ChatTurn[] {
  const at = now.toISOString();
  return [
    ...activeHistory(st, now),
    { role: "user" as const, text: question, at },
    { role: "assistant" as const, text: answer, at },
  ].slice(-CHAT_MAX_TURNS);
}
