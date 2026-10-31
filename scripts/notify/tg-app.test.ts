import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Alert } from "../../src/lib/alerts";
import type { PortfolioSnapshot } from "../../src/lib/sync";
import type { Context } from "./data";
import { withTimeout } from "./data";
import { ROOT, parseMoveOverrides, parseWhySubjects } from "./env";
import { contextAt } from "./testContext";
import { alertMessages, runHandler, searchEdition, type Deps, type HubResponse } from "./tg-app";
import { fakeEngine, memoryStore } from "./news/testFakes";
import { hubError } from "./hubError.fixture";
import { fixtureNewsBody } from "../../src/test/newsFixture";
import { VWCE, WBIT } from "../../src/test/fixture";
import { article } from "./news/why";
import type { WhyState } from "./state";
import type { MoveAlertSettings, NotifySettings } from "../../src/lib/planPrefs";

// The tg-hub handler at the protocol level: a request JSON in, a response
// JSON out, on the invented portfolio (src/test/fixture.ts), no network.

let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-app-"));
  stateFile = join(dir, "state.json");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };
const depsFor = (ctx: () => Context): Deps => ({ load: async () => ctx(), stateFile, env });
const failing = (message: string): Deps => ({
  load: async () => {
    throw new Error(message);
  },
  stateFile,
  env,
});

const base = { v: 1, id: "r1", app: "portfolio", now: "" };
const commandReq = (command: string, args = "") =>
  JSON.stringify({ ...base, type: "command", command, args, argv: args.split(" ").filter(Boolean), chat: { id: 1 }, message: { id: 1, date: "" } });
const textReq = (text: string, context: string | null) =>
  JSON.stringify({ ...base, type: "text", text, context, chat: { id: 1 }, message: { id: 2, date: "" } });
const jobReq = (job = "tick") =>
  JSON.stringify({ ...base, type: "job", job, scheduledFor: null, catchUp: false, manual: false, lastSuccessAt: null });

const call = async (input: string, deps: Deps): Promise<HubResponse> => {
  const out = await runHandler(input, deps);
  return JSON.parse(out) as HubResponse;
};
const readState = () => JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;

// A Wednesday morning in October (no weekly / month-end event).
const WED: [number, number, number, number] = [2026, 10, 14, 10];

describe("commands", () => {
  it("/allas → one HTML message", async () => {
    const r = await call(commandReq("allas"), depsFor(() => contextAt(WED)));
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].html).toContain("Ft");
  });

  it("/esemenyek [napok] → the horizon follows the optional argument (default 30, bad values fall back)", async () => {
    const days = async (args: string) => {
      const r = await call(commandReq("esemenyek", args), depsFor(() => contextAt(WED)));
      return /következő (\d+) nap/.exec(r.messages![0].html ?? "")?.[1] ?? "none";
    };
    expect(await days("")).toBe("30");
    expect(await days("365")).toBe("365");
    expect(await days("0")).toBe("30");
    expect(await days("99999")).toBe("30");
    expect(await days("abc")).toBe("30");
  });

  it.each([
    ["terv", "Havi terv – 2026. október"],
    ["palya", "Célpálya – 2026. okt. 14."],
    ["hozam", "Pénzsúlyozott (XIRR)"],
    ["tbsz", "Lightyear TBSZ 2025"],
  ])("/%s → one HTML message", async (command, head) => {
    const r = await call(commandReq(command), depsFor(() => contextAt(WED)));
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].html).toContain(head);
  });

  it("/palya lists the band rule's steps for a bucket out of its band", async () => {
    // A 2 pp band: equity (54% vs 58%) falls below, bonds (41% vs 37%) above.
    const narrow = (s: PortfolioSnapshot) => {
      for (const b of s.prefs!.glidePath!.value[0].buckets)
        if (b.id !== "crypto") b.band = { kind: "abs", pp: 0.02 };
    };
    const r = await call(commandReq("palya"), depsFor(() => contextAt(WED, narrow)));
    const html = r.messages![0].html;
    expect(html).toContain("⬇️ Részvény");
    expect(html).toContain("⬆️ Kötvény");
    expect(html).toContain("Sávon kívül – javasolt lépések");
    expect(html).toMatch(/→ Vétel: VWCE/);
    expect(html).not.toContain("Minden csoport a sávon belül");
  });

  it("/tbsz: milestone dates are the local 31 December in every time zone", async () => {
    // The milestones are stored as ISO instants of local 23:59:59 — in New
    // York that is already 1 January in UTC.
    const html = (await call(commandReq("tbsz"), depsFor(() => contextAt(WED)))).messages![0].html;
    expect(html).toContain("Következő: 3 éves lekötés – 2028. dec. 31.");
    expect(html).toContain("2030. dec. 31. után");
    expect(html).not.toContain("jan. 1.");
  });

  it("/terv and /palya without a glide path or goals say so", async () => {
    const bare = (s: PortfolioSnapshot) => {
      s.prefs = {};
      s.goals = [];
    };
    const deps = depsFor(() => contextAt(WED, bare));
    expect((await call(commandReq("palya"), deps)).messages![0].html).toContain("Még nincs beállított célpálya");
    expect((await call(commandReq("terv"), deps)).messages![0].html).toContain("nincs mit tervezni");
  });

  it("an unknown command is a handled error", async () => {
    const r = await call(commandReq("nincsilyen"), depsFor(() => contextAt(WED)));
    expect(r).toMatchObject({ ok: false, error: "Ismeretlen parancs: /nincsilyen" });
  });

  it("/maradek 50000 → the split, and the amount is remembered for the month", async () => {
    const r = await call(commandReq("maradek", "50000"), depsFor(() => contextAt(WED)));
    expect(r.ok).toBeUndefined();
    expect(r.expectText).toBeUndefined();
    expect(r.messages![0].html).toContain("🐷");
    expect(readState().leftover).toEqual({ answered: { "2026-10": 50_000 } });
  });

  it("/maradek without an amount asks, and takes the next message as the amount", async () => {
    const deps = depsFor(() => contextAt(WED));
    const ask = await call(commandReq("maradek"), deps);
    expect(ask.expectText).toEqual({ context: "maradek", ttl: "10m" });
    expect(ask.messages![0].html).toContain("elég csak az összeget");
    expect(existsSync(stateFile)).toBe(false);

    const answer = await call(textReq("50e", "maradek"), deps);
    expect(answer.expectText).toBeUndefined();
    expect(answer.messages![0].html).toBe(
      (await call(commandReq("maradek", "50000"), deps)).messages![0].html,
    );
    expect(readState().leftover).toEqual({ answered: { "2026-10": 50_000 } });
  });

  it("/maradek with a bad amount says why and waits for a better one", async () => {
    const r = await call(commandReq("maradek", "sok"), depsFor(() => contextAt(WED)));
    expect(r.messages![0].html).toContain("❌");
    expect(r.expectText?.context).toBe("maradek");
    expect(existsSync(stateFile)).toBe(false);
  });

  it("a load failure is a handled error, with the token hint on 401/403", async () => {
    expect(await call(commandReq("allas"), failing("401 Unauthorized – https://api.github.com/…"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("GITHUB_TOKEN"),
    });
  });
});

