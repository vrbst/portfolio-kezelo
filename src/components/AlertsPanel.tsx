import { Link } from "react-router-dom";
import { AlertTriangle, X, ArrowRight } from "lucide-react";
import { usePortfolio, useActiveAlerts } from "../lib/store";
import {
  categorizeAlerts,
  type Alert,
  type AlertSeverity,
} from "../lib/alerts";
import { Card } from "./ui";

const SEV_DOT: Record<AlertSeverity, string> = {
  high: "bg-[var(--color-negative)]",
  medium: "bg-[var(--color-warning)]",
  info: "bg-[var(--color-brand)]",
};

/**
 * One alert row, reused by the Dashboard panel and the Figyelmeztetések page.
 * `tone` switches the trailing control: dismiss (active), nothing (fulfilled),
 * or restore (dismissed).
 */
export function AlertRow({
  severity,
  title,
  detail,
  to,
  actionLabel,
  muted = false,
  onDismiss,
  onRestore,
}: {
  severity: AlertSeverity;
  title: string;
  detail?: string;
  to?: string;
  actionLabel?: string;
  muted?: boolean;
  onDismiss?: () => void;
  onRestore?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          muted ? "bg-[var(--color-muted)]" : SEV_DOT[severity]
        }`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`font-medium ${muted ? "text-[var(--color-muted)]" : ""}`}
        >
          {title}
        </div>
        {detail && (
          <div className="amt mt-0.5 text-xs text-[var(--color-muted)]">
            {detail}
          </div>
        )}
        {to && actionLabel && (
          <Link
            to={to}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline"
          >
            {actionLabel} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          title="Elvet"
          className="shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {onRestore && (
        <button
          onClick={onRestore}
          className="shrink-0 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted)] transition hover:border-[var(--color-brand)]/40 hover:text-[var(--color-text)]"
        >
          Visszaállít
        </button>
      )}
    </div>
  );
}

/**
 * Dashboard "Teendők" card: the active (non-dismissed) alerts, red-tinted.
 * Renders nothing when there's nothing to do.
 */
export default function AlertsPanel() {
  const active = useActiveAlerts();
  const alertState = usePortfolio((s) => s.alertState);
  const dismissAlert = usePortfolio((s) => s.dismissAlert);
  const { active: visible } = categorizeAlerts(active, alertState);
  if (visible.length === 0) return null;

  return (
    <Card className="mb-6 border-[var(--color-negative)]/40 bg-[var(--color-negative)]/5 p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-[var(--color-negative)]" />
          <h2 className="text-lg font-semibold">Teendők</h2>
        </div>
        <Link
          to="/alerts"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-brand)] hover:underline"
        >
          Összes <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <div className="space-y-2">
        {visible.map((a: Alert) => (
          <AlertRow
            key={a.id}
            severity={a.severity}
            title={a.title}
            detail={a.detail}
            to={a.to}
            actionLabel={a.actionLabel}
            onDismiss={() => dismissAlert(a)}
          />
        ))}
      </div>
    </Card>
  );
}
