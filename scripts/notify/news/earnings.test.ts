import { describe, expect, it } from "vitest";
import {
  emptyEventsFile,
  validateDigestBody,
  validateEventsFile,
  type NewsUpcoming,
} from "../../../src/lib/newsSchema";
import { fixtureDigest } from "../../../src/test/newsFixture";
import {
  APPROX_DEADLINE_MIN,
  APPROX_GIVE_UP_MIN,
  GIVE_UP_MIN,
  advanceSlots,
  buildEventPrompt,
  deadline,
  eventText,
  followUpsText,
  recordLatency,
  registerFollowUps,
  sessionTime,
  slotStart,
  slotsToProbe,
  subscriptionsOf,
  toResults,
  watchLine,
} from "./events";
import { coverageUrl, earningsQuery } from "./rss";

// Earnings have no exact time, only a session (before the open / after the
// close): they are followed from the session's start, and the news decide.

const MIN = 60_000;
const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min);
const NOW = at(21, 7, 45);

const digestWith = (upcoming: Partial<NewsUpcoming>[]) => ({
  ...fixtureDigest("2026-10-21", "morning"),
  upcoming: upcoming.map((u) => ({ date: "2026-10-21", event: "Esemény", why: "Mert.", ...u }) as NewsUpcoming),
});
const register = (upcoming: Partial<NewsUpcoming>[], ev = registerFollowUps(undefined, digestWith([]), NOW), now = NOW) =>
  registerFollowUps(ev, digestWith(upcoming), now);

const tesla = { event: "Tesla gyorsjelentés", followUp: true, kind: "EARNINGS" as const, session: "post" as const };
const meta = { ...tesla, event: "Meta gyorsjelentés" };
const netflix = { ...tesla, event: "Netflix gyorsjelentés", session: "pre" as const };

describe("sessionTime", () => {
  it("is the New York open/close in Budapest time, across the clock changes", () => {
    expect(sessionTime("2026-10-21", "post")).toBe("22:00");
    expect(sessionTime("2026-10-21", "pre")).toBe("12:00");
    // Budapest is on winter time from 25 October, New York only from 1 November.
    expect(sessionTime("2026-10-28", "post")).toBe("21:00");
    expect(sessionTime("2026-11-04", "post")).toBe("22:00");
  });
});

describe("validateDigestBody: session", () => {
  const body = (u: Record<string, unknown>) => {
    const d = fixtureDigest("2026-10-21", "morning");
    return validateDigestBody({ headline: d.headline, items: d.items, upcoming: [{ date: "2026-10-21", event: "X", why: "Y", ...u }] })
      .upcoming[0];
  };
  it("is kept without an exact time, dropped with one or when unknown", () => {
    expect(body({ time: null, session: "post" }).session).toBe("post");
    expect(body({ time: "22:05", session: "post" })).toMatchObject({ time: "22:05" });
    expect(body({ time: "22:05", session: "post" }).session).toBeUndefined();
    expect(body({ time: null, session: "este" }).session).toBeUndefined();
  });
});

describe("registerFollowUps: earnings by session", () => {
  it("earnings with only a session get one approximate slot from the close", () => {
    const ev = register([tesla, meta]);
    expect(ev.slots).toHaveLength(1);
    expect(ev.slots[0]).toMatchObject({
      key: "release|2026-10-21|22:00",
      time: "22:00",
      session: "post",
      kind: "EARNINGS",
      startsAt: at(21, 22).toISOString(),
      events: [{ event: "Tesla gyorsjelentés" }, { event: "Meta gyorsjelentés" }],
    });
  });

  it("no time and no session: still nothing to follow", () => {
    expect(register([{ ...tesla, session: undefined }]).slots).toHaveLength(0);
  });

  it("other companies' earnings the same day are not taken for the same announcement", () => {
    const ev = register([netflix]);
    expect(register([tesla], ev).slots.map((s) => `${s.time} ${s.events[0].event}`)).toEqual([
      "12:00 Netflix gyorsjelentés",
      "22:00 Tesla gyorsjelentés",
    ]);
  });

  it("is registered while its longer window is open", () => {
    expect(register([tesla], undefined, at(21, 22 + 4)).slots).toHaveLength(1);
  });
});

