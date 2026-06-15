// Rule-based portfolio alerts ("Figyelmeztetések / Teendők").
//
// Pure & deterministic — no AI, no extra data. computeAlerts() derives the
// currently-active alerts from the live summary; reconcileAlertState() keeps a
// synced history (seen / dismissed) so the Alerts page can show which alerts are
// active, which resolved on their own (fulfilled), and which you dismissed.

import type { PortfolioSummary } from './portfolio'
import { upcomingEvents } from './events'
import { formatMoney } from './format'

export type AlertSeverity = 'high' | 'medium' | 'info'

export interface Alert {
  /** Stable id used for dismiss / history tracking. */
  id: string
  severity: AlertSeverity
  title: string
  detail?: string
  /** Optional deep link (router path) to act on the alert. */
  to?: string
  actionLabel?: string
}

export interface AlertConfig {
  /** Cash above this (HUF) on any account raises an "idle cash" alert. */
  idleCashHuf: number
  /** Surface upcoming-event alerts within this many days. */
  eventHorizonDays: number
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  idleCashHuf: 100_000,
  eventHorizonDays: 14,
}

const IDLE_KEY = 'pf-alert-idle-cash'

/** Per-device alert config (only the idle-cash threshold is user-tunable). */
export function loadAlertConfig(): AlertConfig {
  let idleCashHuf = DEFAULT_ALERT_CONFIG.idleCashHuf
  try {
    const v = Number(localStorage.getItem(IDLE_KEY))
    if (Number.isFinite(v) && v > 0) idleCashHuf = v
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_ALERT_CONFIG, idleCashHuf }
}

export function saveIdleCashThreshold(huf: number) {
  try {
    localStorage.setItem(IDLE_KEY, String(huf))
  } catch {
    /* ignore */
  }
}

/**
 * Binary status checks: each is either OK (green "Rendben" on the Alerts page)
 * or failing (a red alert). Single source of truth so the two views can't drift.
 * Currently: "is there a TBSZ for the current gyűjtőév?".
 */
export interface StatusCheck {
  id: string
  ok: boolean
  label: string
  detail?: string
  to?: string
}

export function computeStatusChecks(
  summary: PortfolioSummary,
  now: Date = new Date(),
): StatusCheck[] {
  const out: StatusCheck[] = []

  // Only relevant once you actually use TBSZ.
  const usesTbsz = summary.accounts.some((a) => a.account.kind === 'tbsz')
  if (usesTbsz) {
    const year = now.getFullYear()
    const tbsz = summary.accounts.find(
      (a) => a.account.kind === 'tbsz' && a.account.tbszYear === year,
    )
    out.push({
      id: `tbsz-current:${year}`,
      ok: !!tbsz,
      label: tbsz ? `Idei (${year}) TBSZ megnyitva` : `Nincs ${year}-os TBSZ`,
      detail: tbsz
        ? tbsz.account.name
        : `Az idei befizetésekhez nyiss egy ${year}-ös gyűjtőévűt.`,
      to: tbsz ? `/accounts/${tbsz.account.id}` : undefined,
    })
  }

  return out
}

