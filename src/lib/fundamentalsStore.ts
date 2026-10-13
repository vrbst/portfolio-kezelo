import { useEffect, useState } from "react";
import type { SyncTarget } from "./remote";
import { FUNDAMENTALS_PATH, validateFundamentalsFile, type FundamentalsFile } from "./fundamentals";
import { usePortfolio } from "./store";

const TTL_MS = 60 * 60_000;
let cache: { key: string; at: number; file: Promise<FundamentalsFile | null> } | null = null;

export function loadFundamentalsFile(target: SyncTarget): Promise<FundamentalsFile | null> {
  const key = target.id;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.file;
  const file = target.store.read(FUNDAMENTALS_PATH).then((f) =>
    f ? validateFundamentalsFile(JSON.parse(f.text)) : null,
  );
  const entry = { key, at: Date.now(), file };
  cache = entry;
  file.catch(() => {
    if (cache === entry) cache = null;
  });
  return file;
}

export function useFundamentalsFile(): FundamentalsFile | null {
  const target = usePortfolio((s) => s.syncTarget);
  const [loaded, setLoaded] = useState<{ key: string; file: FundamentalsFile | null } | null>(null);
  const key = target?.id ?? null;
  useEffect(() => {
    if (!target || !key) return;
    let live = true;
    loadFundamentalsFile(target).then(
      (file) => live && setLoaded({ key, file }),
      () => live && setLoaded({ key, file: null }),
    );
    return () => {
      live = false;
    };
  }, [target, key]);
  return loaded && loaded.key === key ? loaded.file : null;
}
