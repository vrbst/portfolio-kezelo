import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A ?skin= link forces a skin for that window only: it beats the stored skin,
// is never stored, and disappears from the address once a skin is picked.

let store: Map<string, string>;
let href: string;

beforeEach(() => {
  store = new Map();
  href = "https://example.test/portfolio/";
  vi.resetModules();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("location", {
    get search() {
      return new URL(href).search;
    },
    get href() {
      return href;
    },
  });
  vi.stubGlobal("history", {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string | URL) => {
      href = String(url);
    },
  });
  vi.stubGlobal("document", {
    documentElement: { dataset: {} },
    querySelector: () => ({ setAttribute: () => {} }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const load = () => import("./skin");

describe("?skin= link", () => {
  it("beats the stored skin without storing itself", async () => {
    store.set("pf-skin", "terminal");
    href += "?skin=asszisztens#/";
    const { currentSkin } = await load();
    expect(currentSkin()).toBe("asszisztens");
    expect(store.get("pf-skin")).toBe("terminal");
  });

  it("can force the classic skin over a stored one", async () => {
    store.set("pf-skin", "retro");
    href += "?skin=classic";
    const { currentSkin } = await load();
    expect(currentSkin()).toBe("classic");
  });

  it("ignores an unknown name", async () => {
    store.set("pf-skin", "paper");
    href += "?skin=xyz";
    const { currentSkin, skinFromUrl } = await load();
    expect(skinFromUrl()).toBeNull();
    expect(currentSkin()).toBe("paper");
  });

  it("picking a skin stores it and drops the parameter, keeping the hash", async () => {
    href += "?skin=asszisztens&x=1#/settings";
    const { useSkin, currentSkin } = await load();
    useSkin.getState().setSkin("paper");
    expect(currentSkin()).toBe("paper");
    expect(store.get("pf-skin")).toBe("paper");
    expect(href).toBe("https://example.test/portfolio/?x=1#/settings");
  });
});

describe("asszisztens colours", () => {
  it("every skinned table has hex colours (alpha suffixes like `${c}80` rely on it)", async () => {
    href += "?skin=asszisztens";
    const { CHART, SERIES_COLORS } = await load();
    const hex = /^#[0-9a-f]{6}$/i;
    for (const k of Object.keys(CHART)) {
      expect(CHART[k as keyof typeof CHART], k).toMatch(hex);
    }
    for (const c of SERIES_COLORS) expect(c).toMatch(hex);
  });
});
