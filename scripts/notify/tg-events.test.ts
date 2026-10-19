import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateEventsFile, type NewsUpcoming } from "../../src/lib/newsSchema";
import type { NotifySettings } from "../../src/lib/planPrefs";
import type { PortfolioSnapshot } from "../../src/lib/sync";
import { fixtureNewsBody } from "../../src/test/newsFixture";
import { ROOT } from "./env";
import { contextAt } from "./testContext";
import { runHandler, type Deps, type HubResponse } from "./tg-app";
import { MAX_SEARCH_TRIES, PRESS_DELAY_MIN, RETRY_MIN } from "./news/events";
import { fakeEngine, memoryStore } from "./news/testFakes";
import type { Coverage } from "./news/rss";
import type { EventsState } from "./state";

// The announcement follow-up at the protocol level: the morning digest lists
// the announcements → the tick watches the news → the news-event job searches
// the result → Telegram + news/events.json. Invented portfolio, no network.

let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-events-"));
  stateFile = join(dir, "state.json");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };
const base = { v: 1, id: "r1", app: "portfolio", now: "" };
const jobReq = (job: string) =>
  JSON.stringify({ ...base, type: "job", job, scheduledFor: null, catchUp: false, manual: false, lastSuccessAt: null });
const commandReq = (command: string) =>
  JSON.stringify({ ...base, type: "command", command, args: "", argv: [], chat: { id: 1 }, message: { id: 1, date: "" } });
const call = async (input: string, deps: Deps): Promise<HubResponse> =>
  JSON.parse(await runHandler(input, deps)) as HubResponse;
const readState = () => JSON.parse(readFileSync(stateFile, "utf8")) as { events?: EventsState } & Record<string, unknown>;
const slots = () => readState().events?.slots ?? [];

const withNotify = (ai: Partial<NotifySettings["ai"]>) => (s: PortfolioSnapshot) => {
  s.prefs = { ...s.prefs, notify: { updatedAt: "2026-10-01T08:00:00.000Z", value: { ai } as NotifySettings } };
};

const CPI: NewsUpcoming = {
  date: "2026-10-14",
  event: "US CPI",
  why: "Az inflációs adat a kamatvárakozásokat mozgatja.",
  time: "14:30",
  followUp: true,
  kind: "US_CPI",
  expected: "3,0% é/é",
};
const released = {
  released: true,
  items: [
    {
      event: "US CPI",
      actual: "3,2% é/é",
      expected: "3,0% é/é",
      surprise: "above",
      reaction: "Erősödő dollár, emelkedő hozamok.",
      outlook: "Kisebb a kamatvágás esélye.",
      impact: "mixed",
      affects: ["EUR/HUF"],
      sources: [{ title: "Reuters", url: "https://example.com/cpi" }],
    },
  ],
};
const notReleased = { released: false, items: [] };

function setup(opts: { upcoming?: NewsUpcoming[]; answers?: unknown[]; ai?: Partial<NotifySettings["ai"]> } = {}) {
  let clock: [number, number, number, number, number] = [2026, 10, 14, 7, 45];
  const store = memoryStore();
  const news = fakeEngine([{ ...fixtureNewsBody(), upcoming: opts.upcoming ?? [CPI] }]);
  const events = fakeEngine(opts.answers ?? []);
  const started: string[] = [];
  const probed: string[] = [];
  const searched: string[] = [];
  let coverage: Coverage | null = { count: 0, earliest: "" };
  const deps: Deps = {
    load: async () => contextAt(clock, withNotify({ newsMorning: "notify", newsEvening: "notify", ...opts.ai })),
    stateFile,
    env,
    news: () => ({ engine: news, store, cacheDir: join(dir, "news"), appUrl: "https://example.com/app/" }),
    events: () => events,
    probe: async (kind, text) => {
      probed.push(kind);
      searched.push(text);
      return coverage;
    },
    runJob: async (job) => {
      started.push(job);
      return "started";
    },
  };
  /** Moves the clock (the code reads Date) and the portfolio's context with it. */
  const at = (h: number, mi = 0, d = 14) => {
    clock = [2026, 10, d, h, mi];
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, d, h, mi) });
  };
  const eventsFile = () => validateEventsFile(JSON.parse(store.files["news/events.json"]));
  return {
    deps,
    store,
    events,
    started,
    probed,
    searched,
    at,
    eventsFile,
    setCoverage: (c: Coverage | null) => (coverage = c),
    morning: async () => {
      at(7, 45);
      return call(jobReq("news-morning"), deps);
    },
    tick: () => call(jobReq("tick"), deps),
    job: () => call(jobReq("news-event"), deps),
  };
}

