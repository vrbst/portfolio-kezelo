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
import { fixtureNewsBody } from "../../src/test/newsFixture";
import { VWCE, WBIT } from "../../src/test/fixture";
import { article } from "./news/why";
import type { WhyState } from "./state";
import type { MoveAlertSettings } from "../../src/lib/planPrefs";

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

  it("/hirek: the latest digest, or a note when there is none yet", async () => {
    const empty = newsDeps(EVENING);
    expect((await call(commandReq("hirek"), empty.deps)).messages![0].html).toContain("Még nincs hírösszefoglaló");
    await call(jobReq("news-evening"), empty.deps);
    const r = await call(commandReq("hirek"), empty.deps);
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
    expect((await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 2]))).messages![0].html).toContain("Már keresem");
    await call(jobReq("news-evening"), s.at([2026, 10, 14, 15, 3]));
    now(2026, 10, 14, 15, 10);
    const r = await call(commandReq("hirkereses"), s.at([2026, 10, 14, 15, 10]));
    expect(r.messages![0].html).toContain("10 perce volt. Újat 20 perc múlva");
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
