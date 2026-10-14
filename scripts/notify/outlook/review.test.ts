// Regressions from the code review of the outlook feature (PR #20): each test
// failed before its fix.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshOutlook, type OutlookDeps, type OutlookTarget } from "./refresh";
import { mergeAiAnswer, runOutlookAi } from "./aiViews";
import { candidateDays, collectIssuerDocs } from "./issuerDocs";
import { miniPdf } from "./pdfFixture";
import { fakeEngine, memoryStore } from "../news/testFakes";
import { OUTLOOK_PATH, type ImpliedBand, type OutlookFile } from "../../../src/lib/outlook";

const NOW = new Date(2026, 9, 14, 6, 50);
const day = (n: number) => new Date(2026, 9, 10 + n, 6, 50);

const band: ImpliedBand = {
  underlying: "BTC", horizonDays: 90, expiry: "2027-01-15", spot: 83_000, forward: 84_000,
  p10: 65_000, p50: 83_000, p90: 105_000, probUp: 0.49, asOf: "2026-10-13",
};
const r = (raw: number) => ({ raw, fmt: String(raw) });
const wbitJson = { quoteSummary: { result: [{ price: { quoteType: "ETF", currency: "EUR", longName: "WisdomTree Physical Bitcoin" } }] } };
const stockJson = {
  quoteSummary: {
    result: [
      {
        price: { quoteType: "EQUITY", currency: "HUF" },
        financialData: { numberOfAnalystOpinions: r(13), targetLowPrice: r(38_000), targetMeanPrice: r(45_525), targetHighPrice: r(52_900) },
      },
    ],
  },
};
// What yahooFetcher returns on a 401/429: a body, not an exception.
const errorBody = { quoteSummary: { result: null, error: { description: "Invalid Crumb" } } };

const wbit: OutlookTarget = { key: "B", name: "WBIT", isin: "GB0000000001", currency: "EUR", type: "etf" };
const stock: OutlookTarget = { key: "S", name: "Példa Bank", isin: "HU0000000001", currency: "HUF", type: "stock" };

function deps(over: Partial<OutlookDeps> = {}, files: Record<string, string> = {}) {
  const store = memoryStore(files);
  const d: OutlookDeps = {
    resolve: async (t) => t.key,
    fetch: async (s) => (s === "S" ? stockJson : wbitJson),
    bands: async () => [band],
    store,
    ...over,
  };
  return { d, store };
}

describe("refreshOutlook: a Yahoo error body is a failure, not an answer", () => {
  it("a known bitcoin profile and its band survive a 401/429 body", async () => {
    const first = deps();
    await refreshOutlook([wbit], first.d, day(0));
    const { d } = deps({ fetch: async () => errorBody }, { ...first.store.files });
    const { file } = await refreshOutlook([wbit], d, NOW);
    expect(file.profiles.B).toMatchObject({ assetClass: "crypto", underlying: "BTC" });
    expect(file.items.B.implied).toEqual([band]);
  });

  it("a share keeps its last Yahoo consensus and the error is recorded with Yahoo's reason", async () => {
    const first = deps();
    await refreshOutlook([stock], first.d, day(0));
    const { d } = deps({ fetch: async () => errorBody }, { ...first.store.files });
    const { file } = await refreshOutlook([stock], d, NOW);
    expect(file.items.S.consensus?.[0]).toMatchObject({ source: "yahoo", asOf: "2026-10-10" });
    expect(file.errors.S.message).toMatch(/Invalid Crumb/);
  });
});