const cov = (min: number): Coverage => ({ count: 3, earliest: new Date(2026, 9, 14, 14, 30 + min).toISOString() });

describe("registering from the digest", () => {
  it("the morning digest registers the announcement, says so, and publishes the subscription", async () => {
    const s = setup();
    const r = await s.morning();
    expect(r.messages![0].html).toContain("🔔 Ma figyelem: US CPI 14:30");
    expect(slots()).toMatchObject([{ key: "release|2026-10-14|14:30", status: "waiting", kind: "US_CPI" }]);
    expect(s.eventsFile().subscriptions).toMatchObject([
      { key: "release|2026-10-14|14:30", status: "waiting", events: [{ event: "US CPI", expected: "3,0% é/é" }] },
    ]);
  });

  it("the evening digest registers too, but the 'Ma figyelem' line is the morning's", async () => {
    const s = setup({ upcoming: [{ ...CPI, date: "2026-10-15" }] });
    s.at(18, 15);
    const r = await call(jobReq("news-evening"), s.deps);
    expect(r.messages![0].html).not.toContain("Ma figyelem");
    expect(slots()).toHaveLength(1);
  });

  it("no follow-up marks → nothing registered, no line, no file", async () => {
    const s = setup({ upcoming: [{ ...CPI, followUp: false }, { ...CPI, time: undefined }] });
    const r = await s.morning();
    expect(r.messages![0].html).not.toContain("Ma figyelem");
    expect(readState().events).toBeUndefined();
    expect(s.store.files["news/events.json"]).toBeUndefined();
  });

  it("switched off in the settings: nothing is registered or published", async () => {
    const s = setup({ ai: { events: "off" } });
    const r = await s.morning();
    expect(r.messages![0].html).not.toContain("Ma figyelem");
    expect(readState().events).toBeUndefined();
    expect(s.store.writes).not.toContain("news/events.json");
  });

  it("a failed upload of the file doesn't fail the digest", async () => {
    const s = setup();
    const write = s.store.write;
    s.store.write = async (p, t, m) => {
      if (p === "news/events.json") throw new Error("HTTP 500");
      return write(p, t, m);
    };
    const r = await s.morning();
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(slots()).toHaveLength(1);
  });
});

describe("the tick", () => {
  it("a time from the press: approximate slot, the news searched for the digest's query", async () => {
    const budget: NewsUpcoming = {
      date: "2026-10-14",
      event: "A 2027-es költségvetés bemutatása az Országgyűlésben",
      why: "A hiánypálya a forintot mozgatja.",
      time: "13:00",
      timeApprox: true,
      followUp: true,
      kind: "OTHER",
      query: "2027-es költségvetés",
    };
    const s = setup({ upcoming: [budget] });
    const r = await s.morning();
    expect(r.messages![0].html).toMatch(/Ma figyelem: A 2027-es költségvetés.* ~13:00/);
    expect(slots()[0]).toMatchObject({ time: "13:00", approx: true });
    s.at(13, 10);
    await s.tick();
    expect(s.searched).toEqual(["2027-es költségvetés"]);
    expect(s.eventsFile().subscriptions[0]).toMatchObject({ approx: true, events: [{ event: budget.event }] });
  });

  it("does not touch the news before the announcement", async () => {
    const s = setup();
    await s.morning();
    s.at(14, 25);
    await s.tick();
    expect(s.probed).toEqual([]);
    expect(s.started).toEqual([]);
    expect(slots()[0].status).toBe("waiting");
  });

  it("after the announcement it watches the news (and says so in the file)", async () => {
    const s = setup();
    await s.morning();
    s.at(14, 35);
    await s.tick();
    expect(s.probed).toEqual(["US_CPI"]);
    expect(s.started).toEqual([]);
    expect(slots()[0].status).toBe("watching");
    expect(s.eventsFile().subscriptions[0].status).toBe("watching");
  });

  it("an unreadable news feed changes nothing", async () => {
    const s = setup();
    await s.morning();
    s.setCoverage(null);
    s.at(14, 35);
    await s.tick();
    expect(slots()[0].status).toBe("watching");
    expect(s.started).toEqual([]);
  });

  it("coverage found → the search job starts at once; the gap is no sample yet (it may be a preview)", async () => {
    const s = setup();
    await s.morning();
    s.setCoverage(cov(6));
    s.at(14, 38);
    await s.tick();
    expect(s.started).toEqual(["news-event"]);
    expect(slots()[0]).toMatchObject({ status: "due" });
    expect(readState().events!.latency).toEqual({});
    expect(s.eventsFile().subscriptions[0].status).toBe("searching");
    expect(s.eventsFile().latency).toEqual({});
  });

  it("without any coverage the fallback delay starts the search", async () => {
    const s = setup();
    await s.morning();
    s.at(15, 29);
    await s.tick();
    expect(s.started).toEqual([]);
    s.at(15, 30);
    await s.tick();
    expect(s.started).toEqual(["news-event"]);
  });

  it("switched off: the tick leaves the slots alone", async () => {
    const s = setup();
    await s.morning();
    s.deps.load = async () => contextAt([2026, 10, 14, 14, 40], withNotify({ events: "off" }));
    s.setCoverage(cov(4));
    s.at(14, 40);
    await s.tick();
    expect(s.probed).toEqual([]);
    expect(s.started).toEqual([]);
  });

  it("keeps the follow-up state a job wrote while the tick was computing", async () => {
    const s = setup();
    await s.morning();
    s.at(14, 35);
    const seed = readState();
    const fresh = { ...seed.events!, slots: seed.events!.slots.map((x) => ({ ...x, status: "done" as const })) };
    s.deps.load = async () => {
      const ctx = contextAt([2026, 10, 14, 14, 35]);
      const glide = ctx.glide;
      let wrote = false;
      Object.defineProperty(ctx, "glide", {
        get() {
          if (!wrote) {
            wrote = true;
            writeFileSync(stateFile, JSON.stringify({ ...readState(), events: fresh }));
          }
          return glide;
        },
      });
      return ctx;
    };
    await s.tick();
    expect(slots()[0].status).toBe("done");
  });
});

