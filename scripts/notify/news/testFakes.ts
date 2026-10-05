// Test fakes for the news digest: an in-memory repo and a scripted AI.

import type { NewsEngine } from "./engine";
import type { NewsStore } from "./job";

export function memoryStore(files: Record<string, string> = {}) {
  const writes: string[] = [];
  const store: NewsStore & { files: Record<string, string>; writes: string[] } = {
    files,
    writes,
    read: async (p) => files[p] ?? null,
    write: async (p, text) => {
      writes.push(p);
      files[p] = text;
    },
  };
  return store;
}

export function fakeEngine(answers: unknown[]): NewsEngine & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    model: "teszt",
    prompts,
    run: async (p) => {
      prompts.push(p);
      if (!answers.length) throw new Error("no more answers");
      return { output: answers.shift(), costUsd: 0.1 };
    },
  };
}
