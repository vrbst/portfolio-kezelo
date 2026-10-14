import { describe, expect, it } from "vitest";
import {
  isStaleView,
  staleOutlookErrors,
  validateConsensus,
  validateOutlookFile,
  validateProfile,
  validateView,
  type AnalystView,
} from "./outlook";

const NOW = new Date(2026, 9, 13, 12, 0); // 2026-10-13, local

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

describe("validateView", () => {
  it("keeps a sourced, dated, recent view", () => {
    expect(validateView(view(), NOW)).toMatchObject({ house: "UBS", value: 52_900, publishedAt: "2026-07-20" });
  });

  it("drops a view without a source URL or a date", () => {
    expect(validateView(view({ url: undefined }), NOW)).toBeNull();
    expect(validateView(view({ url: "ubs.com/x" }), NOW)).toBeNull();
    expect(validateView(view({ publishedAt: undefined }), NOW)).toBeNull();
    expect(validateView(view({ publishedAt: "tavaly" }), NOW)).toBeNull();
  });

  it("drops a view older than a year, keeps one just inside", () => {
    expect(validateView(view({ publishedAt: "2025-10-12" }), NOW)).toBeNull();
    expect(validateView(view({ publishedAt: "2025-10-14" }), NOW)).not.toBeNull();
  });

  it("drops a view dated in the future", () => {
    expect(validateView(view({ publishedAt: "2026-11-01" }), NOW)).toBeNull();
  });

  it("rejects a non-positive target and an absurd annual return", () => {
    expect(validateView(view({ value: 0 }), NOW)).toBeNull();
    expect(validateView(view({ kind: "annualReturn", value: 0.07 }), NOW)).not.toBeNull();
    expect(validateView(view({ kind: "annualReturn", value: 7 }), NOW)).toBeNull();
  });

  it("an instant at local midnight keeps its local day", () => {
    const iso = new Date(2026, 6, 20).toISOString();
    expect(validateView(view({ publishedAt: iso }), NOW)?.publishedAt).toBe("2026-07-20");
  });
});

describe("isStaleView", () => {
  it("greys out after about six months", () => {
    expect(isStaleView(validateView(view({ publishedAt: "2026-07-20" }), NOW) as AnalystView, NOW)).toBe(false);
    expect(isStaleView(validateView(view({ publishedAt: "2026-02-01" }), NOW) as AnalystView, NOW)).toBe(true);
  });
});

const consensus = (o: Record<string, unknown> = {}) => ({
  source: "issuer",
  url: "https://example.com/c.pdf",
  asOf: "2026-08-03",
  currency: "huf",
  target: { min: 29_000, avg: 45_888, max: 58_667, count: 17 },
  recent: { min: 42_200, avg: 51_122, max: 58_667, count: 9 },
  ratings: { buy: 12, hold: 4, sell: 0 },
  estimates: [{ year: 2026, eps: 4_577, dps: 1_251 }, { year: "x" }],
  ...o,
});

describe("validateConsensus", () => {
  it("normalises the currency and keeps the valid estimates", () => {
    const c = validateConsensus(consensus());
    expect(c?.currency).toBe("HUF");
    expect(c?.estimates).toEqual([{ year: 2026, eps: 4_577, dps: 1_251 }]);
    expect(c?.target.count).toBe(17);
  });

  it("drops a range where min > avg or avg > max", () => {
    expect(validateConsensus(consensus({ target: { min: 50_000, avg: 45_000, max: 58_000 } }))).toBeNull();
    expect(validateConsensus(consensus({ target: { min: 29_000, avg: 60_000, max: 58_000 } }))).toBeNull();
  });

  it("an invalid optional part does not kill the consensus", () => {
    const c = validateConsensus(consensus({ recent: { min: 9, avg: 1, max: 5 }, ratings: { buy: -1, hold: 0, sell: 0 } }));
    expect(c).not.toBeNull();
    expect(c?.recent).toBeUndefined();
    expect(c?.ratings).toBeUndefined();
  });
});

describe("validateProfile", () => {
  it("needs a known class and a source", () => {
    const ok = { assetClass: "crypto", underlying: "btc", source: "rule", checkedAt: "2026-10-13T00:00:00Z" };
    expect(validateProfile(ok)).toMatchObject({ assetClass: "crypto", underlying: "BTC" });
    expect(validateProfile({ ...ok, assetClass: "lottery" })).toBeNull();
    expect(validateProfile({ ...ok, source: undefined })).toBeNull();
  });

  it("the underlying is only for crypto and commodity products (the AI once filed an index name there)", () => {
    const base = { source: "ai", checkedAt: "2026-10-14T00:00:00Z" };
    expect(validateProfile({ ...base, assetClass: "equity_fund", underlying: "FTSE ALL-WORLD (GLOBÁLIS RÉSZVÉNYEK)" })?.underlying).toBeUndefined();
    expect(validateProfile({ ...base, assetClass: "equity", underlying: "OTP" })?.underlying).toBeUndefined();
    expect(validateProfile({ ...base, assetClass: "crypto", underlying: "btc" })?.underlying).toBe("BTC");
    expect(validateProfile({ ...base, assetClass: "commodity", underlying: "xau" })?.underlying).toBe("XAU");
  });

  it("drops a consensus URL that is not http(s)", () => {
    const p = validateProfile({ assetClass: "equity", source: "ai", checkedAt: "x", consensusUrl: "javascript:alert(1)" });
    expect(p?.consensusUrl).toBeUndefined();
  });
});

describe("validateOutlookFile", () => {
  const file = (items: unknown) => ({
    v: 1,
    updatedAt: "2026-10-13T04:30:00Z",
    profiles: { A: { assetClass: "equity", source: "rule", checkedAt: "2026-10-13" } },
    items,
    errors: { A: { since: "2026-10-08T05:00:00Z", message: "x" }, B: { since: 5 } },
  });

  it("filters views, drops an item that ends up empty, keeps the rest", () => {
    const f = validateOutlookFile(
      file({
        A: { views: [view(), view({ url: undefined })], consensus: [consensus()] },
        B: { views: [view({ publishedAt: "2020-01-01" })] },
      }),
      NOW,
    );
    expect(f?.items.A.views).toHaveLength(1);
    expect(f?.items.A.consensus).toHaveLength(1);
    expect(f?.items.B).toBeUndefined();
    expect(Object.keys(f?.errors ?? {})).toEqual(["A"]);
  });

  it("rejects another version or garbage", () => {
    expect(validateOutlookFile({ v: 2 }, NOW)).toBeNull();
    expect(validateOutlookFile(null, NOW)).toBeNull();
  });
});

describe("staleOutlookErrors", () => {
  it("reports errors that last at least three days", () => {
    const f = validateOutlookFile(
      {
        v: 1,
        updatedAt: "2026-10-13T04:30:00Z",
        errors: {
          old: { since: new Date(2026, 9, 9).toISOString(), message: "x" },
          fresh: { since: new Date(2026, 9, 12).toISOString(), message: "x" },
        },
      },
      NOW,
    );
    expect(staleOutlookErrors(f, NOW).map(([k]) => k)).toEqual(["old"]);
  });
});
