import { describe, expect, it } from "vitest";
import { NEWS_EVENTS_PATH, validateEventsFile, type NewsUpcoming } from "../../../src/lib/newsSchema";
import { fixtureDigest, fixtureEventsFile } from "../../../src/test/newsFixture";
import type { EventSlot, EventsState } from "../state";
import {
  FALLBACK_DELAY_MIN,
  GIVE_UP_MIN,
  MAX_SLOTS_PER_DAY,
  PRESS_DELAY_MIN,
  RETRY_MIN,
  advanceSlots,
  askEvent,
  buildEventPrompt,
  emptyEvents,
  eventText,
  followUpsText,
  latencyOf,
  learnedDelayMin,
  nextDue,
  patchSlot,
  publishEvents,
  publishSignature,
  registerFollowUps,
  slotStart,
  slotsToProbe,
  subscriptionsOf,
  toResults,
  validateEventAnswer,
  watchLine,
} from "./events";
import { fakeEngine, memoryStore } from "./testFakes";

// All times are built from local time (new Date(y, m-1, d, h, min)), like the
// code: the suite runs in Budapest, UTC and New York alike.
const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min);
const MIN = 60_000;

const digestWith = (upcoming: Partial<NewsUpcoming>[]) => ({
  ...fixtureDigest("2026-10-14", "morning"),
  upcoming: upcoming.map((u) => ({ date: "2026-10-14", event: "Esemény", why: "Mert.", ...u }) as NewsUpcoming),
});

const cpi = { event: "US CPI", time: "14:30", followUp: true, kind: "US_CPI" as const, expected: "3,0%" };
const NOW = at(14, 7, 45);

const register = (upcoming: Partial<NewsUpcoming>[], ev?: EventsState, now = NOW) =>
  registerFollowUps(ev, digestWith(upcoming), now);

describe("slotStart", () => {
  it("is the digest's HH:MM on that local day", () => {
    expect(slotStart("2026-10-14", "14:30").getTime()).toBe(at(14, 14, 30).getTime());
  });
});

describe("registerFollowUps", () => {
  it("keeps the announcements marked for follow-up with a time", () => {
    const ev = register([cpi, { event: "Háttér", time: "10:00", followUp: false }, { event: "Idő nélkül", followUp: true }]);
    expect(ev.slots).toHaveLength(1);
    expect(ev.slots[0]).toMatchObject({
      key: "release|2026-10-14|14:30",
      phase: "release",
      kind: "US_CPI",
      status: "waiting",
      tries: 0,
      startsAt: at(14, 14, 30).toISOString(),
      events: [{ event: "US CPI", expected: "3,0%" }],
    });
  });

  it("two releases at the same time are one slot (one search)", () => {
    const ev = register([cpi, { ...cpi, event: "Heti munkanélküli", expected: undefined }]);
    expect(ev.slots).toHaveLength(1);
    expect(ev.slots[0].events.map((e) => e.event)).toEqual(["US CPI", "Heti munkanélküli"]);
  });

  it("the next digest listing it again adds nothing and resets nothing", () => {
    let ev = register([cpi]);
    ev = patchSlot(ev, ev.slots[0].key, (s) => ({ ...s, status: "watching", tries: 2 }));
    const again = registerFollowUps(ev, { ...digestWith([cpi]), edition: "evening" }, at(14, 18, 15));
    expect(again.slots).toHaveLength(1);
    expect(again.slots[0]).toMatchObject({ status: "watching", tries: 2 });
  });

  it("a later digest can add an event to a known slot", () => {
    let ev = register([cpi]);
    ev = register([{ ...cpi, event: "Reál bérek" }], ev);
    expect(ev.slots[0].events.map((e) => e.event)).toEqual(["US CPI", "Reál bérek"]);
  });

  it(`at most ${MAX_SLOTS_PER_DAY} a day (the earliest ones)`, () => {
    const many = ["15:00", "10:00", "12:00", "11:00", "13:00"].map((time, i) => ({ ...cpi, kind: "OTHER" as const, event: `E${i}`, time }));
    const ev = register(many);
    expect(ev.slots.map((s) => s.time)).toEqual(["10:00", "11:00", "12:00"]);
    // another day has its own budget
    const other = register([{ ...cpi, kind: "OTHER" as const, event: "E9", date: "2026-10-15", time: "09:00" }], ev);
    expect(other.slots).toHaveLength(4);
  });

  it("a rate decision with a press conference also gets a press slot", () => {
    const ev = register([{ event: "MNB-döntés", time: "14:00", followUp: true, kind: "MNB_RATE", pressTime: "15:00" }]);
    expect(ev.slots.map((s) => `${s.phase} ${s.time}`)).toEqual(["release 14:00", "press 15:00"]);
    expect(ev.slots[1].kind).toBe("MNB_RATE");
  });

  it("no press slot for a non-rate kind, or one before the decision", () => {
    expect(register([{ ...cpi, pressTime: "15:00" }]).slots).toHaveLength(1);
    expect(
      register([{ event: "Fed", time: "20:00", followUp: true, kind: "FED_RATE", pressTime: "19:00" }]).slots,
    ).toHaveLength(1);
  });

  it("an unknown kind is OTHER", () => {
    expect(register([{ ...cpi, kind: undefined }]).slots[0].kind).toBe("OTHER");
  });

  it("announcements long past are not registered; days later ones are", () => {
    const early = { ...cpi, time: "08:00" };
    expect(register([early], undefined, at(14, 18, 15)).slots).toHaveLength(0);
    expect(register([early], undefined, at(14, 9, 0)).slots).toHaveLength(1);
    expect(register([{ ...cpi, date: "2026-10-20" }]).slots).toHaveLength(1);
  });

  it("slots older than a week are dropped", () => {
    const ev = register([{ ...cpi, date: "2026-10-01", time: "23:00" }], undefined, at(1, 8));
    expect(ev.slots).toHaveLength(1);
    expect(register([cpi], ev, at(14, 7, 45)).slots.map((s) => s.date)).toEqual(["2026-10-14"]);
  });
});

