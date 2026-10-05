import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextAt } from "../testContext";
import { savingsGoals } from "../../../src/test/fixture";
import { fixtureDigest, fixtureNewsBody } from "../../../src/test/newsFixture";
import { NEWS_INDEX_PATH, validateDigest, validateNewsIndex, withIndexEntry } from "../../../src/lib/newsSchema";
import { parseClaudeCodeOutput, type NewsEngine } from "./engine";
import { fakeEngine, memoryStore } from "./testFakes";
import { extractJson, latestDigest, makeDigest, type NewsDeps, type NewsStore } from "./job";
import { buildNewsPrompt, portfolioExposure } from "./prompt";

// The digest run with a fake AI and a fake repo, on the invented portfolio.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "news-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (engine: NewsEngine, store: NewsStore): NewsDeps => ({
  engine,
  store,
  cacheDir: join(dir, "cache"),
  appUrl: "https://example.com/app/",
});

const FRESH = { reuseLocal: false };
const RESEND = { reuseLocal: true };

const WED_EVENING: [number, number, number, number, number] = [2026, 10, 14, 18, 15];

describe("makeDigest", () => {
  it("asks the AI, keeps a local copy and uploads the digest and the index", async () => {
    const store = memoryStore();
    const engine = fakeEngine([fixtureNewsBody()]);
    const run = await makeDigest(contextAt(WED_EVENING), deps(engine, store), "evening", FRESH);
    expect(run.uploadError).toBeUndefined();
    expect(run.digest).toMatchObject({ day: "2026-10-14", edition: "evening", engine: "fake", model: "teszt", costUsd: 0.1 });
    expect(store.writes).toEqual(["news/2026-10-14-evening.json", NEWS_INDEX_PATH]);
    expect(validateDigest(JSON.parse(store.files["news/2026-10-14-evening.json"]))).toEqual(run.digest);
    expect(validateNewsIndex(JSON.parse(store.files[NEWS_INDEX_PATH])).entries).toHaveLength(1);
    expect(existsSync(join(dir, "cache", "2026-10-14-evening.json"))).toBe(true);
  });

  it("briefs the AI with what was already reported, older digests only", async () => {
    let idx = withIndexEntry(null, { ...fixtureDigest("2026-10-14", "morning"), items: [{ ...fixtureNewsBody().items[0], title: "Reggeli tétel" }] });
    idx = withIndexEntry(idx, { ...fixtureDigest("2026-10-14", "evening"), items: [{ ...fixtureNewsBody().items[0], title: "Esti tétel" }] });
    const store = memoryStore({ [NEWS_INDEX_PATH]: JSON.stringify(idx) });
    const engine = fakeEngine([fixtureNewsBody()]);
    // Re-making the morning edition: the evening one is later, not "before".
    await makeDigest(contextAt([2026, 10, 14, 7, 45]), deps(engine, store), "morning", FRESH);
    expect(engine.prompts[0]).not.toContain("Reggeli tétel");
    expect(engine.prompts[0]).not.toContain("Esti tétel");
    // The next evening sees both (the morning one as remade just now).
    const engine2 = fakeEngine([fixtureNewsBody()]);
    await makeDigest(contextAt([2026, 10, 15, 18, 15]), deps(engine2, store), "evening", FRESH);
    expect(engine2.prompts[0]).toContain("[2026-10-14 napzárta] Esti tétel");
    expect(engine2.prompts[0]).toContain("[2026-10-14 reggeli előzetes] Az MNB kivárást jelzett");
    expect(engine2.prompts[0]).not.toContain("Reggeli tétel");
    expect(engine2.prompts[0]).toContain("Napzártát írsz");
  });

  it("retries once on an invalid answer, then gives up", async () => {
    const ok = fakeEngine([{ headline: "" }, fixtureNewsBody()]);
    const run = await makeDigest(contextAt(WED_EVENING), deps(ok, memoryStore()), "evening", FRESH);
    expect(ok.prompts).toHaveLength(2);
    expect(ok.prompts[1]).toContain("nem volt érvényes (headline: üres)");
    expect(run.digest.costUsd).toBeCloseTo(0.2);

    const bad = fakeEngine([{ headline: "" }, "nincs itt JSON"]);
    await expect(makeDigest(contextAt(WED_EVENING), deps(bad, memoryStore()), "morning", FRESH)).rejects.toThrow(/kétszer/);
  });

  it("a failed upload keeps the digest; a resend reuses it without the AI", async () => {
    const store = memoryStore();
    store.write = async () => {
      throw new Error("Feltöltés sikertelen: HTTP 403");
    };
    const engine = fakeEngine([fixtureNewsBody()]);
    const run = await makeDigest(contextAt(WED_EVENING), deps(engine, store), "evening", FRESH);
    expect(run.uploadError).toMatch(/NEWS_GITHUB_TOKEN/);

    const store2 = memoryStore();
    const engine2 = fakeEngine([]);
    const rerun = await makeDigest(contextAt(WED_EVENING), deps(engine2, store2), "evening", RESEND);
    expect(engine2.prompts).toHaveLength(0);
    expect(rerun.uploadError).toBeUndefined();
    expect(rerun.digest).toEqual(run.digest);
  });

  it("a fresh run searches again even if today's copy exists", async () => {
    await makeDigest(contextAt(WED_EVENING), deps(fakeEngine([fixtureNewsBody()]), memoryStore()), "evening", FRESH);
    const again = fakeEngine([{ ...fixtureNewsBody(), headline: "Újabb fejlemények" }]);
    const run = await makeDigest(contextAt(WED_EVENING), deps(again, memoryStore()), "evening", FRESH);
    expect(again.prompts).toHaveLength(1);
    expect(run.digest.headline).toBe("Újabb fejlemények");
  });

  it("an unreadable index blocks the upload (it would be overwritten)", async () => {
    const store = memoryStore({ [NEWS_INDEX_PATH]: "{rossz" });
    const run = await makeDigest(contextAt(WED_EVENING), deps(fakeEngine([fixtureNewsBody()]), store), "evening", FRESH);
    expect(run.uploadError).toBeDefined();
    expect(store.writes).toEqual([]);
  });

  it("the day is the local one, also just after midnight in other zones", async () => {
    const run = await makeDigest(contextAt([2026, 10, 15, 0, 5]), deps(fakeEngine([fixtureNewsBody()]), memoryStore()), "morning", FRESH);
    expect(run.digest.day).toBe("2026-10-15");
  });
});

