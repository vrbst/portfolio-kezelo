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

/** The current time, refreshed hourly and when the tab comes back: staleness and horizons must not freeze at page load. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = window.setInterval(tick, 3_600_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

/**
 * The forecast's numbers as it runs with them. For read-only consumers (the
 * glide path's expected line, …) it loads the saved settings itself; the
 * Forecast page passes its own, editable settings in (`given`) so there is
 * one definition of "what the forecast runs with" and of its status.
 */
export function useEffectiveForecast(given?: ForecastSettings): EffectiveForecast {
  const [own, setOwn] = useState(loadForecastSettings);
  useEffect(() => {
    if (given) return;
    const reload = () => setOwn(loadForecastSettings());
    window.addEventListener(PREFS_EVENT, reload);
    return () => window.removeEventListener(PREFS_EVENT, reload);
  }, [given]);
  const settings = given ?? own;
  const summary = usePortfolioSummary();
  const outlook = useOutlookFile();
  const now = useNow();
  const estimate = useMemo(
    () => (outlook === undefined ? null : estimateFromSettings(settings, summary, outlook, now)),
    [settings, summary, outlook, now],
  );
  const effective = useMemo(() => effectiveForecastSettings(settings, estimate), [settings, estimate]);
  const status: ForecastReturnStatus =
    settings.returnSource !== "outlook" ? "manual" : outlook === undefined ? "loading" : estimate?.usable ? "ready" : "missing";
  return { settings, effective, estimate, status };
}
