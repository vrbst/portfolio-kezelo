// The nightly AI analysis (made on the owner's machine, see scripts/notify/
// analysis/) from the sync store (Drive or the private repo). Read
// only; looked up when the AI page opens and every 10 minutes after.

import { useEffect, useState } from "react";
import { readRemoteFile } from "./remote";
import { ANALYSIS_LATEST_PATH, validateNightly, type NightlyAnalysis } from "./aiAnalysis";
import { usePortfolio } from "./store";

const REFRESH_MS = 10 * 60_000;

/** The newest nightly analysis, or null (no sync, none yet, unreadable). */
export function useNightlyAnalysis(): NightlyAnalysis | null {
  const target = usePortfolio((s) => s.syncTarget);
  const [found, setFound] = useState<NightlyAnalysis | null>(null);
  const key = target?.id ?? null;
  useEffect(() => {
    if (!target) return;
    let live = true;
    const load = () =>
      readRemoteFile(target, ANALYSIS_LATEST_PATH).then(
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
    // `target` only changes with the sync config; its id names all it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return target ? found : null;
}
