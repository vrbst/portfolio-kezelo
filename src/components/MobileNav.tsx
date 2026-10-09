import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { LayoutGrid } from "lucide-react";
import { usePortfolio, useActiveAlerts } from "../lib/store";
import { categorizeAlerts } from "../lib/alerts";
import { useTodayUnread } from "../lib/news";
import { BottomSheet } from "./ui";
import { MOBILE_MORE, MOBILE_TABS, NAV, isUnder, type NavItem } from "./navLinks";

function TabBody({
  item,
  active,
  badge,
  dot,
}: {
  item: { short: string; icon: NavItem["icon"] };
  active: boolean;
  badge?: number;
  dot?: boolean;
}) {
  return (
    <>
      {active && (
        <motion.span
          layoutId="mobile-tab-pill"
          className="mobile-tab-pill absolute inset-x-1 inset-y-1 rounded-xl"
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        />
      )}
      <span className="relative">
        <item.icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.25 : 1.75} />
        {badge != null && badge > 0 && (
          <span className="absolute -right-2 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--color-negative)] px-1 text-[9px] font-semibold text-white">
            {badge}
          </span>
        )}
        {dot && (
          <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-[var(--color-brand)] ring-2 ring-[var(--color-bg-soft)]" />
        )}
      </span>
      <span className="relative">{item.short}</span>
    </>
  );
}

const tabCls = (active: boolean) =>
  `mobile-tab relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
    active ? "text-[var(--color-text)]" : "text-[var(--color-muted)]"
  }`;

export default function MobileNav() {
  const active = useActiveAlerts();
  const alertState = usePortfolio((s) => s.alertState);
  const alertCount = categorizeAlerts(active, alertState).active.length;
  const newsCount = useTodayUnread().reduce((n, e) => n + e.count, 0);
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MOBILE_MORE.some((l) => isUnder(pathname, l));

  return (
    <>
      <nav
        aria-label="Fő navigáció"
        className="mobile-nav fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 flex rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-soft)]/85 px-1 shadow-2xl backdrop-blur-xl md:hidden"
      >
        {MOBILE_TABS.map((link) => {
          const on = isUnder(pathname, link);
          return (
            <NavLink key={link.to} to={link.to} end={link.end} className={tabCls(on)}>
              <TabBody
                item={link}
                active={on}
                badge={link.to === NAV.alerts.to ? alertCount : undefined}
              />
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={tabCls(moreActive)}
        >
          <TabBody
            item={{ short: "Több", icon: LayoutGrid }}
            active={moreActive}
            dot={newsCount > 0}
          />
        </button>
      </nav>
      {moreOpen && (
        <BottomSheet label="További oldalak" onClose={() => setMoreOpen(false)}>
          <div className="mb-4 text-sm font-semibold">További oldalak</div>
          <div className="grid grid-cols-3 gap-2">
            {MOBILE_MORE.map((link) => {
              const on = isUnder(pathname, link);
              return (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  onClick={() => setMoreOpen(false)}
                  className={`mobile-tile relative flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 text-center text-xs font-medium ${
                    on
                      ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/15 text-[var(--color-text)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)]/40 text-[var(--color-muted)]"
                  }`}
                >
                  <span className="relative grid h-10 w-10 place-items-center rounded-xl bg-[var(--color-brand)]/15 text-[var(--color-brand)]">
                    <link.icon className="h-5 w-5" />
                    {link.to === NAV.news.to && newsCount > 0 && (
                      <span
                        title="Mai olvasatlan hírek"
                        className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--color-brand)] px-1 text-[9px] font-semibold text-white"
                      >
                        {newsCount}
                      </span>
                    )}
                  </span>
                  {link.label}
                </NavLink>
              );
            })}
          </div>
        </BottomSheet>
      )}
    </>
  );
}
