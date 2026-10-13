// Follow-up of the announcements the news digest lists (CPI, rate decisions…):
// the digest marks the scheduled ones worth a look and gives their time →
// registerFollowUps keeps them as slots in the state → the 5-minute tick
// watches the news (rss.ts) and, once the announcement is covered, starts the
// news-event job → one AI search for the result, the expectation, the market
// reaction and the outlook → Telegram + news/events.json in the sync repo.
// The gap between the announcement and its first coverage is measured per
// kind; the next time the search is timed from that.

import {
  EVENT_PHASE_LABEL,
  NEWS_EVENTS_PATH,
  NEWS_IMPACTS,
  RATE_KINDS,
  SURPRISES,
  SUBSCRIPTION_STATUS_LABEL,
  SURPRISE_LABEL,
  emptyEventsFile,
  validateEventsFile,
  withEventResult,
  type EventResult,
  type EventsFile,
  type EventSubscription,
  type NewsDigest,
  type NewsSource,
  type Surprise,
  type SubscriptionStatus,
} from "../../../src/lib/newsSchema";
import { addDaysIso, toLocalDay } from "../../../src/lib/day";
import { dayLabel, esc } from "../reports";
import type { EventSlot, EventsState } from "../state";
import type { NewsEngine } from "./engine";
import { extractJson, type NewsStore } from "./job";
import type { Coverage } from "./rss";

/** At most this many announcements a day are followed. */
export const MAX_SLOTS_PER_DAY = 3;
/** No learned delay yet: search this long after the announcement at the latest. */
export const FALLBACK_DELAY_MIN = 60;
/** A press conference is searched this long after its start. */
export const PRESS_DELAY_MIN = 45;
/** After this long without a result a slot is given up. */
export const GIVE_UP_MIN = 180;
/** The result wasn't out yet: look again after this long. */
export const RETRY_MIN = 15;
/** Articles needed before the announcement counts as covered. */
export const RSS_MIN_HITS = 2;
export const MIN_SAMPLES = 3;
export const MIN_DELAY_MIN = 5;
export const MAX_DELAY_MIN = 60;
export const LATENCY_KEEP = 10;
/** Slots older than this many days are dropped. */
export const KEEP_DAYS = 7;
/** A search that holds a slot for longer than this crashed: the slot is free again. */
export const TAKEN_STALE_MIN = 20;

const MIN = 60_000;

