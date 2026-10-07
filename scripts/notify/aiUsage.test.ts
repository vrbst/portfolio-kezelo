import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_USAGE_KEEP_DAYS,
  AI_USAGE_MAX_LINES,
  aiCostText,
  appendAiUsage,
  readAiUsage,
  summarizeAiUsage,
  trimAiUsage,
  usageFromClaudeOutput,
  usageFromClaudeResult,
  weeklyAiLine,
  type AiUsageRecord,
} from "./aiUsage";
import { aiUsageRecord, runHandler, type Deps, type HubResponse } from "./tg-app";
import { weeklyText } from "./reports";
import { contextAt } from "./testContext";
import { fakeEngine, memoryStore } from "./news/testFakes";
import { fixtureNewsBody } from "../../src/test/newsFixture";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-usage-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 14, 12, 0);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const rec = (over: Partial<AiUsageRecord> = {}): AiUsageRecord => ({
  at: daysAgo(1),
  job: "news-morning",
  model: "opus",
  ok: true,
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationTokens: 2000,
  cacheReadTokens: 30_000,
  webSearches: 4,
  turns: 6,
  durationMs: 90_000,
  costUsd: 1.2,
  ...over,
});

describe("claude -p --output-format json → usage", () => {
  it("reads tokens, searches, turns, time, cost and the per-model split", () => {
    const u = usageFromClaudeResult({
      type: "result",
      subtype: "success",
      duration_ms: 81_234,
      num_turns: 7,
      total_cost_usd: 0.8125,
      usage: {
        input_tokens: 120,
        output_tokens: 3400,
        cache_creation_input_tokens: 15_000,
        cache_read_input_tokens: 220_000,
        server_tool_use: { web_search_requests: 5, web_fetch_requests: 2 },
      },
      modelUsage: {
        "claude-sonnet-5-5": {
          inputTokens: 120,
          outputTokens: 3400,
          cacheReadInputTokens: 220_000,
          cacheCreationInputTokens: 15_000,
          webSearchRequests: 5,
          costUSD: 0.8,
        },
      },
    });
    expect(u).toEqual({
      inputTokens: 120,
      outputTokens: 3400,
      cacheCreationTokens: 15_000,
      cacheReadTokens: 220_000,
      webSearches: 5,
      turns: 7,
      durationMs: 81_234,
      costUsd: 0.8125,
      models: {
        "claude-sonnet-5-5": {
          inputTokens: 120,
          outputTokens: 3400,
          cacheCreationTokens: 15_000,
          cacheReadTokens: 220_000,
          webSearches: 5,
          costUsd: 0.8,
        },
      },
    });
  });

  it("missing or odd fields are zero or left out, never an error", () => {
    expect(usageFromClaudeResult({ result: "x", usage: { input_tokens: "sok" } })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearches: 0,
    });
    expect(usageFromClaudeResult(null).webSearches).toBe(0);
    expect(usageFromClaudeOutput("nem json")).toBeUndefined();
    expect(usageFromClaudeOutput('{"is_error":true,"total_cost_usd":0.05}')?.costUsd).toBe(0.05);
  });

  it("a run without usage keeps the measured time and the error", () => {
    const r = aiUsageRecord("news-why", "sonnet", { ok: false, error: "időtúllépés", durationMs: 720_000 }, NOW);
    expect(r).toEqual({
      at: NOW.toISOString(),
      job: "news-why",
      model: "sonnet",
      ok: false,
      error: "időtúllépés",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearches: 0,
      durationMs: 720_000,
    });
  });
});

