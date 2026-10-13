import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { weeklyOutlookAi } from "./weekly";
import { readAiState } from "./aiState";
import type { OutlookTarget } from "./refresh";
import { fakeEngine, memoryStore } from "../news/testFakes";
import { OUTLOOK_PATH } from "../../../src/lib/outlook";

const targets: OutlookTarget[] = [{ key: "S", name: "Példa Bank", isin: "HU0000000001", currency: "HUF", type: "stock" }];
const answer = {
  assets: [
    {
      key: "S",
      assetClass: "equity",
      views: [{ house: "UBS", kind: "target", value: 52_900, unit: "HUF", publishedAt: "2026-07-20", url: "https://example.com/ubs" }],
    },
  ],
};
const sat0430 = new Date(2026, 9, 17, 4, 30);
const sat0815 = new Date(2026, 9, 17, 8, 15);
const sun = new Date(2026, 9, 18, 9, 0);
const limitHit = { name: "f", model: "m", run: async () => Promise.reject(new Error("Claude usage limit reached, resets at 8am")) };

let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outlook-weekly-"));
  stateFile = join(dir, "outlook", "ai-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("weeklyOutlookAi", () => {
  it("04:30 succeeds, so the 08:15 retry does nothing (and spends no AI run)", async () => {
    const store = memoryStore();
    const first = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile }, sat0430);
    expect(first.status).toBe("ok");
    const engine = fakeEngine([answer]);
    const retry = await weeklyOutlookAi(targets, { engine, store, stateFile }, sat0815);
    expect(retry).toEqual({ status: "skipped" });
    expect(engine.prompts).toEqual([]);
  });

  it("the usage limit at 04:30 is recorded, the data stays, and the retry then succeeds", async () => {
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify({ v: 1, updatedAt: "2026-10-10T00:00:00Z", profiles: {}, items: {}, errors: {} }) });
    const before = store.files[OUTLOOK_PATH];
    const first = await weeklyOutlookAi(targets, { engine: limitHit, store, stateFile }, sat0430);
    expect(first).toMatchObject({ status: "failed", reason: "limit" });
    expect(store.files[OUTLOOK_PATH]).toBe(before);
    expect(readAiState(stateFile)?.lastAttempt).toMatchObject({ ok: false, reason: "limit" });
    expect(readAiState(stateFile)?.lastSuccessWeek).toBeUndefined();

    const retry = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile }, sat0815);
    expect(retry.status).toBe("ok");
    expect(readAiState(stateFile)?.lastSuccessWeek).toBe("2026-W42");
  });

  it("Saturday off: the Sunday catch-up runs", async () => {
    const out = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store: memoryStore(), stateFile }, sun);
    expect(out.status).toBe("ok");
  });

  it("an ordinary error is told apart from the limit", async () => {
    const out = await weeklyOutlookAi(targets, { engine: fakeEngine([{ a: 1 }, { b: 2 }]), store: memoryStore(), stateFile }, sat0430);
    expect(out).toMatchObject({ status: "failed", reason: "error" });
  });

  it("a manual run goes even when this week is done", async () => {
    const store = memoryStore();
    await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile }, sat0430);
    const engine = fakeEngine([answer]);
    const out = await weeklyOutlookAi(targets, { engine, store, stateFile }, sat0815, { manual: true });
    expect(out.status).toBe("ok");
    expect(engine.prompts).toHaveLength(1);
  });
});
