import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_QUESTIONS,
  historyOf,
  loadConversation,
  newConversation,
  questionCount,
  saveConversation,
} from "./aiChat";

// The browser-side conversation of the AI chat (kept in localStorage, per device).

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("aiChat", () => {
  it("a new conversation has the frozen snapshot and no turns", () => {
    const c = newConversation("SNAPSHOT", new Date(2026, 10, 14, 10));
    expect(c).toMatchObject({ v: 2, context: "SNAPSHOT", turns: [] });
    expect(questionCount(c)).toBe(0);
    expect(historyOf(c)).toEqual([]);
    expect(historyOf(null)).toEqual([]);
  });

  it("saves and loads a conversation; an empty one is not kept", () => {
    const c = { ...newConversation("S"), turns: [{ role: "user" as const, text: "q" }, { role: "assistant" as const, text: "a" }] };
    saveConversation(c);
    expect(loadConversation()).toEqual(c);
    expect(questionCount(c)).toBe(1);
    saveConversation(newConversation("S"));
    expect(loadConversation()).toBeNull();
    saveConversation(null);
    expect(loadConversation()).toBeNull();
  });

  it("ignores broken or foreign data", () => {
    localStorage.setItem("pf-ai-hub-chat", "{not json");
    expect(loadConversation()).toBeNull();
    localStorage.setItem("pf-ai-hub-chat", JSON.stringify({ v: 1, context: "x", turns: [] }));
    expect(loadConversation()).toBeNull();
    localStorage.setItem("pf-ai-hub-chat", JSON.stringify({ v: 2, context: "x" }));
    expect(loadConversation()).toBeNull();
  });

  it("drops the saved conversation of the former API-key chat", () => {
    localStorage.setItem("pf-ai-chat", JSON.stringify({ v: 1, turns: [{ role: "user", text: "régi" }], api: [] }));
    loadConversation();
    expect(localStorage.getItem("pf-ai-chat")).toBeNull();
  });

  it("counts only the user's turns against the question limit", () => {
    const turns = Array.from({ length: MAX_QUESTIONS * 2 }, (_, i) => ({
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      text: String(i),
    }));
    expect(questionCount({ ...newConversation("S"), turns })).toBe(MAX_QUESTIONS);
  });
});