describe("the log file", () => {
  it("appends one JSON line per run and reads them back, skipping broken lines", () => {
    const file = join(dir, "sub", "ai-usage.jsonl");
    appendAiUsage(file, rec(), NOW);
    appendAiUsage(file, rec({ job: "news-why", model: "sonnet" }), NOW);
    writeFileSync(file, readFileSync(file, "utf8") + "{félbe\n" + '{"at":1}\n', "utf8");
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
    expect(readAiUsage(file).map((r) => r.job)).toEqual(["news-morning", "news-why"]);
    expect(readAiUsage(join(dir, "nincs.jsonl"))).toEqual([]);
  });

  it("drops lines older than the keep window and keeps at most the max count", () => {
    const old = rec({ at: daysAgo(AI_USAGE_KEEP_DAYS + 1) });
    const fresh = rec({ at: daysAgo(AI_USAGE_KEEP_DAYS - 1) });
    expect(trimAiUsage([old, fresh], NOW)).toEqual([fresh]);
    const many = Array.from({ length: AI_USAGE_MAX_LINES + 3 }, (_, i) => rec({ job: `j${i}` }));
    const kept = trimAiUsage(many, NOW);
    expect(kept).toHaveLength(AI_USAGE_MAX_LINES);
    expect(kept[kept.length - 1].job).toBe(`j${AI_USAGE_MAX_LINES + 2}`);
  });

  it("a failed write is logged, never thrown", () => {
    const blocked = join(dir, "blocked");
    mkdirSync(join(blocked, "ai-usage.jsonl.tmp"), { recursive: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => appendAiUsage(join(blocked, "ai-usage.jsonl"), rec(), NOW)).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("summaries", () => {
  const log = [
    rec({ at: daysAgo(1), job: "news-morning", model: "opus", costUsd: 1.5 }),
    rec({ at: daysAgo(2), job: "news-why", model: "sonnet", costUsd: 0.25, webSearches: 2 }),
    rec({ at: daysAgo(3), job: "news-why", model: "sonnet", ok: false, costUsd: 0.05 }),
    rec({ at: daysAgo(10), job: "news-evening", model: "opus", costUsd: 2 }),
    rec({ at: daysAgo(40), job: "hirkereses", model: "opus", costUsd: 9 }),
  ];

  it("totals by job and by model", () => {
    const s = summarizeAiUsage(log.slice(0, 3));
    expect(s.total.runs).toBe(3);
    expect(s.total.failed).toBe(1);
    expect(s.total.costUsd).toBeCloseTo(1.8);
    expect(s.byJob["news-why"].runs).toBe(2);
    expect(s.byJob["news-why"].webSearches).toBe(6);
    expect(Object.keys(s.byModel).sort()).toEqual(["opus", "sonnet"]);
  });

  it("/koltseg text: 7 and 30 days, per job and model, with the note on $", () => {
    const t = aiCostText(log, NOW);
    expect(t).toContain("🤖 <b>AI-felhasználás</b>");
    const [week, month] = t.split("<b>Elmúlt 30 nap</b>");
    expect(week).toContain("3 futás (1 sikertelen), ~$1,80");
    expect(week).toContain("• Miért mozdult?: 2 futás (1 sikertelen), ~$0,30");
    expect(week).toContain("• Reggeli hírek: 1 futás, ~$1,50");
    expect(week).not.toContain("Esti hírek");
    expect(month).toContain("4 futás (1 sikertelen), ~$3,80");
    expect(month).toContain("• Esti hírek: 1 futás, ~$2,00");
    expect(month).not.toContain("/hirkereses");
    expect(month).toContain("Modellenként: opus 2× ~$3,50, sonnet 2× ~$0,30");
    expect(t).toContain("előfizetés keretéből");
  });

  it("/koltseg with an empty log says so", () => {
    expect(aiCostText([], NOW)).toContain("Nem volt AI-futás.");
  });

  it("the weekly line, with last week for comparison; none without runs", () => {
    expect(weeklyAiLine(log, NOW)).toBe("🤖 AI: 3 futás, ~$1,80 API-áron (előző hét: $2,00)");
    expect(weeklyAiLine([rec({ costUsd: 4.8 })], NOW)).toBe("🤖 AI: 1 futás, ~$4,80 API-áron");
    expect(weeklyAiLine([rec({ at: daysAgo(10) })], NOW)).toBeNull();
    expect(weeklyAiLine(undefined, NOW)).toBeNull();
    expect(weeklyAiLine([], NOW)).toBeNull();
  });

  it("the weekly report carries the line only when there were runs", () => {
    const ctx = contextAt([2026, 10, 16, 18, 0]);
    expect(weeklyText(ctx)).not.toContain("🤖 AI");
    ctx.aiUsage = [rec({ at: new Date(2026, 9, 15, 7, 45).toISOString(), costUsd: 4.8 })];
    expect(weeklyText(ctx).split("\n").pop()).toBe("🤖 AI: 1 futás, ~$4,80 API-áron");
  });
});

describe("the bot", () => {
  const request = (body: object) => JSON.stringify({ v: 1, id: "r", app: "p", now: "", ...body });
  const call = async (input: string, deps: Deps) => JSON.parse(await runHandler(input, deps)) as HubResponse;
  const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };

  it("/koltseg reads the log", async () => {
    const aiUsageFile = join(dir, "ai-usage.jsonl");
    appendAiUsage(aiUsageFile, rec({ at: new Date().toISOString(), job: "news-why", model: "sonnet", costUsd: 0.4 }));
    const deps: Deps = { load: async () => contextAt([2026, 10, 14, 12, 0]), stateFile: join(dir, "state.json"), env, aiUsageFile };
    const r = await call(request({ type: "command", command: "koltseg", args: "" }), deps);
    expect(r.messages![0].html).toContain("• Miért mozdult?: 1 futás, ~$0,40");
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("the news job names itself to the engine: scheduled edition or /hirkereses", async () => {
    const jobs: string[] = [];
    const engine = fakeEngine([fixtureNewsBody(), fixtureNewsBody()]);
    const store = memoryStore();
    const deps: Deps = {
      load: async () => contextAt([2026, 10, 14, 18, 15]),
      stateFile: join(dir, "state.json"),
      env,
      news: (job) => {
        jobs.push(job ?? "");
        return { engine, store, cacheDir: join(dir, "news"), appUrl: "https://example.com/app/" };
      },
      runJob: async () => "started",
    };
    await call(request({ type: "job", job: "news-evening" }), deps);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 14, 19, 0) });
    await call(request({ type: "command", command: "hirkereses", args: "" }), deps);
    vi.useRealTimers();
    deps.load = async () => contextAt([2026, 10, 14, 19, 1]);
    await call(request({ type: "job", job: "news-evening" }), deps);
    expect(jobs).toEqual(["news-evening", "hirkereses"]);
  });
});