describe("tick", () => {
  it("returns the new alerts once, and saves what it sent", async () => {
    const deps = depsFor(() => contextAt(WED));
    const first = await call(jobReq(), deps);
    expect(first.ok).toBeUndefined();
    const alerts = first.messages!.filter((m) => m.html.includes("új teendő") || m.html.includes("Új teendő"));
    expect(alerts).toHaveLength(1);
    const sent = readState().sentAlerts as Record<string, string>;
    expect(Object.keys(sent).length).toBeGreaterThan(0);

    const second = await call(jobReq(), deps);
    expect(second.messages).toEqual([]);
  });

  it("without a high-severity alert the alert message waits out the quiet hours", async () => {
    expect(contextAt(WED).alerts.some((a) => a.severity === "high")).toBe(false);
    const r = await call(jobReq(), depsFor(() => contextAt(WED)));
    expect(r.messages!.find((x) => /új teendő/i.test(x.html))!.priority).toBe("normal");
  });

  const weeklyAt = async (at: [number, number, number, number, number?]) =>
    (await call(jobReq(), depsFor(() => contextAt(at)))).messages!.filter((m) => m.html.includes("Heti"));

  it("the weekly report goes out on Friday after the close, once, as a normal message", async () => {
    writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, lastWeekly: "2026-10-09", lastMonthly: "2026-10" }));
    expect(await weeklyAt([2026, 10, 16, 17, 55])).toHaveLength(0);
    const weekly = await weeklyAt([2026, 10, 16, 18, 0]);
    expect(weekly).toHaveLength(1);
    expect(weekly[0].priority).toBe("normal");
    expect(readState().lastWeekly).toBe("2026-10-16");
    expect(await weeklyAt([2026, 10, 16, 18, 5])).toHaveLength(0);
    expect(await weeklyAt([2026, 10, 18, 18, 30])).toHaveLength(0);
  });

  it("a Friday missed (hub down) is caught up on the weekend, not on Monday", async () => {
    writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, lastWeekly: "2026-10-09", lastMonthly: "2026-10" }));
    expect(await weeklyAt([2026, 10, 18, 9, 0])).toHaveLength(1);
    expect(readState().lastWeekly).toBe("2026-10-16");

    writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, lastWeekly: "2026-10-09", lastMonthly: "2026-10" }));
    expect(await weeklyAt([2026, 10, 19, 9, 0])).toHaveLength(0);
  });

  it("a Sunday sent under the old schedule doesn't re-send for the Friday before it", async () => {
    writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, lastWeekly: "2026-10-04", lastMonthly: "2026-10" }));
    expect(await weeklyAt([2026, 10, 4, 18, 30])).toHaveLength(0);
    expect(await weeklyAt([2026, 10, 9, 18, 0])).toHaveLength(1);
  });

  it("loads the old bot's state; the hub's fields are dropped, the rest kept", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        offset: 123,
        strangers: { "42": "2026-10-01T10:00:00.000Z" },
        queue: ["<b>régi</b>"],
        lastBeat: "2026-10-13T10:00:00.000Z",
        lastErrorAt: "2026-10-12T10:00:00.000Z",
        sentAlerts: {},
        warned: {},
        lastWeekly: "2026-10-11",
        lastMonthly: "2026-10",
        leftover: { asked: "2026-09", answered: { "2026-09": 20_000 } },
      }),
    );
    const r = await call(jobReq(), depsFor(() => contextAt(WED)));
    expect(r.ok).toBeUndefined();
    const st = readState();
    for (const k of ["offset", "strangers", "queue", "lastBeat", "lastErrorAt"]) expect(st).not.toHaveProperty(k);
    expect(st).toMatchObject({
      lastWeekly: "2026-10-11",
      lastMonthly: "2026-10",
      leftover: { asked: "2026-09", answered: { "2026-09": 20_000 } },
    });
    // The queued message is the hub's business now: not re-sent from here.
    expect(r.messages!.some((m) => m.html.includes("régi"))).toBe(false);
  });

  it("keeps a /maradek answer saved while the tick was loading", async () => {
    const deps: Deps = {
      load: async () => {
        const ctx = contextAt(WED);
        // A command process answers meanwhile.
        await call(commandReq("maradek", "30000"), depsFor(() => ctx));
        return ctx;
      },
      stateFile,
      env,
    };
    await call(jobReq(), deps);
    expect(readState().leftover).toMatchObject({ answered: { "2026-10": 30_000 } });
  });

  it("a token error (401/403) → ok:false at once, with the hint", async () => {
    expect(await call(jobReq(), failing("403 Forbidden – https://api.github.com/repos/x"))).toEqual({
      v: 1,
      ok: false,
      error:
        "🔑 Nem érem el a szinkron-repót (a GitHub-token lejárt vagy hibás). Frissítsd a .notify/.env-ben a GITHUB_TOKEN-t.",
    });
    expect(existsSync(stateFile)).toBe(false);
  });

  it("a transient load failure is silent for 30 min, then ok:false with the reason", async () => {
    // 2026-10-03 23:46 and 00:01: single GitHub timeouts, each fixed by the
    // next tick — they must not reach the phone as ❌ + ✅.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 23, 46));
    const timeout = failing("The operation was aborted due to timeout");
    expect(await call(jobReq(), timeout)).toEqual({ v: 1, messages: [] });
    vi.setSystemTime(new Date(2026, 9, 4, 0, 11));
    expect(await call(jobReq(), timeout)).toEqual({ v: 1, messages: [] });

    vi.setSystemTime(new Date(2026, 9, 4, 0, 16));
    expect(await call(jobReq(), timeout)).toEqual({
      v: 1,
      ok: false,
      error: "Nem sikerült frissíteni az adatokat: The operation was aborted due to timeout (30 perce)",
    });
  });

  it("a successful load restarts the grace period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timeout = failing("fetch failed");
    vi.setSystemTime(new Date(2026, 9, 3, 23, 0));
    await call(jobReq(), timeout);
    expect(readState().loadFailingSince).toBeDefined();

    vi.setSystemTime(new Date(2026, 9, 3, 23, 25));
    await call(jobReq(), depsFor(() => contextAt(WED)));
    expect(readState()).not.toHaveProperty("loadFailingSince");

    vi.setSystemTime(new Date(2026, 9, 3, 23, 40));
    expect(await call(jobReq(), timeout)).toEqual({ v: 1, messages: [] });
  });

  it("an unknown job is an error", async () => {
    expect(await call(jobReq("napi"), depsFor(() => contextAt(WED)))).toMatchObject({ ok: false });
  });
});

