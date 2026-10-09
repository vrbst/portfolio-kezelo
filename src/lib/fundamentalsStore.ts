import { useEffect, useState } from "react";
import { getRepoFile, type SyncConfig } from "./sync";
import { FUNDAMENTALS_PATH, validateFundamentalsFile, type FundamentalsFile } from "./fundamentals";
import { usePortfolio } from "./store";

const TTL_MS = 60 * 60_000;
let cache: { key: string; at: number; file: Promise<FundamentalsFile | null> } | null = null;

export function loadFundamentalsFile(config: SyncConfig): Promise<FundamentalsFile | null> {
  const key = `${config.owner}/${config.repo}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.file;
  const file = getRepoFile(config, FUNDAMENTALS_PATH).then((f) =>
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
  const config = usePortfolio((s) => s.syncConfig);
  const [loaded, setLoaded] = useState<{ key: string; file: FundamentalsFile | null } | null>(null);
  const key = config ? `${config.owner}/${config.repo}` : null;
  useEffect(() => {
    if (!config || !key) return;
    let live = true;
    loadFundamentalsFile(config).then(
      (file) => live && setLoaded({ key, file }),
      () => live && setLoaded({ key, file: null }),
    );
    return () => {
      live = false;
    };
  }, [config, key]);
  return loaded && loaded.key === key ? loaded.file : null;
}
