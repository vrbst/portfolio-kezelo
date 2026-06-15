import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { motion } from 'motion/react'
import { usePortfolio, useActiveAlerts } from '../lib/store'
import { categorizeAlerts } from '../lib/alerts'
import {
  LayoutDashboard,
  Wallet,
  Upload,
  Settings as SettingsIcon,
  TrendingUp,
  Receipt,
  CalendarDays,
  Bell,
  Sparkles,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'

const links = [
  { to: '/', label: 'Áttekintés', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Számlák', icon: Wallet, end: false },
  { to: '/income', label: 'Hozam', icon: Receipt, end: false },
  { to: '/calendar', label: 'Naptár', icon: CalendarDays, end: false },
  { to: '/alerts', label: 'Figyelmeztetések', icon: Bell, end: false },
  { to: '/ai', label: 'AI elemzés', icon: Sparkles, end: false },
  { to: '/import', label: 'Importálás', icon: Upload, end: false },
  { to: '/settings', label: 'Beállítások', icon: SettingsIcon, end: false },
]

const KEY = 'pf-sidebar-collapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const active = useActiveAlerts()
  const alertState = usePortfolio((s) => s.alertState)
  const alertCount = categorizeAlerts(active, alertState).active.length

  function toggle() {
    setCollapsed((c) => {
      const v = !c
      try {
        localStorage.setItem(KEY, v ? '1' : '0')
      } catch {
        /* ignore */
      }
      return v
    })
  }

  return (
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 py-6 backdrop-blur-xl transition-[width] duration-200 md:flex ${
        collapsed ? 'w-[4.5rem] px-2' : 'w-64 px-4'
      }`}
    >
      <div
        className={`mb-8 flex items-center gap-3 ${
          collapsed ? 'justify-center' : 'px-2'
        }`}
      >
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] shadow-[var(--shadow-glow)]">
          <TrendingUp className="h-5 w-5 text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight">Portfólió</div>
            <div className="text-xs text-[var(--color-muted)]">
              befektetés-kezelő
            </div>
          </div>
        )}
      </div>

      <nav className="flex flex-col gap-1">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            title={collapsed ? link.label : undefined}
            className="group relative"
          >
            {({ isActive }) => (
              <div
                className={`relative flex items-center gap-3 rounded-xl py-2.5 text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center px-0' : 'px-3'
                } ${
                  isActive
                    ? 'text-white'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 -z-10 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/15"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <link.icon className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && <span className="flex-1">{link.label}</span>}
                {link.to === '/alerts' &&
                  alertCount > 0 &&
                  (collapsed ? (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--color-negative)]" />
                  ) : (
                    <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-negative)] px-1.5 text-[10px] font-semibold text-white">
                      {alertCount}
                    </span>
                  ))}
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <button
          onClick={toggle}
          title={collapsed ? 'Menü kibontása' : 'Menü összecsukása'}
          className={`flex items-center gap-2 rounded-xl border border-[var(--color-border)] py-2 text-sm text-[var(--color-muted)] transition hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] ${
            collapsed ? 'justify-center px-0' : 'px-3'
          }`}
        >
          {collapsed ? (
            <ChevronsRight className="h-[18px] w-[18px]" />
          ) : (
            <>
              <ChevronsLeft className="h-[18px] w-[18px]" />
              Összecsuk
            </>
          )}
        </button>
        {!collapsed && (
          <div className="px-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            Az adataid a böngésződben, helyben tárolódnak.
          </div>
        )}
      </div>
    </aside>
  )
}
