import {
  LayoutDashboard,
  Wallet,
  Upload,
  Settings as SettingsIcon,
  Receipt,
  CalendarDays,
  LineChart,
  Target,
  Bell,
  Sparkles,
  Newspaper,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  to: string;
  label: string;
  short: string;
  icon: LucideIcon;
  end: boolean;
};

export const NAV = {
  home: { to: "/", label: "Áttekintés", short: "Kezdő", icon: LayoutDashboard, end: true },
  accounts: { to: "/accounts", label: "Számlák", short: "Számlák", icon: Wallet, end: false },
  income: { to: "/income", label: "Hozam", short: "Hozam", icon: Receipt, end: false },
  calendar: { to: "/calendar", label: "Naptár", short: "Naptár", icon: CalendarDays, end: false },
  forecast: { to: "/forecast", label: "Előrejelzés", short: "Előrejelzés", icon: LineChart, end: false },
  goals: { to: "/goals", label: "Célok", short: "Célok", icon: Target, end: false },
  alerts: { to: "/alerts", label: "Figyelmeztetések", short: "Teendők", icon: Bell, end: false },
  news: { to: "/hirek", label: "Hírek", short: "Hírek", icon: Newspaper, end: false },
  ai: { to: "/ai", label: "AI elemzés", short: "AI elemzés", icon: Sparkles, end: false },
  import: { to: "/import", label: "Importálás", short: "Importálás", icon: Upload, end: false },
  settings: { to: "/settings", label: "Beállítások", short: "Beállítások", icon: SettingsIcon, end: false },
} satisfies Record<string, NavItem>;

export const SIDEBAR_GROUPS: NavItem[][] = [
  [NAV.home],
  [NAV.accounts, NAV.income, NAV.calendar],
  [NAV.forecast, NAV.goals],
  [NAV.alerts, NAV.news, NAV.ai],
  [NAV.import, NAV.settings],
];

export const MOBILE_TABS: NavItem[] = [NAV.home, NAV.accounts, NAV.calendar, NAV.alerts];

export const MOBILE_MORE: NavItem[] = [
  NAV.income,
  NAV.forecast,
  NAV.goals,
  NAV.news,
  NAV.ai,
  NAV.import,
  NAV.settings,
];

const ALL: NavItem[] = SIDEBAR_GROUPS.flat();

export function isUnder(pathname: string, item: NavItem): boolean {
  return item.end
    ? pathname === item.to
    : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function pageTitle(pathname: string): string {
  return ALL.find((n) => isUnder(pathname, n))?.label ?? "Portfólió";
}
