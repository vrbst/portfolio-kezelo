// The market-news digests (made on the owner's machine, see scripts/notify/
// news/) from the private sync repo, with the device's sync token. Read-only
// here; kept in memory and refreshed every 10 minutes (and when the app is
// shown again), so a new digest shows up in an open app. "Read" marks are per
// device (localStorage).

import { useEffect, useState, useSyncExternalStore } from "react";
import { getRepoFile, type SyncConfig } from "./sync";
import {
  NEWS_INDEX_PATH,
  newsDigestPath,
  validateDigest,
  validateNewsIndex,
  type NewsDigest,
  type NewsEdition,
  type NewsIndex,
  type NewsIndexEntry,
  seenKey,
  unreadToday,
} from "./newsSchema";
import { toLocalDay } from "./day";
import { usePortfolio } from "./store";

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    // A failure is not remembered: the next visit tries again.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export function loadNewsIndex(config: SyncConfig): Promise<NewsIndex | null> {
  return cached(`index:${config.owner}/${config.repo}`, async () => {
    const file = await getRepoFile(config, NEWS_INDEX_PATH);
    return file ? validateNewsIndex(JSON.parse(file.text)) : null;
  });
}

export function loadNewsDigest(
  config: SyncConfig,
  day: string,
  edition: NewsEdition,
): Promise<NewsDigest | null> {
  return cached(`digest:${config.owner}/${config.repo}:${day}-${edition}`, async () => {
    const file = await getRepoFile(config, newsDigestPath(day, edition));
    return file ? validateDigest(JSON.parse(file.text)) : null;
  });
}

/** "okt. 5., hétfő" — built from the local day, never via a UTC parse. */
export function newsDayLabel(day: string, weekday = true): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("hu-HU", {
    month: "short",
    day: "numeric",
    ...(weekday ? { weekday: "long" as const } : {}),
  }).format(new Date(y, m - 1, d));
}

export type Loadable<T> =
  | { status: "off" } // no cloud sync on this device
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

// ---- refresh: one shared version, bumped every 10 minutes and on return ----

/** How often an open app looks for a new digest (and when it's shown again). */
export const NEWS_REFRESH_MS = 10 * 60_000;

let version = 0;
let bumpedAt = Date.now();
const versionListeners = new Set<() => void>();
let stopTimers: (() => void) | null = null;

function bump() {
  cache.clear();
  version++;
  bumpedAt = Date.now();
  for (const l of versionListeners) l();
}

function subscribeVersion(l: () => void) {
  versionListeners.add(l);
  if (!stopTimers) {
    const id = setInterval(bump, NEWS_REFRESH_MS);
    const onShow = () => {
      if (document.visibilityState === "visible" && Date.now() - bumpedAt > NEWS_REFRESH_MS / 2) bump();
    };
    document.addEventListener("visibilitychange", onShow);
    stopTimers = () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
    };
  }
  return () => {
    versionListeners.delete(l);
    if (!versionListeners.size && stopTimers) {
      stopTimers();
      stopTimers = null;
    }
  };
}

/** Load everything again now (the refresh button). */
export function refreshNews() {
  bump();
}

const useVersion = () => useSyncExternalStore(subscribeVersion, () => version);

/**
 * `load()` for `base` (null = nothing to load), again whenever `version`
 * changes. While a reload of the same `base` runs, the previous result stays
 * (no flicker every 10 minutes); a new `base` reads as loading at once.
 */
function useLoad<T>(base: string | null, version: number, load: () => Promise<T>): Loadable<T> {
  const [done, setDone] = useState<{ base: string; value: Loadable<T> } | null>(null);
  useEffect(() => {
    if (base == null) return;
    let live = true;
    load().then(
      (data) => live && setDone({ base, value: { status: "ready", data } }),
      (e: unknown) =>
        live &&
        setDone({ base, value: { status: "error", error: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
    // `load` is rebuilt every render; `base` and `version` name all it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, version]);
  return done?.base === base ? done.value : { status: "loading" };
}

/** The digest index of the sync repo (refreshed in the background). */
export function useNewsIndex(): Loadable<NewsIndex | null> {
  const config = usePortfolio((s) => s.syncConfig);
  const v = useVersion();
  const r = useLoad(config ? `${config.owner}/${config.repo}` : null, v, () => loadNewsIndex(config!));
  return config ? r : { status: "off" };
}

/** One digest (null = none: ready with no data). */
export function useNewsDigest(pick: { day: string; edition: NewsEdition } | null): Loadable<NewsDigest | null> {
  const config = usePortfolio((s) => s.syncConfig);
  const v = useVersion();
  const base = config && pick ? `${config.owner}/${config.repo}:${pick.day}-${pick.edition}` : null;
  const r = useLoad(base, v, () => loadNewsDigest(config!, pick!.day, pick!.edition));
  if (!config) return { status: "off" };
  if (!pick) return { status: "ready", data: null };
  return r;
}

// ---- read marks (per device) --------------------------------------------------

const SEEN_KEY = "pf-news-seen";

function loadSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let seen = loadSeen();
const seenListeners = new Set<() => void>();

/** Mark one digest version read (only today's matter; a few are kept). */
export function markNewsSeen(entries: NewsIndexEntry[]) {
  const add = entries.map(seenKey).filter((k) => !seen.includes(k));
  if (!add.length) return;
  seen = [...seen, ...add].slice(-20);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
  for (const l of seenListeners) l();
}

function subscribeSeen(l: () => void) {
  seenListeners.add(l);
  return () => void seenListeners.delete(l);
}

/** Today's digests not read on this device yet (empty without sync). */
export function useTodayUnread(): NewsIndexEntry[] {
  const index = useNewsIndex();
  const s = useSyncExternalStore(subscribeSeen, () => seen);
  return index.status === "ready" ? unreadToday(index.data, s, toLocalDay()) : [];
}
