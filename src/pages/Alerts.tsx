import { BellRing, CheckCircle2, EyeOff } from 'lucide-react'
import { usePortfolio, useActiveAlerts } from '../lib/store'
import { categorizeAlerts } from '../lib/alerts'
import { PageHeader, Card, EmptyState } from '../components/ui'
import { AlertRow } from '../components/AlertsPanel'
import { formatDate } from '../lib/format'

export default function Alerts() {
  const active = useActiveAlerts()
  const alertState = usePortfolio((s) => s.alertState)
  const dismissAlert = usePortfolio((s) => s.dismissAlert)
  const restoreAlert = usePortfolio((s) => s.restoreAlert)
  const {
    active: visibleActive,
    fulfilled,
    dismissed,
  } = categorizeAlerts(active, alertState)

  const activeById = new Map(active.map((a) => [a.id, a]))
  const nothing =
    visibleActive.length === 0 && fulfilled.length === 0 && dismissed.length === 0

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