describe("refreshOutlook: it never rebuilds the file from nothing", () => {
  const prev = (): OutlookFile => ({
    v: 1,
    updatedAt: "2026-10-13T00:00:00Z",
    profiles: { S: { assetClass: "equity", consensusUrl: "https://example.com/c_20260803.pdf", source: "ai", checkedAt: "2026-10-13" } },
    items: { S: { views: [{ house: "UBS", kind: "target", value: 52_900, unit: "HUF", publishedAt: "2026-08-24", url: "https://example.com/ubs" }] } },
    errors: {},
  });

  it("a failed read stops the job and writes nothing", async () => {
    const { d, store } = deps({
      store: {
        read: async () => {
          throw new Error("HTTP 502");
        },
        write: async () => {
          throw new Error("must not be written");
        },
      },
    });
    await expect(refreshOutlook([stock], d, NOW)).rejects.toThrow(/502/);
    expect(store.writes).toEqual([]);
  });

  it("an unreadable file stops the job instead of being overwritten", async () => {
    const files = { [OUTLOOK_PATH]: "{nem json" };
    const { d, store } = deps({}, files);
    await expect(refreshOutlook([stock], d, NOW)).rejects.toThrow(/nem olvasható/);
    expect(store.files[OUTLOOK_PATH]).toBe("{nem json");
    expect(store.writes).toEqual([]);
  });

  it("no held papers (e.g. a failed load): nothing is written, the file stays", async () => {
    const text = JSON.stringify(prev());
    const { d, store } = deps({}, { [OUTLOOK_PATH]: text });
    const { file } = await refreshOutlook([], d, NOW);
    expect(store.writes).toEqual([]);
    expect(store.files[OUTLOOK_PATH]).toBe(text);
    expect(file.items.S.views).toHaveLength(1);
  });

  it("a missing file is fine: the first run creates it", async () => {
    const { d, store } = deps();
    await refreshOutlook([stock], d, NOW);
    expect(store.writes).toEqual([OUTLOOK_PATH]);
  });
});

describe("the weekly AI run", () => {
  const targets: OutlookTarget[] = [stock, wbit];
  const prev = (): OutlookFile => ({
    v: 1,
    updatedAt: "2026-10-13T00:00:00Z",
    profiles: {
      S: { assetClass: "equity", consensusUrl: "https://example.com/c_20260803.pdf", source: "ai", checkedAt: "2026-10-13" },
      B: { assetClass: "crypto", underlying: "BTC", source: "rule", checkedAt: "2026-10-13" },
    },
    items: {},
    errors: {},
  });

  it("keeps the earlier consensusUrl and underlying when this week's answer leaves them out", () => {
    const { file } = mergeAiAnswer(
      prev(),
      { assets: [{ key: "S", assetClass: "equity", views: [] }, { key: "B", assetClass: "crypto", views: [] }] },
      targets,
      NOW,
    );
    expect(file.profiles.S.consensusUrl).toBe("https://example.com/c_20260803.pdf");
    expect(file.profiles.B.underlying).toBe("BTC");
    expect(file.profiles.S.source).toBe("ai");
  });

  it("a newer consensusUrl or underlying wins; a changed class drops a stale underlying", () => {
    const { file } = mergeAiAnswer(
      prev(),
      {
        assets: [
          { key: "S", assetClass: "equity", consensusUrl: "https://example.com/c_20261001.pdf", views: [] },
          { key: "B", assetClass: "equity_fund", views: [] },
        ],
      },
      targets,
      NOW,
    );
    expect(file.profiles.S.consensusUrl).toBe("https://example.com/c_20261001.pdf");
    expect(file.profiles.B.assetClass).toBe("equity_fund");
    expect(file.profiles.B.underlying).toBeUndefined();
  });

  it("an answer about none of the held papers is an error, so the week does not count as done", async () => {
    expect(() => mergeAiAnswer(prev(), { assets: [] }, targets, NOW)).toThrow(/egyetlen ismert/);
    expect(() => mergeAiAnswer(prev(), { assets: [{ key: "MAS", assetClass: "equity", views: [] }] }, targets, NOW)).toThrow(/egyetlen ismert/);
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(prev()) });
    const before = store.files[OUTLOOK_PATH];
    await expect(runOutlookAi(targets, { engine: fakeEngine([{ assets: [] }, { assets: [] }]), store }, NOW)).rejects.toThrow(/kétszer/);
    expect(store.files[OUTLOOK_PATH]).toBe(before);
  });

  it("a failed or unreadable read of the stored file stops the run before the AI is asked", async () => {
    const engine = fakeEngine([{ assets: [] }]);
    const failing = {
      read: async () => {
        throw new Error("HTTP 502");
      },
      write: async () => undefined,
    };
    await expect(runOutlookAi(targets, { engine, store: failing }, NOW)).rejects.toThrow(/502/);
    await expect(runOutlookAi(targets, { engine, store: memoryStore({ [OUTLOOK_PATH]: "{" }) }, NOW)).rejects.toThrow(/nem olvasható/);
    expect(engine.prompts).toEqual([]);
  });
});