describe("news digest", () => {
  const newsDeps = (at: [number, number, number, number, number?], engine = fakeEngine([fixtureNewsBody()]), store = memoryStore()) => ({
    deps: {
      ...depsFor(() => contextAt(at)),
      news: () => ({ engine, store, cacheDir: join(dir, "news"), appUrl: "https://example.com/app/" }),
    } satisfies Deps,
    engine,
    store,
  });
  const EVENING: [number, number, number, number, number] = [2026, 10, 14, 18, 15];
  const MORNING: [number, number, number, number, number] = [2026, 10, 14, 7, 45];

  it("the evening job: one normal message, uploaded, once a day", async () => {
    const { deps, engine, store } = newsDeps(EVENING);
    const r = await call(jobReq("news-evening"), deps);
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].priority).toBe("normal");
    expect(r.messages![0].html).toContain("📰 <b>Napzárta – 2026. okt. 14.</b>");
    expect(r.messages![0].html).toContain('href="https://example.com/app/#/hirek"');
    expect(store.writes).toContain("news/2026-10-14-evening.json");
    expect(readState().news).toEqual({ evening: "2026-10-14" });

    expect(await call(jobReq("news-evening"), deps)).toEqual({ v: 1, messages: [] });
    expect(engine.prompts).toHaveLength(1);
  });

  it("the morning and the evening edition are separate runs", async () => {
    const m = newsDeps(MORNING);
    const r = await call(jobReq("news-morning"), m.deps);
    expect(r.messages![0].html).toContain("☀️ <b>Reggeli előzetes – 2026. okt. 14.</b>");
    expect(m.engine.prompts[0]).toContain("Reggeli előzetest írsz");
    const e = newsDeps(EVENING, undefined, m.store);
    expect((await call(jobReq("news-evening"), e.deps)).messages).toHaveLength(1);
    expect(readState().news).toEqual({ morning: "2026-10-14", evening: "2026-10-14" });
  });

  it("a manual run from the hub sends it again from the local copy", async () => {
    const { deps, engine } = newsDeps(EVENING);
    await call(jobReq("news-evening"), deps);
    const manual = JSON.stringify({ ...JSON.parse(jobReq("news-evening")), manual: true });
    expect((await call(manual, deps)).messages).toHaveLength(1);
    expect(engine.prompts).toHaveLength(1);
  });

  it("an AI failure is a job error (the hub reports it)", async () => {
    const { deps } = newsDeps(EVENING, fakeEngine([]));
    expect(await call(jobReq("news-evening"), deps)).toMatchObject({ ok: false, error: "no more answers" });
    expect(existsSync(stateFile) ? readState().news : undefined).toBeUndefined();
  });

  it("a failed upload still sends the digest, with a warning", async () => {
    const store = memoryStore();
    store.write = async () => {
      throw new Error("Feltöltés sikertelen: HTTP 403");
    };
    const { deps } = newsDeps(EVENING, undefined, store);
    const r = await call(jobReq("news-evening"), deps);
    expect(r.messages![0].html).toContain("⚠️ A felhőbe nem sikerült feltölteni");
  });

  it("the tick keeps the news state the job wrote meanwhile", async () => {
    const deps: Deps = {
      ...depsFor(() => contextAt(WED)),
      load: async () => {
        const ctx = contextAt(WED);
        // The news job finishes while this tick is computing (after it read
        // the state): the first thing the tick computes reads ctx.glide.
        const glide = ctx.glide;
        let wrote = false;
        Object.defineProperty(ctx, "glide", {
          get() {
            if (!wrote) {
              wrote = true;
              writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, news: { evening: "2026-10-13" } }));
            }
            return glide;
          },
        });
        return ctx;
      },
    };
    writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {} }));
    await call(jobReq(), deps);
    expect(readState().news).toEqual({ evening: "2026-10-13" });
  });

  it("/hirek: a menu of the affected assets with \"Mind\"; none yet → a note", async () => {
    const empty = newsDeps(EVENING);
    expect((await call(commandReq("hirek"), empty.deps)).messages![0].html).toContain("Még nincs hírösszefoglaló");
    await call(jobReq("news-evening"), empty.deps);
    const r = await call(commandReq("hirek"), empty.deps);
    const m = r.messages![0];
    expect(m.html).toContain("Melyik papír hírei");
    const buttons = m.buttons!.flat();
    expect(buttons[0]).toEqual({ text: "Mind", data: "news:*" });
    // the most mentioned first (ties: first seen first), three to a row after "Mind"
    expect(m.buttons!.map((row) => row.map((b) => b.data))).toEqual([
      ["news:*"],
      ["news:EUR/HUF", "news:VWCE", "news:WBIT"],
      ["news:DKJ", "news:FixMÁP"],
    ]);
    expect(buttons.every((b) => new TextEncoder().encode(b.data).length <= 64)).toBe(true);
  });

  it("/hirek Mind button: the whole digest as before, buttons kept, the menu replaced", async () => {
    const { deps } = newsDeps(EVENING);
    await call(jobReq("news-evening"), deps);
    const r = await call(JSON.stringify({ ...base, type: "callback", data: "news:*" }), deps);
    expect(r.editOriginal).toBe(true);
    expect(r.messages![0].html).toContain("Napzárta – 2026. okt. 14.");
    expect(r.messages![0].buttons![0][0].text).toBe("▸ Mind");
  });

  it("/hirek asset button (or typed, any case): only that asset's items with summaries", async () => {
    const { deps } = newsDeps(EVENING);
    await call(jobReq("news-evening"), deps);
    const r = await call(JSON.stringify({ ...base, type: "callback", data: "news:EUR/HUF" }), deps);
    expect(r.editOriginal).toBe(true);
    const html = r.messages![0].html;
    expect(html).toContain("Gyengült a forint &lt;az euróval&gt; szemben");
    expect(html).toContain("A gyengébb forint a devizás eszközök forintértékét növeli.");
    expect(html).not.toContain("Az MNB kivárást jelzett");
    expect(r.messages![0].buttons!.flat().find((b) => b.data === "news:EUR/HUF")!.text).toBe("▸ EUR/HUF");
    const typed = await call(commandReq("hirek", "vwce"), deps);
    expect(typed.editOriginal).toBeUndefined();
    expect(typed.messages![0].html).toContain("Gyengült a forint");
  });

  it("/hirek: a stale button (asset not in the newest digest) → note and the whole digest, \"Mind\" marked", async () => {
    const { deps } = newsDeps(EVENING);
    await call(jobReq("news-evening"), deps);
    const r = await call(JSON.stringify({ ...base, type: "callback", data: "news:RÉGIPAPÍR" }), deps);
    expect(r.editOriginal).toBe(true);
    expect(r.messages![0].html).toContain("Nem találok ilyen papírt");
    expect(r.messages![0].html).toContain("Napzárta – 2026. okt. 14.");
    expect(r.messages![0].buttons![0][0].text).toBe("▸ Mind");
  });

  it("/hirek with an unknown asset: a note, then the whole digest", async () => {
    const { deps } = newsDeps(EVENING);
    await call(jobReq("news-evening"), deps);
    const r = await call(commandReq("hirek", "nincsilyen"), deps);
    expect(r.messages![0].html).toContain("Nem találok ilyen papírt");
    expect(r.messages![0].html).toContain("Napzárta – 2026. okt. 14.");
  });
});

describe("/hirkereses", () => {
  // The command starts the news job at the hub (a fake here) and answers at
  // once; the job, started by the hub, does the search.
  const setup = (engine = fakeEngine([fixtureNewsBody(), fixtureNewsBody(), fixtureNewsBody()])) => {
    const store = memoryStore();
    const started: string[] = [];
    let hub: "started" | "running" | Error = "started";
    const at = (when: [number, number, number, number, number?]): Deps => ({
      ...depsFor(() => contextAt(when)),
      news: () => ({ engine, store, cacheDir: join(dir, "news"), appUrl: "https://example.com/app/" }),
      runJob: async (job) => {
        if (hub instanceof Error) throw hub;
        started.push(job);
        return hub;
      },
    });
    return { at, engine, store, started, setHub: (h: typeof hub) => (hub = h) };
  };
  const now = (y: number, m: number, d: number, h: number, mi = 0) =>
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(y, m - 1, d, h, mi) });

  it("starts the edition of the time of day and answers at once", async () => {
    const s = setup();
    now(2026, 10, 14, 9, 30);
    const r = await call(commandReq("hirkereses"), s.at([2026, 10, 14, 9, 30]));
    expect(r.messages![0].html).toContain("Keresem a friss híreket (reggeli előzetes)");
    expect(r.status).toBe("started"); // the assistant opens its "done" watch only for started / pending
    expect(s.started).toEqual(["news-morning"]);
    expect(s.engine.prompts).toHaveLength(0);
    now(2026, 10, 14, 12, 0);
    expect(searchEdition(new Date())).toBe("evening");
  });

  it("the job it starts: a fresh search, urgent, not counted as the scheduled run", async () => {
    const s = setup();
    // The scheduled morning edition is already out today…
    now(2026, 10, 14, 7, 45);
    await call(jobReq("news-morning"), s.at([2026, 10, 14, 7, 45]));
    // …and still, on request, a new search.
    now(2026, 10, 14, 15, 0);
    await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 0]));
    expect(s.started).toEqual(["news-evening"]);
    const r = await call(JSON.stringify({ ...JSON.parse(jobReq("news-evening")), manual: true }), s.at([2026, 10, 14, 15, 1]));
    expect(r.messages![0].priority).toBe("urgent");
    expect(s.engine.prompts).toHaveLength(2);
    const st = readState().news as Record<string, string>;
    expect(st.searchRequestedAt).toBeUndefined();
    expect(st.evening).toBeUndefined();
    // So the evening digest still comes after the close, with a new search.
    const evening = await call(jobReq("news-evening"), s.at([2026, 10, 14, 18, 15]));
    expect(evening.messages).toHaveLength(1);
    expect(evening.messages![0].priority).toBe("normal");
    expect(s.engine.prompts).toHaveLength(3);
  });

  it("at most once per half hour; a second request meanwhile is told to wait", async () => {
    const s = setup();
    now(2026, 10, 14, 15, 0);
    await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 0]));
    now(2026, 10, 14, 15, 2);
    const pending = await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 2]));
    expect(pending.messages![0].html).toContain("Már keresem");
    expect(pending.status).toBe("pending");
    await call(jobReq("news-evening"), s.at([2026, 10, 14, 15, 3]));
    now(2026, 10, 14, 15, 10);
    const r = await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 10]));
    expect(r.messages![0].html).toContain("10 perce volt. Újat 20 perc múlva");
    expect(r.status).toBe("refused"); // no watch: nothing started
    now(2026, 10, 14, 15, 30);
    await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 30]));
    expect(s.started).toEqual(["news-evening", "news-evening"]);
  });

  it("the scheduled run already in progress answers instead; a hub error frees the command", async () => {
    const s = setup();
    s.setHub("running");
    now(2026, 10, 14, 18, 16);
    const r = await call(commandReq("hirkereses"), s.at([2026, 10, 14, 18, 16]));
    expect(r.messages![0].html).toContain("Épp most készül a(z) napzárta");
    expect((readState().news as Record<string, string>).searchRequestedAt).toBeUndefined();

    const t = setup();
    writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {} }));
    t.setHub(new Error("A tg-hub nem indította el a keresést (HTTP 500)."));
    now(2026, 10, 14, 15, 0);
    expect(await call(commandReq("hirkereses"), t.at([2026, 10, 14, 15, 0]))).toMatchObject({ ok: false });
    t.setHub("started");
    await call(commandReq("hirkereses"), t.at([2026, 10, 14, 15, 1]));
    expect(t.started).toEqual(["news-evening"]);
  });

  it("a failed search frees the command for another try", async () => {
    const s = setup(fakeEngine([]));
    now(2026, 10, 14, 15, 0);
    await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 0]));
    expect(await call(jobReq("news-evening"), s.at([2026, 10, 14, 15, 1]))).toMatchObject({ ok: false });
    expect((readState().news as Record<string, string>).searchRequestedAt).toBeUndefined();
  });
});