describe("learnedDelayMin", () => {
  it("needs three samples", () => {
    expect(learnedDelayMin(undefined)).toBeUndefined();
    expect(learnedDelayMin([5, 6])).toBeUndefined();
  });

  it("is the 80th percentile + 3 minutes", () => {
    expect(learnedDelayMin([10, 12, 20])).toBe(23);
    expect(learnedDelayMin([20, 10, 12, 11, 40, 13, 9, 10, 12, 14])).toBe(17);
  });

  it("stays between 5 and 60 minutes", () => {
    expect(learnedDelayMin([0, 0, 1])).toBe(5);
    expect(learnedDelayMin([90, 120, 100])).toBe(60);
  });

  it("does not reorder its input", () => {
    const s = [30, 10, 20];
    learnedDelayMin(s);
    expect(s).toEqual([30, 10, 20]);
  });
});

describe("advanceSlots", () => {
  const start = at(14, 14, 30);
  const base = () => register([cpi]);
  const plus = (min: number) => new Date(start.getTime() + min * MIN);
  const cov = (count: number, minAfter: number) => ({ count, earliest: plus(minAfter).toISOString() });

  it("waits until the announcement", () => {
    const r = advanceSlots(base(), plus(-1));
    expect(r.ev.slots[0].status).toBe("waiting");
    expect(r.becameDue).toEqual([]);
  });

  it("watches from the announcement; due at the fallback delay without coverage", () => {
    const watching = advanceSlots(base(), plus(1)).ev;
    expect(watching.slots[0].status).toBe("watching");
    expect(advanceSlots(watching, plus(FALLBACK_DELAY_MIN - 1), { [watching.slots[0].key]: cov(1, 5) }).becameDue).toEqual([]);
    const due = advanceSlots(watching, plus(FALLBACK_DELAY_MIN));
    expect(due.becameDue).toEqual(["release|2026-10-14|14:30"]);
    expect(due.ev.slots[0]).toMatchObject({ status: "due" });
    expect(due.ev.latency).toEqual({});
  });

  it("covered by enough articles → due at once (the gap is a sample only once the result is found)", () => {
    const ev = base();
    const key = ev.slots[0].key;
    expect(advanceSlots(ev, plus(8), { [key]: cov(1, 5) }).becameDue).toEqual([]);
    const r = advanceSlots(ev, plus(8), { [key]: cov(3, 5) });
    expect(r.becameDue).toEqual([key]);
    expect(r.ev.slots[0]).toMatchObject({ status: "due", firstSeenAt: plus(5).toISOString() });
    expect(r.ev.latency).toEqual({});
  });

  it("an unreadable feed (null) is just no coverage", () => {
    const ev = base();
    expect(advanceSlots(ev, plus(8), { [ev.slots[0].key]: null }).becameDue).toEqual([]);
  });

  it("a learned delay replaces the fallback", () => {
    const ev = { ...base(), latency: { US_CPI: [5, 6, 7] } };
    expect(learnedDelayMin([5, 6, 7])).toBe(10);
    expect(advanceSlots(ev, plus(9)).becameDue).toEqual([]);
    expect(advanceSlots(ev, plus(10)).becameDue).toHaveLength(1);
  });

  it("a press conference is due after its own delay (no news probe)", () => {
    const ev = register([{ event: "Fed", time: "20:00", followUp: true, kind: "FED_RATE", pressTime: "20:30" }]);
    const press = ev.slots.find((s) => s.phase === "press")!;
    const t0 = slotStart(press.date, press.time).getTime();
    expect(advanceSlots(ev, new Date(t0 + (PRESS_DELAY_MIN - 1) * MIN)).ev.slots.find((s) => s.phase === "press")!.status).toBe("watching");
    expect(advanceSlots(ev, new Date(t0 + PRESS_DELAY_MIN * MIN)).ev.slots.find((s) => s.phase === "press")!.status).toBe("due");
  });

  it("gives up after the window; finished slots stay as they are", () => {
    const ev = base();
    const r = advanceSlots(ev, plus(GIVE_UP_MIN));
    expect(r.ev.slots[0].status).toBe("expired");
    expect(r.becameDue).toEqual([]);
    const done = patchSlot(ev, ev.slots[0].key, (s) => ({ ...s, status: "done" }));
    expect(advanceSlots(done, plus(GIVE_UP_MIN + 60)).ev.slots[0].status).toBe("done");
  });

  it("a search that holds a slot for too long crashed: the slot is free again", () => {
    let ev = base();
    ev = patchSlot(ev, ev.slots[0].key, (s) => ({ ...s, status: "searching", takenAt: plus(60).toISOString() }));
    expect(advanceSlots(ev, plus(70)).ev.slots[0].status).toBe("searching");
    expect(advanceSlots(ev, plus(85)).ev.slots[0]).toMatchObject({ status: "due", takenAt: undefined });
  });
});

