import { useEffect, useState } from "react";
import type { SyncTarget } from "./remote";
import { OUTLOOK_PATH, validateOutlookFile, type OutlookFile } from "./outlook";
import { usePortfolio } from "./store";

const TTL_MS = 60 * 60_000;
let cache: { key: string; at: number; file: Promise<OutlookFile | null> } | null = null;

export function loadOutlookFile(target: SyncTarget): Promise<OutlookFile | null> {
  const key = target.id;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.file;
  const file = target.store.read(OUTLOOK_PATH).then((f) => (f ? validateOutlookFile(JSON.parse(f.text)) : null));
  const entry = { key, at: Date.now(), file };
  cache = entry;
  file.catch(() => {
    if (cache === entry) cache = null;
  });
  return file;
}

export function useOutlookFile(): OutlookFile | null {
  const target = usePortfolio((s) => s.syncTarget);
  const [loaded, setLoaded] = useState<{ key: string; file: OutlookFile | null } | null>(null);
  const key = target?.id ?? null;
  useEffect(() => {
    if (!target || !key) return;
    let live = true;
    loadOutlookFile(target).then(
      (file) => live && setLoaded({ key, file }),
      () => live && setLoaded({ key, file: null }),
    );
    return () => {
      live = false;
    };
  }, [target, key]);
  return loaded && loaded.key === key ? loaded.file : null;
}
