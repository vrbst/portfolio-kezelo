import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, X, ArrowRight } from 'lucide-react'
import { usePortfolio, useActiveAlerts } from '../lib/store'
import { categorizeAlerts } from '../lib/alerts'

/**
 * Slim top banner shown when there are active alerts. Clicking it opens the
 * Figyelmeztetések page; the ✕ hides it for THIS session only (it reappears on
 * reload) — distinct from dismissing an individual alert, which is permanent.
 */
export default function AlertsBanner() {
  const active = useActiveAlerts()
  const alertState = usePortfolio((s) => s.alertState)
  const [hidden, setHidden] = useState(false)
  const { active: visible } = categorizeAlerts(active, alertState)
  if (hidden || visible.length === 0) return null

  const n = visible.length
  return (
    <div className="mb-6 flex items-center gap-3 rounded-xl border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-4 py-2.5">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-negative)]" />
      <Link to="/alerts" className="min-w-0 flex-1 text-sm hover:underline">
        <span className="font-medium">
          {n} aktív {n === 1 ? 'teendő' : 'teendő'}
        </span>{' '}
        <span className="text-[var(--color-muted)]">— nézd meg</span>
      </Link>
      <Link
        to="/alerts"
        className="hidden shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline sm:inline-flex"
      >
        Megnézem <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <button
        onClick={() => setHidden(true)}
        title="Elrejtés (mostanra)"
        className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