describe("alert priorities", () => {
  const a = (id: string, severity: Alert["severity"], bypassQuiet?: boolean): Alert => ({
    id,
    severity,
    title: id,
    bypassQuiet,
  });

  it("normal alerts together: urgent if any is high", () => {
    expect(alertMessages([a("x", "medium"), a("y", "info")]).map((m) => m.priority)).toEqual(["normal"]);
    expect(alertMessages([a("x", "medium"), a("y", "high")]).map((m) => m.priority)).toEqual(["urgent"]);
  });

  it("deep glide re-alerts apart: urgent where the user lets them through the quiet hours", () => {
    const deepOk = a("glide:R:below:2026-10:n2", "medium", true);
    const deepWait = a("glide:K:above:2026-10:n3", "medium", false);
    const ms = alertMessages([a("x", "medium"), deepOk, deepWait]);
    expect(ms.map((m) => m.priority)).toEqual(["normal", "urgent", "normal"]);
    expect(ms[1].html).toContain("glide:R");
    expect(ms[2].html).toContain("glide:K");
    expect(ms[1].html).toContain("Tovább mélyült");
  });
});

describe("process", () => {
  it("withTimeout leaves no timer behind (it would keep the handler alive)", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 30_000, 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the handler writes only the JSON response on stdout, logs on stderr, and exits", () => {
    const t0 = Date.now();
    const p = spawnSync(
      process.execPath,
      [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), "scripts/notify/tg-handler.ts"],
      {
        cwd: ROOT,
        input: JSON.stringify({ ...base, type: "job", job: "nincsilyen" }),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(p.status).toBe(0);
    expect(JSON.parse(p.stdout)).toEqual({ v: 1, ok: false, error: "Ismeretlen job: nincsilyen" });
    expect(p.stdout.trim().split("\n")).toHaveLength(1);
    expect(p.stderr).toContain("job nincsilyen");
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 40_000);

  it("console.log goes to stderr once logToStderr is loaded", () => {
    const p = spawnSync(
      process.execPath,
      [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), "-e", "import('./scripts/notify/logToStderr.ts').then(() => console.log('napló'))"],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    expect(p.stdout).toBe("");
    expect(p.stderr).toContain("napló");
  }, 40_000);
});

describe("Miért mozdult?", () => {
  const env1 = { bigMovePct: 1, positionMovePct: 1, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };
  const moveQuotes = (moves: Record<string, number>) => (ctx: Context) => {
    for (const [key, ch] of Object.entries(moves)) {
      const q = ctx.liveQuotes[key];
      q.price = Math.round(q.prevClose! * (1 + ch) * 10_000) / 10_000;
    }
    return ctx;
  };
  const setup = (
    moves: Record<string, number> = {},
    extra: Partial<Deps["env"]> = {},
    tweak?: (s: PortfolioSnapshot) => void,
  ) => {
    const answers: unknown[] = [];
    const engine = fakeEngine(answers);
    const started: string[] = [];
    let current = moves;
    let minute = 0;
    const deps: Deps = {
      load: async () => moveQuotes(current)(contextAt([2026, 10, 14, 10, (minute += 5)], tweak)),
      stateFile,
      env: { ...env1, ...extra },
      why: () => engine,
      runJob: async (job) => {
        started.push(job);
        return "started";
      },
    };
    const request = () => (readState().why as WhyState).request!;
    const answerAll = () =>
      answers.push({
        items: request().factors.map((f) => ({
          factor: f.key,
          explanation: `Ok: ${f.key} <hír>`,
          sources: [{ title: "Reuters", url: "https://example.com/a?b=1&c=2" }],
        })),
      });
    return { deps, engine, started, request, answerAll, setMoves: (m: Record<string, number>) => (current = m) };
  };

  it("the move alert goes out at once and starts one search; its answer names the factor, not the numbers", async () => {
    const s = setup();
    const tick = await call(jobReq(), s.deps);
    expect(tick.messages!.some((m) => m.html.includes("−1,5%</b> ma"))).toBe(true);
    expect(s.started).toEqual(["news-why"]);
    expect(s.request().factors.map((f) => f.key)).toContain(WBIT);
    s.answerAll();
    const r = await call(jobReq("news-why"), s.deps);
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].priority).toBe("normal");
    const html = r.messages![0].html;
    expect(html).toMatch(new RegExp(`🔎 <b>Miért mozdult a .+\\?</b> Ok: ${WBIT} &lt;hír&gt;`));
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">Reuters</a>');
    expect(html).not.toMatch(/\d%|Ft\b/);
    expect(s.engine.prompts[0]).toContain(`factor: "${WBIT}"`);
    expect(s.engine.prompts[0]).not.toMatch(/\d Ft/);

    expect(await call(jobReq("news-why"), s.deps)).toEqual({ v: 1, messages: [] });
    await call(jobReq(), s.deps);
    expect(s.started).toEqual(["news-why"]);
    expect(s.engine.prompts).toHaveLength(1);
  });

  it("factors that move together are explained in one search, one paragraph each; EUR/HUF alerts too", async () => {
    const s = setup({ [VWCE]: 0.012, EUR: 0.011 });
    const tick = await call(jobReq(), s.deps);
    expect(tick.messages!.some((m) => m.html.includes("<b>EUR/HUF: +1,1%</b> ma"))).toBe(true);
    const keys = s.request().factors.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining([VWCE, WBIT, "EUR/HUF"]));
    s.answerAll();
    const html = (await call(jobReq("news-why"), s.deps)).messages![0].html;
    expect(html).toContain("Miért mozdult az EUR/HUF?");
    expect(html.split("\n\n")).toHaveLength(keys.length);
    expect(s.started).toEqual(["news-why"]);
  });

  it("a factor that moves later gets its own search once the first is taken; at most 3 a day", async () => {
    const s = setup();
    await call(jobReq(), s.deps);
    s.setMoves({ EUR: 0.011 });
    await call(jobReq(), s.deps);
    expect(s.started).toEqual(["news-why"]);
    s.answerAll();
    await call(jobReq("news-why"), s.deps);
    await call(jobReq(), s.deps);
    expect(s.started).toEqual(["news-why", "news-why"]);
    expect(s.request().factors.map((f) => f.key)).toEqual(["EUR/HUF"]);
    expect((readState().why as WhyState).runs).toBe(2);

    const st = readState();
    writeFileSync(stateFile, JSON.stringify({ ...st, why: { ...(st.why as WhyState), explained: [], runs: 3 }, whyTaken: undefined }));
    s.setMoves({ [VWCE]: 0.02 });
    await call(jobReq(), s.deps);
    expect(s.started).toHaveLength(2);
  });

  it("a failed search is a job error and keeps failing (no false recovery) until it is answered", async () => {
    const s = setup();
    await call(jobReq(), s.deps);
    expect(await call(jobReq("news-why"), s.deps)).toMatchObject({ ok: false, error: "no more answers" });
    expect(await call(jobReq("news-why"), s.deps)).toMatchObject({ ok: false });
    s.answerAll();
    expect((await call(jobReq("news-why"), s.deps)).messages).toHaveLength(1);
    expect(await call(jobReq("news-why"), s.deps)).toEqual({ v: 1, messages: [] });
  });

  it("an expired failed request is no recovery: the idle run says keepFailing", async () => {
    const s = setup();
    await call(jobReq(), s.deps);
    await call(jobReq("news-why"), s.deps);
    const st = readState();
    const why = st.why as WhyState;
    writeFileSync(stateFile, JSON.stringify({ ...st, why: { ...why, request: { ...why.request!, at: "2000-01-01T00:00:00.000Z" } } }));
    expect(await call(jobReq("news-why"), s.deps)).toEqual({ v: 1, messages: [], keepFailing: true });
  });

  it("without a move alert nothing is searched", async () => {
    const s = setup();
    const deps = { ...s.deps, env: { ...env1, bigMovePct: 2, positionMovePct: 5 } };
    await call(jobReq(), deps);
    expect(s.started).toEqual([]);
    expect(await call(jobReq("news-why"), deps)).toEqual({ v: 1, messages: [] });
  });

  it("a per-instrument threshold (by ticker or ISIN) replaces the default one for that instrument", async () => {
    for (const key of ["WBIT", WBIT.toLowerCase()]) {
      const quiet = setup({}, { moveOverrides: { [key.toUpperCase()]: 4 } });
      const tick = await call(jobReq(), quiet.deps);
      expect(tick.messages!.some((m) => m.html.includes("−1,5%</b> ma"))).toBe(false);
      expect(quiet.started).toEqual([]);
      rmSync(stateFile, { force: true });
    }
    const loud = setup({ [WBIT]: -0.045 }, { moveOverrides: { WBIT: 4 } });
    const tick = await call(jobReq(), loud.deps);
    expect(tick.messages!.some((m) => m.html.includes("<b>WBIT: −4,5%</b> ma"))).toBe(true);
    expect(loud.request().factors.map((f) => f.key)).toEqual([WBIT]);
  });

  const moveAlertPrefs = (value: MoveAlertSettings) => (s: PortfolioSnapshot) => {
    s.prefs = { ...s.prefs, moveAlerts: { updatedAt: "2026-10-01T08:00:00.000Z", value } };
  };
  const moveLines = (r: HubResponse) =>
    (r.messages ?? []).flatMap((m) => m.html.split("\n")).filter((l) => /<\/b> ma\b|Nagy mozgás ma/.test(l));

  it("a per-instrument threshold set in the app is used and wins over the .env one", async () => {
    const quiet = setup({}, {}, moveAlertPrefs({ byKey: { [WBIT]: 4 } }));
    expect(moveLines(await call(jobReq(), quiet.deps)).some((l) => l.includes("WBIT"))).toBe(false);
    rmSync(stateFile, { force: true });
    const loud = setup({}, { moveOverrides: { WBIT: 4 } }, moveAlertPrefs({ byKey: { [WBIT]: 1 } }));
    const wbit = moveLines(await call(jobReq(), loud.deps)).find((l) => l.includes("<b>WBIT: −1,5%</b> ma"));
    expect(wbit).toMatch(/ma, árfolyam: \d+,\d{2,4} EUR \(/);
  });

  it("a threshold changed during the day: the same move is not sent again, a bigger one is measured by the new threshold", async () => {
    let byKey: Record<string, number> = { [WBIT]: 1 };
    const s = setup({}, {}, (snap) => moveAlertPrefs({ byKey })(snap));
    const wbitLines = async () => moveLines(await call(jobReq(), s.deps)).filter((l) => l.includes("<b>WBIT:"));
    expect(await wbitLines()).toHaveLength(1);
    byKey = { [WBIT]: 0.5 };
    expect(await wbitLines()).toEqual([]);
    byKey = { [WBIT]: 4 };
    s.setMoves({ [WBIT]: -0.045 });
    expect(await wbitLines()).toEqual([expect.stringContaining("<b>WBIT: −4,5%</b> ma")]);
  });

  it("the app's portfolio and default position thresholds replace the .env ones; EUR/HUF has its own", async () => {
    const quiet = setup(
      { [VWCE]: 0.012, EUR: 0.011 },
      {},
      moveAlertPrefs({ portfolioPct: 50, positionPct: 50, byKey: {} }),
    );
    expect(moveLines(await call(jobReq(), quiet.deps))).toEqual([]);
    expect(quiet.started).toEqual([]);
    rmSync(stateFile, { force: true });
    const fx = setup({ EUR: 0.011 }, { bigMovePct: 50, positionMovePct: 50 }, moveAlertPrefs({ byKey: { "EUR/HUF": 1 } }));
    expect(moveLines(await call(jobReq(), fx.deps))).toEqual([expect.stringContaining("<b>EUR/HUF: +1,1%</b> ma")]);
  });

  it("the search subject of a tracker is its underlying, the message keeps the instrument's name", async () => {
    const s = setup({ [VWCE]: 0.012 }, { whySubjects: { WBIT: "Bitcoin (BTC)" } });
    await call(jobReq(), s.deps);
    s.answerAll();
    const html = (await call(jobReq("news-why"), s.deps)).messages![0].html;
    expect(html).toContain("Miért mozdult a WBIT?");
    const prompt = s.engine.prompts[0];
    const wbit = prompt.split("\n").find((l) => l.includes(`factor: "${WBIT}"`))!;
    expect(wbit).toContain("keresd: Bitcoin (BTC) árfolyammozgásának oka");
    expect(wbit).toContain("az EUR/USD mozgása is számíthat");
    const vwce = prompt.split("\n").find((l) => l.includes(`factor: "${VWCE}"`))!;
    expect(vwce).toContain("a követett index vagy piac");
    expect(vwce).not.toContain("keresd:");
  });

  describe("reversal off the day's low / high", () => {
    // WBIT's day as moves off the previous close: the bars so far and the
    // current price (the last bar). Threshold 2%, so a bounce of 3% counts.
    const env2 = { ...env1, bigMovePct: 50, positionMovePct: 2 };
    const swingSetup = (bars: number[]) => {
      const answers: unknown[] = [];
      const engine = fakeEngine(answers);
      const started: string[] = [];
      let day = bars;
      let minute = 0;
      const deps: Deps = {
        load: async () => {
          const ctx = contextAt([2026, 10, 14, 10, (minute += 5)]);
          const q = ctx.liveQuotes[WBIT];
          const at = (b: number) => Math.round(q.prevClose! * (1 + b) * 10_000) / 10_000;
          q.intraday = day.map(at);
          q.intradayT = day.map((_, i) => new Date(2026, 9, 14, 9, i * 5).getTime());
          q.price = at(day.at(-1)!);
          return ctx;
        },
        stateFile,
        env: env2,
        why: () => engine,
        runJob: async (job) => {
          started.push(job);
          return "started";
        },
      };
      const swings = async () =>
        (await call(jobReq(), deps)).messages!.flatMap((m) => m.html.split("\n")).filter((l) => /mai (mélypontjától|csúcsától)/.test(l));
      const answerAll = () =>
        answers.push({
          items: (readState().why as WhyState).request!.factors.map((f) => ({
            factor: f.key,
            explanation: "Ok",
            sources: [],
          })),
        });
      return { deps, engine, started, swings, answerAll, setDay: (b: number[]) => (day = b) };
    };

    it("a bounce off the low pings once per level, though the day is still deep in the red", async () => {
      const s = swingSetup([-0.06, -0.059]);
      expect(await s.swings()).toEqual([]);
      s.setDay([-0.06, -0.05, -0.03]);
      const bounce = await s.swings();
      expect(bounce).toEqual([expect.stringContaining("↗️ <b>WBIT: +3,2%</b> a mai mélypontjától (ma: −3,0%)")]);
      expect(await s.swings()).toEqual([]);
      s.setDay([-0.06, -0.05, -0.03, 0]);
      expect(await s.swings()).toEqual([expect.stringContaining("<b>WBIT: +6,4%</b> a mai mélypontjától (ma: +0,0%)")]);
    });

    it("a fall off the high is the mirror image", async () => {
      const s = swingSetup([0.06, 0.05, 0.03]);
      expect(await s.swings()).toEqual([expect.stringContaining("↘️ <b>WBIT: −2,8%</b> a mai csúcsától (ma: +3,0%)")]);
    });

    it("a straight move off the previous close is the daily alert's, not a reversal", async () => {
      const s = swingSetup([0, 0.02, 0.035]);
      const lines = (await call(jobReq(), s.deps)).messages!.flatMap((m) => m.html.split("\n"));
      expect(lines.some((l) => l.includes("<b>WBIT: +3,5%</b> ma"))).toBe(true);
      expect(await s.swings()).toEqual([]);
    });

    it("a borrowed or stale curve is no evidence of the day's extremes", async () => {
      const s = swingSetup([-0.06, -0.05, -0.03]);
      const load = s.deps.load;
      s.deps.load = async () => {
        const ctx = await load();
        ctx.liveQuotes[WBIT].intradayFrom = "BTC-USD";
        return ctx;
      };
      expect(await s.swings()).toEqual([]);
    });

    it("the why of a reversal carries the reported size, not what is left of it after a retrace", async () => {
      const s = swingSetup([-0.06, -0.059]);
      await call(jobReq(), s.deps); // baseline: the day's move starts a why (still unanswered)
      s.setDay([-0.06, -0.05, -0.03]);
      expect(await s.swings()).toHaveLength(1); // +3.19% off the low reported; its why waits
      s.setDay([-0.06, -0.05, -0.03, -0.0585]); // fell back: only ~+0.16% left off the low
      s.answerAll();
      await call(jobReq("news-why"), s.deps); // the first why is answered
      await call(jobReq(), s.deps); // now the reversal's own why is queued
      const request = (readState().why as WhyState).request!;
      expect(request.factors).toEqual([expect.objectContaining({ key: WBIT, swing: { from: "low", pct: expect.closeTo(0.0319, 3) } })]);
    });

    it("the reversal gets its own search even after the factor was explained today", async () => {
      const s = swingSetup([-0.06, -0.059]);
      await call(jobReq(), s.deps);
      expect(s.started).toEqual(["news-why"]);
      s.answerAll();
      await call(jobReq("news-why"), s.deps);
      s.setDay([-0.06, -0.05, -0.03]);
      await call(jobReq(), s.deps);
      expect(s.started).toEqual(["news-why", "news-why"]);
      const request = (readState().why as WhyState).request!;
      expect(request.factors).toEqual([expect.objectContaining({ key: WBIT, swing: { from: "low", pct: expect.closeTo(0.0319, 3) } })]);
      s.answerAll();
      await call(jobReq("news-why"), s.deps);
      expect(s.engine.prompts[1]).toContain("a napi mélypontjáról +3,19% visszapattanás");
      await call(jobReq(), s.deps);
      expect(s.started).toHaveLength(2);
    });

    const dailyLines = async (s: ReturnType<typeof swingSetup>) =>
      (await call(jobReq(), s.deps)).messages!.flatMap((m) => m.html.split("\n")).filter((l) => /<\/b> ma, /.test(l));

    it("the same move is not announced twice: the daily crossing after a reversal off a low at the previous close", async () => {
      const s = swingSetup([-0.001, 0.0199]);
      expect(await s.swings()).toHaveLength(1); // +2.1% off the low, the day still +1.99%
      expect(s.started).toEqual(["news-why"]);
      s.answerAll();
      await call(jobReq("news-why"), s.deps);
      s.setDay([-0.001, 0.0205]); // now the day crosses 2% too: the same move
      expect(await dailyLines(s)).toEqual([]);
      expect(s.started).toEqual(["news-why"]); // and no second search
    });

    it("a daily crossing far from the reported reversal's low is still its own alert", async () => {
      const s = swingSetup([-0.03, 0.0199]);
      expect(await s.swings()).toHaveLength(1);
      s.setDay([-0.03, 0.0205]);
      expect(await dailyLines(s)).toHaveLength(1);
    });
  });

  it("override settings: malformed entries are ignored", () => {
    expect(parseMoveOverrides("WBIT:4, xyz : 2.5,bad,:3,ABC:0,DEF:x,")).toEqual({ WBIT: 4, XYZ: 2.5 });
    expect(parseMoveOverrides("")).toEqual({});
    expect(parseWhySubjects("WBIT=Bitcoin (BTC); rossz ; arany = Arany, unciánként;=x")).toEqual({
      WBIT: "Bitcoin (BTC)",
      ARANY: "Arany, unciánként",
    });
  });

  it("the article before the factor's name", () => {
    expect(article("EUR/HUF")).toBe("az");
    expect(article("portfólió")).toBe("a");
    expect(article("VWCE")).toBe("a");
  });
});

