import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CalendarClock, ExternalLink, RefreshCw } from "lucide-react";
import { toLocalDay } from "../lib/day";
import { PageHeader, Card, EmptyState, Badge } from "../components/ui";
import { ImpactIcon } from "../components/NewsCard";
import {
  markNewsSeen,
  newsDayLabel,
  refreshNews,
  useEventsFile,
  useNewsDigest,
  useNewsIndex,
  useTodayUnread,
} from "../lib/news";
import {
  EVENT_PHASE_LABEL,
  NEWS_CATEGORY_LABEL,
  NEWS_EDITION_LABEL,
  NEWS_REGION_LABEL,
  SUBSCRIPTION_STATUS_LABEL,
  SURPRISE_LABEL,
  digestKey,
  rankedItems,
  seenKey,
  type EventResult,
  type EventSubscription,
  type EventsFile,
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
      <FollowUps />
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
                  <div className="flex items-center gap-1.5 font-medium">
                    <span>
                      {newsDayLabel(u.date)}
                      {u.time ? ` ${u.time}` : ""}: {u.event}
                    </span>
                    {u.followUp && u.time && (
                      <span title="Az eredményét a bejelentés után automatikusan megkeresi">
                        <Bell size={13} className="text-[var(--color-brand)]" aria-label="Utókövetés" />
                      </span>
                    )}
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

const STATUS_TONE: Record<EventSubscription["status"], "neutral" | "brand" | "positive" | "warning"> = {
  waiting: "neutral",
  watching: "brand",
  searching: "brand",
  done: "positive",
  expired: "warning",
};

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The announcements the notifier follows and what it found (news/events.json). */
function FollowUps() {
  const file = useEventsFile();
  if (file.status !== "ready" || !file.data) return null;
  return <FollowUpCards file={file.data} today={toLocalDay()} />;
}

export function FollowUpCards({ file, today }: { file: EventsFile; today: string }) {
  const subs = file.subscriptions.filter((s) => s.date >= today);
  const results = file.results.slice(0, 8);
  const latency = Object.entries(file.latency);
  if (!subs.length && !results.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-4" data-testid="follow-ups">
      {subs.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <Bell size={18} className="text-[var(--color-brand)]" />
            Figyelt bejelentések
          </h2>
          <ul className="flex flex-col gap-3">
            {subs.map((s) => (
              <li key={s.key} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {newsDayLabel(s.date)} {s.time}: {s.events.map((e) => e.event).join(", ")}
                    {s.phase === "press" ? ` (${EVENT_PHASE_LABEL.press.toLowerCase()})` : ""}
                  </span>
                  <Badge tone={STATUS_TONE[s.status]}>{SUBSCRIPTION_STATUS_LABEL[s.status]}</Badge>
                </div>
                <div className="text-[var(--color-muted)]">
                  {s.events.some((e) => e.expected) &&
                    `Várakozás: ${s.events.map((e) => e.expected).filter(Boolean).join(", ")}. `}
                  {s.expectedRunAt && (s.status === "waiting" || s.status === "watching")
                    ? `A híreket figyeli, a keresés legkésőbb ${hhmm(s.expectedRunAt)}-kor indul.`
                    : s.firstSeenAt
                      ? `Az első hír ${hhmm(s.firstSeenAt)}-kor jelent meg.`
                      : ""}
                </div>
              </li>
            ))}
          </ul>
          {latency.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-[var(--color-muted)]">Tanult késések</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {latency.map(([kind, l]) => (
                  <li key={kind}>
                    {kind}: {l.delayMin != null ? `~${l.delayMin} perc` : "még nincs elég mérés"} ({l.samples} mérés)
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}
      {results.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <CalendarClock size={18} className="text-[var(--color-brand)]" />
            Bejelentések eredménye
          </h2>
          <ul className="flex flex-col gap-4">
            {results.map((r) => (
              <ResultRow key={r.key} r={r} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ResultRow({ r }: { r: EventResult }) {
  return (
    <li className="text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <ImpactIcon impact={r.impact} size={16} />
        <span className="font-medium">
          {newsDayLabel(r.date)} {r.time}: {r.event}
        </span>
        {r.phase === "press" && <Badge>{EVENT_PHASE_LABEL.press}</Badge>}
        {r.phase === "release" && r.surprise !== "unknown" && (
          <Badge tone={r.surprise === "inline" ? "neutral" : "warning"}>{SURPRISE_LABEL[r.surprise]}</Badge>
        )}
      </div>
      <div>
        {r.phase === "release" ? "Tény: " : ""}
        <strong>{r.actual}</strong>
        {r.expected && r.phase === "release" ? ` · Várakozás: ${r.expected}` : ""}
      </div>
      {r.reaction && <div className="text-[var(--color-muted)]">Reakció: {r.reaction}</div>}
      {r.outlook && (
        <div>
          <span className="font-medium">Mi várható:</span> {r.outlook}
        </div>
      )}
      {r.sources.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-3">
          {r.sources.map((s, i) => (
            <li key={i}>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[var(--color-brand)] hover:underline"
              >
                <ExternalLink size={12} />
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