/** The Budapest wall-clock time of the digest, as an instant (the notifier runs in Budapest). */
export function slotStart(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

export const emptyEvents = (): EventsState => ({ slots: [], latency: {} });

/**
 * The delay (minutes) after an announcement by which its coverage is usually
 * out: the 80th percentile of the measured gaps + 3 minutes, between 5 and 60.
 * Undefined with fewer than MIN_SAMPLES gaps.
 */
export function learnedDelayMin(samples: readonly number[] | undefined): number | undefined {
  if (!samples || samples.length < MIN_SAMPLES) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const p80 = sorted[Math.ceil(sorted.length * 0.8) - 1];
  return Math.min(MAX_DELAY_MIN, Math.max(MIN_DELAY_MIN, Math.round(p80 + 3)));
}

const newSlot = (
  phase: EventSlot["phase"],
  date: string,
  time: string,
  kind: EventSlot["kind"],
  events: EventSlot["events"],
): EventSlot => ({
  key: `${phase}|${date}|${time}`,
  phase,
  date,
  time,
  kind,
  startsAt: slotStart(date, time).toISOString(),
  events,
  status: "waiting",
  tries: 0,
});

/**
 * The digest's follow-up announcements added to `ev` as slots. Same time = one
 * slot (one search for several releases); a rate decision with a press
 * conference gets a second slot for it; at most MAX_SLOTS_PER_DAY a day; ones
 * long past or already known (re-listed by the next digest) are not touched.
 */
export function registerFollowUps(ev: EventsState | undefined, digest: NewsDigest, now: Date): EventsState {
  const cur = ev ?? emptyEvents();
  const oldest = addDaysIso(toLocalDay(now), -KEEP_DAYS);
  const slots = cur.slots.filter((s) => s.date >= oldest);
  const byKey = new Map(slots.map((s) => [s.key, s]));
  const perDay = (date: string) => slots.filter((s) => s.phase === "release" && s.date === date).length;

  const groups = new Map<string, NewsDigest["upcoming"]>();
  for (const u of digest.upcoming) {
    if (!u.followUp || !u.time) continue;
    if (slotStart(u.date, u.time).getTime() + GIVE_UP_MIN * MIN <= now.getTime()) continue;
    const k = `release|${u.date}|${u.time}`;
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }
  for (const [key, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = items[0];
    const events = items.map((u) => ({ event: u.event, ...(u.expected ? { expected: u.expected } : {}) }));
    const known = byKey.get(key);
    if (known) {
      for (const e of events) if (!known.events.some((k) => k.event === e.event)) known.events.push(e);
      continue;
    }
    if (perDay(first.date) >= MAX_SLOTS_PER_DAY) continue;
    const slot = newSlot("release", first.date, first.time!, first.kind ?? "OTHER", events);
    slots.push(slot);
    byKey.set(key, slot);
    const press = items.find((u) => u.pressTime && RATE_KINDS.includes(u.kind ?? "OTHER"));
    if (press?.pressTime && press.pressTime > first.time!) {
      const p = newSlot("press", first.date, press.pressTime, slot.kind, events.map((e) => ({ event: e.event })));
      if (!byKey.has(p.key)) {
        slots.push(p);
        byKey.set(p.key, p);
      }
    }
  }
  slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { ...cur, slots };
}

/** The slots whose coverage should be probed now: announced, not yet due. */
export function slotsToProbe(ev: EventsState | undefined, now: Date): EventSlot[] {
  return (ev?.slots ?? []).filter(
    (s) =>
      s.phase === "release" &&
      (s.status === "waiting" || s.status === "watching") &&
      slotStart(s.date, s.time).getTime() <= now.getTime() &&
      now.getTime() - slotStart(s.date, s.time).getTime() < GIVE_UP_MIN * MIN,
  );
}

/** When a slot's search is due at the latest, without any coverage seen. */
export function deadline(ev: EventsState, slot: EventSlot): Date {
  const start = slotStart(slot.date, slot.time).getTime();
  const delay =
    slot.phase === "press" ? PRESS_DELAY_MIN : (learnedDelayMin(ev.latency[slot.kind]) ?? FALLBACK_DELAY_MIN);
  return new Date(start + delay * MIN);
}

/**
 * The slots one step on: waiting → watching at the announcement; watching →
 * due when the probe found coverage (the gap is a new sample) or the deadline
 * passed; anything unfinished long after → expired; a crashed search's slot
 * is free again. `probes`: slot key → what the news show (null = unknown).
 * Returns the keys that became due.
 */
export function advanceSlots(
  ev: EventsState,
  now: Date,
  probes: Record<string, Coverage | null> = {},
): { ev: EventsState; becameDue: string[] } {
  const becameDue: string[] = [];
  const latency = { ...ev.latency };
  const slots = ev.slots.map((s): EventSlot => {
    if (s.status === "done" || s.status === "expired") return s;
    const start = slotStart(s.date, s.time).getTime();
    if (now.getTime() - start >= GIVE_UP_MIN * MIN) return { ...s, status: "expired" };
    if (s.status === "searching") {
      const stale = s.takenAt && now.getTime() - Date.parse(s.takenAt) > TAKEN_STALE_MIN * MIN;
      return stale ? { ...s, status: "due", takenAt: undefined, dueAt: now.toISOString() } : s;
    }
    if (s.status === "due") return s;
    if (now.getTime() < start) return s;
    const watching: EventSlot = { ...s, status: "watching" };
    const probe = probes[s.key];
    if (probe && probe.count >= RSS_MIN_HITS) {
      const gap = Math.max(0, Math.round((Date.parse(probe.earliest) - start) / MIN));
      latency[s.kind] = [...(latency[s.kind] ?? []), gap].slice(-LATENCY_KEEP);
      becameDue.push(s.key);
      return { ...watching, status: "due", firstSeenAt: probe.earliest, dueAt: now.toISOString() };
    }
    if (now.getTime() >= deadline(ev, s).getTime()) {
      becameDue.push(s.key);
      return { ...watching, status: "due", dueAt: now.toISOString() };
    }
    return watching;
  });
  return { ev: { ...ev, slots, latency }, becameDue };
}

/** The first slot whose search may start now. */
export function nextDue(ev: EventsState | undefined, now: Date): EventSlot | undefined {
  return (ev?.slots ?? [])
    .filter((s) => s.status === "due" && (!s.dueAt || Date.parse(s.dueAt) <= now.getTime()))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
}

/** The slot with `change` applied (by key). */
export function patchSlot(ev: EventsState, key: string, change: (s: EventSlot) => EventSlot): EventsState {
  return { ...ev, slots: ev.slots.map((s) => (s.key === key ? change(s) : s)) };
}

// ---- the AI search --------------------------------------------------------

export interface EventAnswerItem {
  event: string;
  actual: string;
  expected: string;
  surprise: Surprise;
  reaction: string;
  outlook: string;
  impact: (typeof NEWS_IMPACTS)[number];
  affects: string[];
  sources: NewsSource[];
}

export type EventAnswer = { released: false } | { released: true; items: EventAnswerItem[] };

export const EVENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["released", "items"],
  properties: {
    released: { type: "boolean" },
    items: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event", "actual", "expected", "surprise", "reaction", "outlook", "impact", "affects", "sources"],
        properties: {
          event: { type: "string" },
          actual: { type: "string" },
          expected: { type: "string" },
          surprise: { type: "string", enum: [...SURPRISES] },
          reaction: { type: "string" },
          outlook: { type: "string" },
          impact: { type: "string", enum: [...NEWS_IMPACTS] },
          affects: { type: "array", items: { type: "string" } },
          sources: {
            type: "array",
            maxItems: 3,
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
  },
} as const;

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

export function validateEventAnswer(x: unknown): EventAnswer {
  if (!isObj(x) || typeof x.released !== "boolean") throw new Error("released: igaz/hamis kell");
  if (!x.released) return { released: false };
  if (!Array.isArray(x.items) || !x.items.length) throw new Error("items: legalább egy eredmény kell, ha a bejelentés kint van");
  const items = x.items.map((it, i): EventAnswerItem => {
    const at = `items[${i}]`;
    if (!isObj(it) || !text(it.event) || !text(it.actual)) throw new Error(`${at}: esemény és tényleges eredmény kell`);
    const sources = (Array.isArray(it.sources) ? it.sources : []).map((s, j) => {
      if (!isObj(s) || !text(s.title) || !text(s.url) || !/^https?:\/\//.test(s.url))
        throw new Error(`${at}.sources[${j}]: cím és http(s) URL kell`);
      return { title: s.title.trim(), url: s.url.trim() };
    });
    return {
      event: it.event.trim(),
      actual: it.actual.trim(),
      expected: typeof it.expected === "string" ? it.expected.trim() : "",
      surprise: SURPRISES.includes(it.surprise as Surprise) ? (it.surprise as Surprise) : "unknown",
      reaction: typeof it.reaction === "string" ? it.reaction.trim() : "",
      outlook: typeof it.outlook === "string" ? it.outlook.trim() : "",
      impact: NEWS_IMPACTS.includes(it.impact as never) ? (it.impact as EventAnswerItem["impact"]) : "neutral",
      affects: Array.isArray(it.affects) ? it.affects.filter(text).map((a) => a.trim()) : [],
      sources,
    };
  });
  return { released: true, items };
}

const WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

export function buildEventPrompt(p: { slot: EventSlot; now: Date; exposure: string[] }): string {
  const { slot } = p;
  const list = slot.events
    .map((e) => `- ${e.event}${e.expected ? ` (a digest szerinti várakozás: ${e.expected})` : ""}`)
    .join("\n");
  const [y, m, d] = slot.date.split("-").map(Number);
  const when = `${slot.date} (${WEEKDAYS[new Date(y, m - 1, d).getDay()]}) ${slot.time}, budapesti idő szerint`;
  const task =
    slot.phase === "release"
      ? `Az alábbi bejelentés ${when} volt esedékes. Keress a weben, és tételenként add meg:
- actual: a tényleges eredmény (számmal, a hivatalos közlés szerint);
- expected: a piaci várakozás/konszenzus (forrásból, ne a digestből másold, ha eltér);
- surprise: "above" (a várakozás felett), "below" (alatta), "inline" (megfelelt) vagy "unknown";
- reaction: az első piaci reakció 1–2 mondatban (forint, hozamok, indexek – ami a lenti portfóliót érinti);
- outlook: mi várható ezután most, hogy az eredmény és a várakozás ismert (pl. kamatpálya, következő lépések), és mit jelent ez a portfóliónak;
- impact és affects: a portfólió érintett elemeire várható hatás.`
      : `Az alábbi kamatdöntés sajtótájékoztatója ${when} kezdődött. Keress a weben, és tételenként add meg:
- actual: a döntéshozó fő üzenete, irányadása a sajtótájékoztatón (2–3 mondat);
- expected: mit vártak a piacok a kommunikációtól;
- surprise: "above" (a vártnál szigorúbb/magasabb kamatpálya), "below" (lazább), "inline" vagy "unknown";
- reaction: a piaci reakció a sajtótájékoztató alatt/után;
- outlook: a várható kamatpálya és a következő lépések, és mit jelent ez a portfóliónak;
- impact és affects: mint fent.`;
  return `Te egy magyar magánbefektető piaci hírszerkesztője vagy. Most ${p.now.toISOString()} van.

${task}

Bejelentések:
${list}

A portfólió (súlyok a teljes vagyonból):
${p.exposure.join("\n")}

Szabályok:
- Ha a bejelentés még nincs kint (nincs hivatalos közlés), "released": false és üres "items".
- Csak megbízható forrás (pl. Reuters, Bloomberg, FT, CNBC, MNB, KSH, BLS, Eurostat, Portfolio.hu). Tételenként legfeljebb 3 forrás; a "title" a kiadó rövid neve, az "url" egy valódi cikk, amit ténylegesen megnyitottál vagy a keresés visszaadott.
- Ne találj ki számot, árfolyamot vagy idézetet: ha bizonytalan, hagyd ki (üres szöveg).
- Minden tételhez pontosan egy elem, az "event" a fenti név legyen.
- Röviden, magyarul.

A válasz kizárólag a megadott JSON-séma szerinti objektum legyen.`;
}

export async function askEvent(
  engine: NewsEngine,
  prompt: string,
): Promise<{ answer: EventAnswer; costUsd?: number }> {
  let cost = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt
      ? `${prompt}\n\nAz előző válaszod nem volt érvényes (${lastError}). Add vissza javítva, a séma szerint.`
      : prompt;
    const r = await engine.run(p);
    cost += r.costUsd ?? 0;
    try {
      return { answer: validateEventAnswer(extractJson(r.output)), costUsd: cost || undefined };
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`news-event: invalid answer (${attempt + 1}/2): ${lastError}`);
    }
  }
  throw new Error(`Az AI kétszer is hibás bejelentés-elemzést adott: ${lastError}`);
}

/** The stored results of an answer (one per item). */
export function toResults(
  slot: EventSlot,
  answer: Extract<EventAnswer, { released: true }>,
  meta: { engine: string; model: string; at: Date; costUsd?: number; latencyMin?: number },
): EventResult[] {
  return answer.items.map((it, i) => ({
    key: `${slot.key}#${i}`,
    phase: slot.phase,
    date: slot.date,
    time: slot.time,
    kind: slot.kind,
    ...it,
    ...(meta.latencyMin != null ? { latencyMin: meta.latencyMin } : {}),
    generatedAt: meta.at.toISOString(),
    engine: meta.engine,
    model: meta.model,
    ...(meta.costUsd != null && i === 0 ? { costUsd: meta.costUsd } : {}),
  }));
}

const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
const SURPRISE_ICON: Record<Surprise, string> = { above: "📈", below: "📉", inline: "➖", unknown: "❔" };

/** The Telegram message of a slot's results. */
export function eventText(results: EventResult[]): string {
  return results
    .map((r) => {
      const sources = r.sources.length
        ? ` (${r.sources.map((s) => `<a href="${attr(s.url)}">${esc(s.title)}</a>`).join(", ")})`
        : "";
      const head =
        r.phase === "press"
          ? `🎙 <b>${esc(r.event)}: ${EVENT_PHASE_LABEL.press.toLowerCase()} (${r.time})</b>`
          : `📊 <b>${esc(r.event)} (${r.time})</b>`;
      const lines = [head];
      if (r.phase === "press") lines.push(esc(r.actual));
      else
        lines.push(
          `Tény: <b>${esc(r.actual)}</b>${r.expected ? ` · Várakozás: ${esc(r.expected)}` : ""} ${SURPRISE_ICON[r.surprise]} <i>${SURPRISE_LABEL[r.surprise]}</i>`,
        );
      if (r.reaction) lines.push(`${r.phase === "press" ? "Reakció" : "Piaci reakció"}: ${esc(r.reaction)}`);
      if (r.outlook) lines.push(`<b>Mi várható:</b> ${esc(r.outlook)}${sources}`);
      else if (sources) lines.push(sources.trim());
      return lines.join("\n");
    })
    .join("\n\n");
}

// ---- what the user sees ---------------------------------------------------

const SUB_STATUS: Record<EventSlot["status"], SubscriptionStatus> = {
  waiting: "waiting",
  watching: "watching",
  due: "searching",
  searching: "searching",
  done: "done",
  expired: "expired",
};

/** The slots as the subscriptions of news/events.json (and /bejelentesek). */
export function subscriptionsOf(ev: EventsState): EventSubscription[] {
  return ev.slots.map((s) => {
    const expected =
      s.status === "waiting" || s.status === "watching"
        ? deadline(ev, s).toISOString()
        : undefined;
    return {
      key: s.key,
      phase: s.phase,
      date: s.date,
      time: s.time,
      kind: s.kind,
      events: s.events,
      status: SUB_STATUS[s.status],
      ...(expected ? { expectedRunAt: expected } : {}),
      ...(s.firstSeenAt ? { firstSeenAt: s.firstSeenAt } : {}),
      tries: s.tries,
    };
  });
}

export function latencyOf(ev: EventsState): EventsFile["latency"] {
  return Object.fromEntries(
    Object.entries(ev.latency).map(([k, v]) => [
      k,
      { samples: v.length, ...(learnedDelayMin(v) != null ? { delayMin: learnedDelayMin(v) } : {}) },
    ]),
  );
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The morning digest's last line: what is followed today, e.g.
 * "US CPI 14:30, MNB-döntés 14:00 (+ sajtótáj. 15:00)". Undefined if none.
 */
export function watchLine(ev: EventsState | undefined, today: string): string | undefined {
  const mine = (ev?.slots ?? []).filter((s) => s.date === today);
  const parts = mine
    .filter((s) => s.phase === "release")
    .map((s) => {
      const press = mine.find((p) => p.phase === "press" && p.events[0]?.event === s.events[0]?.event);
      const more = s.events.length > 1 ? ` +${s.events.length - 1}` : "";
      return `${clip(s.events[0]?.event ?? s.kind)}${more} ${s.time}${press ? ` (+ sajtótáj. ${press.time})` : ""}`;
    });
  return parts.length ? parts.join(", ") : undefined;
}

/** /bejelentesek: the followed announcements, their state and the learned delays. */
export function followUpsText(ev: EventsState | undefined, now: Date, label = dayLabel): string {
  const from = addDaysIso(toLocalDay(now), -1);
  const slots = (ev?.slots ?? []).filter((s) => s.date >= from);
  if (!slots.length)
    return "🔔 Nincs figyelt bejelentés. A reggeli (és esti) hírkeresés jelöli ki őket, ha a pontos idejük ismert.";
  const subs = new Map(subscriptionsOf(ev!).map((s) => [s.key, s]));
  const lines = ["🔔 <b>Figyelt bejelentések</b>"];
  let day = "";
  for (const s of slots) {
    if (s.date !== day) {
      day = s.date;
      lines.push("", `<b>${label(day)}</b>`);
    }
    const sub = subs.get(s.key)!;
    const name = `${s.phase === "press" ? "🎙 " : ""}${clip(s.events[0]?.event ?? s.kind, 50)}${s.events.length > 1 ? ` +${s.events.length - 1}` : ""}`;
    const due = sub.expectedRunAt ? `, legkésőbb ${new Date(sub.expectedRunAt).toTimeString().slice(0, 5)}` : "";
    lines.push(`• ${s.time} ${esc(name)} — ${SUBSCRIPTION_STATUS_LABEL[sub.status]}${due}`);
  }
  const learned = Object.entries(latencyOf(ev!));
  if (learned.length) {
    lines.push("", "<i>Tanult késés a hírekig:</i>");
    for (const [k, v] of learned)
      lines.push(`${k}: ${v.delayMin != null ? `~${v.delayMin} perc` : "még nincs elég mérés"} (${v.samples} mérés)`);
  }
  return lines.join("\n");
}

/** What the file shows of the state: compared to skip uploads of no change. */
export const publishSignature = (ev: EventsState) =>
  JSON.stringify([subscriptionsOf(ev), latencyOf(ev)]);

async function readEventsFile(store: NewsStore): Promise<EventsFile | null> {
  const t = await store.read(NEWS_EVENTS_PATH);
  if (!t) return null;
  try {
    return validateEventsFile(JSON.parse(t));
  } catch (e) {
    console.error("news-event: events.json unreadable, starting a new one:", (e as Error).message);
    return null;
  }
}

/**
 * news/events.json updated: the subscriptions and the learned delays from the
 * state, and the new `results`. Returns the signature to remember.
 */
export async function publishEvents(
  store: NewsStore,
  ev: EventsState,
  results: EventResult[] = [],
  message = "esemény-utókövetés",
): Promise<string> {
  let file = (await readEventsFile(store)) ?? emptyEventsFile();
  for (const r of results) file = withEventResult(file, r);
  file = { ...file, subscriptions: subscriptionsOf(ev), latency: latencyOf(ev) };
  await store.write(NEWS_EVENTS_PATH, JSON.stringify(file, null, 2), message);
  return publishSignature(ev);
}