describe("slotsToProbe / nextDue", () => {
  const ev = register([cpi, { ...cpi, event: "Később", time: "16:00" }, { event: "MNB", time: "14:00", followUp: true, kind: "MNB_RATE", pressTime: "15:00" }]);

  it("probes only announced release slots inside the window", () => {
    expect(slotsToProbe(ev, at(14, 14, 10)).map((s) => s.time)).toEqual(["14:00"]);
    expect(slotsToProbe(ev, at(14, 15, 5)).map((s) => s.time)).toEqual(["14:00", "14:30"]);
    expect(slotsToProbe(ev, at(14, 20, 0))).toEqual([]);
    expect(slotsToProbe(undefined, at(14, 20, 0))).toEqual([]);
  });

  it("the earliest due slot whose retry time has come", () => {
    let s = ev;
    s = patchSlot(s, "release|2026-10-14|14:30", (x) => ({ ...x, status: "due", dueAt: at(14, 15, 0).toISOString() }));
    s = patchSlot(s, "release|2026-10-14|14:00", (x) => ({ ...x, status: "due", dueAt: at(14, 16, 0).toISOString() }));
    expect(nextDue(s, at(14, 15, 30))?.key).toBe("release|2026-10-14|14:30");
    expect(nextDue(s, at(14, 16, 0))?.key).toBe("release|2026-10-14|14:00");
    expect(nextDue(s, at(14, 14, 59))).toBeUndefined();
    expect(nextDue(undefined, NOW)).toBeUndefined();
  });
});

