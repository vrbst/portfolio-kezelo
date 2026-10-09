import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { TrendingUp } from "lucide-react";
import PrivacyToggle from "./PrivacyToggle";
import { pageTitle } from "./navLinks";

export default function MobileTopBar() {
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);

  return (
    <header
      className={`mobile-topbar sticky top-0 z-30 -mx-4 mb-2 flex items-center gap-3 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] backdrop-blur-xl transition-colors md:hidden ${
        scrolled
          ? "border-b border-[var(--color-border)] bg-[var(--color-bg-soft)]/80"
          : "border-b border-transparent"
      }`}
    >
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] shadow-[var(--shadow-glow)]">
        <TrendingUp className="h-4 w-4 text-white" />
      </div>
      <div
        className={`min-w-0 flex-1 truncate text-sm font-semibold transition-all duration-200 ${
          scrolled ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
        }`}
        aria-hidden={!scrolled}
      >
        {pageTitle(pathname)}
      </div>
      <PrivacyToggle className="btn-ghost !px-2.5" showLabel={false} />
    </header>
  );
}
