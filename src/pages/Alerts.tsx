import { Link } from 'react-router-dom'
import { BellRing, CheckCircle2, EyeOff, ShieldCheck, ArrowRight } from 'lucide-react'
import { usePortfolio, useActiveAlerts, usePortfolioSummary } from '../lib/store'
import { categorizeAlerts, computeStatusChecks } from '../lib/alerts'
import { PageHeader, Card, EmptyState } from '../components/ui'
import { AlertRow } from '../components/AlertsPanel'
import { formatDate } from '../lib/format'

export default function Alerts() {
  const summary = usePortfolioSummary()
  const active = useActiveAlerts()
  const alertState = usePortfolio((s) => s.alertState)
  const dismissAlert = usePortfolio((s) => s.dismissAlert)
  const restoreAlert = usePortfolio((s) => s.restoreAlert)
  const {
    active: visibleActive,
    fulfilled,
    dismissed,
  } = categorizeAlerts(active, alertState)

  // Passing status checks (e.g. current-year TBSZ present) — shown green here on
  // the Alerts page, but never on the Dashboard (which only surfaces problems).
  const okChecks = computeStatusChecks(summary).filter((c) => c.ok)

  const activeById = new Map(active.map((a) => [a.id, a]))
  const nothing =
    visibleActive.length === 0 &&
    okChecks.length === 0 &&
    fulfilled.length === 0 &&
    dismissed.length === 0

  return (
    <div>
      <PageHeader
        title="Figyelmeztetések"
        subtitle="Teendők és emlékeztetők a portfóliódhoz"
      />

      {nothing ? (
        <EmptyState
          title="Nincs figyelmeztetés"
          description="Jelenleg nincs teendő. Ha lesz (pl. parlagon álló készpénz, közelgő lejárat vagy hiányzó idei TBSZ), itt jelenik meg."
        />
      ) : (
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex items-center gap-2">
              <BellRing className="h-5 w-5 text-[var(--color-negative)]" />
              <h2 className="text-lg font-semibold">Aktív</h2>
              <span className="text-sm text-[var(--color-muted)]">
                ({visibleActive.length})
              </span>
            </div>
            {visibleActive.length === 0 ? (
              <Card className="p-4 text-sm text-[var(--color-muted)]">
                Nincs aktív teendő. 🎉
              </Card>
            ) : (
              <div className="space-y-2">
                {visibleActive.map((a) => (
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
            )}
          </section>

          {okChecks.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[var(--color-positive)]" />
                <h2 className="text-lg font-semibold">Rendben</h2>
                <span className="text-sm text-[var(--color-muted)]">
                  ({okChecks.length})
                </span>
              </div>
              <div className="space-y-2">
                {okChecks.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-start gap-3 rounded-xl border border-[var(--color-positive)]/30 bg-[var(--color-positive)]/5 p-3"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-positive)]" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{c.label}</div>
                      {c.detail && (
                        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                          {c.detail}
                        </div>
                      )}
                      {c.to && (
                        <Link
                          to={c.to}
                          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline"
                        >
                          Megnézem <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {fulfilled.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-[var(--color-positive)]" />
                <h2 className="text-lg font-semibold">Teljesült</h2>
                <span className="text-sm text-[var(--color-muted)]">
                  ({fulfilled.length})
                </span>
              </div>
              <div className="space-y-2">
                {fulfilled.map((r) => (
                  <AlertRow
                    key={r.id}
                    severity={r.severity}
                    title={r.title}
                    detail={`Teljesült · először: ${formatDate(r.firstSeenAt)}`}
                    muted
                  />
                ))}
              </div>
            </section>
          )}

          {dismissed.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <EyeOff className="h-5 w-5 text-[var(--color-muted)]" />
                <h2 className="text-lg font-semibold">Elvetett</h2>
                <span className="text-sm text-[var(--color-muted)]">
                  ({dismissed.length})
                </span>
              </div>
              <div className="space-y-2">
                {dismissed.map((r) => {
                  const stillActive = activeById.has(r.id)
                  return (
                    <AlertRow
                      key={r.id}
                      severity={r.severity}
                      title={r.title}
                      detail={
                        stillActive
                          ? `Elvetve: ${formatDate(r.dismissedAt)} · még fennáll`
                          : `Elvetve: ${formatDate(r.dismissedAt)}`
                      }
                      muted
                      onRestore={() => restoreAlert(r.id)}
                    />
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