describe("nightly AI analysis", () => {
  const NIGHT: [number, number, number, number, number] = [2026, 10, 15, 3, 30];
  const analysisAnswer = () => ({
    headline: "Minden rendben.",
    overall: "rendben",
    changes: "Nőtt a készpénz aránya.",
    sections: [{ topic: "egyeb", title: "Egyéb", status: "rendben", text: "Semmi különös." }],
  });
  const analysisDeps = (engine = fakeEngine([analysisAnswer()]), store = memoryStore()) => ({
    deps: {
      ...depsFor(() => contextAt(NIGHT)),
      analysis: () => ({ engine, store, cacheDir: join(dir, "analysis") }),
    } satisfies Deps,
    engine,
    store,
  });
  const manual = JSON.stringify({ ...JSON.parse(jobReq("analysis")), manual: true });

  it("one normal message with what changed, uploaded, once a day", async () => {
    const { deps, engine, store } = analysisDeps();
    const r = await call(jobReq("analysis"), deps);
    expect(r.ok).toBeUndefined();
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0].priority).toBe("normal");
    expect(r.messages![0].html).toContain("AI-elemzés kész");
    expect(r.messages![0].html).toContain("Nőtt a készpénz aránya.");
    expect(store.writes).toEqual(["analysis/2026-10-15.json", "analysis/latest.json"]);
    expect(readState().analysis).toBe("2026-10-15");

    expect(await call(jobReq("analysis"), deps)).toEqual({ v: 1, messages: [] });
    expect(engine.prompts).toHaveLength(1);
  });

  it("a manual run sends it again from the local copy", async () => {
    const { deps, engine } = analysisDeps();
    await call(jobReq("analysis"), deps);
    expect((await call(manual, deps)).messages).toHaveLength(1);
    expect(engine.prompts).toHaveLength(1);
  });

  it("an AI failure is a job error and does not count as done", async () => {
    const { deps } = analysisDeps(fakeEngine([]));
    const r = await call(jobReq("analysis"), deps);
    expect(r.ok).toBe(false);
    expect(existsSync(stateFile) ? readState().analysis : undefined).toBeUndefined();
  });

  it("is not set up without the dependency", async () => {
    const r = await call(jobReq("analysis"), depsFor(() => contextAt(NIGHT)));
    expect(r.ok).toBe(false);
  });
});

