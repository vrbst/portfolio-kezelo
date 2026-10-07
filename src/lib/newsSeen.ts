// Which news digests are read. A synced pref (see prefs.ts), merged as a
// union so reading on one device never un-reads on another. Kept apart from
// news.ts so prefs.ts can load it without an import cycle.

import { touchPref } from "./prefs";

const SEEN_KEY = "pf-news-seen";
const KEEP = 20;

export function loadNewsSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Both lists, no duplicates, the latest few kept (only today's matter). */
export function mergeNewsSeen(a: unknown, b: unknown): string[] {
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is string => typeof k === "string") : []);
  return [...new Set([...list(a), ...list(b)])].slice(-KEEP);
}

export function saveNewsSeen(seen: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    touchPref("newsSeen");
  } catch {
    /* ignore */
  }
}