describe("the AI's answer", () => {
  const item = {
    event: "US CPI",
    actual: "3,2% é/é",
    expected: "3,0% é/é",
    surprise: "above",
    reaction: "A dollár erősödött.",
    outlook: "Kisebb az esély a kamatvágásra.",
    impact: "mixed",
    affects: ["EUR/HUF"],
    sources: [{ title: "Reuters", url: "https://example.com/a?b=1&c=2" }],
  };
  const good = { released: true, items: [item] };

  it("not out yet is a valid answer", () => {
    expect(validateEventAnswer({ released: false, items: [] })).toEqual({ released: false });
  });

  it("a release comes back trimmed", () => {
    const a = validateEventAnswer({ released: true, items: [{ ...item, actual: "  3,2%  ", surprise: "sideways" }] });
    expect(a).toMatchObject({ released: true, items: [{ actual: "3,2%", surprise: "unknown" }] });
  });

  it.each([
    ["not an object", "szöveg"],
    ["released missing", { items: [item] }],
    ["released but empty", { released: true, items: [] }],
    ["no actual result", { released: true, items: [{ ...item, actual: " " }] }],
    ["a source without http(s)", { released: true, items: [{ ...item, sources: [{ title: "x", url: "javascript:1" }] }] }],
  ])("refuses %s", (_n, x) => {
    expect(() => validateEventAnswer(x)).toThrow();
  });

  it("a bad answer is asked again once, with the error; two bad ones fail", async () => {
    const engine = fakeEngine([{ released: true, items: [] }, good]);
    const r = await askEvent(engine, "kérdés");
    expect(r.answer).toMatchObject({ released: true });
    expect(r.costUsd).toBeCloseTo(0.2);
    expect(engine.prompts[1]).toContain("nem volt érvényes");
    await expect(askEvent(fakeEngine([{}, {}]), "kérdés")).rejects.toThrow(/kétszer is hibás/);
  });

  it("the answer's JSON may sit in text", async () => {
    const r = await askEvent(fakeEngine([`Íme:\n${JSON.stringify(good)}\nVége.`]), "kérdés");
    expect(r.answer).toMatchObject({ released: true });
  });
});

describe("buildEventPrompt", () => {
  const slot = register([{ ...cpi, event: "US CPI" }, { ...cpi, event: "Heti munkanélküli", expected: undefined }]).slots[0];
  const exposure = ["- VWCE (ETF): 60%", "- Készpénz: 5%"];

  it("names the announcements, their time, the expectation and the exposure — no amounts", () => {
    const p = buildEventPrompt({ slot, now: at(14, 14, 45), exposure });
    expect(p).toContain("2026-10-14 (szerda) 14:30, budapesti idő szerint");
    expect(p).toContain("- US CPI (a digest szerinti várakozás: 3,0%)");
    expect(p).toContain("- Heti munkanélküli");
    expect(p).toContain("- VWCE (ETF): 60%");
    expect(p).toContain('"released": false');
    expect(p).not.toMatch(/\d Ft|\d EUR/);
  });

  it("a press conference asks for the message and the rate path", () => {
    const ev = register([{ event: "MNB-döntés", time: "14:00", followUp: true, kind: "MNB_RATE", pressTime: "15:00" }]);
    const p = buildEventPrompt({ slot: ev.slots[1], now: at(14, 15, 50), exposure });
    expect(p).toContain("sajtótájékoztatója 2026-10-14 (szerda) 15:00");
    expect(p).toContain("kamatpálya");
  });
});