describe("outlook jobs", () => {
  const SAT_EARLY: [number, number, number, number, number] = [2026, 10, 17, 4, 30];
  const SAT_RETRY: [number, number, number, number, number] = [2026, 10, 17, 8, 15];
  const aiState = () => join(dir, "outlook", "ai-state.json");
  // The fixture portfolio holds VWCE and WBIT (and a few more quoted papers).
  const answer = {
    assets: [
      {
        key: VWCE,
        assetClass: "equity_fund",
        views: [
          { house: "Vanguard", kind: "annualReturn", value: 0.059, unit: "%/év", horizon: "10 év", publishedAt: "2026-01-22", url: "https://example.com/vcmm" },
        ],
      },
    ],
  };
  const limitHit = {
    name: "f",
    model: "m",
    run: async () => Promise.reject(hubError("quota_exhausted", { status: 429, message: "A kvóta elfogyott, reset 8-kor" })),
  };
  const aiDeps = (at: [number, number, number, number, number], engine: ReturnType<typeof fakeEngine> | typeof limitHit, store = memoryStore()) => ({
    deps: {
      ...depsFor(() => contextAt(at)),
      outlookAi: () => ({ engine, store, stateFile: aiState() }),
    } satisfies Deps,
    store,
  });

  it("the 04:30 run is silent, writes the file, and makes the 08:15 retry a no-op", async () => {
    const early = aiDeps(SAT_EARLY, fakeEngine([answer]));
    expect(await call(jobReq("outlook-ai"), early.deps)).toEqual({ v: 1, messages: [] });
    expect(early.store.writes).toEqual(["market/outlook.json"]);

    const engine = fakeEngine([answer]);
    const retry = aiDeps(SAT_RETRY, engine, early.store);
    expect(await call(jobReq("outlook-ai-retry"), retry.deps)).toEqual({ v: 1, messages: [] });
    expect(engine.prompts).toEqual([]);
    expect(early.store.writes).toHaveLength(1);
  });

  it("the usage limit at 04:30 is quiet; the retry after 08:00 then does the work", async () => {
    const early = aiDeps(SAT_EARLY, limitHit);
    expect(await call(jobReq("outlook-ai"), early.deps)).toEqual({ v: 1, messages: [] });
    expect(early.store.writes).toEqual([]);

    const retry = aiDeps(SAT_RETRY, fakeEngine([answer]), early.store);
    const r = await call(jobReq("outlook-ai-retry"), retry.deps);
    expect(r.ok).toBeUndefined();
    expect(early.store.writes).toEqual(["market/outlook.json"]);
  });

  it("only a failed retry is reported, with the reason", async () => {
    const retry = aiDeps(SAT_RETRY, limitHit);
    const r = await call(jobReq("outlook-ai-retry"), retry.deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("keret");
    expect(retry.store.writes).toEqual([]);
  });

  it("is not set up without the dependency", async () => {
    expect((await call(jobReq("outlook-ai"), depsFor(() => contextAt(SAT_EARLY)))).ok).toBe(false);
  });

  it("the daily job keeps a newly found issuer consensus document as pending, without any AI", async () => {
    const { miniPdf } = await import("./outlook/pdfFixture");
    const rows: [number, number, string][] = Array.from({ length: 12 }, (_, i) => [50, 780 - i * 20, `Celar sor ${i} HUF 45.888 atlag`]);
    const url = "https://example.com/Consensus_20261001.pdf";
    // The AI named a consensus document for the fixture's VWCE (any asset will do).
    const store = memoryStore({
      "market/outlook.json": JSON.stringify({
        v: 1,
        updatedAt: "2026-10-10T00:00:00Z",
        profiles: { [VWCE]: { assetClass: "equity", consensusUrl: url, source: "ai", checkedAt: "2026-10-10" } },
        items: {},
        errors: {},
      }),
    });
    const r = await call(jobReq("outlook"), {
      ...depsFor(() => contextAt(SAT_EARLY)),
      outlook: () => ({
        resolve: async (t) => t.key,
        fetch: async () => ({ quoteSummary: { result: [{ price: { quoteType: "EQUITY", currency: "EUR" } }] } }),
        bands: async () => null,
        store,
      }),
      outlookDocs: () => ({
        dir: join(dir, "outlook"),
        head: async (u) => u === url,
        get: async () => ({ ok: true, contentType: "application/pdf", bytes: miniPdf(rows) }),
      }),
    });
    expect(r.ok).toBeUndefined();
    const { listPending } = await import("./outlook/issuerDocs");
    expect(listPending(join(dir, "outlook")).map((d) => [d.key, d.url])).toEqual([[VWCE, url]]);
  });

  it("the daily job profiles every held paper from its own data, nothing hard-wired", async () => {
    const store = memoryStore();
    const r = await call(jobReq("outlook"), {
      ...depsFor(() => contextAt(SAT_EARLY)),
      outlook: () => ({
        resolve: async (t) => t.key,
        fetch: async (symbol) => ({
          quoteSummary: {
            result: [{ price: { quoteType: "ETF", currency: "EUR", longName: symbol === WBIT ? "WisdomTree Physical Bitcoin" : "Vanguard FTSE All-World" } }],
          },
        }),
        bands: async (underlying) => [
          { underlying, horizonDays: 90, expiry: "2027-01-15", spot: 80_000, forward: 81_000, p10: 60_000, p50: 80_000, p90: 105_000, probUp: 0.49, asOf: "2026-10-17" },
        ],
        store,
      }),
    });
    expect(r.ok).toBeUndefined();
    const file = JSON.parse(store.files["market/outlook.json"]) as {
      profiles: Record<string, { assetClass: string; underlying?: string }>;
      items: Record<string, { implied?: unknown[] }>;
    };
    expect(file.profiles[WBIT]).toMatchObject({ assetClass: "crypto", underlying: "BTC" });
    expect(file.profiles[VWCE].assetClass).toBe("equity_fund");
    expect(file.items[WBIT].implied).toHaveLength(1);
    expect(file.items[VWCE]).toBeUndefined();
  });
});

describe("schedule.app.json: the outlook jobs", () => {
  it("the weekly AI run is on Saturday before 08:00, its retry after, and the retry may catch up on Sunday", () => {
    const app = JSON.parse(readFileSync(resolve(ROOT, "schedule.app.json"), "utf8")) as {
      jobs: { id: string; at?: string; days?: string[]; catchUp?: string; catchUpWindow?: string }[];
    };
    const job = (id: string) => app.jobs.find((j) => j.id === id)!;
    expect(job("outlook-ai")).toMatchObject({ days: ["sat"], at: "04:30" });
    expect(job("outlook-ai-retry")).toMatchObject({ days: ["sat"], at: "08:15", catchUp: "run", catchUpWindow: "36h" });
    // A late catch-up of the first run must still land before the 08:00 reset.
    const [h, m] = job("outlook-ai").at!.split(":").map(Number);
    const windowH = Number(job("outlook-ai").catchUpWindow!.replace("h", ""));
    expect(h * 60 + m + windowH * 60).toBeLessThanOrEqual(8 * 60);
    expect(job("outlook").days).toBeUndefined();
  });
});

describe("the hub request binds the AI calls' run_id", () => {
  it("runHandler hands every parsed request (its id is the run_id) to bindRequest before handling it", async () => {
    const seen: { id: string; type: string; job?: string }[] = [];
    const deps: Deps = {
      ...depsFor(() => contextAt(WED)),
      bindRequest: (r) => seen.push({ id: r.id, type: r.type, ...(r.type === "job" ? { job: r.job } : {}) }),
    };
    await call(JSON.stringify({ ...JSON.parse(jobReq("fundamentals")), id: "r_7f3a" }), deps);
    await call(commandReq("teendok"), deps);
    expect(seen).toEqual([
      { id: "r_7f3a", type: "job", job: "fundamentals" },
      { id: "r1", type: "command" },
    ]);
  });
});

describe("schedule.app.json: the analysis job", () => {
  it("runs Tuesday to Saturday in the small hours (Monday's would be Sunday night's)", () => {
    const app = JSON.parse(readFileSync(resolve(ROOT, "schedule.app.json"), "utf8")) as {
      jobs: { id: string; at?: string; days?: string[] }[];
    };
    const job = app.jobs.find((j) => j.id === "analysis")!;
    expect(job.days).toEqual(["tue", "wed", "thu", "fri", "sat"]);
    expect(job.at).toBe("03:30");
  });
});

describe("notification settings (Beállítások → Telegram-értesítések)", () => {
  const withNotify = (value: Partial<NotifySettings>) => (s: PortfolioSnapshot) => {
    s.prefs = { ...s.prefs, notify: { updatedAt: "2026-10-01T08:00:00.000Z", value: value as NotifySettings } };
  };
  const tickAt = async (at: [number, number, number, number, number?], value: Partial<NotifySettings> = {}) =>
    call(jobReq(), depsFor(() => contextAt(at, withNotify(value))));
  const alertHtml = (r: HubResponse) => (r.messages ?? []).filter((m) => /új teendő/i.test(m.html));

  it("a switched-off type sends nothing but the state moves on: switching it back on replays nothing", async () => {
    const off = await tickAt(WED, { off: { alerts: true } });
    expect(alertHtml(off)).toHaveLength(0);
    expect(Object.keys(readState().sentAlerts as object).length).toBeGreaterThan(0);

    const on = await tickAt(WED, { off: {} });
    expect(alertHtml(on)).toHaveLength(0);
  });

  it("the weekly report: switch and due hour", async () => {
    const stale = () =>
      writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, lastWeekly: "2026-10-09", lastMonthly: "2026-10" }));
    const weekly = (r: HubResponse) => (r.messages ?? []).filter((m) => m.html.includes("Heti"));
    stale();
    expect(weekly(await tickAt([2026, 10, 16, 18, 0], { weeklyHour: 20 }))).toHaveLength(0);
    expect(weekly(await tickAt([2026, 10, 16, 20, 0], { weeklyHour: 20 }))).toHaveLength(1);
    stale();
    expect(weekly(await tickAt([2026, 10, 16, 18, 0], { off: { weekly: true } }))).toHaveLength(0);
    expect(readState().lastWeekly).toBe("2026-10-16");
  });

  it("the monthly report waits for the set hour", async () => {
    const stale = () =>
      writeFileSync(stateFile, JSON.stringify({ sentAlerts: {}, warned: {}, lastWeekly: "2026-09-25", lastMonthly: "2026-09" }));
    stale();
    await tickAt([2026, 10, 1, 9, 0], { monthlyHour: 10 });
    expect(readState().lastMonthly).toBe("2026-09");
    await tickAt([2026, 10, 1, 10, 0], { monthlyHour: 10 });
    expect(readState().lastMonthly).toBe("2026-10");
  });

  it("the quiet hours go back to the hub with every tick; null means none", async () => {
    expect((await tickAt(WED)).quietHours).toEqual({ from: "22:00", to: "07:30" });
    expect((await tickAt(WED, { quietHours: { from: "23:00", to: "06:00" } })).quietHours).toEqual({ from: "23:00", to: "06:00" });
    expect((await tickAt(WED, { quietHours: null })).quietHours).toBeNull();
  });

  it("“Miért mozdult?” off: a big move is reported but no search is requested", async () => {
    const run = async (value: Partial<NotifySettings>) => {
      rmSync(stateFile, { force: true });
      const deps: Deps = {
        load: async () => {
          const ctx = contextAt([2026, 10, 14, 10, 5], withNotify(value));
          const q = ctx.liveQuotes[WBIT];
          q.price = Math.round(q.prevClose! * 0.95 * 10_000) / 10_000;
          return ctx;
        },
        stateFile,
        env: { bigMovePct: 1, positionMovePct: 1, wealthStepHuf: 1_000_000, drawdownStepPct: 5 },
        runJob: async () => "started",
      };
      const r = await call(jobReq(), deps);
      expect(r.messages!.some((m) => m.html.includes("<b>WBIT: −5,0%</b> ma"))).toBe(true);
      return (readState().why as WhyState).request;
    };
    expect(await run({})).toBeDefined();
    expect(await run({ ai: { why: "off" } as NotifySettings["ai"] })).toBeUndefined();
  });

  describe("AI jobs", () => {
    const EVENING: [number, number, number, number, number] = [2026, 10, 14, 18, 15];
    const NIGHT: [number, number, number, number, number] = [2026, 10, 15, 3, 30];
    const analysisAnswer = {
      headline: "Minden rendben.",
      overall: "rendben",
      changes: "Nőtt a készpénz aránya.",
      sections: [{ topic: "egyeb", title: "Egyéb", status: "rendben", text: "Semmi különös." }],
    };
    const newsSetup = (ai: Partial<NotifySettings["ai"]>) => {
      const engine = fakeEngine([fixtureNewsBody()]);
      const deps: Deps = {
        ...depsFor(() => contextAt(EVENING, withNotify({ ai: ai as NotifySettings["ai"] }))),
        news: () => ({ engine, store: memoryStore(), cacheDir: join(dir, "news"), appUrl: "https://example.com/app/" }),
      };
      return { deps, engine };
    };
    const analysisSetup = (ai: Partial<NotifySettings["ai"]>) => {
      const engine = fakeEngine([analysisAnswer]);
      const deps: Deps = {
        ...depsFor(() => contextAt(NIGHT, withNotify({ ai: ai as NotifySettings["ai"] }))),
        analysis: () => ({ engine, store: memoryStore(), cacheDir: join(dir, "analysis") }),
      };
      return { deps, engine };
    };
    const manualReq = (job: string) => JSON.stringify({ ...JSON.parse(jobReq(job)), manual: true });

    it("news off: no search, the day isn't marked done; a manual run still works", async () => {
      const { deps, engine } = newsSetup({ newsEvening: "off" });
      expect(await call(jobReq("news-evening"), deps)).toEqual({ v: 1, messages: [] });
      expect(engine.prompts).toHaveLength(0);
      expect(existsSync(stateFile)).toBe(false);
      expect((await call(manualReq("news-evening"), deps)).messages).toHaveLength(1);
    });

    it("news silent: the search runs and is marked done, but no message", async () => {
      const { deps, engine } = newsSetup({ newsEvening: "silent" });
      expect(await call(jobReq("news-evening"), deps)).toEqual({ v: 1, messages: [] });
      expect(engine.prompts).toHaveLength(1);
      expect(readState().news).toEqual({ evening: "2026-10-14" });
    });

    it("the morning and the evening edition have their own setting", async () => {
      const { deps, engine } = newsSetup({ newsMorning: "off", newsEvening: "notify" });
      expect((await call(jobReq("news-evening"), deps)).messages).toHaveLength(1);
      expect(engine.prompts).toHaveLength(1);
    });

    it("analysis off: no AI run; silent: runs, no message", async () => {
      const off = analysisSetup({ analysis: "off" });
      expect(await call(jobReq("analysis"), off.deps)).toEqual({ v: 1, messages: [] });
      expect(off.engine.prompts).toHaveLength(0);
      expect(existsSync(stateFile)).toBe(false);

      const silent = analysisSetup({ analysis: "silent" });
      expect(await call(jobReq("analysis"), silent.deps)).toEqual({ v: 1, messages: [] });
      expect(silent.engine.prompts).toHaveLength(1);
      expect(readState().analysis).toBe("2026-10-15");
    });
  });
});
