import { describe, expect, it } from "vitest";
import { MAX_VIEWS_PER_ASSET, buildOutlookPrompt, mergeAiAnswer, runOutlookAi } from "./aiViews";
import type { OutlookTarget } from "./refresh";
import { fakeEngine, memoryStore } from "../news/testFakes";
import { OUTLOOK_PATH, type OutlookFile } from "../../../src/lib/outlook";

const NOW = new Date(2026, 9, 17, 4, 30);
const targets: OutlookTarget[] = [
  { key: "S", name: "Példa Bank", isin: "HU0000000001", currency: "HUF", type: "stock" },
  { key: "B", name: "Példa Physical Bitcoin ETP", isin: "GB0000000001", currency: "EUR", type: "etf" },
];

const view = (o: Record<string, unknown> = {}) => ({
  house: "UBS",
  kind: "target",
  value: 52_900,
  unit: "HUF",
  horizon: "12 hó",
  publishedAt: "2026-07-20",
  url: "https://example.com/ubs",
  ...o,
});

const empty = (): OutlookFile => ({ v: 1, updatedAt: "2026-10-13T00:00:00Z", profiles: {}, items: {}, errors: {} });

describe("buildOutlookPrompt", () => {
  it("lists the held assets and asks for sourced, dated views", () => {
    const p = buildOutlookPrompt(targets, empty(), NOW);
    expect(p).toContain("2026-10-17");
    expect(p).toContain("kulcs: S | név: Példa Bank | ISIN: HU0000000001");
    expect(p).toContain("kulcs: B");
    expect(p).toMatch(/URL/);
    expect(p).toMatch(/publishedAt/);
  });

  it("names the views already known so the AI updates them", () => {
    const prev = empty();
    prev.items.S = { views: [view() as never] };
    expect(buildOutlookPrompt(targets, prev, NOW)).toContain("UBS (2026-07-20)");
  });
});

describe("mergeAiAnswer", () => {
  it("takes the AI's profile and valid views; drops the unsourced and the unknown asset", () => {
    const { file, assets, views } = mergeAiAnswer(
      empty(),
      {
        assets: [
          {
            key: "S",
            assetClass: "equity",
            consensusUrl: "https://example.com/c",
            views: [view(), view({ house: "X", url: "" }), view({ house: "Y", publishedAt: "2020-01-01" })],
          },
          { key: "NINCS", assetClass: "equity", views: [view()] },
        ],
      },
      targets,
      NOW,
    );
    expect(file.profiles.S).toMatchObject({ assetClass: "equity", source: "ai", consensusUrl: "https://example.com/c" });
    expect(file.items.S.views).toHaveLength(1);
    expect(file.profiles.NINCS).toBeUndefined();
    expect(file.items.NINCS).toBeUndefined();
    expect([assets, views]).toEqual([1, 1]);
  });

  it("a profile set by hand is not overwritten", () => {
    const prev = empty();
    prev.profiles.B = { assetClass: "commodity", source: "manual", checkedAt: "2026-10-01" };
    const { file } = mergeAiAnswer(prev, { assets: [{ key: "B", assetClass: "crypto", underlying: "btc", views: [] }] }, targets, NOW);
    expect(file.profiles.B.assetClass).toBe("commodity");
  });

  it("an asset the AI found nothing valid for keeps its earlier views", () => {
    const prev = empty();
    prev.items.S = { views: [view() as never] };
    const { file } = mergeAiAnswer(prev, { assets: [{ key: "S", assetClass: "equity", views: [] }] }, targets, NOW);
    expect(file.items.S.views).toHaveLength(1);
  });

  it("keeps the newest view per house, newest first, capped", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      view({ house: `Ház ${i}`, publishedAt: `2026-0${1 + (i % 9)}-15`, url: `https://example.com/${i}` }),
    );
    const { file } = mergeAiAnswer(
      empty(),
      {
        assets: [
          {
            key: "S",
            assetClass: "equity",
            views: [view({ publishedAt: "2026-03-01", value: 40_000 }), view({ publishedAt: "2026-08-01", value: 50_000 }), ...many],
          },
        ],
      },
      targets,
      NOW,
    );
    const v = file.items.S.views!;
    expect(v.filter((x) => x.house === "UBS")).toEqual([expect.objectContaining({ value: 50_000 })]);
    expect(v.length).toBeLessThanOrEqual(MAX_VIEWS_PER_ASSET);
    expect(v.map((x) => x.publishedAt)).toEqual([...v.map((x) => x.publishedAt)].sort().reverse());
  });

  it("an answer without an assets list is an error", () => {
    expect(() => mergeAiAnswer(empty(), { nope: 1 }, targets, NOW)).toThrow();
  });
});

describe("runOutlookAi", () => {
  const good = { assets: [{ key: "S", assetClass: "equity", views: [view()] }] };

  it("writes the merged file next to what the daily job wrote", async () => {
    const daily = empty();
    daily.items.B = { implied: [{ underlying: "BTC", horizonDays: 90, expiry: "2027-01-15", spot: 1, forward: 1, p10: 1, p50: 1, p90: 1, probUp: 0.5, asOf: "2026-10-17" }] };
    const store = memoryStore({ [OUTLOOK_PATH]: JSON.stringify(daily) });
    const res = await runOutlookAi(targets, { engine: fakeEngine([good]), store }, NOW);
    expect(res).toMatchObject({ assets: 1, views: 1 });
    const out = JSON.parse(store.files[OUTLOOK_PATH]) as OutlookFile;
    expect(out.items.B.implied).toHaveLength(1);
    expect(out.items.S.views).toHaveLength(1);
  });

  it("one retry on an invalid answer, then an error — and nothing is written", async () => {
    const store = memoryStore();
    const engine = fakeEngine([{ nope: 1 }, good]);
    await runOutlookAi(targets, { engine, store }, NOW);
    expect(engine.prompts).toHaveLength(2);
    expect(engine.prompts[1]).toContain("nem volt érvényes");

    const bad = memoryStore();
    await expect(runOutlookAi(targets, { engine: fakeEngine([{ a: 1 }, { b: 2 }]), store: bad }, NOW)).rejects.toThrow(/kétszer/);
    expect(bad.writes).toEqual([]);
  });

  it("an engine failure (e.g. the usage limit) leaves the stored file untouched", async () => {
    const daily = JSON.stringify(empty());
    const store = memoryStore({ [OUTLOOK_PATH]: daily });
    const engine = { name: "f", model: "m", run: async () => { throw new Error("usage limit reached"); } };
    await expect(runOutlookAi(targets, { engine, store }, NOW)).rejects.toThrow(/usage limit/);
    expect(store.files[OUTLOOK_PATH]).toBe(daily);
    expect(store.writes).toEqual([]);
  });

  it("a failed upload does not cost another AI run", async () => {
    const store = memoryStore();
    store.write = async () => {
      throw new Error("HTTP 403");
    };
    const engine = fakeEngine([good, good]);
    await expect(runOutlookAi(targets, { engine, store }, NOW)).rejects.toThrow(/403/);
    expect(engine.prompts).toHaveLength(1);
  });
});