describe("issuer documents: the probing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "issuer-review-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rows: [number, number, string][] = Array.from({ length: 12 }, (_, i) => [50, 780 - i * 20, `Celar sor ${i} HUF 45.888 atlag`]);
  const profiles = (urls: Record<string, string>): OutlookFile => ({
    v: 1,
    updatedAt: "2026-10-13T00:00:00Z",
    profiles: Object.fromEntries(Object.entries(urls).map(([k, u]) => [k, { assetClass: "equity", consensusUrl: u, source: "ai", checkedAt: "2026-10-01" }])) as OutlookFile["profiles"],
    items: {},
    errors: {},
  });

  it("the window is the NEWEST 75 days, newest first (not the oldest 75 after the known one)", () => {
    const days = candidateDays("2025-01-01", "2026-10-13");
    expect(days).toHaveLength(75);
    expect(days[0]).toBe("2026-10-13");
    expect(days[74]).toBe("2026-07-31");
  });

  it("a document long after a stale known one is still found", async () => {
    const base = "https://example.com/c_20260301.pdf";
    const newer = "https://example.com/c_20260929.pdf";
    const out = await collectIssuerDocs(
      profiles({ X: base }),
      {
        dir,
        head: async (u) => u === newer,
        get: async () => ({ ok: true, contentType: "application/pdf", bytes: miniPdf(rows) }),
      },
      NOW,
    );
    expect(out.saved).toEqual(["X"]);
    const state = JSON.parse(readFileSync(join(dir, "issuer-state.json"), "utf8")) as Record<string, { latestUrl: string }>;
    expect(state.X.latestUrl).toBe(newer);
  });

  it("the days are asked about in parallel batches, newest candidate still preferred", async () => {
    const base = "https://example.com/c_20260801.pdf";
    let running = 0;
    let peak = 0;
    const newest = "https://example.com/c_20261013.pdf";
    const older = "https://example.com/c_20261012.pdf";
    await collectIssuerDocs(
      profiles({ X: base }),
      {
        dir,
        head: async (u) => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((res) => setTimeout(res, 2));
          running--;
          return u === newest || u === older;
        },
        get: async (u) => {
          expect(u).toBe(newest);
          return { ok: true, contentType: "application/pdf", bytes: miniPdf(rows) };
        },
      },
      NOW,
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("the state is saved after each asset, so a killed job does not lose the earlier ones", async () => {
    let seenWhenSecondStarts: Record<string, unknown> | null = null;
    const a = "https://example.com/a_20261001.pdf";
    const b = "https://example.com/b_20261001.pdf";
    await collectIssuerDocs(
      profiles({ A: a, B: b }),
      {
        dir,
        head: async (u) => {
          if (u.includes("/b_")) {
            try {
              seenWhenSecondStarts = JSON.parse(readFileSync(join(dir, "issuer-state.json"), "utf8"));
            } catch {
              seenWhenSecondStarts = null;
            }
          }
          return false;
        },
        get: async () => ({ ok: true, contentType: "application/pdf", bytes: miniPdf(rows) }),
      },
      NOW,
    );
    expect(Object.keys(seenWhenSecondStarts ?? {})).toEqual(["A"]);
  });
});