describe("the news-event job", () => {
  const ready = async (answers: unknown[], ai?: Partial<NotifySettings["ai"]>) => {
    const s = setup({ answers, ai });
    await s.morning();
    s.setCoverage(cov(5));
    s.at(14, 36);
    await s.tick();
    return s;
  };

  it("the result: fact vs expectation, reaction, outlook → one message, the file, the slot done", async () => {
    const s = await ready([released]);
    s.at(14, 37);
    const r = await s.job();
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].priority).toBe("normal");
    const html = r.messages![0].html;
    expect(html).toContain("📊 <b>US CPI (14:30)</b>");
    expect(html).toContain("Tény: <b>3,2% é/é</b> · Várakozás: 3,0% é/é 📈 <i>a várakozás felett</i>");
    expect(html).toContain("<b>Mi várható:</b> Kisebb a kamatvágás esélye.");
    expect(html).toContain('<a href="https://example.com/cpi">Reuters</a>');
    // the brief names the exposure in percent, never an amount
    expect(s.events.prompts[0]).toContain("3,0% é/é");
    expect(s.events.prompts[0]).not.toMatch(/\d Ft/);
    expect(slots()[0].status).toBe("done");
    const file = s.eventsFile();
    expect(file.results).toMatchObject([{ event: "US CPI", actual: "3,2% é/é", surprise: "above", latencyMin: 5 }]);
    expect(file.subscriptions[0].status).toBe("done");

    // once only
    s.at(14, 50);
    expect(await s.job()).toEqual({ v: 1, messages: [] });
    expect(s.events.prompts).toHaveLength(1);
  });

  it("not out yet: no message, and the same search is repeated after the retry gap", async () => {
    const s = await ready([notReleased, released]);
    s.at(14, 37);
    expect(await s.job()).toEqual({ v: 1, messages: [] });
    expect(slots()[0].status).toBe("due");
    expect(s.events.prompts).toHaveLength(1);

    s.at(14, 37 + RETRY_MIN - 1);
    expect(await s.job()).toEqual({ v: 1, messages: [] });
    expect(s.events.prompts).toHaveLength(1);

    s.at(14, 37 + RETRY_MIN);
    const r = await s.job();
    expect(r.messages).toHaveLength(1);
    expect(s.events.prompts).toHaveLength(2);
  });

  it("gives up three hours after the announcement", async () => {
    const s = await ready([notReleased]);
    s.at(14, 37);
    await s.job();
    s.at(17, 31);
    expect(await s.job()).toEqual({ v: 1, messages: [] });
    expect(slots()[0].status).toBe("expired");
    expect(s.events.prompts).toHaveLength(1);
  });

  it("an AI failure is a job error; the slot is tried again, and the recovery isn't announced early", async () => {
    const s = await ready([]);
    s.at(14, 37);
    expect(await s.job()).toMatchObject({ ok: false, error: "no more answers" });
    expect(slots()[0].status).toBe("due");
    expect(slots()[0].takenAt).toBeUndefined();
    expect(readState().events!.failing).toBe(true);

    // nothing due yet: the failure stays open (the hub doesn't announce a recovery)
    s.at(14, 40);
    expect(await s.job()).toEqual({ v: 1, messages: [], keepFailing: true });

    s.events.run = fakeEngine([released]).run;
    s.at(14, 37 + RETRY_MIN);
    expect((await s.job()).messages).toHaveLength(1);
    expect(readState().events!.failing).toBe(false);
  });

  it("silent: searched and published, but no message", async () => {
    const s = await ready([released], { events: "silent" });
    s.at(14, 37);
    expect(await s.job()).toEqual({ v: 1, messages: [] });
    expect(s.eventsFile().results).toHaveLength(1);
  });

  it("off: no search at all", async () => {
    const s = await ready([released]);
    s.deps.load = async () => contextAt([2026, 10, 14, 14, 37], withNotify({ events: "off" }));
    s.at(14, 37);
    expect(await s.job()).toEqual({ v: 1, messages: [] });
    expect(s.events.prompts).toHaveLength(0);
  });

  it("a failed upload keeps the result and sends it with the next change", async () => {
    const s = await ready([released]);
    const write = s.store.write;
    s.store.write = async () => {
      throw new Error("HTTP 502");
    };
    s.at(14, 37);
    const r = await s.job();
    expect(r.messages).toHaveLength(1);
    expect(readState().events!.pending).toHaveLength(1);
    expect(s.eventsFile().results).toHaveLength(0);

    s.store.write = write;
    s.at(14, 45);
    await s.tick();
    expect(s.eventsFile().results).toHaveLength(1);
    expect(readState().events!.pending).toEqual([]);
  });

  it("two announcements at one time are searched together, one message", async () => {
    const two = { ...released, items: [released.items[0], { ...released.items[0], event: "Heti munkanélküli", actual: "230 ezer" }] };
    const s = setup({ upcoming: [CPI, { ...CPI, event: "Heti munkanélküli", expected: undefined }], answers: [two] });
    await s.morning();
    expect(slots()).toHaveLength(1);
    s.setCoverage(cov(5));
    s.at(14, 36);
    await s.tick();
    s.at(14, 37);
    const r = await s.job();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].html).toContain("Heti munkanélküli");
    expect(s.eventsFile().results).toHaveLength(2);
  });
});