describe("results and the message", () => {
  const slot = register([cpi]).slots[0];
  const answer = validateEventAnswer({
    released: true,
    items: [
      {
        event: "US <CPI>",
        actual: "3,2% & több",
        expected: "3,0%",
        surprise: "above",
        reaction: "Erősödő dollár.",
        outlook: "Kevesebb vágás.",
        impact: "down",
        affects: ["EUR/HUF"],
        sources: [{ title: "Reuters", url: "https://example.com/a?b=1&c=2" }],
      },
      { event: "Másik", actual: "x", expected: "", surprise: "unknown", reaction: "", outlook: "", impact: "neutral", affects: [], sources: [] },
    ],
  });
  if (!answer.released) throw new Error("fixture");
  const results = toResults(slot, answer, { engine: "claude-code", model: "opus", at: NOW, costUsd: 0.5, latencyMin: 6 });

  it("one result per item, keyed by the slot; the cost is counted once", () => {
    expect(results.map((r) => r.key)).toEqual(["release|2026-10-14|14:30#0", "release|2026-10-14|14:30#1"]);
    expect(results[0]).toMatchObject({ phase: "release", kind: "US_CPI", latencyMin: 6, costUsd: 0.5, engine: "claude-code" });
    expect(results[1].costUsd).toBeUndefined();
  });

  it("the Telegram text: fact vs expectation, the surprise, reaction, outlook, sources — escaped", () => {
    const html = eventText(results);
    expect(html).toContain("📊 <b>US &lt;CPI&gt; (14:30)</b>");
    expect(html).toContain("Tény: <b>3,2% &amp; több</b> · Várakozás: 3,0% 📈 <i>a várakozás felett</i>");
    expect(html).toContain("Piaci reakció: Erősödő dollár.");
    expect(html).toContain('<b>Mi várható:</b> Kevesebb vágás. (<a href="https://example.com/a?b=1&amp;c=2">Reuters</a>)');
    expect(html).toContain("📊 <b>Másik (14:30)</b>");
    expect(html).not.toContain("Piaci reakció: \n");
  });

  it("a press conference reads as a statement, not a number", () => {
    const press = { ...results[0], phase: "press" as const, time: "15:00", event: "MNB-döntés", actual: "Kivárás." };
    const html = eventText([press]);
    expect(html).toContain("🎙 <b>MNB-döntés: sajtótájékoztató (15:00)</b>");
    expect(html).toContain("Kivárás.");
    expect(html).toContain("Reakció: Erősödő dollár.");
    expect(html).not.toContain("Tény:");
  });
});

describe("what the user sees", () => {
  const ev = register([
    cpi,
    { event: "MNB-döntés", time: "14:00", followUp: true, kind: "MNB_RATE", pressTime: "15:00" },
  ]);

  it("the morning line: today's announcements, the press conference with its decision", () => {
    expect(watchLine(ev, "2026-10-14")).toBe("MNB-döntés 14:00 (+ sajtótáj. 15:00), US CPI 14:30");
    expect(watchLine(ev, "2026-10-15")).toBeUndefined();
    expect(watchLine(undefined, "2026-10-14")).toBeUndefined();
  });

  it("the subscriptions: states, and when the search starts at the latest", () => {
    const s = patchSlot(ev, "release|2026-10-14|14:00", (x) => ({ ...x, status: "due" }));
    const subs = subscriptionsOf(s);
    const mnb = subs.find((x) => x.key === "release|2026-10-14|14:00")!;
    const cpiSub = subs.find((x) => x.key === "release|2026-10-14|14:30")!;
    expect(mnb.status).toBe("searching");
    expect(mnb.expectedRunAt).toBeUndefined();
    expect(cpiSub).toMatchObject({ status: "waiting", expectedRunAt: new Date(at(14, 14, 30).getTime() + FALLBACK_DELAY_MIN * MIN).toISOString() });
    expect(subscriptionsOf(patchSlot(s, cpiSub.key, (x) => ({ ...x, status: "done" })))[1].expectedRunAt).toBeUndefined();
  });

  it("the learned delays", () => {
    expect(latencyOf({ ...ev, latency: { US_CPI: [5, 6, 7], HU_CPI: [3] } })).toEqual({
      US_CPI: { samples: 3, delayMin: 10 },
      HU_CPI: { samples: 1 },
    });
  });

  it("/bejelentesek lists the slots by day, with state and the learned delays", () => {
    const html = followUpsText({ ...ev, latency: { US_CPI: [5, 6, 7] } }, NOW, (d) => `[${d}]`);
    expect(html).toContain("🔔 <b>Figyelt bejelentések</b>");
    expect(html).toContain("<b>[2026-10-14]</b>");
    expect(html).toContain("• 14:30 US CPI — vár a bejelentésre, legkésőbb ");
    expect(html).toContain("• 15:00 🎙 MNB-döntés — vár a bejelentésre");
    expect(html).toContain("US_CPI: ~10 perc (3 mérés)");
  });

  it("/bejelentesek with nothing followed says so", () => {
    expect(followUpsText(undefined, NOW)).toContain("Nincs figyelt bejelentés");
    expect(followUpsText(emptyEvents(), NOW)).toContain("Nincs figyelt bejelentés");
  });
});

