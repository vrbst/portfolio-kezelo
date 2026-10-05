// The market-news digests (made on the owner's machine, see scripts/notify/
// news/) from the private sync repo, with the device's sync token. Read-only
// here; kept in memory for the session so switching pages doesn't refetch.

import { useEffect, useState } from "react";
import { getRepoFile, type SyncConfig } from "./sync";
import {
  NEWS_INDEX_PATH,
  newsDigestPath,
  validateDigest,
  validateNewsIndex,
  type NewsDigest,
  type NewsEdition,
  type NewsIndex,
} from "./newsSchema";
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

/** Forget what was loaded (the refresh button). */
export function clearNewsCache() {
  cache.clear();
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

/**
 * `load()` for the current `key` (null = nothing to load). The result is
 * kept with the key it belongs to, so a new key reads as loading at once.
 */
function useLoad<T>(key: string | null, load: () => Promise<T>): Loadable<T> {
  const [done, setDone] = useState<{ key: string; value: Loadable<T> } | null>(null);
  useEffect(() => {
    if (key == null) return;
    let live = true;
    load().then(
      (data) => live && setDone({ key, value: { status: "ready", data } }),
      (e: unknown) =>
        live &&
        setDone({ key, value: { status: "error", error: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
    // `load` is rebuilt every render; `key` names everything it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return done?.key === key ? done.value : { status: "loading" };
}

/** The digest index of the sync repo; bump `reload` after clearNewsCache(). */
export function useNewsIndex(reload = 0): Loadable<NewsIndex | null> {
  const config = usePortfolio((s) => s.syncConfig);
  const r = useLoad(config ? `${config.owner}/${config.repo}#${reload}` : null, () =>
    loadNewsIndex(config!),
  );
  return config ? r : { status: "off" };
}

/** One digest (null = none: ready with no data). */
export function useNewsDigest(
  pick: { day: string; edition: NewsEdition } | null,
  reload = 0,
): Loadable<NewsDigest | null> {
  const config = usePortfolio((s) => s.syncConfig);
  const key = config && pick ? `${config.owner}/${config.repo}:${pick.day}-${pick.edition}#${reload}` : null;
  const r = useLoad(key, () => loadNewsDigest(config!, pick!.day, pick!.edition));
  if (!config) return { status: "off" };
  if (!pick) return { status: "ready", data: null };
  return r;
}
