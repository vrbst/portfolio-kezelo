import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, ExternalLink, RefreshCw } from "lucide-react";
import { PageHeader, Card, EmptyState, Badge } from "../components/ui";
import { ImpactIcon } from "../components/NewsCard";
import {
  markNewsSeen,
  newsDayLabel,
  refreshNews,
  useNewsDigest,
  useNewsIndex,
  useTodayUnread,
} from "../lib/news";
import {
  NEWS_CATEGORY_LABEL,
  NEWS_EDITION_LABEL,
  NEWS_REGION_LABEL,
  digestKey,
  rankedItems,
  seenKey,
  type NewsDigest,
} from "../lib/newsSchema";

const IMPORTANCE_LABEL = { 3: "Fontos", 2: "Érdemes tudni", 1: "Háttér" } as const;

export default function News() {
  const index = useNewsIndex();
  const entries = index.status === "ready" ? (index.data?.entries ?? []) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const current = entries.find((e) => digestKey(e) === picked) ?? entries[0] ?? null;
  const digest = useNewsDigest(current);
  const unread = new Set(useTodayUnread().map(seenKey));

  // The digest on screen counts as read (only today's are ever flagged).
  const shown = digest.status === "ready" && digest.data ? current : null;
  useEffect(() => {
    if (shown) markNewsSeen([shown]);
  }, [shown]);

  const header = (
    <PageHeader
      title="Hírek"
      info="AI-összefoglaló a portfóliót érintő hírekről: hétköznap reggel a Xetra nyitása előtt és este a zárása után."
      action={
        index.status !== "off" && (
          <button
            type="button"
            onClick={refreshNews}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)]"
          >
            <RefreshCw size={14} /> Frissítés
          </button>
        )
      }
    />
  );

  if (index.status === "off")
    return (
      <div>
        {header}
        <EmptyState
          title="A hírek a felhő-szinkronból jönnek"
          description="Az összefoglalókat a saját gépeden futó értesítő készíti, és a privát szinkron-repóba tölti fel. Kapcsold be a szinkront ezen az eszközön is, és itt megjelennek."
          action={
            <Link to="/settings" className="text-sm font-medium text-[var(--color-brand)] hover:underline">
              Beállítások → Szinkron
            </Link>
          }
        />
      </div>
    );

  if (index.status === "error")
    return (
      <div>
        {header}
        <EmptyState title="Nem sikerült betölteni a híreket" description={index.error} />
      </div>
    );

  if (index.status === "ready" && !entries.length)
    return (
      <div>
        {header}
        <EmptyState
          title="Még nincs hírösszefoglaló"
          description="Az első hétköznap 7:45 vagy 18:15 körül készül el (a gépen futó tg-hub indítja)."
        />
      </div>
    );

  return (
    <div data-privacy="public">
      {header}
      {entries.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label htmlFor="news-pick" className="text-sm text-[var(--color-muted)]">
            Kiadás:
          </label>
          <select
            id="news-pick"
            value={current ? digestKey(current) : ""}
            onChange={(e) => setPicked(e.target.value)}
            className="max-w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            {entries.map((e) => (
              <option key={digestKey(e)} value={digestKey(e)}>
                {unread.has(seenKey(e)) ? "● " : ""}
                {newsDayLabel(e.day)} – {NEWS_EDITION_LABEL[e.edition].toLowerCase()} ({e.count} hír)
                {unread.has(seenKey(e)) ? " – új" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {digest.status === "loading" || index.status === "loading" ? (
        <Card className="p-5 text-sm text-[var(--color-muted)]">Betöltés…</Card>
      ) : digest.status === "error" ? (
        <EmptyState title="Nem sikerült betölteni ezt az összefoglalót" description={digest.error} />
      ) : digest.status === "ready" && digest.data ? (
        <DigestView digest={digest.data} />
      ) : (
        <EmptyState title="Ez az összefoglaló hiányzik" description="Az index említi, de a fájlja nincs a repóban." />
      )}
    </div>
  );
}

function DigestView({ digest }: { digest: NewsDigest }) {
  const items = rankedItems(digest.items);
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <div className="mb-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">
          {NEWS_EDITION_LABEL[digest.edition]} · {newsDayLabel(digest.day)}
        </div>
        <p className="text-lg font-semibold">{digest.headline}</p>
      </Card>

      {items.map((it, i) => (
        <Card key={i} className="p-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <ImpactIcon impact={it.impact} size={18} />
            <Badge tone={it.importance === 3 ? "warning" : it.importance === 2 ? "brand" : "neutral"}>
              {IMPORTANCE_LABEL[it.importance]}
            </Badge>
            <Badge>{NEWS_CATEGORY_LABEL[it.category]}</Badge>
            <Badge>{NEWS_REGION_LABEL[it.region]}</Badge>
          </div>
          <h3 className="mb-1 break-words font-semibold">{it.title}</h3>
          <p className="break-words text-sm text-[var(--color-muted)]">{it.summary}</p>
          {it.affects.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-[var(--color-muted)]">Érinti:</span>
              {it.affects.map((a) => (
                <Badge key={a} tone="brand">
                  {a}
                </Badge>
              ))}
            </div>
          )}
          <ul className="mt-3 flex flex-col gap-1 text-xs">
            {it.sources.map((s) => (
              <li key={s.url} className="min-w-0">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-[var(--color-brand)] hover:underline"
                >
                  <ExternalLink size={12} className="shrink-0" />
                  <span className="truncate">{s.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {digest.upcoming.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <CalendarClock size={18} className="text-[var(--color-brand)]" />
            Következő napok
          </h2>
          <ul className="flex flex-col gap-3">
            {[...digest.upcoming]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((u, i) => (
                <li key={i} className="text-sm">
                  <div className="font-medium">
                    {newsDayLabel(u.date)}: {u.event}
                  </div>
                  <div className="text-[var(--color-muted)]">{u.why}</div>
                </li>
              ))}
          </ul>
        </Card>
      )}

      <p className="text-xs text-[var(--color-muted)]">
        Készítette: {digest.engine} ({digest.model}). Az AI tévedhet; döntés előtt nézd meg a forrást.
      </p>
    </div>
  );
}
