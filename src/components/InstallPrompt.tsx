import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "portfolio.installDismissed";

/**
 * Install banner shown when the browser reports the app is installable
 * (Chrome/Edge/Android via beforeinstallprompt). iOS Safari never fires this —
 * there the user installs via Share → Add to Home Screen.
 */
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, "1");
  };

  const install = async () => {
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };

  return (
    <div className="fixed inset-x-0 bottom-16 z-50 flex justify-center px-4 md:bottom-0 md:pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-3 shadow-xl backdrop-blur-xl">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] text-white">
          <Download className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Telepítsd az appot</div>
          <div className="text-xs text-[var(--color-muted)]">
            Gyors indítás a kezdőképernyőről, offline is.
          </div>
        </div>
        <button className="btn-primary" onClick={install}>
          Telepítés
        </button>
        <button
          className="btn-ghost px-2"
          onClick={dismiss}
          aria-label="Bezárás"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
