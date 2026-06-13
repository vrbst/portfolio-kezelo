import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Wallet,
  Receipt,
  Upload,
  Settings as SettingsIcon,
} from 'lucide-react'

const links = [
  { to: '/', label: 'Kezdő', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Számlák', icon: Wallet, end: false },
  { to: '/income', label: 'Hozam', icon: Receipt, end: false },
  { to: '/import', label: 'Import', icon: Upload, end: false },
  { to: '/settings', label: 'Beáll.', icon: SettingsIcon, end: false },
]

/** Bottom tab bar for mobile (the sidebar is desktop-only). */
export default function MobileNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-bg-soft)]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              isActive
                ? 'text-[var(--color-brand)]'
                : 'text-[var(--color-muted)]'
            }`
          }
        >
          <link.icon className="h-5 w-5" />
          {link.label}
        </NavLink>
      ))}
    </nav>
  )
}