/** Currently-active alerts, derived from the live portfolio summary. */
export function computeAlerts(
  summary: PortfolioSummary,
  config: AlertConfig = DEFAULT_ALERT_CONFIG,
  now: Date = new Date(),
): Alert[] {
  const out: Alert[] = []

  // 1) Idle cash above the threshold, per account.
  for (const acc of summary.accounts) {
    if (acc.cashValueHuf > config.idleCashHuf) {
      out.push({
        id: `idle-cash:${acc.account.id}`,
        severity: 'medium',
        title: `Parlagon álló készpénz – ${acc.account.name}`,
        detail: `${formatMoney(acc.cashValueHuf)} fekszik a számlán. Érdemes lehet befektetni.`,
        to: `/accounts/${acc.account.id}`,
        actionLabel: 'Számla megnyitása',
      })
    }
  }

  // 2) Failing status checks (e.g. missing current-year TBSZ) → alerts.
  for (const c of computeStatusChecks(summary, now)) {
    if (!c.ok) {
      out.push({
        id: c.id,
        severity: 'info',
        title: c.label,
        detail: c.detail,
        to: c.to,
      })
    }
  }

  // 3) Upcoming events (coupon / maturity / TBSZ milestone) within the horizon.
  for (const e of upcomingEvents(summary, now)) {
    if (e.daysUntil > config.eventHorizonDays) continue
    const when =
      e.daysUntil <= 0
        ? 'ma'
        : e.daysUntil === 1
          ? 'holnap'
          : `${e.daysUntil} nap múlva`
    out.push({
      id: `event:${e.date}:${e.kind}:${e.accountId ?? ''}`,
      severity: e.daysUntil <= 3 ? 'high' : 'medium',
      title: e.title,
      detail: e.detail ? `${when} · ${e.detail}` : when,
      to: '/calendar',
    })
  }

  return out
}

// ---- Synced history (seen / dismissed) ------------------------------------

export interface AlertRecord {
  /** 'seen' = surfaced & still trackable; 'dismissed' = user hid it. */
  status: 'seen' | 'dismissed'
  firstSeenAt: string
  dismissedAt?: string
  /** Snapshot of the display fields at first sight, for the history view. */
  title: string
  detail?: string
  severity: AlertSeverity
}

export type AlertState = Record<string, AlertRecord>

export interface AlertHistoryItem extends AlertRecord {
  id: string
}

/**
 * Fold the currently-active alerts into the stored state.
 *  - New active alert → recorded as 'seen'.
 *  - A dismissed alert whose condition no longer holds → released back to
 *    'seen' (so a later re-trigger shows again, and it now counts as fulfilled).
 * Returns the next state plus whether anything actually changed (to avoid
 * needless persistence / sync churn). Existing titles are never rewritten, so a
 * volatile amount in a detail line doesn't cause a write on every refresh.
 */
export function reconcileAlertState(
  prev: AlertState,
  active: Alert[],
  now: string,
): { state: AlertState; changed: boolean } {
  const activeIds = new Set(active.map((a) => a.id))
  const next: AlertState = { ...prev }
  let changed = false

  for (const a of active) {
    if (!next[a.id]) {
      next[a.id] = {
        status: 'seen',
        firstSeenAt: now,
        title: a.title,
        detail: a.detail,
        severity: a.severity,
      }
      changed = true
    }
  }

  for (const [id, rec] of Object.entries(next)) {
    if (rec.status === 'dismissed' && !activeIds.has(id)) {
      next[id] = { ...rec, status: 'seen', dismissedAt: undefined }
      changed = true
    }
  }

  return { state: next, changed }
}

/** Split active alerts + stored state into the three display buckets. */
export function categorizeAlerts(
  active: Alert[],
  state: AlertState,
): { active: Alert[]; fulfilled: AlertHistoryItem[]; dismissed: AlertHistoryItem[] } {
  const activeIds = new Set(active.map((a) => a.id))
  const dismissedIds = new Set(
    Object.entries(state)
      .filter(([, r]) => r.status === 'dismissed')
      .map(([id]) => id),
  )
  const visibleActive = active.filter((a) => !dismissedIds.has(a.id))
  const fulfilled: AlertHistoryItem[] = []
  const dismissed: AlertHistoryItem[] = []
  for (const [id, rec] of Object.entries(state)) {
    if (rec.status === 'dismissed') dismissed.push({ id, ...rec })
    else if (!activeIds.has(id)) fulfilled.push({ id, ...rec })
  }
  const byRecent = (a: AlertHistoryItem, b: AlertHistoryItem) =>
    (b.dismissedAt ?? b.firstSeenAt).localeCompare(a.dismissedAt ?? a.firstSeenAt)
  fulfilled.sort(byRecent)
  dismissed.sort(byRecent)
  return { active: visibleActive, fulfilled, dismissed }
}