describe("an approximate slot waits for the news", () => {
  const ev = register([tesla, meta]);
  const slot = ev.slots[0];
  const t0 = slotStart(slot.date, slot.time).getTime();

  it("has no early deadline: the learned delay of other kinds doesn't apply", () => {
    expect(deadline(ev, slot).getTime()).toBe(t0 + APPROX_DEADLINE_MIN * MIN);
    const watched = advanceSlots(ev, new Date(t0 + 60 * MIN));
    expect(watched.becameDue).toEqual([]);
    expect(watched.ev.slots[0].status).toBe("watching");
  });

  it("the news start the search", () => {
    const r = advanceSlots(ev, new Date(t0 + 20 * MIN), { [slot.key]: { count: 3, earliest: new Date(t0 + 7 * MIN).toISOString() } });
    expect(r.becameDue).toEqual([slot.key]);
  });

  it("is probed and kept longer than an exact one", () => {
    const late = new Date(t0 + (GIVE_UP_MIN + 30) * MIN);
    expect(slotsToProbe(ev, late)).toHaveLength(1);
    expect(advanceSlots(ev, late).ev.slots[0].status).not.toBe("expired");
    expect(advanceSlots(ev, new Date(t0 + APPROX_GIVE_UP_MIN * MIN)).ev.slots[0].status).toBe("expired");
  });

  it("gives no latency sample", () => {
    expect(recordLatency(ev, { ...slot, firstSeenAt: new Date(t0 + 7 * MIN).toISOString() }, new Date(t0 + 30 * MIN)).latency).toEqual({});
  });
});

describe("how an approximate slot is shown", () => {
  const ev = register([tesla, meta]);
  const slot = ev.slots[0];

  it("says the session, not a made-up minute", () => {
    expect(watchLine(ev, "2026-10-21")).toBe("Tesla gyorsjelentés +1 zárás után (~22:00)");
    expect(followUpsText(ev, NOW)).toContain("• zárás után (~22:00) Tesla gyorsjelentés +1");
  });

  it("the search prompt asks for the earnings after the close", () => {
    const p = buildEventPrompt({ slot, now: at(21, 22, 30), exposure: [] });
    expect(p).toContain("az amerikai tőzsde zárása után (nagyjából 22:00-tól");
    expect(p).toContain("EPS");
  });

  it("the session goes into the file and the message", () => {
    const [sub] = subscriptionsOf(ev);
    expect(sub.session).toBe("post");
    const results = toResults(
      slot,
      {
        released: true,
        items: [{ event: "Tesla gyorsjelentés", actual: "EPS 0,50 USD", expected: "", surprise: "unknown", reaction: "", outlook: "", impact: "neutral", affects: [], sources: [] }],
      },
      { engine: "x", model: "y", at: at(21, 23) },
    );
    expect(results[0].session).toBe("post");
    expect(eventText(results)).toContain("Tesla gyorsjelentés (zárás után)");
    const file = validateEventsFile(JSON.parse(JSON.stringify({ ...emptyEventsFile(), results, subscriptions: [sub] })));
    expect(file.results[0].session).toBe("post");
    expect(file.subscriptions[0].session).toBe("post");
  });
});

describe("earnings news search", () => {
  it("searches the company in English", () => {
    expect(earningsQuery("Tesla gyorsjelentés")).toBe("Tesla earnings");
    expect(earningsQuery("Meta harmadik negyedéves gyorsjelentése (Q3)")).toBe("Meta earnings");
    expect(earningsQuery("Microsoft Q3-as jelentés")).toBe("Microsoft earnings");
    const url = coverageUrl("EARNINGS", "Tesla gyorsjelentés");
    expect(decodeURIComponent(url)).toContain("q=Tesla earnings when:1d");
    expect(url).toContain("hl=en-US");
  });
});
