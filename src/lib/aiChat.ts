// The AI chat conversation, kept on this device. The chat runs on the my-claude-hub through the
// local bridge (aiBridge.ts), which has no session to resume: every question carries the earlier
// turns, and the portfolio snapshot the conversation started with (frozen, so the later answers
// stay consistent with the earlier ones).

export interface DisplayTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Conversation {
  v: 2;
  startedAt: string;
  /** The portfolio snapshot taken when the first question was asked. */
  context: string;
  turns: DisplayTurn[];
}

const KEY = "pf-ai-hub-chat";
/** The key of the former, API-key chat; its saved conversation is dropped. */
const OLD_KEY = "pf-ai-chat";

/** Most questions in one conversation (the whole history goes along with each one). */
export const MAX_QUESTIONS = 20;
/** Longest question taken (the bridge cuts the same). */
export const MAX_QUESTION_CHARS = 2000;

export function newConversation(context: string, now = new Date()): Conversation {
  return { v: 2, startedAt: now.toISOString(), context, turns: [] };
}

export function loadConversation(): Conversation | null {
  try {
    localStorage.removeItem(OLD_KEY);
    const raw = localStorage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as Conversation) : null;
    return c && c.v === 2 && typeof c.context === "string" && Array.isArray(c.turns) ? c : null;
  } catch {
    return null;
  }
}

/** Persist; a conversation too big for storage is simply not kept (it still works in this session). */
export function saveConversation(c: Conversation | null) {
  try {
    if (!c || c.turns.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

/** A stored ISO moment as hu-HU month/day/time in local time; "" if unreadable. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Questions asked so far. */
export const questionCount = (c: Conversation | null) =>
  c ? c.turns.filter((t) => t.role === "user").length : 0;

/** What the bridge needs for the next question: the turns so far (the new question is not among them). */
export const historyOf = (c: Conversation | null): DisplayTurn[] => (c ? c.turns : []);