describe("latestDigest", () => {
  it("is the newest index entry's file, or null", async () => {
    expect(await latestDigest(memoryStore())).toBeNull();
    const d = fixtureDigest("2026-10-14", "morning");
    const store = memoryStore({
      [NEWS_INDEX_PATH]: JSON.stringify(withIndexEntry(null, d)),
      "news/2026-10-14-morning.json": JSON.stringify(d),
    });
    expect(await latestDigest(store)).toEqual(d);
  });
});

describe("what the AI is told", () => {
  it("weights and instruments only: no amount, no goal name", () => {
    const ctx = contextAt(WED_EVENING);
    const exposure = portfolioExposure(ctx);
    const prompt = buildNewsPrompt({ day: "2026-10-14", weekday: 3, edition: "morning", exposure, previous: [] });
    expect(exposure.join("\n")).toMatch(/VWCE.*\d+%/);
    // Stored as local midnight (UTC: the day before): the local day counts.
    expect(exposure.join("\n")).toMatch(/D261118 .*lejárat: 2026-11-18/);
    // (\s covers the no-break spaces of Hungarian number formatting too.)
    expect(prompt).not.toMatch(/\d[\d\s.,]*\s?(Ft|EUR\b|€)/);
    for (const g of savingsGoals()) expect(prompt).not.toContain(g.name);
    expect(prompt).toContain("Reggeli előzetest írsz");
  });
});

describe("parsing", () => {
  it("Claude Code's JSON result: the structured output and the cost", () => {
    expect(parseClaudeCodeOutput(JSON.stringify({ subtype: "success", structured_output: { a: 1 }, result: "x", total_cost_usd: 0.3 }))).toEqual({
      output: { a: 1 },
      costUsd: 0.3,
    });
    expect(parseClaudeCodeOutput(JSON.stringify({ subtype: "success", result: "{\"a\":1}" })).output).toBe("{\"a\":1}");
    expect(() => parseClaudeCodeOutput(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "" }))).toThrow(/error_max_turns/);
    expect(() => parseClaudeCodeOutput("not json")).toThrow(/nem JSON/);
  });

  it("extractJson: the object inside surrounding text", () => {
    expect(extractJson('Íme:\n```json\n{"a":{"b":1}}\n```')).toEqual({ a: { b: 1 } });
    expect(extractJson({ a: 1 })).toEqual({ a: 1 });
    expect(() => extractJson("semmi")).toThrow();
  });
});
