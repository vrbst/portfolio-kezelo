import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  usePortfolio,
  useActiveAlerts,
  usePortfolioSummary,
  useDayChange,
} from "../lib/store";
import { categorizeAlerts } from "../lib/alerts";
import { useTodayUnread } from "../lib/news";
import { formatMoney, formatPercent } from "../lib/format";
import {
  LayoutDashboard,
  Wallet,
  Upload,
  Settings as SettingsIcon,
  TrendingUp,
  Receipt,
  CalendarDays,
  LineChart,
  Target,
  Bell,
  Sparkles,
  Newspaper,
  ChevronsLeft,
  ChevronsRight,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

// Nav grouped by intent: overview | what happened/happens | planning |
// attention | maintenance. Rendered with a thin separator between groups so
// the 10 entries read as 5 small clusters instead of one long list.
const linkGroups = [
  [{ to: "/", label: "Áttekintés", icon: LayoutDashboard, end: true }],
  [
    { to: "/accounts", label: "Számlák", icon: Wallet, end: false },
    { to: "/income", label: "Hozam", icon: Receipt, end: false },
    { to: "/calendar", label: "Naptár", icon: CalendarDays, end: false },
  ],
  [
    { to: "/forecast", label: "Előrejelzés", icon: LineChart, end: false },
    { to: "/goals", label: "Célok", icon: Target, end: false },
  ],
  [
    { to: "/alerts", label: "Figyelmeztetések", icon: Bell, end: false },
    { to: "/hirek", label: "Hírek", icon: Newspaper, end: false },
    { to: "/ai", label: "AI elemzés", icon: Sparkles, end: false },
  ],
  [
    { to: "/import", label: "Importálás", icon: Upload, end: false },
    { to: "/settings", label: "Beállítások", icon: SettingsIcon, end: false },
  ],
];

const KEY = "pf-sidebar-collapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const active = useActiveAlerts();
  const alertState = usePortfolio((s) => s.alertState);
  const alertCount = categorizeAlerts(active, alertState).active.length;
  // Today's unread news items (older unread digests are never flagged).
  const newsCount = useTodayUnread().reduce((n, e) => n + e.count, 0);
  const summary = usePortfolioSummary();
  const day = useDayChange();
  const hasValue = summary.totalValueHuf > 0;
  const dayUp = (day?.abs ?? 0) >= 0;
  const navRef = useRef<HTMLElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /** Put the marker on `link` (null: hide it); `instant` skips the glide. */
  const moveMarker = useCallback((link: HTMLElement | null, instant = false) => {
    const m = markerRef.current;
    if (!m) return;
    if (!link) {
      m.style.opacity = "0";
      return;
    }
    if (instant || m.style.opacity !== "1") m.classList.add("no-glide");
    m.style.transform = `translate(${link.offsetLeft}px, ${link.offsetTop}px)`;
    m.style.width = `${link.offsetWidth}px`;
    m.style.height = `${link.offsetHeight}px`;
    m.style.opacity = "1";
    if (m.classList.contains("no-glide")) {
      void m.offsetWidth; // apply the jump before the transition comes back
      m.classList.remove("no-glide");
    }
  }, []);

  // Follow the route (back / forward, links elsewhere) and size changes
  // (collapsing the sidebar, new badges): the active link carries "active".
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = (instant: boolean) =>
      moveMarker(nav.querySelector<HTMLElement>("a.active"), instant);
    place(false);
    // Only a real size change jumps the marker: the observer also fires right
    // after observe(), which would cut a glide that has just started.
    let size = `${nav.offsetWidth}x${nav.offsetHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${nav.offsetWidth}x${nav.offsetHeight}`;
      if (now === size) return;
      size = now;
      place(true);
    });
    ro.observe(nav);
    return () => ro.disconnect();
  }, [pathname, collapsed, moveMarker]);

  /**
   * A plain click: start the glide first and change the page a frame later,
   * so the browser runs the transition before the new page's render takes
   * the main thread (a heavy page used to stall the marker for ~140 ms).
   */
  function go(e: React.MouseEvent<HTMLAnchorElement>, to: string) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    moveMarker(e.currentTarget);
    requestAnimationFrame(() => requestAnimationFrame(() => navigate(to)));
  }

  function toggle() {
    setCollapsed((c) => {
      const v = !c;
      try {
        localStorage.setItem(KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
      return v;
    });
  }

  return (
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 py-6 backdrop-blur-xl transition-[width] duration-200 md:flex ${
        collapsed ? "w-[4.5rem] px-2" : "w-64 px-4"
      }`}
    >
      <div
        className={`mb-8 flex items-center gap-3 ${
          collapsed ? "justify-center" : "px-2"
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

      {/* Always-visible portfolio value — the "balance" is one glance away on
          every page. Collapsed: just a pulsing dot coloured by today's move. */}
      {hasValue &&
        (collapsed ? (
          <div className="mb-4 flex justify-center" title="Teljes érték">
            <span
              className="live-dot relative h-2 w-2 rounded-full"
              style={{
                background: dayUp
                  ? "var(--color-positive)"
                  : "var(--color-negative)",
              }}
            />
          </div>
        ) : (
          <div className="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
              <span className="live-dot relative h-1.5 w-1.5 rounded-full bg-[var(--color-positive)]" />
              Teljes érték
            </div>
            <div className="amt font-display mt-0.5 text-lg font-semibold tabular-nums">
              {formatMoney(summary.totalValueHuf)}
            </div>
            {day && (
              <div
                className={`mt-0.5 flex items-center gap-1 text-xs ${
                  dayUp
                    ? "text-[var(--color-positive)]"
                    : "text-[var(--color-negative)]"
                }`}
              >
                {dayUp ? (
                  <ArrowUpRight className="h-3.5 w-3.5" />
                ) : (
                  <ArrowDownRight className="h-3.5 w-3.5" />
                )}
                <span className="amt">
                  {formatMoney(day.abs, "HUF", { sign: true })}
                </span>
                {day.pct != null && (
                  <span className="opacity-80">{formatPercent(day.pct)}</span>
                )}
                <span className="text-[var(--color-muted)]">{day.note}</span>
              </div>
            )}
          </div>
        ))}

      <nav ref={navRef} className="relative flex flex-col gap-1">
        {/* The active-page marker: one element moved with a CSS transform
            transition, which the browser runs off the main thread — so it
            glides on even while a heavy page (charts, projections) renders. */}
        <div
          ref={markerRef}
          aria-hidden
          className="nav-marker pointer-events-none absolute left-0 top-0 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/15 opacity-0"
        />
        {linkGroups.map((group, gi) => (
          <div key={gi} className="flex flex-col gap-1">
            {gi > 0 && (
              <div
                className={`my-1.5 border-t border-[var(--color-border)]/60 ${
                  collapsed ? "mx-2" : "mx-3"
                }`}
              />
            )}
            {group.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                title={collapsed ? link.label : undefined}
                className="group relative"
                onClick={(e) => go(e, link.to)}
              >
                {({ isActive }) => (
                  <div
                    className={`relative flex items-center gap-3 rounded-xl py-2.5 text-sm font-medium transition-colors ${
                      collapsed ? "justify-center px-0" : "px-3"
                    } ${
                      isActive
                        ? "text-white"
                        : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    <link.icon className="h-[18px] w-[18px] shrink-0" />
                    {!collapsed && <span className="flex-1">{link.label}</span>}
                    {link.to === "/alerts" &&
                      alertCount > 0 &&
                      (collapsed ? (
                        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--color-negative)]" />
                      ) : (
                        <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-negative)] px-1.5 text-[10px] font-semibold text-white">
                          {alertCount}
                        </span>
                      ))}
                    {link.to === "/hirek" &&
                      newsCount > 0 &&
                      (collapsed ? (
                        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--color-brand)]" />
                      ) : (
                        <span
                          title="Mai olvasatlan hírek"
                          className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-brand)] px-1.5 text-[10px] font-semibold text-white"
                        >
                          {newsCount}
                        </span>
                      ))}
                  </div>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <button
          onClick={toggle}
          title={collapsed ? "Menü kibontása" : "Menü összecsukása"}
          className={`flex items-center gap-2 rounded-xl border border-[var(--color-border)] py-2 text-sm text-[var(--color-muted)] transition hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] ${
            collapsed ? "justify-center px-0" : "px-3"
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
  );
}
