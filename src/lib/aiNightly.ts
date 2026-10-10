// The nightly AI analysis (made on the owner's machine, see scripts/notify/
// analysis/) from the private sync repo, with the device's sync token. Read
// only; looked up when the AI page opens and every 10 minutes after.

import { useEffect, useState } from "react";
import { getRepoFile } from "./sync";
import { ANALYSIS_LATEST_PATH, validateNightly, type NightlyAnalysis } from "./aiAnalysis";
import { usePortfolio } from "./store";

const REFRESH_MS = 10 * 60_000;

/** The newest nightly analysis, or null (no sync, none yet, unreadable). */
export function useNightlyAnalysis(): NightlyAnalysis | null {
  const config = usePortfolio((s) => s.syncConfig);
  const [found, setFound] = useState<NightlyAnalysis | null>(null);
  const key = config ? `${config.owner}/${config.repo}` : null;
  useEffect(() => {
    if (!config) return;
    let live = true;
    const load = () =>
      getRepoFile(config, ANALYSIS_LATEST_PATH).then(
        (file) => {
          if (live) setFound(file ? validateNightly(JSON.parse(file.text)) : null);
        },
        // Offline or unreadable: keep what's shown.
        () => undefined,
      );
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
    // `config` is a new object per store update; its repo names all it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return config ? found : null;
}
