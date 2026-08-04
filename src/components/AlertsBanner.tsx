import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertTriangle, X, ArrowRight } from "lucide-react";
import { usePortfolio, useActiveAlerts } from "../lib/store";
import { categorizeAlerts, type Alert } from "../lib/alerts";

const HIDE_KEY = "pf-alerts-banner-hidden";

/** Stable fingerprint of the current alert set, so the ✕ only hides THESE. */
function setKey(alerts: Alert[]): string {
  return alerts
    .map((a) => a.id)
    .sort()
    .join("|");
}

function loadHiddenKey(): string {
  try {
    return localStorage.getItem(HIDE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Slim top banner shown when there are active alerts — except on the dashboard,
 * where the Teendők card already shows the same alerts in full. The ✕ hides the
 * banner for the CURRENT alert set (persisted locally): it stays hidden across
 * reloads until a new/different alert appears. Dismissing an individual alert
 * on the Figyelmeztetések page remains the permanent, synced action.
 */
export default function AlertsBanner() {
  const location = useLocation();
  const active = useActiveAlerts();
  const alertState = usePortfolio((s) => s.alertState);
  const [hiddenKey, setHiddenKey] = useState(loadHiddenKey);
  const { active: visible } = categorizeAlerts(active, alertState);

  // The dashboard renders the full Teendők card — a banner pointing at the same
  // content right below it is pure noise.
  if (location.pathname === "/") return null;
  if (visible.length === 0) return null;
  const key = setKey(visible);
  if (key === hiddenKey) return null;

  function hide() {
    try {
      localStorage.setItem(HIDE_KEY, key);
    } catch {
      /* ignore */
    }
    setHiddenKey(key);
  }

  const n = visible.length;
  return (
    <div className="mb-6 flex items-center gap-3 rounded-xl border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-4 py-2.5">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-negative)]" />
      <Link to="/alerts" className="min-w-0 flex-1 text-sm hover:underline">
        <span className="font-medium">{n} aktív teendő</span>{" "}
        <span className="text-[var(--color-muted)]">— nézd meg</span>
      </Link>
      <Link
        to="/alerts"
        className="hidden shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline sm:inline-flex"
      >
        Megnézem <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <button
        onClick={hide}
        title="Elrejtés (amíg új teendő nem érkezik)"
        className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
