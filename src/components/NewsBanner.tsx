import { Link } from "react-router-dom";
import { ArrowRight, Newspaper, X } from "lucide-react";
import { markNewsSeen, useTodayUnread } from "../lib/news";
import { NEWS_EDITION_LABEL } from "../lib/newsSchema";

/**
 * Slim dashboard banner for today's unread market news (like the alerts
 * banner on the other pages). Older unread digests never show here. Opening
 * the Hírek page or the ✕ marks them read on this device.
 */
export default function NewsBanner() {
  const unread = useTodayUnread();
  if (!unread.length) return null;
  const newest = unread[0];
  const items = unread.reduce((n, e) => n + e.count, 0);
  const editions = unread.map((e) => NEWS_EDITION_LABEL[e.edition].toLowerCase()).join(" és ");
  return (
    <div
      data-privacy="public"
      className="mb-4 flex items-center gap-3 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-4 py-2.5"
    >
      <Newspaper className="h-4 w-4 shrink-0 text-[var(--color-brand)]" />
      <Link to="/hirek" className="min-w-0 flex-1 text-sm hover:underline">
        <span className="font-medium">
          {items} új hír ma ({editions})
        </span>{" "}
        <span className="text-[var(--color-muted)]">— {newest.headline}</span>
      </Link>
      <Link
        to="/hirek"
        className="hidden shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline sm:inline-flex"
      >
        Elolvasom <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      <button
        onClick={() => markNewsSeen(unread)}
        title="Olvasottnak jelölöm"
        className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
