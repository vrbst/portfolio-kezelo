import { Link } from "react-router-dom";
import {
  AlertTriangle,
  X,
  ArrowRight,
  ChevronRight,
  RefreshCw,
  CloudOff,
} from "lucide-react";
import {
  usePortfolio,
  useActiveAlerts,
  useAlertsReadiness,
} from "../lib/store";
import {
  categorizeAlerts,
  type Alert,
  type AlertSeverity,
} from "../lib/alerts";
import { Card } from "./ui";
import PrivateText from "./PrivateText";

/**
 * Why the alerts aren't (fully) trustworthy yet: the cloud pull is still
 * running (none are computed), or it failed (shown from local data, marked).
 * Renders nothing once the device reflects the cloud copy.
 */
export function AlertsSyncNote({ className = "" }: { className?: string }) {
  const readiness = useAlertsReadiness();
  if (readiness === "ready") return null;
  const syncing = readiness === "syncing";
  const Icon = syncing ? RefreshCw : CloudOff;
  return (
    <div
      className={`flex items-center gap-2 text-sm text-[var(--color-muted)] ${className}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${syncing ? "animate-spin" : ""}`} />
      {syncing
        ? "Szinkronizálás a felhővel… a teendők utána jelennek meg."
        : "A felhős szinkron nem sikerült — a teendők a nem szinkronizált helyi adatokból számolódnak."}
    </div>
  );
}

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
  id,
  severity,
  title,
  detail,
  to,
  actionLabel,
  muted = false,
  onDismiss,
  onRestore,
}: {
  /** Alert id — lets savings-goal alerts blur their instrument names too. */
  id?: string;
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
          <PrivateText text={title} alertId={id} />
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
export default function AlertsPanel({ compact = false }: { compact?: boolean }) {
  const active = useActiveAlerts();
  const alertState = usePortfolio((s) => s.alertState);
  const dismissAlert = usePortfolio((s) => s.dismissAlert);
  const readiness = useAlertsReadiness();
  const { active: visible } = categorizeAlerts(active, alertState);
  if (readiness === "syncing")
    return (
      <Card className="mb-6 p-4">
        <AlertsSyncNote />
      </Card>
    );
  if (visible.length === 0) return null;

  if (compact) {
    const first = visible[0];
    return (
      <Link
        to="/alerts"
        className="card mobile-row mb-4 flex items-center gap-3 border-[var(--color-negative)]/40 bg-[var(--color-negative)]/5 px-4 py-3"
      >
        <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--color-negative)]/15 text-[var(--color-negative)]">
          <AlertTriangle className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {visible.length} teendő
          </div>
          <div className="truncate text-xs text-[var(--color-muted)]">
            <PrivateText text={first.title} alertId={first.id} />
            {visible.length > 1 && ` és még ${visible.length - 1}`}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
      </Link>
    );
  }

  return (
    <Card className="mb-6 border-[var(--color-negative)]/40 bg-[var(--color-negative)]/5 p-6">
      <AlertsSyncNote className="mb-3" />
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
            id={a.id}
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
