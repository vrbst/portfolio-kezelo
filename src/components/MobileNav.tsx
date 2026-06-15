import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Wallet,
  Receipt,
  Settings as SettingsIcon,
  CalendarDays,
  Bell,
} from 'lucide-react'
import { usePortfolio, useActiveAlerts } from '../lib/store'
import { categorizeAlerts } from '../lib/alerts'

const links = [
  { to: '/', label: 'Kezdő', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Számlák', icon: Wallet, end: false },
  { to: '/income', label: 'Hozam', icon: Receipt, end: false },
  { to: '/calendar', label: 'Naptár', icon: CalendarDays, end: false },
  { to: '/alerts', label: 'Teendők', icon: Bell, end: false },
  { to: '/settings', label: 'Beáll.', icon: SettingsIcon, end: false },
]

/** Bottom tab bar for mobile (the sidebar is desktop-only). */
export default function MobileNav() {
  const active = useActiveAlerts()
  const alertState = usePortfolio((s) => s.alertState)
  const alertCount = categorizeAlerts(active, alertState).active.length
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-bg-soft)]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) =>
            `relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              isActive
                ? 'text-[var(--color-brand)]'
                : 'text-[var(--color-muted)]'
            }`
          }
        >
          <span className="relative">
            <link.icon className="h-5 w-5" />
            {link.to === '/alerts' && alertCount > 0 && (
              <span className="absolute -right-1.5 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--color-negative)] px-1 text-[9px] font-semibold text-white">
                {alertCount}
              </span>
            )}
          </span>
          {link.label}
        </NavLink>
      ))}
    </nav>
  )
}
