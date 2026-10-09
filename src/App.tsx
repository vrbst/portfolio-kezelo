import { useEffect, useState } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useIsPresent,
} from "motion/react";
import Sidebar from "./components/Sidebar";
import MobileNav from "./components/MobileNav";
import MobileTopBar from "./components/MobileTopBar";
import InstallPrompt from "./components/InstallPrompt";
import UpdatePrompt from "./components/UpdatePrompt";
import TouchTitles from "./components/TouchTitles";
import AlertsBanner from "./components/AlertsBanner";
import { Skeleton } from "./components/ui";
import {
  usePortfolio,
  useActiveAlerts,
  useAlertsReadiness,
} from "./lib/store";
import { isSnappy, useSkin } from "./lib/skin";

/** Re-fetch live prices at most this often when refreshing on tab focus. */
const REFRESH_MS = 5 * 60 * 1000;

export default function App() {
  const location = useLocation();
  const load = usePortfolio((s) => s.load);
  const loaded = usePortfolio((s) => s.loaded);
  const privacy = usePortfolio((s) => s.privacy);
  const skin = useSkin((s) => s.skin);
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const reconcileAlerts = usePortfolio((s) => s.reconcileAlerts);
  const startupSync = usePortfolio((s) => s.startupSync);
  const refreshHistory = usePortfolio((s) => s.refreshHistory);
  const activeAlerts = useActiveAlerts();
  const alertsReadiness = useAlertsReadiness();

  useEffect(() => {
    load();
  }, [load]);

  // Once local data is loaded, pull from the cloud if it has a newer copy, and
  // fetch the daily chart history for every held security.
  useEffect(() => {
    if (loaded) {
      void startupSync();
      void refreshHistory();
    }
  }, [loaded, startupSync, refreshHistory]);

  // Fold the current active alerts into the synced history (seen / fulfilled)
  // — only once this device reflects the cloud copy: alerts from stale local
  // data (or an offline start) must never land in the synced history.
  useEffect(() => {
    if (loaded && alertsReadiness === "ready") reconcileAlerts(activeAlerts);
  }, [loaded, alertsReadiness, activeAlerts, reconcileAlerts]);

  // Keep prices fresh: poll every 5 minutes, and whenever the user returns to
  // the tab (but not more often than REFRESH_MS, to avoid a focus storm).
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      void refreshPrices();
    };
    const id = setInterval(refresh, REFRESH_MS);
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - last > REFRESH_MS
      )
        refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshPrices]);

  useEffect(() => {
    document.documentElement.classList.toggle("privacy-on", privacy);
  }, [privacy]);

  // Terminal/retro skins: no sliding/springing — only fades remain, so they feel
  // snappy.
  return (
    <MotionConfig reducedMotion={isSnappy(skin) ? "always" : "user"}>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 min-w-0">
          <div className="relative mx-auto max-w-7xl px-4 pb-28 pt-0 md:px-8 md:py-8 2xl:max-w-[1600px]">
            <MobileTopBar />
            {loaded && <AlertsBanner />}
            {!loaded ? (
              <LoadingSkeleton />
            ) : (
              // popLayout: the new page mounts at once while the old one fades
              // out on top (a "wait" transition stalls in a hidden tab, where no
              // animation frame runs, and then remounts the new page).
              <AnimatePresence mode="popLayout">
                <motion.div
                  // Keyed by skin too: a switch remounts the page so skinned
                  // colour tables (lib/skin.ts) are re-read.
                  key={`${skin}:${location.pathname}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  <FrozenOutlet />
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </main>
        <MobileNav />
        <InstallPrompt />
        <UpdatePrompt />
        <TouchTitles />
      </div>
    </MotionConfig>
  );
}

/**
 * The route element captured when this page mounted. A plain <Outlet /> in
 * the exiting (fading-out) wrapper would render the NEW route — so that page
 * got built twice and every draft in it (a half-edited form) was lost when
 * the exit finished. Frozen, each page mounts exactly once.
 */
function FrozenOutlet() {
  const outlet = useOutlet();
  const [frozen] = useState(outlet);
  // The page fading out lies on top of the new one: keep it from taking clicks.
  const present = useIsPresent();
  return (
    <div
      className={present ? undefined : "pointer-events-none"}
      aria-hidden={!present || undefined}
    >
      {frozen}
    </div>
  );
}

/** First-paint placeholder while IndexedDB loads: mirrors the dashboard shape
 * (title, four stat cards, chart + sidebar) with shimmering blocks. */
function LoadingSkeleton() {
  return (
    <div>
      <Skeleton className="h-8 w-44" />
      <div className="mt-2">
        <Skeleton className="h-4 w-64 border-0" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1 space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-40" />
        </div>
        <div className="w-full space-y-4 xl:w-[400px] xl:shrink-0">
          <Skeleton className="h-44" />
          <Skeleton className="h-64" />
        </div>
      </div>
    </div>
  );
}
