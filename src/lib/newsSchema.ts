// Daily market-news digest: what the local notifier's AI run (scripts/notify/
// news/) writes to the private sync repo (news/<day>.json + news/index.json)
// and what the app's Hírek page reads back. Shared so both sides validate the
// same shape. The content is public market news — no personal amounts: the
// model only ever sees the portfolio's weights in percent.

export const NEWS_CATEGORIES = [
  "fx",
  "rates",
  "hu_bonds",
  "equities",
  "crypto",
  "geopolitics",
  "macro",
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const NEWS_CATEGORY_LABEL: Record<NewsCategory, string> = {
  fx: "Forint, devizák",
  rates: "Kamatok, jegybankok",
  hu_bonds: "Magyar állampapírok",
  equities: "Részvénypiac",
  crypto: "Kripto",
  geopolitics: "Geopolitika",
  macro: "Makrogazdaság",
};

export const NEWS_REGIONS = ["hu", "eu", "us", "global"] as const;
export type NewsRegion = (typeof NEWS_REGIONS)[number];

export const NEWS_REGION_LABEL: Record<NewsRegion, string> = {
  hu: "Magyarország",
  eu: "Európa",
  us: "USA",
  global: "Világ",
};

/** Expected effect on the portfolio's value (the holdings it names). */
export const NEWS_IMPACTS = ["up", "down", "mixed", "neutral"] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

export interface NewsSource {
  title: string;
  url: string;
}

export interface NewsItem {
  category: NewsCategory;
  region: NewsRegion;
  /** 3 = moves the portfolio / must know, 2 = worth knowing, 1 = background. */
  importance: 1 | 2 | 3;
  title: string;
  summary: string;
  impact: NewsImpact;
  /** Holdings / factors it touches, e.g. "VWCE", "EUR/HUF", "DKJ". */
  affects: string[];
  sources: NewsSource[];
}

export interface NewsUpcoming {
  /** YYYY-MM-DD */
  date: string;
  event: string;
  why: string;
}

/** What the model returns (NEWS_JSON_SCHEMA). */
export interface NewsDigestBody {
  /** One sentence: the day in a nutshell. */
  headline: string;
  items: NewsItem[];
  upcoming: NewsUpcoming[];
}

/**
 * Two digests a weekday: the morning one before the Xetra opens (the night's
 * news, what today may bring) and the evening one after it closes.
 */
export const NEWS_EDITIONS = ["morning", "evening"] as const;
export type NewsEdition = (typeof NEWS_EDITIONS)[number];

export const NEWS_EDITION_LABEL: Record<NewsEdition, string> = {
  morning: "Reggeli előzetes",
  evening: "Napzárta",
};

/** The stored file: the model's body plus our own metadata. */
export interface NewsDigest extends NewsDigestBody {
  version: 1;
  /** Local day (YYYY-MM-DD) the digest is for. */
  day: string;
  edition: NewsEdition;
  generatedAt: string;
  engine: string;
  model: string;
  /** What the run would cost at API list prices (informative). */
  costUsd?: number;
}

export interface NewsIndexEntry {
  day: string;
  edition: NewsEdition;
  headline: string;
  count: number;
  /** Item titles, so the next run can skip what was already reported. */
  titles: string[];
}

export interface NewsIndex {
  version: 1;
  /** Newest first. */
  entries: NewsIndexEntry[];
}

export const NEWS_DIR = "news";
export const NEWS_INDEX_PATH = `${NEWS_DIR}/index.json`;
export const newsDigestPath = (day: string, edition: NewsEdition) =>
  `${NEWS_DIR}/${day}-${edition}.json`;
/** How many digests the index lists (the files stay in the repo). */
export const NEWS_INDEX_SIZE = 120;

/** Order of digests in time: by day, the morning one before the evening one. */
export const digestKey = (d: { day: string; edition: NewsEdition }) =>
  `${d.day}-${NEWS_EDITIONS.indexOf(d.edition)}`;

/** JSON Schema of NewsDigestBody, for the model's structured output. */
export const NEWS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "items", "upcoming"],
  properties: {
    headline: { type: "string" },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "region", "importance", "title", "summary", "impact", "affects", "sources"],
        properties: {
          category: { type: "string", enum: [...NEWS_CATEGORIES] },
          region: { type: "string", enum: [...NEWS_REGIONS] },
          importance: { type: "integer", enum: [1, 2, 3] },
          title: { type: "string" },
          summary: { type: "string" },
          impact: { type: "string", enum: [...NEWS_IMPACTS] },
          affects: { type: "array", items: { type: "string" } },
          sources: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "url"],
              properties: { title: { type: "string" }, url: { type: "string" } },
            },
          },
        },
      },
    },
    upcoming: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "event", "why"],
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          event: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
} as const;

// ---- validation -------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T =>
  typeof x === "string" && (list as readonly string[]).includes(x);

