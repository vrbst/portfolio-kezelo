import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { weeklyOutlookAi } from "./weekly";
import { HubError } from "../hubClient";
import { readAiState } from "./aiState";
import { listPending } from "./issuerDocs";
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
const quotaError = () => new HubError("quota_exhausted", 429, "A kvóta elfogyott", { resetAt: null });
const deadlineError = () => new HubError("deadline_missed", 409, "Nem fér bele a job idejébe");
const limitHit = { name: "f", model: "m", run: async () => Promise.reject(quotaError()) };
const deadlineHit = { name: "f", model: "m", run: async () => Promise.reject(deadlineError()) };

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

  it("only the hub's quota code counts as a limit, whatever the text says", async () => {
    const lookalike = { name: "f", model: "m", run: async () => Promise.reject(new Error("Claude usage limit reached, HTTP 429")) };
    const out = await weeklyOutlookAi(targets, { engine: lookalike, store: memoryStore(), stateFile }, sat0430);
    expect(out).toMatchObject({ status: "failed", reason: "error" });
  });

  it("a view call that no longer fits the job's time leaves the week open for the retry", async () => {
    const store = memoryStore();
    const first = await weeklyOutlookAi(targets, { engine: deadlineHit, store, stateFile }, sat0430);
    expect(first).toMatchObject({ status: "failed", reason: "error" });
    expect(readAiState(stateFile)?.lastSuccessWeek).toBeUndefined();
    const retry = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile }, sat0815);
    expect(retry.status).toBe("ok");
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

describe("weeklyOutlookAi: the issuers' consensus documents", () => {
  const consensus = {
    price: 46_700,
    currency: "HUF",
    asOf: "2026-08-03",
    target: { min: 29_000, avg: 45_888, max: 58_667, count: 17 },
  };
  const putPending = () => {
    mkdirSync(join(dir, "outlook", "pending"), { recursive: true });
    writeFileSync(
      join(dir, "outlook", "pending", "S.json"),
      JSON.stringify({ key: "S", url: "https://example.com/c_20260803.pdf", fetchedAt: "2026-10-13T04:50:00Z", text: "Célár HUF 45.888" }),
    );
  };
  const docsOf = (engine: ReturnType<typeof fakeEngine> | { name: string; model: string; run: () => Promise<never> }) => ({
    docEngine: engine,
    docsDir: join(dir, "outlook"),
  });
  const consensusOf = (store: ReturnType<typeof memoryStore>) =>
    (JSON.parse(store.files[OUTLOOK_PATH]) as { items: Record<string, { consensus?: { source: string; target: { avg: number } }[] }> }).items.S?.consensus;

  it("after the week's run the waiting document is read too", async () => {
    putPending();
    const store = memoryStore();
    const out = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile, ...docsOf(fakeEngine([consensus])) }, sat0430);
    expect(out).toMatchObject({ status: "ok", docs: { done: ["S"], failed: {} } });
    expect(consensusOf(store)).toEqual([expect.objectContaining({ source: "issuer", target: expect.objectContaining({ avg: 45_888 }) })]);
    expect(listPending(join(dir, "outlook"))).toEqual([]);
  });

  it("the usage limit on the document does not fail the week; the retry reads it later", async () => {
    putPending();
    const store = memoryStore();
    const limit = { name: "f", model: "m", run: () => Promise.reject(quotaError()) };
    const first = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile, ...docsOf(limit) }, sat0430);
    expect(first).toMatchObject({ status: "ok", docs: { done: [] } });
    expect(readAiState(stateFile)?.lastSuccessWeek).toBe("2026-W42");
    expect(listPending(join(dir, "outlook"))).toHaveLength(1);

    const mainEngine = fakeEngine([answer]);
    const retry = await weeklyOutlookAi(targets, { engine: mainEngine, store, stateFile, ...docsOf(fakeEngine([consensus])) }, sat0815);
    expect(retry).toMatchObject({ status: "ok", docs: { done: ["S"] } });
    expect(mainEngine.prompts).toEqual([]); // the week is done: only the document was read
    expect(consensusOf(store)?.[0].source).toBe("issuer");
  });

  it("when a document call no longer fits the job's time, the loop stops and every document stays pending", async () => {
    const two: OutlookTarget[] = [...targets, { key: "T", name: "Másik Bank", isin: "HU0000000002", currency: "HUF", type: "stock" }];
    const answerTwo = { assets: [answer.assets[0], { ...answer.assets[0], key: "T" }] };
    mkdirSync(join(dir, "outlook", "pending"), { recursive: true });
    for (const key of ["S", "T"])
      writeFileSync(
        join(dir, "outlook", "pending", `${key}.json`),
        JSON.stringify({ key, url: `https://example.com/${key}_20260803.pdf`, fetchedAt: "2026-10-13T04:50:00Z", text: "Célár HUF 45.888" }),
      );
    let calls = 0;
    const docEngine = {
      name: "f",
      model: "m",
      run: () => {
        calls++;
        return Promise.reject(deadlineError());
      },
    };
    const out = await weeklyOutlookAi(two, { engine: fakeEngine([answerTwo]), store: memoryStore(), stateFile, ...docsOf(docEngine) }, sat0430);
    expect(out).toMatchObject({ status: "ok" }); // the week's run itself is done
    expect(calls).toBe(1);
    expect(listPending(join(dir, "outlook")).map((d) => d.key)).toEqual(["S", "T"]);
  });

  it("a finished week with nothing waiting stays a no-op (no AI call at all)", async () => {
    const store = memoryStore();
    await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store, stateFile }, sat0430);
    const docEngine = fakeEngine([consensus]);
    const out = await weeklyOutlookAi(targets, { engine: fakeEngine([]), store, stateFile, docEngine, docsDir: join(dir, "outlook") }, sat0815);
    expect(out).toEqual({ status: "skipped" });
    expect(docEngine.prompts).toEqual([]);
  });

  it("without a document engine the documents just wait", async () => {
    putPending();
    const out = await weeklyOutlookAi(targets, { engine: fakeEngine([answer]), store: memoryStore(), stateFile }, sat0430);
    expect(out).toMatchObject({ status: "ok" });
    expect(listPending(join(dir, "outlook"))).toHaveLength(1);
  });
});