describe("fixes of the code review", () => {
  const ready = async (answers: unknown[], upcoming?: NewsUpcoming[]) => {
    const s = setup({ answers, upcoming });
    await s.morning();
    s.setCoverage(cov(5));
    s.at(14, 36);
    await s.tick();
    return s;
  };

  it("the delay is learned from a release that was really out, not from a search that found nothing", async () => {
    const s = await ready([notReleased, released]);
    s.at(14, 37);
    await s.job();
    expect(readState().events!.latency).toEqual({});
    s.at(14, 37 + RETRY_MIN);
    await s.job();
    // counted from the first article (14:35), not from the failed search
    expect(readState().events!.latency).toEqual({ US_CPI: [5] });
    expect(s.eventsFile().latency).toEqual({ US_CPI: { samples: 1 } });
  });

  it("without coverage seen, the successful search is the (upper bound) sample", async () => {
    const s = setup({ answers: [released] });
    await s.morning();
    s.at(15, 30);
    await s.tick();
    s.at(15, 31);
    await s.job();
    expect(readState().events!.latency).toEqual({ US_CPI: [61] });
  });

  it("a release that never comes out is given up after a few tries, not every 15 minutes for hours", async () => {
    const s = await ready(Array.from({ length: 12 }, () => notReleased));
    for (let i = 0; i < 12; i++) {
      s.at(14, 37 + i * RETRY_MIN);
      await s.job();
    }
    expect(s.events.prompts).toHaveLength(MAX_SEARCH_TRIES);
    expect(slots()[0].status).toBe("expired");
    expect(s.eventsFile().subscriptions[0].status).toBe("expired");
  });

  it("a group where only one release is out: that one is sent, the rest is left out", async () => {
    const two = { released: true, items: [released.items[0], { ...released.items[0], event: "Core CPI", actual: "" }] };
    const s = setup({ upcoming: [CPI, { ...CPI, event: "Core CPI" }], answers: [two] });
    await s.morning();
    s.setCoverage(cov(5));
    s.at(14, 36);
    await s.tick();
    s.at(14, 37);
    const r = await s.job();
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].html).not.toContain("Core CPI");
    expect(s.eventsFile().results).toHaveLength(1);
  });

  it("every event of a slot is watched, in parallel: coverage of the second one is enough", async () => {
    const s = setup({ upcoming: [CPI, { ...CPI, event: "Core CPI" }] });
    await s.morning();
    let running = 0;
    let peak = 0;
    const asked: string[] = [];
    s.deps.probe = async (_kind, event) => {
      asked.push(event);
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return event === "Core CPI" ? cov(4) : { count: 0, earliest: "" };
    };
    s.at(14, 36);
    await s.tick();
    expect(asked.sort()).toEqual(["Core CPI", "US CPI"]);
    expect(peak).toBe(2);
    expect(s.started).toEqual(["news-event"]);
  });

  it("an events.json from a newer version isn't overwritten: the result is kept and sent", async () => {
    const s = await ready([released]);
    const newer = JSON.stringify({ version: 2, results: [] });
    s.store.files["news/events.json"] = newer;
    s.at(14, 37);
    const r = await s.job();
    expect(r.messages).toHaveLength(1);
    expect(s.store.files["news/events.json"]).toBe(newer);
    expect(readState().events!.pending).toHaveLength(1);
  });
});

