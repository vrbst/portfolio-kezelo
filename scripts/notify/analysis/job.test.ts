import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextAt } from "../testContext";
import { fakeEngine, memoryStore } from "../news/testFakes";
import { ANALYSIS_LATEST_PATH, validateNightly, type Analysis } from "../../../src/lib/aiAnalysis";
import { analysisText } from "../reports";
import { askAnalysis, buildAnalysisPrompt, latestAnalysis, makeAnalysis, analysisContext } from "./job";

// The nightly analysis with a fake AI and a fake repo, on the invented portfolio.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "analysis-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const answer = (changes = "A TBSZ egy hónappal közelebb került a mérföldkőhöz."): Analysis => ({
  headline: "A portfólió <rendben>, a koncentráció a figyelendő.",
  overall: "figyelj",
  changes,
  sections: [
    { topic: "koncentracio", title: "Koncentráció", status: "figyelj", text: "A VWCE a vagyon nagy része." },
    { topic: "tbsz", title: "TBSZ", status: "teendo", text: "Közeleg a 3 éves mérföldkő." },
  ],
});

const THU_NIGHT: [number, number, number, number, number] = [2026, 10, 15, 3, 30];
const deps = (engine: ReturnType<typeof fakeEngine>, store: ReturnType<typeof memoryStore>) => ({
  engine,
  store,
  cacheDir: join(dir, "cache"),
});

describe("makeAnalysis", () => {
  it("runs the AI on the app's snapshot, keeps a copy and uploads latest + the day", async () => {
    const store = memoryStore();
    const engine = fakeEngine([answer()]);
    const ctx = contextAt(THU_NIGHT);
    const run = await makeAnalysis(ctx, deps(engine, store), { reuseLocal: false });
    expect(run.uploadError).toBeUndefined();
    expect(run.analysis).toMatchObject({ day: "2026-10-15", engine: "fake", model: "teszt", costUsd: 0.1 });
    expect(store.writes).toEqual(["analysis/2026-10-15.json", ANALYSIS_LATEST_PATH]);
    expect(validateNightly(JSON.parse(store.files[ANALYSIS_LATEST_PATH]))).toEqual(run.analysis);
    expect(existsSync(join(dir, "cache", "2026-10-15.json"))).toBe(true);
    // The prompt carries the same snapshot the app's AI page builds.
    expect(engine.prompts[0]).toContain(analysisContext(ctx));
    expect(engine.prompts[0]).toContain("Portfólió pillanatkép");
  });

  it("gives the previous analysis to the AI for the 'what changed' part", async () => {
    const store = memoryStore();
    await makeAnalysis(contextAt([2026, 10, 14, 3, 30]), deps(fakeEngine([answer("")]), store), { reuseLocal: false });
    const engine = fakeEngine([answer()]);
    await makeAnalysis(contextAt(THU_NIGHT), deps(engine, store), { reuseLocal: false });
    expect(engine.prompts[0]).toContain("Előző elemzés (");
    expect(engine.prompts[0]).toContain("Koncentráció");
    expect((await latestAnalysis(store))?.day).toBe("2026-10-15");
  });

  it("has no comparison on the first run", () => {
    expect(buildAnalysisPrompt("ctx", null)).not.toContain("Előző elemzés");
  });

  it("a resend reuses the local copy (no new AI run) and retries the upload", async () => {
    const failing = memoryStore();
    failing.write = async () => {
      throw new Error("HTTP 403 forbidden");
    };
    const engine = fakeEngine([answer()]);
    const first = await makeAnalysis(contextAt(THU_NIGHT), deps(engine, failing), { reuseLocal: false });
    expect(first.uploadError).toContain("NEWS_GITHUB_TOKEN");
    const store = memoryStore();
    const again = await makeAnalysis(contextAt(THU_NIGHT), deps(fakeEngine([]), store), { reuseLocal: true });
    expect(again.uploadError).toBeUndefined();
    expect(again.analysis).toEqual(first.analysis);
    expect(store.writes).toContain(ANALYSIS_LATEST_PATH);
  });
});

describe("askAnalysis", () => {
  it("retries once with the problem spelled out", async () => {
    const engine = fakeEngine([{ nonsense: true }, answer()]);
    const r = await askAnalysis(engine, "kérdés");
    expect(r.data.sections).toHaveLength(2);
    expect(engine.prompts[1]).toContain("nem volt érvényes");
    expect(r.costUsd).toBeCloseTo(0.2);
  });

  it("gives up after two bad answers", async () => {
    await expect(askAnalysis(fakeEngine([{}, {}]), "kérdés")).rejects.toThrow("kétszer is hibás");
  });
});

describe("analysisText", () => {
  const a = () =>
    validateNightly({ version: 1, day: "2026-10-15", at: "2026-10-15T01:30:00Z", model: "opus", engine: "claude-code", costUsd: 0, data: answer() });

  it("says it is done and spells out what changed, the rest is in the app", () => {
    const t = analysisText(a(), "https://example.com/app/");
    expect(t).toContain("AI-elemzés kész");
    expect(t).toContain("Mi változott:</b> A TBSZ egy hónappal közelebb");
    expect(t).toContain("1 teendő");
    expect(t).toContain('href="https://example.com/app/#/ai"');
    // Model text is escaped for Telegram's HTML.
    expect(t).toContain("&lt;rendben&gt;");
  });

  it("says so when there was nothing to compare to, and warns about a failed upload", () => {
    const x = a();
    x.data.changes = "";
    const t = analysisText(x, "https://example.com/app/", "HTTP 403");
    expect(t).toContain("nincs előző elemzés");
    expect(t).toContain("nem sikerült feltölteni");
  });
});
