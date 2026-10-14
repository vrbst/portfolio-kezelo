import { describe, expect, it } from "vitest";
import { NEWS_EVENTS_PATH, type NewsUpcoming } from "../../../src/lib/newsSchema";
import { fixtureDigest, fixtureEventsFile } from "../../../src/test/newsFixture";
import type { EventsState } from "../state";
import {
  MAX_SEARCH_TRIES,
  combineCoverage,
  patchSlot,
  publishEvents,
  recordLatency,
  registerFollowUps,
  validateEventAnswer,
} from "./events";
import { isPreview, parseRss, probeCoverage } from "./rss";
import { memoryStore } from "./testFakes";

// The fixes of the code review of the announcement follow-up (PR #21). Times
// are built from local time, like the code (the suite runs in any zone).
const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min);

const digestWith = (upcoming: Partial<NewsUpcoming>[], edition: "morning" | "evening" = "morning") => ({
  ...fixtureDigest("2026-10-14", edition),
  upcoming: upcoming.map((u) => ({ date: "2026-10-14", event: "Esemény", why: "Mert.", ...u }) as NewsUpcoming),
});
const cpi = { event: "US CPI", time: "14:30", followUp: true, kind: "US_CPI" as const };
const NOW = at(14, 7, 45);
const register = (upcoming: Partial<NewsUpcoming>[], ev?: EventsState, edition: "morning" | "evening" = "morning") =>
  registerFollowUps(ev, digestWith(upcoming, edition), NOW);

const item = {
  event: "US CPI",
  actual: "3,2% é/é",
  expected: "3,0%",
  surprise: "above",
  reaction: "",
  outlook: "",
  impact: "neutral",
  affects: [],
  sources: [],
};

describe("a partly known answer", () => {
  it("an item without a result is left out, the published ones are kept", () => {
    const a = validateEventAnswer({ released: true, items: [item, { ...item, event: "Core CPI", actual: " " }] });
    expect(a).toMatchObject({ released: true, items: [{ event: "US CPI" }] });
    if (a.released) expect(a.items).toHaveLength(1);
  });

  it("no item with a result at all is still an invalid answer", () => {
    expect(() => validateEventAnswer({ released: true, items: [{ ...item, actual: "" }] })).toThrow();
  });
});

describe("the same announcement listed again", () => {
  it("another digest with a slightly different time is the same slot", () => {
    const ev = register([cpi]);
    const again = register([{ ...cpi, time: "14:35" }], ev, "evening");
    expect(again.slots).toHaveLength(1);
    expect(again.slots[0].time).toBe("14:30");
  });

  it("the same kind on the same day under another name is the same slot, the name is added", () => {
    const ev = register([cpi]);
    const again = register([{ ...cpi, event: "Amerikai fogyasztói árak", time: "14:30" }], ev);
    expect(again.slots).toHaveLength(1);
    expect(again.slots[0].events.map((e) => e.event)).toEqual(["US CPI", "Amerikai fogyasztói árak"]);
  });

  it("two different OTHER events at different times stay two slots", () => {
    const ev = register([
      { event: "Aukció A", time: "10:00", followUp: true, kind: "OTHER" },
      { event: "Aukció B", time: "11:00", followUp: true, kind: "OTHER" },
    ]);
    expect(ev.slots).toHaveLength(2);
  });

  it("an event added to a slot that is already searched or done gets a slot of its own", () => {
    for (const status of ["searching", "done"] as const) {
      let ev = register([cpi]);
      ev = patchSlot(ev, ev.slots[0].key, (s) => ({ ...s, status }));
      const again = register([cpi, { event: "Heti munkanélküli", time: "14:30", followUp: true, kind: "US_JOBS" }], ev);
      expect(again.slots).toHaveLength(2);
      expect(new Set(again.slots.map((s) => s.key)).size).toBe(2);
      expect(again.slots.find((s) => s.status === "waiting")?.events.map((e) => e.event)).toEqual(["Heti munkanélküli"]);
      expect(again.slots.find((s) => s.status === status)?.events.map((e) => e.event)).toEqual(["US CPI"]);
    }
  });
});

describe("the press conference", () => {
  const mnb = { event: "MNB kamatdöntés", time: "14:00", followUp: true, kind: "MNB_RATE" as const };

  it("a later digest that brings the press time adds the press slot to the known decision", () => {
    const ev = register([mnb]);
    expect(ev.slots.map((s) => s.phase)).toEqual(["release"]);
    const again = register([{ ...mnb, pressTime: "15:00" }], ev, "evening");
    expect(again.slots.map((s) => `${s.phase} ${s.time}`)).toEqual(["release 14:00", "press 15:00"]);
  });

  it("it isn't added twice", () => {
    let ev = register([{ ...mnb, pressTime: "15:00" }]);
    ev = register([{ ...mnb, pressTime: "15:00" }], ev, "evening");
    expect(ev.slots.filter((s) => s.phase === "press")).toHaveLength(1);
  });

  it("in a mixed group the press slot takes the kind of the rate decision, not of the first item", () => {
    const ev = register([
      { event: "Heti munkanélküli", time: "14:00", followUp: true, kind: "US_JOBS" },
      { ...mnb, pressTime: "15:00" },
    ]);
    expect(ev.slots.find((s) => s.phase === "press")?.kind).toBe("MNB_RATE");
  });
});

