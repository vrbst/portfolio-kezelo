import { useEffect } from "react";
import { RefreshCw, X } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";

/** Re-check for a new deploy this often while the app stays open. */
const CHECK_MS = 30 * 60 * 1000;

/**
 * "Új verzió érhető el" toast. The service worker runs in "prompt" mode: a new
 * build installs in the background but only activates when the user clicks
 * Frissítés (which reloads with the new version). Checks for updates
 * periodically and when the tab regains focus, so a long-lived PWA window
 * notices a deploy without any manual hard reload.
 */
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      if (!registration) return;
      const check = async () => {
        if (registration.installing || !navigator.onLine) return;
        try {
          // Bypass the HTTP cache so a fresh sw.js is actually fetched.
          const resp = await fetch(swUrl, { cache: "no-store" });
          if (resp.ok) await registration.update();
        } catch {
          /* offline / transient network error — try again next tick */
        }
      };
      setInterval(check, CHECK_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void check();
      });
    },
  });

  // Keyboard-reachable escape hatch: Esc dismisses the toast.
  useEffect(() => {
    if (!needRefresh) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNeedRefresh(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [needRefresh, setNeedRefresh]);

  if (!needRefresh) return null;

  return (
    <div className="fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 md:bottom-6">
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--color-brand)]/40 bg-[var(--color-surface)] px-4 py-3 shadow-xl">
        <RefreshCw className="h-4 w-4 shrink-0 text-[var(--color-brand)]" />
        <span className="text-sm">Új verzió érhető el.</span>
        <button
          className="btn-primary px-3 py-1.5 text-sm"
          onClick={() => void updateServiceWorker(true)}
        >
          Frissítés
        </button>
        <button
          className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          onClick={() => setNeedRefresh(false)}
          title="Később"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