describe("publishEvents (news/events.json)", () => {
  const ev = register([cpi]);

  it("writes the subscriptions and the learned delays, keeping the earlier results", async () => {
    const store = memoryStore({ [NEWS_EVENTS_PATH]: JSON.stringify(fixtureEventsFile()) });
    const sig = await publishEvents(store, { ...ev, latency: { US_CPI: [5, 6, 7] } });
    const file = validateEventsFile(JSON.parse(store.files[NEWS_EVENTS_PATH]));
    expect(file.results).toEqual(fixtureEventsFile().results);
    expect(file.subscriptions.map((s) => s.key)).toEqual(["release|2026-10-14|14:30"]);
    expect(file.latency).toEqual({ US_CPI: { samples: 3, delayMin: 10 } });
    expect(sig).toBe(publishSignature({ ...ev, latency: { US_CPI: [5, 6, 7] } }));
  });

  it("adds the new results", async () => {
    const store = memoryStore();
    const slot = ev.slots[0];
    const answer = validateEventAnswer({
      released: true,
      items: [{ event: "US CPI", actual: "3,2%", expected: "", surprise: "inline", reaction: "", outlook: "", impact: "neutral", affects: [], sources: [] }],
    });
    if (!answer.released) throw new Error("fixture");
    await publishEvents(store, ev, toResults(slot, answer, { engine: "e", model: "m", at: NOW }));
    expect(validateEventsFile(JSON.parse(store.files[NEWS_EVENTS_PATH])).results[0]).toMatchObject({ event: "US CPI", actual: "3,2%" });
  });

  it("a damaged file isn't overwritten: the publish fails and the file stays as it is", async () => {
    const store = memoryStore({ [NEWS_EVENTS_PATH]: "{nem json" });
    await expect(publishEvents(store, ev)).rejects.toThrow();
    expect(store.files[NEWS_EVENTS_PATH]).toBe("{nem json");
  });

  it("the signature changes with the state of a slot, not with the retry bookkeeping", () => {
    const a = publishSignature(ev);
    const watching = patchSlot(ev, ev.slots[0].key, (s) => ({ ...s, status: "watching" }));
    expect(publishSignature(watching)).not.toBe(a);
    const retried = patchSlot(watching, ev.slots[0].key, (s) => ({ ...s, dueAt: NOW.toISOString(), takenAt: NOW.toISOString() }));
    expect(publishSignature(retried)).toBe(publishSignature(watching));
  });
});

describe("a slot walked through (state in, state out)", () => {
  it("registered → watching → covered → due → taken → retried when not out → done", () => {
    let ev: EventsState = register([cpi]);
    const key = ev.slots[0].key;
    const step = (s: EventsState, now: Date, probe?: { count: number; earliest: string }) =>
      advanceSlots(s, now, probe ? { [key]: probe } : {}).ev;
    const slot = (s: EventsState): EventSlot => s.slots[0];

    ev = step(ev, at(14, 14, 35));
    expect(slot(ev).status).toBe("watching");
    ev = step(ev, at(14, 14, 40), { count: 4, earliest: at(14, 14, 34).toISOString() });
    expect(slot(ev)).toMatchObject({ status: "due", firstSeenAt: at(14, 14, 34).toISOString() });
    expect(ev.latency).toEqual({});
    expect(nextDue(ev, at(14, 14, 40))?.key).toBe(key);

    // the job takes it, the result isn't out → due again after the retry gap
    ev = patchSlot(ev, key, (s) => ({ ...s, status: "searching", takenAt: at(14, 14, 41).toISOString(), tries: 1 }));
    expect(nextDue(ev, at(14, 14, 41))).toBeUndefined();
    ev = patchSlot(ev, key, (s) => ({ ...s, status: "due", takenAt: undefined, dueAt: new Date(at(14, 14, 41).getTime() + RETRY_MIN * MIN).toISOString() }));
    expect(nextDue(ev, at(14, 14, 50))).toBeUndefined();
    expect(nextDue(ev, at(14, 14, 56))?.key).toBe(key);
    // a later tick keeps it due, not watching again
    expect(slot(step(ev, at(14, 14, 56))).status).toBe("due");
  });
});
