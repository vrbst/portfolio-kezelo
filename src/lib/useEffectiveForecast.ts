import { useEffect, useMemo, useState } from "react";
import { loadForecastSettings, type ForecastSettings } from "./forecast";
import { PREFS_EVENT } from "./prefs";
import { effectiveForecastSettings, estimateFromSettings, type OutlookReturnEstimate } from "./outlookReturns";
import { useOutlookFile } from "./outlookStore";
import { usePortfolioSummary } from "./store";

/**
 * manual: the user's own numbers; loading: "Kilátások alapján" but the file is
 * not here yet (the manual numbers stand in meanwhile); ready: derived numbers
 * in use; missing: the mode is on but there is no usable data (manual numbers).
 */
export type ForecastReturnStatus = "manual" | "loading" | "ready" | "missing";

export interface EffectiveForecast {
  /** What the user saved (never the derived numbers). */
  settings: ForecastSettings;
  /** What the forecast runs with. */
  effective: ForecastSettings;
  /** The outlook-derived numbers, whenever a file is there (also in manual mode: the preview). */
  estimate: OutlookReturnEstimate | null;
  status: ForecastReturnStatus;
}

/** For read-only consumers of the forecast settings (the glide path's expected line, …). */
export function useEffectiveForecast(): EffectiveForecast {
  const [settings, setSettings] = useState(loadForecastSettings);
  useEffect(() => {
    const reload = () => setSettings(loadForecastSettings());
    window.addEventListener(PREFS_EVENT, reload);
    return () => window.removeEventListener(PREFS_EVENT, reload);
  }, []);
  const summary = usePortfolioSummary();
  const outlook = useOutlookFile();
  const [now] = useState(() => new Date());
  const estimate = useMemo(
    () => (outlook === undefined ? null : estimateFromSettings(settings, summary, outlook, now)),
    [settings, summary, outlook, now],
  );
  const effective = useMemo(() => effectiveForecastSettings(settings, estimate), [settings, estimate]);
  const status: ForecastReturnStatus =
    settings.returnSource !== "outlook" ? "manual" : outlook === undefined ? "loading" : estimate?.usable ? "ready" : "missing";
  return { settings, effective, estimate, status };
}
