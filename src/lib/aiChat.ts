// The AI chat conversation, kept on this device. The API history is
// append-only and its system prompt (the portfolio snapshot), model and tool
// set are frozen for the conversation's life: that keeps the prompt cache warm
// between turns and keeps earlier thinking blocks valid (the API checks that
// the prefix they were produced with is unchanged).

import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AiSource } from "./ai";

export interface DisplayTurn {
  role: "user" | "assistant";
  text: string;
  /** Tool calls / searches made while answering (labels). */
  activity?: string[];
  sources?: AiSource[];
  costUsd?: number;
  note?: string;
}

export interface Conversation {
  v: 1;
  startedAt: string;
  model: string;
  tools: boolean;
  web: boolean;
  /** Frozen portfolio snapshot sent as the system prompt. */
  context: string;
  /** Exact API history (content blocks incl. thinking, tool calls). */
  api: BetaMessageParam[];
  turns: DisplayTurn[];
}

const KEY = "pf-ai-chat";

export function newConversation(
  model: string,
  tools: boolean,
  web: boolean,
  context: string,
): Conversation {
  return {
    v: 1,
    startedAt: new Date().toISOString(),
    model,
    tools,
    web,
    context,
    api: [],
    turns: [],
  };
}

export function loadConversation(): Conversation | null {
  try {
    const raw = localStorage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as Conversation) : null;
    return c && c.v === 1 && Array.isArray(c.api) ? c : null;
  } catch {
    return null;
  }
}

/** Persist; a conversation too big for storage is simply not kept (it still
 *  works in this session). */
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

/** Questions asked so far. */
export const questionCount = (c: Conversation | null) =>
  c ? c.turns.filter((t) => t.role === "user").length : 0;