function checkItem(x: unknown, i: number): NewsItem {
  const at = `items[${i}]`;
  if (!isObj(x)) throw new Error(`${at}: nem objektum`);
  if (!oneOf(NEWS_CATEGORIES, x.category)) throw new Error(`${at}.category: ismeretlen (${String(x.category)})`);
  if (!oneOf(NEWS_REGIONS, x.region)) throw new Error(`${at}.region: ismeretlen (${String(x.region)})`);
  if (x.importance !== 1 && x.importance !== 2 && x.importance !== 3)
    throw new Error(`${at}.importance: 1, 2 vagy 3 kell`);
  if (!text(x.title) || !text(x.summary)) throw new Error(`${at}: üres cím vagy összefoglaló`);
  if (!oneOf(NEWS_IMPACTS, x.impact)) throw new Error(`${at}.impact: ismeretlen (${String(x.impact)})`);
  if (!Array.isArray(x.affects) || !x.affects.every(text)) throw new Error(`${at}.affects: szöveglista kell`);
  if (!Array.isArray(x.sources) || !x.sources.length) throw new Error(`${at}.sources: legalább egy forrás kell`);
  const sources = x.sources.map((s, j) => {
    if (!isObj(s) || !text(s.title) || !text(s.url) || !/^https?:\/\//.test(s.url))
      throw new Error(`${at}.sources[${j}]: cím és http(s) URL kell`);
    return { title: s.title.trim(), url: s.url.trim() };
  });
  return {
    category: x.category,
    region: x.region,
    importance: x.importance,
    title: x.title.trim(),
    summary: x.summary.trim(),
    impact: x.impact,
    affects: x.affects.map((a) => a.trim()),
    sources,
  };
}

/** The model's answer → a clean body, or an error saying what's wrong. */
export function validateDigestBody(x: unknown): NewsDigestBody {
  if (!isObj(x)) throw new Error("A válasz nem JSON-objektum.");
  if (!text(x.headline)) throw new Error("headline: üres");
  if (!Array.isArray(x.items) || !x.items.length) throw new Error("items: legalább egy hír kell");
  if (!Array.isArray(x.upcoming)) throw new Error("upcoming: lista kell");
  const upcoming = x.upcoming.map((u, i) => {
    if (!isObj(u) || !text(u.date) || !DAY_RE.test(u.date) || !text(u.event) || !text(u.why))
      throw new Error(`upcoming[${i}]: dátum (YYYY-MM-DD), esemény és indok kell`);
    return { date: u.date, event: u.event.trim(), why: u.why.trim() };
  });
  return {
    headline: x.headline.trim(),
    items: x.items.map(checkItem),
    upcoming,
  };
}

/** A stored day file (newer versions are refused, like the snapshot). */
export function validateDigest(x: unknown): NewsDigest {
  if (!isObj(x)) throw new Error("Sérült hírfájl: nem objektum.");
  if (typeof x.version === "number" && x.version > 1)
    throw new Error("A hírfájl újabb verzióval készült — frissítsd az appot.");
  if (!text(x.day) || !DAY_RE.test(x.day)) throw new Error("Sérült hírfájl: hiányzó nap.");
  if (!oneOf(NEWS_EDITIONS, x.edition)) throw new Error("Sérült hírfájl: ismeretlen kiadás.");
  const body = validateDigestBody(x);
  return {
    version: 1,
    day: x.day,
    edition: x.edition,
    generatedAt: String(x.generatedAt ?? ""),
    engine: String(x.engine ?? ""),
    model: String(x.model ?? ""),
    ...(typeof x.costUsd === "number" ? { costUsd: x.costUsd } : {}),
    ...body,
  };
}

export function validateNewsIndex(x: unknown): NewsIndex {
  if (!isObj(x) || !Array.isArray(x.entries)) throw new Error("Sérült hírindex.");
  const entries = x.entries.filter(
    (d): d is NewsIndexEntry =>
      isObj(d) &&
      text(d.day) &&
      DAY_RE.test(d.day) &&
      oneOf(NEWS_EDITIONS, d.edition) &&
      typeof d.headline === "string",
  );
  return {
    version: 1,
    entries: entries.map((d) => ({
      day: d.day,
      edition: d.edition,
      headline: d.headline,
      count: typeof d.count === "number" ? d.count : 0,
      titles: Array.isArray(d.titles) ? d.titles.filter(text) : [],
    })),
  };
}

/** The index with `digest` added (or replaced), newest first, trimmed. */
export function withIndexEntry(index: NewsIndex | null, digest: NewsDigest): NewsIndex {
  const entry: NewsIndexEntry = {
    day: digest.day,
    edition: digest.edition,
    headline: digest.headline,
    count: digest.items.length,
    titles: digest.items.map((i) => i.title),
  };
  const rest = (index?.entries ?? []).filter((d) => digestKey(d) !== digestKey(digest));
  return {
    version: 1,
    entries: [entry, ...rest]
      .sort((a, b) => digestKey(b).localeCompare(digestKey(a)))
      .slice(0, NEWS_INDEX_SIZE),
  };
}

/** Items most important first; the model's order breaks ties. */
export function rankedItems(items: NewsItem[]): NewsItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.importance - a.it.importance || a.i - b.i)
    .map((x) => x.it);
}
