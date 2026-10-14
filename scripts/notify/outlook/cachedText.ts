import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A fetched text is reused this long (the outlook file changes once a day). */
export const CACHE_FRESH_MS = 30 * 60_000;
/** A failed fetch falls back to the last cached text if it is not older than this. */
export const CACHE_FALLBACK_MS = 24 * 3_600_000;

interface Cached {
  at: number;
  text: string;
}

function read(file: string): Cached | null {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Cached;
    return typeof c?.at === "number" && typeof c.text === "string" ? c : null;
  } catch {
    return null;
  }
}

/**
 * The text from `fetchText`, kept in a file for a while: the bot builds its
 * context every 5 minutes and on every command, and a file that changes daily
 * must not cost a GitHub request each time. A failed fetch gives the last
 * cached text (up to a day old) rather than nothing; null only when neither.
 */
export async function cachedText(
  file: string,
  now: number,
  fetchText: () => Promise<string | null>,
  opts: { freshMs?: number; fallbackMs?: number } = {},
): Promise<string | null> {
  const cached = read(file);
  const age = cached ? now - cached.at : Infinity;
  if (cached && age >= 0 && age < (opts.freshMs ?? CACHE_FRESH_MS)) return cached.text;
  const text = await fetchText().catch(() => null);
  if (text != null) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: now, text } satisfies Cached));
      renameSync(tmp, file);
    } catch {
      // A cache that cannot be written is only a cache.
    }
    return text;
  }
  return cached && age >= 0 && age < (opts.fallbackMs ?? CACHE_FALLBACK_MS) ? cached.text : null;
}
