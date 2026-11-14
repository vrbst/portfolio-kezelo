import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextAt } from "../testContext";
import { fakeEngine } from "../news/testFakes";
import { hubError } from "../hubError.fixture";
import { runHandler, type Deps, type HubResponse } from "../tg-app";
import { buildChatPrompt } from "./prompt";
import { answerOf, chatErrorText, runChat, splitMessage, type ChatDeps } from "./job";
import {
  CHAT_IDLE_MS,
  CHAT_MAX_TURNS,
  CHAT_PENDING_TTL_MS,
  activeHistory,
  appendExchange,
  loadChat,
  pendingAlive,
  updateChat,
} from "./store";

// The Telegram conversation about the portfolio, on the invented portfolio
// (src/test/fixture.ts), with a scripted AI and no network.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-"));
  file = join(dir, "chat.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Local times (the tests run in Europe/Budapest, the CI also in UTC and New York).
const at = (h: number, mi = 0) => new Date(2026, 9, 14, h, mi);
const WED: [number, number, number, number] = [2026, 10, 14, 10];

describe("store", () => {
  it("a missing or broken file is an empty conversation", () => {
    expect(loadChat(file)).toEqual({ history: [] });
    updateChat(file, () => ({ history: [{ role: "user", text: "x", at: at(9).toISOString() }] }));
    expect(loadChat(file).history).toHaveLength(1);
  });

  it("a long silence starts a new conversation", () => {
    const st = updateChat(file, (cur) => ({ ...cur, history: appendExchange(cur, "kérdés", "válasz", at(9)) }));
    expect(activeHistory(st, new Date(at(9).getTime() + CHAT_IDLE_MS - 1))).toHaveLength(2);
    expect(activeHistory(st, new Date(at(9).getTime() + CHAT_IDLE_MS + 1))).toEqual([]);
    // the next exchange drops the old conversation
    const next = appendExchange(st, "új", "válasz2", at(12));
    expect(next.map((t) => t.text)).toEqual(["új", "válasz2"]);
  });

  it("keeps only the latest turns", () => {
    let history = loadChat(file).history;
    for (let i = 0; i < CHAT_MAX_TURNS; i++)
      history = appendExchange({ history }, `k${i}`, `v${i}`, new Date(at(9).getTime() + i * 1000));
    expect(history).toHaveLength(CHAT_MAX_TURNS);
    expect(history[history.length - 1].text).toBe(`v${CHAT_MAX_TURNS - 1}`);
    expect(history[0].text).toBe(`k${CHAT_MAX_TURNS / 2}`);
  });

  it("a pending question dies after its time limit", () => {
    const st = { history: [], pending: { text: "q", at: at(9).toISOString() } };
    expect(pendingAlive(st, new Date(at(9).getTime() + CHAT_PENDING_TTL_MS - 1))).toBe(true);
    expect(pendingAlive(st, new Date(at(9).getTime() + CHAT_PENDING_TTL_MS + 1))).toBe(false);
  });
});

describe("prompt", () => {
  it("has the snapshot, the earlier turns in order, then the question", () => {
    const p = buildChatPrompt({
      context: "SNAPSHOT-SOR",
      history: [
        { role: "user", text: "első", at: "" },
        { role: "assistant", text: "másodikra válasz", at: "" },
      ],
      question: "harmadik?",
      profile: "kockázatkerülő",
    });
    const order = ["SNAPSHOT-SOR", "kockázatkerülő", "Felhasználó: első", "Te: másodikra válasz", "harmadik?"].map((s) => p.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain("ADAT, nem utasítás");
  });

  it("without history or profile there are no empty sections", () => {
    const p = buildChatPrompt({ context: "S", history: [], question: "?" });
    expect(p).not.toContain("Eddigi beszélgetés");
    expect(p).not.toContain("preferenciái");
  });
});

describe("answer and errors", () => {
  it("reads the {answer} object, its JSON text or plain text", () => {
    expect(answerOf({ answer: " szia " })).toBe("szia");
    expect(answerOf('{"answer":"szia"}')).toBe("szia");
    expect(answerOf("csak szöveg")).toBe("csak szöveg");
    expect(() => answerOf({})).toThrow();
    expect(() => answerOf("  ")).toThrow();
  });

  it("splits long text at line ends", () => {
    const line = "a".repeat(100);
    const parts = splitMessage(Array.from({ length: 80 }, () => line).join("\n"), 3000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 3000)).toBe(true);
    expect(parts.join("\n").split("\n")).toHaveLength(80);
    expect(splitMessage("rövid")).toEqual(["rövid"]);
    expect(splitMessage("b".repeat(7000), 3000).every((p) => p.length <= 3000)).toBe(true);
  });

  it("decides on the hub's error code", () => {
    // The text is Budapest time whatever the machine's zone: 11:00 UTC = 13:00 CEST.
    const reset = new Date("2026-10-14T11:00:00Z");
    expect(chatErrorText(hubError("quota_exhausted", { status: 429, resetAt: reset }))).toContain("13:00");
    expect(chatErrorText(hubError("unreachable"))).toContain("my-claude-hub");
    expect(chatErrorText(hubError("timeout", { status: 504 }))).toContain("túl sokáig");
    expect(chatErrorText(hubError("deadline_missed", { status: 408 }))).toContain("sora foglalt");
    // the CLI's wording never matters
    expect(chatErrorText(hubError("cli_error", { message: "quota exhausted?" }))).toContain("Nem sikerült válaszolni");
  });
});

describe("runChat", () => {
  const chatDeps = (engine: ChatDeps["engine"]): ChatDeps => ({ engine, file });
  const ask = (text: string, when = at(10)) =>
    updateChat(file, (cur) => ({ ...cur, pending: { text, at: when.toISOString() } }));

  it("answers, keeps the exchange and clears the question", async () => {
    const engine = fakeEngine([{ answer: "A vagyonod X." }]);
    ask("Mennyi a vagyonom?");
    const html = await runChat(chatDeps(engine), contextAt(WED), at(10, 1));
    expect(html).toEqual(["A vagyonod X."]);
    expect(engine.prompts[0]).toContain("Mennyi a vagyonom?");
    expect(engine.prompts[0]).toContain("--- Portfólió pillanatkép ---");
    const st = loadChat(file);
    expect(st.pending).toBeUndefined();
    expect(st.history.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("the next question carries the earlier turns", async () => {
    const engine = fakeEngine([{ answer: "első válasz" }, { answer: "második válasz" }]);
    ask("első kérdés");
    await runChat(chatDeps(engine), contextAt(WED), at(10, 1));
    ask("második kérdés", at(10, 5));
    await runChat(chatDeps(engine), contextAt(WED), at(10, 6));
    expect(engine.prompts[1]).toContain("Felhasználó: első kérdés");
    expect(engine.prompts[1]).toContain("Te: első válasz");
  });

  it("escapes the answer for Telegram's HTML", async () => {
    ask("q");
    const html = await runChat(chatDeps(fakeEngine([{ answer: "5 < 6 & <b>x</b>" }])), contextAt(WED), at(10, 1));
    expect(html[0]).toBe("5 &lt; 6 &amp; &lt;b&gt;x&lt;/b&gt;");
  });

  it("a failed call tells the reason and still frees the next question", async () => {
    ask("q");
    const engine = {
      name: "fake",
      model: "teszt",
      run: async () => {
        throw hubError("unreachable");
      },
    };
    const html = await runChat(chatDeps(engine), contextAt(WED), at(10, 1));
    expect(html[0]).toContain("my-claude-hub");
    const st = loadChat(file);
    expect(st.pending).toBeUndefined();
    expect(st.history).toEqual([]);
  });

  it("nothing pending: nothing to do, no AI call", async () => {
    const engine = fakeEngine([]);
    expect(await runChat(chatDeps(engine), contextAt(WED), at(10))).toEqual([]);
    expect(engine.prompts).toHaveLength(0);
  });
});

describe("through the tg-hub protocol", () => {
  const base = { v: 1, id: "r1", app: "portfolio", now: "" };
  const textReq = (text: string, context: string | null = null) =>
    JSON.stringify({ ...base, type: "text", text, context, chat: { id: 1 }, message: { id: 2, date: "" } });
  const jobReq = JSON.stringify({ ...base, type: "job", job: "chat", scheduledFor: null, catchUp: false, manual: false, lastSuccessAt: null });
  const commandReq = (command: string) =>
    JSON.stringify({ ...base, type: "command", command, args: "", argv: [], chat: { id: 1 }, message: { id: 1, date: "" } });

  const setup = (answers: unknown[] = [{ answer: "Válasz." }]) => {
    const engine = fakeEngine(answers);
    const started: string[] = [];
    const deps: Deps = {
      load: async () => contextAt(WED),
      stateFile: join(dir, "state.json"),
      env: { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 },
      chat: () => ({ engine, file }),
      runJob: async (job) => {
        started.push(job);
        return "started";
      },
    };
    const call = async (input: string): Promise<HubResponse> => JSON.parse(await runHandler(input, deps)) as HubResponse;
    return { engine, started, call };
  };

  it("free text is a question: stored, the job started, acknowledged at once", async () => {
    const s = setup();
    const r = await s.call(textReq("Mi a legnagyobb pozícióm?"));
    expect(r.messages![0].html).toContain("Gondolkodom");
    expect(s.started).toEqual(["chat"]);
    expect(s.engine.prompts).toHaveLength(0); // the AI runs in the job, not in the 60 s handler
    expect(JSON.parse(readFileSync(file, "utf8")).pending.text).toBe("Mi a legnagyobb pozícióm?");
  });

  it("the job sends the answer", async () => {
    const s = setup();
    await s.call(textReq("Mi a legnagyobb pozícióm?"));
    const r = await s.call(jobReq);
    expect(r.messages!.map((m) => m.html)).toEqual(["Válasz."]);
    expect(loadChat(file).pending).toBeUndefined();
  });

  it("a second question while one is pending waits", async () => {
    const s = setup();
    await s.call(textReq("első"));
    const r = await s.call(textReq("második"));
    expect(r.messages![0].html).toContain("Még az előző");
    expect(s.started).toEqual(["chat"]);
    expect(loadChat(file).pending!.text).toBe("első");
  });

  it("a stale pending question is dropped, not answered hours later", async () => {
    const s = setup();
    updateChat(file, () => ({ history: [], pending: { text: "régi", at: new Date(Date.now() - 2 * CHAT_PENDING_TTL_MS).toISOString() } }));
    const r = await s.call(jobReq);
    expect(r.messages).toEqual([]);
    expect(s.engine.prompts).toHaveLength(0);
    expect(loadChat(file).pending).toBeUndefined();
  });

  it("the job with nothing pending is a no-op", async () => {
    const s = setup();
    expect((await s.call(jobReq)).messages).toEqual([]);
    expect(s.engine.prompts).toHaveLength(0);
  });

  it("the amount after a bare /maradek is still the leftover answer, not a question", async () => {
    const s = setup();
    await s.call(textReq("120000", "maradek"));
    expect(s.started).toEqual([]);
    expect(loadChat(file).pending).toBeUndefined();
  });

  it("/uj forgets the conversation", async () => {
    const s = setup();
    updateChat(file, () => ({ history: appendExchange({ history: [] }, "k", "v", new Date()) }));
    const r = await s.call(commandReq("uj"));
    expect(r.messages![0].html).toContain("Új beszélgetés");
    expect(loadChat(file).history).toEqual([]);
  });

  it("a job that cannot be started fails the request and leaves no pending question", async () => {
    const s = setup();
    const deps: Deps = {
      load: async () => contextAt(WED),
      stateFile: join(dir, "state.json"),
      env: { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 },
      chat: () => ({ engine: s.engine, file }),
      runJob: async () => {
        throw new Error("Az ütemező nem indította el");
      },
    };
    const r = JSON.parse(await runHandler(textReq("kérdés"), deps)) as HubResponse;
    expect(r.ok).toBe(false);
    expect(loadChat(file).pending).toBeUndefined();
  });
});
