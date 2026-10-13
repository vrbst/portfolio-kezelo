import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDocPrompt, consensusFromAnswer, extractPendingDocs } from "./aiDocs";
import { listPending, type PendingDoc } from "./issuerDocs";
import { fakeEngine, memoryStore } from "../news/testFakes";
import { OUTLOOK_PATH, type OutlookFile } from "../../../src/lib/outlook";

const NOW = new Date(2026, 9, 13, 6, 50);
const doc: PendingDoc = {
  key: "OTP",
  url: "https://example.com/Consensus_20260803.pdf",
  fetchedAt: "2026-10-13T04:50:00Z",
  text: "OTP Bank Nyrt. - Elemzői konszenzus\nCélár ( TELJES konszenzus): HUF 29.000 HUF 45.888 HUF 58.667",
};
const good = {
  price: 46_700,
  currency: "HUF",
  asOf: "2026-08-03",
  target: { min: 29_000, avg: 45_888, max: 58_667, count: 17 },
  recent: { min: 42_200, avg: 51_122, max: 58_667, count: 9 },
  estimates: [{ year: 2026, eps: 4_577, dps: 1_251 }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aidocs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const putPending = (d: PendingDoc) => {
  mkdirSync(join(dir, "pending"), { recursive: true });
  writeFileSync(join(dir, "pending", `${encodeURIComponent(d.key)}.json`), JSON.stringify(d));
};
const outlookFile = (): OutlookFile => ({
  v: 1,
  updatedAt: "2026-10-12T00:00:00Z",
  profiles: { OTP: { assetClass: "equity", source: "ai", checkedAt: "2026-10-01" } },
  items: {
    OTP: {
      consensus: [
        { source: "yahoo", asOf: "2026-10-12", currency: "HUF", target: { min: 35_500, avg: 48_514, max: 55_000, count: 13 } },
        { source: "issuer", asOf: "2026-07-01", currency: "HUF", target: { min: 1, avg: 2, max: 3 } },
      ],
    },
  },
  errors: {},
});

describe("buildDocPrompt", () => {
  it("warns about the Hungarian thousands separator and carries the document", () => {
    const p = buildDocPrompt(doc);
    expect(p).toContain("ezres tagoló");
    expect(p).toContain("45.888");
    expect(p).toContain(doc.url);
  });

  it("hands over a bounded text", () => {
    expect(buildDocPrompt({ ...doc, text: "x".repeat(200_000) }).length).toBeLessThan(45_000);
  });
});

describe("consensusFromAnswer", () => {
  it("a good answer becomes an issuer consensus with the document's address", () => {
    const c = consensusFromAnswer(good, doc, NOW);
    expect(c).toMatchObject({ source: "issuer", url: doc.url, asOf: "2026-08-03", currency: "HUF", target: { avg: 45_888, count: 17 } });
    expect(c.recent?.avg).toBe(51_122);
    expect(c.estimates).toEqual([{ year: 2026, eps: 4_577, dps: 1_251 }]);
  });

  it("a thousands separator read as a decimal point is caught by the document's own price", () => {
    const wrong = { ...good, target: { min: 29, avg: 45.888, max: 58.667, count: 17 }, recent: undefined };
    expect(() => consensusFromAnswer(wrong, doc, NOW)).toThrow(/nem fér össze/);
  });

  it("a wrong 'recent' range is dropped, the rest is kept", () => {
    const c = consensusFromAnswer({ ...good, recent: { min: 42.2, avg: 51.122, max: 58.667 } }, doc, NOW);
    expect(c.recent).toBeUndefined();
    expect(c.target.avg).toBe(45_888);
  });

  it("no price to check against, an inconsistent range or an implausible date is an error", () => {
    expect(() => consensusFromAnswer({ ...good, price: undefined }, doc, NOW)).toThrow(/árfolyam/);
    expect(() => consensusFromAnswer({ ...good, target: { min: 50_000, avg: 45_888, max: 58_667 } }, doc, NOW)).toThrow();
    expect(() => consensusFromAnswer({ ...good, asOf: "2024-01-05" }, doc, NOW)).toThrow(/dátuma/);
    expect(() => consensusFromAnswer(null, doc, NOW)).toThrow();
  });
});

describe("extractPendingDocs", () => {
  it("merges the issuer consensus (replacing the old one), keeps Yahoo's, clears the pending text", async () => {
    putPending(doc);
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(outlookFile()) });
    const res = await extractPendingDocs({ engine: fakeEngine([good]), store, dir }, NOW);
    expect(res).toEqual({ done: ["OTP"], failed: {} });
    const out = JSON.parse(store.files[OUTLOOK_PATH]) as OutlookFile;
    expect(out.items.OTP.consensus?.map((c) => c.source)).toEqual(["issuer", "yahoo"]);
    expect(out.items.OTP.consensus?.[0].target.avg).toBe(45_888);
    expect(listPending(dir)).toEqual([]);
  });

  it("a bad answer twice: the document stays pending, nothing is written", async () => {
    putPending(doc);
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(outlookFile()) });
    const wrong = { ...good, target: { min: 29, avg: 45.888, max: 58.667 } };
    const res = await extractPendingDocs({ engine: fakeEngine([wrong, wrong]), store, dir }, NOW);
    expect(res.done).toEqual([]);
    expect(res.failed.OTP).toMatch(/nem fér össze/);
    expect(store.writes).toEqual([]);
    expect(listPending(dir)).toHaveLength(1);
  });

  it("the usage limit leaves everything as it was", async () => {
    putPending(doc);
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(outlookFile()) });
    const engine = { name: "f", model: "m", run: async () => Promise.reject(new Error("usage limit reached")) };
    const res = await extractPendingDocs({ engine, store, dir }, NOW);
    expect(res.failed.OTP).toMatch(/usage limit/);
    expect(store.writes).toEqual([]);
    expect(listPending(dir)).toHaveLength(1);
  });

  it("a failed upload keeps the document pending", async () => {
    putPending(doc);
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(outlookFile()) });
    store.write = async () => {
      throw new Error("HTTP 403");
    };
    await expect(extractPendingDocs({ engine: fakeEngine([good]), store, dir }, NOW)).rejects.toThrow(/403/);
    expect(listPending(dir)).toHaveLength(1);
  });

  it("a document of an asset no longer held is dropped without an AI run", async () => {
    putPending({ ...doc, key: "REGI" });
    const engine = fakeEngine([good]);
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(outlookFile()) });
    const res = await extractPendingDocs({ engine, store, dir }, NOW);
    expect(res).toEqual({ done: [], failed: {} });
    expect(engine.prompts).toEqual([]);
    expect(listPending(dir)).toEqual([]);
  });

  it("without an outlook file yet the documents wait; with nothing pending there is no work", async () => {
    putPending(doc);
    const engine = fakeEngine([good]);
    expect(await extractPendingDocs({ engine, store: memoryStore(), dir }, NOW)).toEqual({ done: [], failed: {} });
    expect(listPending(dir)).toHaveLength(1);
    expect(engine.prompts).toEqual([]);
    rmSync(join(dir, "pending"), { recursive: true });
    expect(await extractPendingDocs({ engine, store: memoryStore(), dir }, NOW)).toEqual({ done: [], failed: {} });
  });
});
