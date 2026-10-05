import { Link } from "react-router-dom";
import { ArrowRight, Minus, MoveVertical, Newspaper, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "./ui";
import { newsDayLabel, useNewsDigest, useNewsIndex } from "../lib/news";
import {
  NEWS_EDITION_LABEL,
  rankedItems,
  type NewsImpact,
} from "../lib/newsSchema";

const IMPACT: Record<NewsImpact, { icon: typeof TrendingUp; label: string; cls: string }> = {
  up: { icon: TrendingUp, label: "Értéknövelő", cls: "text-[var(--color-positive)]" },
  down: { icon: TrendingDown, label: "Értékcsökkentő", cls: "text-[var(--color-negative)]" },
  mixed: { icon: MoveVertical, label: "Vegyes hatás", cls: "text-[var(--color-warning)]" },
  neutral: { icon: Minus, label: "Semleges", cls: "text-[var(--color-muted)]" },
};

export function ImpactIcon({ impact, size = 16 }: { impact: NewsImpact; size?: number }) {
  const { icon: Icon, label, cls } = IMPACT[impact];
  return (
    <span title={label} aria-label={label} className={`inline-flex shrink-0 ${cls}`}>
      <Icon size={size} />
    </span>
  );
}

/**
 * Dashboard card: the newest market-news digest in brief. Shows nothing
 * without cloud sync or before the first digest — the Hírek page explains.
 */
export default function NewsCard() {
  const index = useNewsIndex();
  const last = index.status === "ready" ? (index.data?.entries[0] ?? null) : null;
  const digest = useNewsDigest(last);
  if (digest.status !== "ready" || !digest.data) return null;
  const d = digest.data;
  const top = rankedItems(d.items).slice(0, 3);
  return (
    <Card className="p-5">
      {/* Public market news: nothing personal to hide in privacy mode. */}
      <div data-privacy="public">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Newspaper size={18} className="text-[var(--color-brand)]" />
            Piaci hírek
          </h2>
          <span className="text-xs text-[var(--color-muted)]">
            {NEWS_EDITION_LABEL[d.edition]} · {newsDayLabel(d.day, false)}
          </span>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">{d.headline}</p>
        <ul className="flex flex-col gap-2">
          {top.map((it, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5">
                <ImpactIcon impact={it.impact} />
              </span>
              <span className="min-w-0 break-words">{it.title}</span>
            </li>
          ))}
        </ul>
        <Link
          to="/hirek"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand)] hover:underline"
        >
          Összes hír ({d.items.length}) <ArrowRight size={14} />
        </Link>
      </div>
    </Card>
  );
}
