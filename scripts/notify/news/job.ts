// The news digest (a morning and an evening edition on weekdays): brief the
// AI (prompt.ts) with the portfolio's exposure, validate its answer, keep a
// local copy (.notify/news/), then upload it to the private sync repo
// (news/<day>-<edition>.json + news/index.json), where the app's Hírek page
// reads it. The Telegram text is in reports.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toLocalDay } from "../../../src/lib/day";
import {
  NEWS_INDEX_PATH,
  digestKey,
  newsDigestPath,
  validateDigest,
  validateDigestBody,
  validateNewsIndex,
  withIndexEntry,
  type NewsDigest,
  type NewsDigestBody,
  type NewsEdition,
  type NewsIndex,
} from "../../../src/lib/newsSchema";
import { getRepoFile, putRepoFile, type SyncConfig } from "../../../src/lib/sync";
import type { Context } from "../data";
import type { NewsEngine } from "./engine";
import { buildNewsPrompt, portfolioExposure } from "./prompt";

/** Where the digests live: the sync repo (a fake in the tests). */
export interface NewsStore {
  read(path: string): Promise<string | null>;
  write(path: string, text: string, message: string): Promise<void>;
}

export interface NewsDeps {
  engine: NewsEngine;
  store: NewsStore;
  /** Local copies of the digests (a rerun after a failed upload reuses them). */
  cacheDir: string;
  appUrl: string;
}

/** The private sync repo through the Contents API, with a write token. */
export function repoStore(repo: string, token: () => string): NewsStore {
  const config = (): SyncConfig => {
    const [owner, name] = repo.split("/");
    return { token: token(), owner, repo: name, path: "" };
  };
  return {
    read: async (path) => (await getRepoFile(config(), path))?.text ?? null,
    write: async (path, text, message) => {
      const c = config();
      const sha = (await getRepoFile(c, path))?.sha;
      await putRepoFile(c, path, text, message, sha);
    },
  };
}

/** The JSON object in a model answer that may carry text around it. */
export function extractJson(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const from = output.indexOf("{");
  const to = output.lastIndexOf("}");
  if (from < 0 || to < from) throw new Error("A válaszban nincs JSON-objektum.");
  return JSON.parse(output.slice(from, to + 1));
}

/**
 * The model's answer, validated; one retry with the error spelled out (the
 * structured output makes a bad shape rare, the rules above it still apply).
 */
export async function askDigest(
  engine: NewsEngine,
  prompt: string,
): Promise<{ body: NewsDigestBody; costUsd?: number }> {
  let cost = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt
      ? `${prompt}\n\nAz előző válaszod nem volt érvényes (${lastError}). Add vissza javítva, a séma szerint.`
      : prompt;
    const r = await engine.run(p);
    cost += r.costUsd ?? 0;
    try {
      return { body: validateDigestBody(extractJson(r.output)), costUsd: cost || undefined };
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`news: invalid answer (${attempt + 1}/2): ${lastError}`);
    }
  }
  throw new Error(`Az AI kétszer is hibás hírösszefoglalót adott: ${lastError}`);
}

function readCache(dir: string, day: string, edition: NewsEdition): NewsDigest | null {
  const file = join(dir, `${day}-${edition}.json`);
  if (!existsSync(file)) return null;
  try {
    return validateDigest(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(dir: string, digest: NewsDigest) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${digest.day}-${digest.edition}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(digest, null, 2));
  renameSync(tmp, file);
}

async function readIndex(store: NewsStore): Promise<NewsIndex | null> {
  const text = await store.read(NEWS_INDEX_PATH);
  return text ? validateNewsIndex(JSON.parse(text)) : null;
}

export interface DigestRun {
  digest: NewsDigest;
  /** Why the upload failed (the digest was still made and kept locally). */
  uploadError?: string;
}

/** Today's `edition`: from the local copy if made already, else a new AI run; then uploaded. */
export async function makeDigest(
  ctx: Context,
  deps: NewsDeps,
  edition: NewsEdition,
): Promise<DigestRun> {
  const day = toLocalDay(ctx.at);
  let index: NewsIndex | null = null;
  let indexError: string | undefined;
  try {
    index = await readIndex(deps.store);
  } catch (e) {
    // Without it the brief just has no "already reported" list.
    indexError = (e as Error).message;
    console.error("news: index read failed:", indexError);
  }

  const key = digestKey({ day, edition });
  let digest = readCache(deps.cacheDir, day, edition);
  if (digest) console.error(`news: reusing the local digest ${day} ${edition}`);
  else {
    const prompt = buildNewsPrompt({
      day,
      weekday: ctx.at.getDay(),
      edition,
      exposure: portfolioExposure(ctx),
      previous: (index?.entries ?? []).filter((d) => digestKey(d) < key),
    });
    const started = Date.now();
    const { body, costUsd } = await askDigest(deps.engine, prompt);
    console.error(
      `news: ${body.items.length} items in ${Math.round((Date.now() - started) / 1000)} s` +
        (costUsd != null ? `, ~$${costUsd.toFixed(2)} at API prices` : ""),
    );
    digest = {
      version: 1,
      day,
      edition,
      generatedAt: new Date().toISOString(),
      engine: deps.engine.name,
      model: deps.engine.model,
      ...(costUsd != null ? { costUsd } : {}),
      ...body,
    };
    writeCache(deps.cacheDir, digest);
  }

  try {
    if (indexError) throw new Error(indexError);
    await deps.store.write(
      newsDigestPath(day, edition),
      JSON.stringify(digest, null, 2),
      `hírek ${day} ${edition}`,
    );
    await deps.store.write(
      NEWS_INDEX_PATH,
      JSON.stringify(withIndexEntry(index, digest), null, 2),
      `hírindex ${day} ${edition}`,
    );
    return { digest };
  } catch (e) {
    const m = (e as Error).message;
    console.error("news: upload failed:", m);
    // A token that may only read (or none at all) needs the user, briefly said.
    const uploadError = /HTTP (401|403)\b/.test(m)
      ? "a GitHub-token nem írhatja a szinkron-repót. Adj meg írási jogú tokent NEWS_GITHUB_TOKEN néven a .notify/.env-ben."
      : m;
    return { digest, uploadError };
  }
}

/** The newest digest in the store (for /hirek), or null if there's none yet. */
export async function latestDigest(store: NewsStore): Promise<NewsDigest | null> {
  const index = await readIndex(store);
  const last = index?.entries[0];
  if (!last) return null;
  const text = await store.read(newsDigestPath(last.day, last.edition));
  return text ? validateDigest(JSON.parse(text)) : null;
}