describe("a rate decision: the decision, then the press conference", () => {
  const MNB: NewsUpcoming = {
    date: "2026-10-14",
    event: "MNB kamatdöntés",
    why: "A forintot mozgatja.",
    time: "14:00",
    followUp: true,
    kind: "MNB_RATE",
    pressTime: "15:00",
  };
  const decision = { released: true, items: [{ ...released.items[0], event: "MNB kamatdöntés", actual: "Az alapkamat 6,50% marad." }] };
  const press = { released: true, items: [{ ...released.items[0], event: "MNB kamatdöntés", actual: "A jegybank kivárást jelzett." }] };

  it("two messages: the decision once the news cover it, the press conference after its own delay", async () => {
    const s = setup({ upcoming: [MNB], answers: [decision, press] });
    await s.morning();
    expect(slots().map((x) => x.phase)).toEqual(["release", "press"]);
    expect(
      (await call(commandReq("bejelentesek"), s.deps)).messages![0].html,
    ).toContain("🎙 MNB kamatdöntés");

    s.setCoverage({ count: 2, earliest: new Date(2026, 9, 14, 14, 3).toISOString() });
    s.at(14, 5);
    await s.tick();
    s.at(14, 6);
    const first = await s.job();
    expect(first.messages![0].html).toContain("Az alapkamat 6,50% marad.");

    s.at(15, PRESS_DELAY_MIN - 1);
    await s.tick();
    expect(s.started).toEqual(["news-event"]);
    s.at(15, PRESS_DELAY_MIN);
    await s.tick();
    expect(s.started).toEqual(["news-event", "news-event"]);
    s.at(15, PRESS_DELAY_MIN + 1);
    const second = await s.job();
    expect(second.messages![0].html).toContain("🎙 <b>MNB kamatdöntés: sajtótájékoztató (15:00)</b>");
    expect(second.messages![0].html).toContain("A jegybank kivárást jelzett.");
    expect(s.eventsFile().results.map((r) => r.phase).sort()).toEqual(["press", "release"]);
  });
});

describe("/bejelentesek", () => {
  it("nothing followed yet", async () => {
    const s = setup();
    const r = await call(commandReq("bejelentesek"), s.deps);
    expect(r.messages![0].html).toContain("Nincs figyelt bejelentés");
  });

  it("lists the slots with their state", async () => {
    const s = setup();
    await s.morning();
    s.at(14, 35);
    await s.tick();
    const html = (await call(commandReq("bejelentesek"), s.deps)).messages![0].html;
    expect(html).toContain("• 14:30 US CPI — híreket figyel, legkésőbb 15:30");
  });
});

describe("tg-hub.app.json", () => {
  const app = JSON.parse(readFileSync(resolve(ROOT, "tg-hub.app.json"), "utf8")) as {
    commands: { name: string }[];
    jobs: { id: string; every?: string; timeout?: string }[];
  };

  it("has the news-event job (a retry and catch-up every 15 minutes) and the command", () => {
    expect(app.jobs.find((j) => j.id === "news-event")).toMatchObject({ every: "15m", timeout: "25m" });
    expect(app.commands.map((c) => c.name)).toContain("bejelentesek");
  });
});
