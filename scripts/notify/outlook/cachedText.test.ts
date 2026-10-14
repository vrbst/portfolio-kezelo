import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_FALLBACK_MS, CACHE_FRESH_MS, cachedText } from "./cachedText";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cached-"));
  file = join(dir, "sub", "outlook-cache.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 14, 8);
const counting = (text: string | null | Error) => {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls++;
      if (text instanceof Error) throw text;
      return text;
    },
  };
};

describe("cachedText", () => {
  it("the first call fetches and keeps the text; the next ones within the fresh time do not fetch again", async () => {
    const f = counting("A");
    expect(await cachedText(file, NOW, f.fetch)).toBe("A");
    expect(await cachedText(file, NOW + 60_000, f.fetch)).toBe("A");
    expect(await cachedText(file, NOW + CACHE_FRESH_MS - 1, f.fetch)).toBe("A");
    expect(f.calls()).toBe(1);
  });

  it("an old cache is fetched again and replaced", async () => {
    await cachedText(file, NOW, counting("A").fetch);
    const f = counting("B");
    expect(await cachedText(file, NOW + CACHE_FRESH_MS, f.fetch)).toBe("B");
    expect(f.calls()).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).text).toBe("B");
  });

  it("a failed fetch (an error or nothing) falls back to the cache for up to a day, then to nothing", async () => {
    await cachedText(file, NOW, counting("A").fetch);
    expect(await cachedText(file, NOW + 2 * 3_600_000, counting(new Error("502")).fetch)).toBe("A");
    expect(await cachedText(file, NOW + 2 * 3_600_000, counting(null).fetch)).toBe("A");
    expect(await cachedText(file, NOW + CACHE_FALLBACK_MS, counting(new Error("502")).fetch)).toBeNull();
  });

  it("no cache and a failed fetch: null; a missing remote file (null) is not cached as a text", async () => {
    expect(await cachedText(file, NOW, counting(new Error("x")).fetch)).toBeNull();
    expect(await cachedText(file, NOW, counting(null).fetch)).toBeNull();
    const f = counting("A");
    expect(await cachedText(file, NOW, f.fetch)).toBe("A");
  });

  it("an unreadable cache file is ignored; a clock that went backwards does not trust the cache", async () => {
    await cachedText(file, NOW, counting("A").fetch);
    const f = counting("B");
    expect(await cachedText(file, NOW - 3_600_000, f.fetch)).toBe("B");
    expect(f.calls()).toBe(1);
    const broken = join(dir, "broken.json");
    await cachedText(broken, NOW, counting("C").fetch);
    rmSync(broken);
    expect(await cachedText(broken, NOW, counting("D").fetch)).toBe("D");
  });
});
