import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import Sidebar from "./components/Sidebar";
import MobileNav from "./components/MobileNav";
import InstallPrompt from "./components/InstallPrompt";
import UpdatePrompt from "./components/UpdatePrompt";
import AlertsBanner from "./components/AlertsBanner";
import { Skeleton } from "./components/ui";
import { usePortfolio, useActiveAlerts } from "./lib/store";

/** Re-fetch live prices at most this often when refreshing on tab focus. */
const REFRESH_MS = 5 * 60 * 1000;

export default function App() {
  const location = useLocation();
  const load = usePortfolio((s) => s.load);
  const loaded = usePortfolio((s) => s.loaded);
  const privacy = usePortfolio((s) => s.privacy);
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const reconcileAlerts = usePortfolio((s) => s.reconcileAlerts);
  const startupSync = usePortfolio((s) => s.startupSync);
  const refreshHistory = usePortfolio((s) => s.refreshHistory);
  const activeAlerts = useActiveAlerts();

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

  // Fold the current active alerts into the synced history (seen / fulfilled).
  useEffect(() => {
    if (loaded) reconcileAlerts(activeAlerts);
  }, [loaded, activeAlerts, reconcileAlerts]);

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

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-7xl px-5 py-8 pb-24 sm:px-8 md:pb-8 2xl:max-w-[1600px]">
          {loaded && <AlertsBanner />}
          {!loaded ? (
            <LoadingSkeleton />
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </main>
      <MobileNav />
      <InstallPrompt />
      <UpdatePrompt />
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