describe("the news coverage", () => {
  it("previews and explainers are not coverage of the release", () => {
    for (const t of [
      "US CPI preview: what to expect",
      "What to expect from Wednesday's CPI report",
      "Stocks ahead of CPI data",
      "Heti előzetes: jön az infláció",
      "Mire számíthatunk a kamatdöntésen?",
    ])
      expect(isPreview(t), t).toBe(true);
    for (const t of ["US CPI rose 3.2% in September", "Az MNB 6,5 százalékon tartotta az alapkamatot"])
      expect(isPreview(t), t).toBe(false);
  });

  it("probeCoverage counts only the articles that aren't previews", async () => {
    const xml = (...t: string[]) =>
      `<rss><channel>${t.map((x) => `<item><title>${x}</title><pubDate>Wed, 14 Oct 2026 12:40:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
    const f = (async () => ({ ok: true, text: async () => xml("CPI preview: what to expect", "What to watch today", "CPI rose 3.2%") })) as unknown as typeof fetch;
    const c = await probeCoverage("US_CPI", "US CPI", new Date("2026-10-14T12:30:00Z"), f);
    expect(c).toMatchObject({ count: 1 });
  });

  it("entities are decoded once (&amp; last)", () => {
    const [i] = parseRss(`<rss><item><title>S&amp;P &amp;lt;b&amp;gt; &amp;quot;x&amp;quot; &lt;b&gt;</title><pubDate>Wed, 14 Oct 2026 12:40:00 GMT</pubDate></item></rss>`);
    expect(i.title).toBe('S&P &lt;b&gt; &quot;x&quot; <b>');
  });

  it("the coverage of several events of a slot: the first that is covered, else the largest, else unknown", () => {
    const c = (count: number, min: number) => ({ count, earliest: new Date(2026, 9, 14, 14, min).toISOString() });
    expect(combineCoverage([c(1, 32), c(3, 36), c(2, 34)])).toEqual(c(2, 34));
    expect(combineCoverage([c(0, 0), c(1, 40)])).toEqual(c(1, 40));
    expect(combineCoverage([null, c(2, 31)])).toEqual(c(2, 31));
    expect(combineCoverage([null, null])).toBeNull();
    expect(combineCoverage([])).toBeNull();
  });
});

describe("the learned delay", () => {
  const slot = (ev: EventsState) => ev.slots[0];

  it("a release found by the search counts from the first article, if there was one", () => {
    let ev = register([cpi]);
    ev = patchSlot(ev, slot(ev).key, (s) => ({ ...s, firstSeenAt: at(14, 14, 36).toISOString() }));
    expect(recordLatency(ev, slot(ev), at(14, 15, 5)).latency).toEqual({ US_CPI: [6] });
  });

  it("without coverage seen the time of the successful search is the (upper bound) sample", () => {
    const ev = register([cpi]);
    expect(recordLatency(ev, slot(ev), at(14, 15, 31)).latency).toEqual({ US_CPI: [61] });
  });

  it("a press conference is no sample of the release delay", () => {
    const ev = register([{ event: "Fed", time: "20:00", followUp: true, kind: "FED_RATE", pressTime: "20:30" }]);
    const press = ev.slots.find((s) => s.phase === "press")!;
    expect(recordLatency(ev, press, at(14, 21, 20)).latency).toEqual({});
  });

  it("keeps the last ten", () => {
    let ev: EventsState = { ...register([cpi]), latency: { US_CPI: Array.from({ length: 10 }, (_, i) => i) } };
    ev = recordLatency(ev, slot(ev), at(14, 14, 40));
    expect(ev.latency.US_CPI).toHaveLength(10);
    expect(ev.latency.US_CPI.at(-1)).toBe(10);
  });
});

describe("a file that can't be read isn't overwritten", () => {
  const ev = register([cpi]);

  it("a newer version is left alone (the publish fails, the results wait)", async () => {
    const newer = JSON.stringify({ ...fixtureEventsFile(), version: 2 });
    const store = memoryStore({ [NEWS_EVENTS_PATH]: newer });
    await expect(publishEvents(store, ev)).rejects.toThrow(/újabb/);
    expect(store.files[NEWS_EVENTS_PATH]).toBe(newer);
    expect(store.writes).toEqual([]);
  });

  it("so is a file that is not JSON", async () => {
    const store = memoryStore({ [NEWS_EVENTS_PATH]: "{nem json" });
    await expect(publishEvents(store, ev)).rejects.toThrow();
    expect(store.files[NEWS_EVENTS_PATH]).toBe("{nem json");
  });

  it("a missing file is a new one", async () => {
    const store = memoryStore();
    await publishEvents(store, ev);
    expect(store.writes).toEqual([NEWS_EVENTS_PATH]);
  });
});

describe("the search budget", () => {
  it("is a handful of tries", () => {
    expect(MAX_SEARCH_TRIES).toBeGreaterThanOrEqual(3);
    expect(MAX_SEARCH_TRIES).toBeLessThanOrEqual(8);
  });
});
