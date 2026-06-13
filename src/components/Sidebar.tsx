import { NavLink } from 'react-router-dom'
import { motion } from 'motion/react'
import {
  LayoutDashboard,
  Wallet,
  Upload,
  Settings as SettingsIcon,
  TrendingUp,
  Receipt,
} from 'lucide-react'

const links = [
  { to: '/', label: 'Áttekintés', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Számlák', icon: Wallet, end: false },
  { to: '/income', label: 'Realizált hozam', icon: Receipt, end: false },
  { to: '/import', label: 'Importálás', icon: Upload, end: false },
  { to: '/settings', label: 'Beállítások', icon: SettingsIcon, end: false },
]

export default function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 px-4 py-6 backdrop-blur-xl md:flex">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] shadow-[var(--shadow-glow)]">
          <TrendingUp className="h-5 w-5 text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">Portfólió</div>
          <div className="text-xs text-[var(--color-muted)]">
            befektetés-kezelő
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-1">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className="group relative"
          >
            {({ isActive }) => (
              <div
                className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
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
                <link.icon className="h-[18px] w-[18px]" />
                {link.label}
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto px-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
        Az adataid a böngésződben, helyben tárolódnak.
      </div>
    </aside>
  )
}
