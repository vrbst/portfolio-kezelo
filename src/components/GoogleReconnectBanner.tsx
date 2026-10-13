import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { usePortfolio } from "../lib/store";
import { useGoogleTokenValid } from "../lib/useGoogleToken";

/**
 * Shown on every page once the Google access token (about an hour) has lapsed
 * — the sync can't reach Drive until the user signs in again, and that needs
 * a click (browsers block a popup otherwise). One tap renews it.
 */
export default function GoogleReconnectBanner() {
  const googleSync = usePortfolio((s) => s.googleSync);
  const reconnect = usePortfolio((s) => s.reconnectGoogleSession);
  const valid = useGoogleTokenValid();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!googleSync || valid) return null;

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await reconnect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm"
      data-testid="google-reconnect"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-negative)]" />
      <span className="min-w-0 flex-1">
        A Google-hozzáférés lejárt, a szinkron addig áll — egy koppintással megújítható.
      </span>
      <button className="btn-primary" onClick={onClick} disabled={busy}>
        Kapcsolódj újra
      </button>
      {error && <p className="basis-full text-xs text-[var(--color-negative)]">{error}</p>}
    </div>
  );
}
