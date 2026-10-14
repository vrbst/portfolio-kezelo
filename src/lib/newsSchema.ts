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

/** Kinds of scheduled announcements the follow-up learns its timing per. */
export const EVENT_KINDS = [
  "US_CPI",
  "US_JOBS",
  "US_GDP",
  "FED_RATE",
  "ECB_RATE",
  "MNB_RATE",
  "HU_CPI",
  "HU_GDP",
  "EZ_CPI",
  "PMI",
  "AKK_AUCTION",
  "OTHER",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Central banks: the decision and, later, the press conference. */
export const RATE_KINDS: readonly EventKind[] = ["FED_RATE", "ECB_RATE", "MNB_RATE"];

export interface NewsUpcoming {
  /** YYYY-MM-DD */
  date: string;
  event: string;
  why: string;
  /** HH:MM Budapest time, only when an official calendar gives it. */
  time?: string;
  /** Worth a look for the result once it is out (scheduled, portfolio-moving). */
  followUp?: boolean;
  kind?: EventKind;
  /** HH:MM Budapest time of the press conference (rate decisions). */
  pressTime?: string;
  /** The consensus, if known. */
  expected?: string;
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
  /** When it was made: a new search of the same edition is new again (unread). */
  generatedAt?: string;
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
        required: ["date", "event", "why", "time", "followUp", "kind", "pressTime", "expected"],
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          event: { type: "string" },
          why: { type: "string" },
          time: { type: ["string", "null"] },
          followUp: { type: "boolean" },
          kind: { type: ["string", "null"], enum: [...EVENT_KINDS, null] },
          pressTime: { type: ["string", "null"] },
          expected: { type: ["string", "null"] },
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

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The optional follow-up fields: a bad one is dropped, never an error. */
function checkUpcoming(u: Record<string, unknown> & { date: string; event: string; why: string }): NewsUpcoming {
  const time = typeof u.time === "string" && TIME_RE.test(u.time.trim()) ? u.time.trim() : undefined;
  const pressTime =
    typeof u.pressTime === "string" && TIME_RE.test(u.pressTime.trim()) ? u.pressTime.trim() : undefined;
  const kind = u.kind == null ? undefined : oneOf(EVENT_KINDS, u.kind) ? u.kind : "OTHER";
  return {
    date: u.date,
    event: u.event.trim(),
    why: u.why.trim(),
    ...(time ? { time } : {}),
    ...(u.followUp === true ? { followUp: true } : {}),
    ...(kind ? { kind } : {}),
    ...(pressTime ? { pressTime } : {}),
    ...(text(u.expected) ? { expected: u.expected.trim() } : {}),
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
    return checkUpcoming(u as Record<string, unknown> & { date: string; event: string; why: string });
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
      ...(typeof d.generatedAt === "string" ? { generatedAt: d.generatedAt } : {}),
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
    generatedAt: digest.generatedAt,
  };
  const rest = (index?.entries ?? []).filter((d) => digestKey(d) !== digestKey(digest));
  return {
    version: 1,
    entries: [entry, ...rest]
      .sort((a, b) => digestKey(b).localeCompare(digestKey(a)))
      .slice(0, NEWS_INDEX_SIZE),
  };
}

/** Identity of one version of a digest, for the "read" marks. */
export const seenKey = (e: NewsIndexEntry) => `${digestKey(e)}@${e.generatedAt ?? ""}`;

/**
 * Today's digests not read yet. Only today's: an older one left unread is
 * old news, never flagged.
 */
export function unreadToday(
  index: NewsIndex | null,
  seen: readonly string[],
  today: string,
): NewsIndexEntry[] {
  return (index?.entries ?? []).filter((e) => e.day === today && !seen.includes(seenKey(e)));
}

/** Items most important first; the model's order breaks ties. */
export function rankedItems(items: NewsItem[]): NewsItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.importance - a.it.importance || a.i - b.i)
    .map((x) => x.it);
}

// ---- filtering by the affected asset ---------------------------------------------

/** How an `affects` entry is compared: case and surrounding spaces don't matter. */
export const assetKey = (a: string) => a.trim().toLowerCase();

