// AI-free check whether the news already cover an announcement: a Google News
// RSS search for it, counting the articles published since it was due. The
// follow-up search starts as soon as there are some (events.ts), and the gap
// between the announcement and the first article is what it learns its timing
// from. Unofficial endpoint: any failure is just "don't know" (null).

import type { EventKind } from "../../../src/lib/newsSchema";

export interface Coverage {
  /** Articles published since the announcement. */
  count: number;
  /** ISO: the earliest of them. */
  earliest: string;
}

export interface RssItem {
  title: string;
  /** ms since epoch */
  published: number;
}

// &amp; last: "&amp;lt;" is the text "&lt;", not "<".
const unwrap = (s: string) =>
  s
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/**
 * Articles that come before a release (previews, "what to expect") say
 * nothing about it being out: they don't count as coverage.
 */
const PREVIEW =
  /\b(preview|what to expect|what to watch|ahead of|week ahead|day ahead|how to (trade|watch))\b|előzetes|mire számít|mit várnak/i;
export const isPreview = (title: string) => PREVIEW.test(title);

/** The items of an RSS feed that have a title and a valid pubDate. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const date = m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const published = date ? Date.parse(unwrap(date)) : NaN;
    if (title && !Number.isNaN(published)) items.push({ title: unwrap(title), published });
  }
  return items;
}

/** What to search for per kind; null = the event's own name (Hungarian text). */
const EVENT_QUERY: Record<EventKind, string | null> = {
  US_CPI: "US CPI inflation",
  US_JOBS: "US jobs report nonfarm payrolls",
  US_GDP: "US GDP growth",
  FED_RATE: "Fed interest rate decision",
  ECB_RATE: "ECB interest rate decision",
  MNB_RATE: "MNB kamatdöntés",
  HU_CPI: "KSH infláció",
  HU_GDP: "KSH GDP növekedés",
  EZ_CPI: "eurozone inflation Eurostat",
  PMI: null,
  AKK_AUCTION: null,
  EARNINGS: null,
  OTHER: null,
};

const HUNGARIAN: ReadonlySet<EventKind> = new Set(["MNB_RATE", "HU_CPI", "HU_GDP", "PMI", "AKK_AUCTION", "OTHER"]);

/** "Tesla gyorsjelentés (Q3)" → "Tesla earnings": the company, searched in English. */
export function earningsQuery(event: string): string {
  if (/\bearnings\b/i.test(event)) return event.trim();
  const name = event
    .replace(/\([^)]*\)/g, " ")
    .replace(/(^|\s)Q[1-4]\S*/gi, " ")
    .replace(/\S*(gyorsjelentés|jelentés|negyedév|eredmény|beszámoló|első|második|harmadik|negyedik)\S*/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${name || event} earnings`;
}

export function coverageUrl(kind: EventKind, event: string): string {
  const q = `${kind === "EARNINGS" ? earningsQuery(event) : (EVENT_QUERY[kind] ?? event)} when:1d`;
  const params = HUNGARIAN.has(kind) ? "hl=hu&gl=HU&ceid=HU:hu" : "hl=en-US&gl=US&ceid=US:en";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${params}`;
}

/**
 * How many articles about the event were published since `since`, and when the
 * first appeared; null if the feed can't be read (the caller falls back to the
 * learned or the default delay).
 */
export async function probeCoverage(
  kind: EventKind,
  event: string,
  since: Date,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<Coverage | null> {
  try {
    const res = await fetchFn(coverageUrl(kind, event), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const hits = parseRss(await res.text()).filter((i) => i.published >= since.getTime() && !isPreview(i.title));
    if (!hits.length) return { count: 0, earliest: "" };
    return {
      count: hits.length,
      earliest: new Date(Math.min(...hits.map((i) => i.published))).toISOString(),
    };
  } catch (e) {
    console.error("news-event: rss probe failed:", (e as Error).message);
    return null;
  }
}
