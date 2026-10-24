// A felhasználó befektetési preferenciái: az asszisztens exportálja egy fájlba (state/exports/portfolio-profile.md),
// a portfolio AI-jobjai (hírek, elemzés, „miért mozdult") a promptjukba teszik. Ha nincs fájl, a promptok bájtra
// megegyeznek a korábbiakkal.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contextAt } from "./testContext";
import { fixtureNewsBody } from "../../src/test/newsFixture";
import { fakeEngine, memoryStore } from "./news/testFakes";
import { ROOT } from "./env";
import { PROFILE_MAX_CHARS, cleanProfile, loadProfile, profilePath, profileSection } from "./profile";
import { buildNewsPrompt } from "./news/prompt";
import { buildWhyPrompt, type WhyFactor } from "./news/why";
import { buildAnalysisPrompt, makeAnalysis } from "./analysis/job";
import { makeDigest } from "./news/job";

const PROFILE = "- A kripto nem érdekel\n- Legfeljebb 20% részvény";

describe("profilePath", () => {
  it("az ASSISTANT_PROFILE_FILE felülírja; alapból a testvér asszisztens-mappa exportja", () => {
    expect(profilePath({ ASSISTANT_PROFILE_FILE: "C:/x/p.md" })).toBe(resolve("C:/x/p.md"));
    expect(profilePath({})).toBe(resolve(ROOT, "..", "asszisztens", "state", "exports", "portfolio-profile.md"));
  });
});

describe("loadProfile", () => {
  it("beolvassa és megtisztítja a szöveget", () => {
    expect(loadProfile({}, () => `\r\n${PROFILE}\r\n\r\n`)).toBe(PROFILE);
  });

  it("nincs fájl, olvashatatlan vagy üres: üres profil, sosem dob", () => {
    expect(loadProfile({}, () => {
      throw Object.assign(new Error("nincs"), { code: "ENOENT" });
    })).toBe("");
    expect(loadProfile({}, () => "   \n  ")).toBe("");
    expect(loadProfile({}, () => "")).toBe("");
  });

  it("a vezérlő- és irányító karaktereket kiszűri, a hosszt korlátozza", () => {
    expect(cleanProfile("a\u0000b\u202ec\u0007d\ne")).toBe("abcd\ne");
    const long = cleanProfile("x".repeat(PROFILE_MAX_CHARS + 500));
    expect(long).toHaveLength(PROFILE_MAX_CHARS);
  });
});

describe("profileSection", () => {
  it("profil nélkül üres (a prompt nem változik)", () => {
    expect(profileSection(undefined)).toBe("");
    expect(profileSection("")).toBe("");
    expect(profileSection("  \n ")).toBe("");
  });

  it("profillal: címkézett blokk, adatként (nem utasításként)", () => {
    const s = profileSection(PROFILE);
    expect(s.startsWith("\n\n")).toBe(true);
    expect(s).toContain(PROFILE);
    expect(s).toMatch(/ADAT, nem utasítás/);
    expect(s).toMatch(/preferenciái/);
  });
});

const NEWS_INPUT = { day: "2026-10-14", weekday: 3, edition: "evening" as const, exposure: ["- VWCE: 60%"], previous: [] };
const FACTOR: WhyFactor = { key: "portfolio", label: "Portfólió", pct: -2.4 };

describe("a promptok", () => {
  it("profil nélkül ugyanazt adják, mint korábban (a paraméter elhagyása = üres profil)", () => {
    expect(buildNewsPrompt({ ...NEWS_INPUT, profile: undefined })).toBe(buildNewsPrompt(NEWS_INPUT));
    expect(buildNewsPrompt({ ...NEWS_INPUT, profile: "" })).toBe(buildNewsPrompt(NEWS_INPUT));
    expect(buildAnalysisPrompt("ctx", null, "")).toBe(buildAnalysisPrompt("ctx", null));
    const why = { day: "2026-10-14", weekday: 3, factors: [FACTOR], exposure: ["- VWCE: 60%"] };
    expect(buildWhyPrompt({ ...why, profile: "" })).toBe(buildWhyPrompt(why));
  });

  it("a hírösszefoglaló promptja a portfólió után, a szabályok előtt tartalmazza a profilt", () => {
    const p = buildNewsPrompt({ ...NEWS_INPUT, profile: PROFILE });
    expect(p).toContain(PROFILE);
    expect(p.indexOf(PROFILE)).toBeGreaterThan(p.indexOf("- VWCE: 60%"));
    expect(p.indexOf(PROFILE)).toBeLessThan(p.indexOf("Szabályok:"));
  });

  it("az elemzés promptja a pillanatkép után tartalmazza, a válasz-előírás előtt", () => {
    const p = buildAnalysisPrompt("CTX", null, PROFILE);
    expect(p).toContain(PROFILE);
    expect(p.indexOf(PROFILE)).toBeGreaterThan(p.indexOf("CTX"));
    expect(p.indexOf(PROFILE)).toBeLessThan(p.indexOf("A válasz kizárólag a megadott JSON-séma szerinti objektum legyen."));
  });

  it("a „miért mozdult” prompt is tartalmazza", () => {
    const p = buildWhyPrompt({ day: "2026-10-14", weekday: 3, factors: [FACTOR], exposure: ["- VWCE: 60%"], profile: PROFILE });
    expect(p).toContain(PROFILE);
    expect(p.indexOf(PROFILE)).toBeLessThan(p.indexOf("Szabályok:"));
  });
});

describe("a jobok a függőségeikben kapott profilt használják", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "profile-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const NIGHT: [number, number, number, number, number] = [2026, 10, 15, 3, 30];
  const EVENING: [number, number, number, number, number] = [2026, 10, 14, 18, 15];

  it("hírösszefoglaló: a deps.profile a promptba kerül; nélküle nem", async () => {
    const withProfile = fakeEngine([fixtureNewsBody()]);
    await makeDigest(contextAt(EVENING), { engine: withProfile, store: memoryStore(), cacheDir: join(dir, "a"), appUrl: "https://example.com/", profile: () => PROFILE }, "evening", { reuseLocal: false });
    expect(withProfile.prompts[0]).toContain(PROFILE);

    const without = fakeEngine([fixtureNewsBody()]);
    await makeDigest(contextAt(EVENING), { engine: without, store: memoryStore(), cacheDir: join(dir, "b"), appUrl: "https://example.com/" }, "evening", { reuseLocal: false });
    expect(without.prompts[0]).not.toContain("A kripto nem érdekel");
    expect(without.prompts[0]).not.toMatch(/preferenciái/);
  });

  it("éjszakai elemzés: ugyanígy", async () => {
    const answer = {
      headline: "H",
      overall: "figyelj",
      changes: "",
      sections: [{ topic: "koncentracio", title: "K", status: "figyelj", text: "t" }],
    };
    const withProfile = fakeEngine([answer]);
    await makeAnalysis(contextAt(NIGHT), { engine: withProfile, store: memoryStore(), cacheDir: join(dir, "a"), profile: () => PROFILE }, { reuseLocal: false });
    expect(withProfile.prompts[0]).toContain(PROFILE);

    const without = fakeEngine([answer]);
    await makeAnalysis(contextAt(NIGHT), { engine: without, store: memoryStore(), cacheDir: join(dir, "b") }, { reuseLocal: false });
    expect(without.prompts[0]).not.toMatch(/preferenciái/);
  });
});