export interface DigestAsset {
  /** As the first item wrote it. */
  label: string;
  key: string;
  count: number;
}

/** The assets the items touch, the most mentioned first (ties: first seen first). */
export function digestAssets(items: readonly NewsItem[]): DigestAsset[] {
  const found = new Map<string, DigestAsset>();
  for (const it of items)
    for (const a of new Set(it.affects.map(assetKey))) {
      const label = it.affects.find((x) => assetKey(x) === a)!.trim();
      const cur = found.get(a);
      if (cur) cur.count++;
      else found.set(a, { label, key: a, count: 1 });
    }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

/** The items touching `asset` (by assetKey or label); null = no filter. */
export function itemsForAsset<T extends Pick<NewsItem, "affects">>(items: readonly T[], asset: string | null): T[] {
  if (asset == null) return [...items];
  const k = assetKey(asset);
  return items.filter((it) => it.affects.some((a) => assetKey(a) === k));
}

// ---- event follow-ups (news/events.json) ---------------------------------------

export const NEWS_EVENTS_PATH = `${NEWS_DIR}/events.json`;
/** How many results the file keeps. */
export const EVENT_RESULTS_SIZE = 120;

/** A rate decision comes out as "release", its press conference as "press". */
export const EVENT_PHASES = ["release", "press"] as const;
export type EventPhase = (typeof EVENT_PHASES)[number];

export const EVENT_PHASE_LABEL: Record<EventPhase, string> = {
  release: "Bejelentés",
  press: "Sajtótájékoztató",
};

export const SURPRISES = ["above", "below", "inline", "unknown"] as const;
export type Surprise = (typeof SURPRISES)[number];

export const SURPRISE_LABEL: Record<Surprise, string> = {
  above: "a várakozás felett",
  below: "a várakozás alatt",
  inline: "a várakozásnak megfelelő",
  unknown: "a várakozás nem ismert",
};

export interface EventResult {
  /** Slot key, `${phase}|${date}|${time}`. */
  key: string;
  phase: EventPhase;
  date: string;
  time: string;
  kind: EventKind;
  event: string;
  actual: string;
  expected: string;
  surprise: Surprise;
  reaction: string;
  outlook: string;
  impact: NewsImpact;
  affects: string[];
  sources: NewsSource[];
  /** Minutes from the announcement to the first news coverage, if measured. */
  latencyMin?: number;
  generatedAt: string;
  engine: string;
  model: string;
  costUsd?: number;
}

/** Where a watched announcement stands. */
export const SUBSCRIPTION_STATUSES = ["waiting", "watching", "searching", "done", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  waiting: "vár a bejelentésre",
  watching: "híreket figyel",
  searching: "keres",
  done: "kész",
  expired: "lejárt",
};

export interface EventSubscription {
  key: string;
  phase: EventPhase;
  date: string;
  time: string;
  kind: EventKind;
  events: { event: string; expected?: string }[];
  status: SubscriptionStatus;
  /** ISO: when the search is expected to start (learned delay or fallback). */
  expectedRunAt?: string;
  /** ISO: when the first news about it was seen. */
  firstSeenAt?: string;
  tries: number;
}

export interface EventLatency {
  samples: number;
  /** The learned delay (minutes) once there are enough samples. */
  delayMin?: number;
}

export interface EventsFile {
  version: 1;
  /** Newest first. */
  results: EventResult[];
  subscriptions: EventSubscription[];
  latency: Record<string, EventLatency>;
}

export const emptyEventsFile = (): EventsFile => ({ version: 1, results: [], subscriptions: [], latency: {} });

const strList = (x: unknown): string[] => (Array.isArray(x) ? x.filter(text).map((a) => a.trim()) : []);

function checkSources(x: unknown): NewsSource[] {
  return (Array.isArray(x) ? x : []).flatMap((s) =>
    isObj(s) && text(s.title) && text(s.url) && /^https?:\/\//.test(s.url)
      ? [{ title: s.title.trim(), url: s.url.trim() }]
      : [],
  );
}

function checkResult(x: unknown): EventResult[] {
  if (
    !isObj(x) ||
    !text(x.key) ||
    !oneOf(EVENT_PHASES, x.phase) ||
    !text(x.date) ||
    !DAY_RE.test(x.date) ||
    !text(x.time) ||
    !TIME_RE.test(x.time) ||
    !text(x.event) ||
    !text(x.actual)
  )
    return [];
  return [
    {
      key: x.key,
      phase: x.phase,
      date: x.date,
      time: x.time,
      kind: oneOf(EVENT_KINDS, x.kind) ? x.kind : "OTHER",
      event: x.event.trim(),
      actual: x.actual.trim(),
      expected: typeof x.expected === "string" ? x.expected.trim() : "",
      surprise: oneOf(SURPRISES, x.surprise) ? x.surprise : "unknown",
      reaction: typeof x.reaction === "string" ? x.reaction.trim() : "",
      outlook: typeof x.outlook === "string" ? x.outlook.trim() : "",
      impact: oneOf(NEWS_IMPACTS, x.impact) ? x.impact : "neutral",
      affects: strList(x.affects),
      sources: checkSources(x.sources),
      ...(typeof x.latencyMin === "number" ? { latencyMin: x.latencyMin } : {}),
      generatedAt: String(x.generatedAt ?? ""),
      engine: String(x.engine ?? ""),
      model: String(x.model ?? ""),
      ...(typeof x.costUsd === "number" ? { costUsd: x.costUsd } : {}),
    },
  ];
}

function checkSubscription(x: unknown): EventSubscription[] {
  if (
    !isObj(x) ||
    !text(x.key) ||
    !oneOf(EVENT_PHASES, x.phase) ||
    !text(x.date) ||
    !DAY_RE.test(x.date) ||
    !text(x.time) ||
    !TIME_RE.test(x.time) ||
    !oneOf(SUBSCRIPTION_STATUSES, x.status)
  )
    return [];
  const events = (Array.isArray(x.events) ? x.events : []).flatMap((e) =>
    isObj(e) && text(e.event)
      ? [{ event: e.event.trim(), ...(text(e.expected) ? { expected: e.expected.trim() } : {}) }]
      : [],
  );
  return [
    {
      key: x.key,
      phase: x.phase,
      date: x.date,
      time: x.time,
      kind: oneOf(EVENT_KINDS, x.kind) ? x.kind : "OTHER",
      events,
      status: x.status,
      ...(text(x.expectedRunAt) ? { expectedRunAt: x.expectedRunAt } : {}),
      ...(text(x.firstSeenAt) ? { firstSeenAt: x.firstSeenAt } : {}),
      tries: typeof x.tries === "number" ? x.tries : 0,
    },
  ];
}

/** A stored news/events.json (bad entries are dropped, a newer version refused). */
export function validateEventsFile(x: unknown): EventsFile {
  if (!isObj(x)) throw new Error("Sérült eseményfájl: nem objektum.");
  if (typeof x.version === "number" && x.version > 1)
    throw new Error("Az eseményfájl újabb verzióval készült — frissítsd az appot.");
  const latency: Record<string, EventLatency> = {};
  if (isObj(x.latency))
    for (const [k, v] of Object.entries(x.latency))
      if (isObj(v) && typeof v.samples === "number")
        latency[k] = { samples: v.samples, ...(typeof v.delayMin === "number" ? { delayMin: v.delayMin } : {}) };
  return {
    version: 1,
    results: (Array.isArray(x.results) ? x.results : []).flatMap(checkResult).slice(0, EVENT_RESULTS_SIZE),
    subscriptions: (Array.isArray(x.subscriptions) ? x.subscriptions : []).flatMap(checkSubscription),
    latency,
  };
}

/** The file with `result` added (a rerun of the same slot replaces it), newest first. */
export function withEventResult(file: EventsFile | null, result: EventResult): EventsFile {
  const base = file ?? emptyEventsFile();
  const rest = base.results.filter((r) => r.key !== result.key);
  return {
    ...base,
    results: [result, ...rest]
      .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
      .slice(0, EVENT_RESULTS_SIZE),
  };
}
