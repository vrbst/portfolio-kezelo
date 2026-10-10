// The nightly AI analysis: the same snapshot and prompt as the app's AI page
// (src/lib/aiContext.ts, aiAnalysis.ts), run with Claude Code on the owner's
// subscription instead of the API. The result goes to the private sync repo
// (analysis/latest.json + analysis/<day>.json), where the app's AI page reads
// it on every device; a local copy is kept so a failed upload can be retried
// without a new run. The Telegram text is in reports.ts (analysisText).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFullAiContext } from "../../../src/lib/aiContext";
import { SYSTEM } from "../../../src/lib/ai";
import {
  ANALYSIS_LATEST_PATH,
  STRUCTURED_ANALYSIS_PROMPT,
  analysisDayPath,
  parseAnalysis,
  previousForPrompt,
  validateNightly,
  type Analysis,
  type NightlyAnalysis,
} from "../../../src/lib/aiAnalysis";
import { loadSavingsGoals } from "../../../src/lib/savings";
import { toLocalDay } from "../../../src/lib/day";
import type { Context } from "../data";
import type { NewsEngine } from "../news/engine";
import { extractJson, type NewsStore } from "../news/job";

export interface AnalysisDeps {
  engine: NewsEngine;
  store: NewsStore;
  /** Local copies of the analyses (a rerun after a failed upload reuses them). */
  cacheDir: string;
}

/** The app's AI snapshot, from the notifier's context. */
export function analysisContext(ctx: Context): string {
  return buildFullAiContext({
    summary: ctx.summary,
    accounts: ctx.summary.accounts.map((a) => a.account),
    transactions: ctx.transactions,
    instruments: ctx.instruments,
    prices: ctx.prices,
    fx: ctx.fx,
    historyFile: ctx.history,
    bondRates: ctx.bondRates,
    series: ctx.series,
    dayChange: ctx.dayChange,
    goals: ctx.goalProgress,
    alerts: ctx.alerts,
    savingsGoals: loadSavingsGoals(),
    glide: ctx.glide,
    now: ctx.at,
  });
}

/** Everything the model gets in one prompt (Claude Code has no system block). */
export function buildAnalysisPrompt(context: string, previous: NightlyAnalysis | null): string {
  const prev = previousForPrompt(previous ?? undefined);
  return [
    SYSTEM,
    `--- Portfólió pillanatkép ---\n${context}`,
    prev ? `${STRUCTURED_ANALYSIS_PROMPT}\n\n${prev}` : STRUCTURED_ANALYSIS_PROMPT,
    "A válasz kizárólag a megadott JSON-séma szerinti objektum legyen.",
  ].join("\n\n");
}

/** The model's answer, validated; one retry with the problem spelled out. */
export async function askAnalysis(
  engine: NewsEngine,
  prompt: string,
): Promise<{ data: Analysis; costUsd?: number }> {
  let cost = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt
      ? `${prompt}\n\nAz előző válaszod nem volt érvényes (${lastError}). Add vissza javítva, a séma szerint.`
      : prompt;
    const r = await engine.run(p);
    cost += r.costUsd ?? 0;
    try {
      const data = parseAnalysis(JSON.stringify(extractJson(r.output)));
      if (!data || !data.sections.length) throw new Error("hiányzó vagy üres elemzés");
      return { data, costUsd: cost || undefined };
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`analysis: invalid answer (${attempt + 1}/2): ${lastError}`);
    }
  }
  throw new Error(`Az AI kétszer is hibás elemzést adott: ${lastError}`);
}

function readCache(dir: string, day: string): NightlyAnalysis | null {
  const file = join(dir, `${day}.json`);
  if (!existsSync(file)) return null;
  try {
    return validateNightly(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(dir: string, a: NightlyAnalysis) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${a.day}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2));
  renameSync(tmp, file);
}

/** The newest analysis in the store, or null (none yet / unreadable). */
export async function latestAnalysis(store: NewsStore): Promise<NightlyAnalysis | null> {
  const text = await store.read(ANALYSIS_LATEST_PATH);
  return text ? validateNightly(JSON.parse(text)) : null;
}

export interface AnalysisRun {
  analysis: NightlyAnalysis;
  /** Why the upload failed (the analysis was still made and kept locally). */
  uploadError?: string;
}

/**
 * Today's analysis: a new AI run — or, with `reuseLocal` (a manual resend,
 * e.g. after a failed upload), the local copy if it was made already — then
 * uploaded.
 */
export async function makeAnalysis(
  ctx: Context,
  deps: AnalysisDeps,
  opts: { reuseLocal: boolean },
): Promise<AnalysisRun> {
  const day = toLocalDay(ctx.at);
  let analysis = opts.reuseLocal ? readCache(deps.cacheDir, day) : null;
  if (analysis) console.error(`analysis: reusing the local analysis ${day}`);
  else {
    // The previous one is what "what changed" compares to; without it (first
    // run, unreadable) the analysis just has no comparison.
    let previous: NightlyAnalysis | null = null;
    try {
      previous = await latestAnalysis(deps.store);
    } catch (e) {
      console.error("analysis: previous read failed:", (e as Error).message);
    }
    const started = Date.now();
    const { data, costUsd } = await askAnalysis(
      deps.engine,
      buildAnalysisPrompt(analysisContext(ctx), previous),
    );
    console.error(
      `analysis: ${data.sections.length} cards in ${Math.round((Date.now() - started) / 1000)} s` +
        (costUsd != null ? `, ~$${costUsd.toFixed(2)} at API prices` : ""),
    );
    analysis = {
      version: 1,
      day,
      at: new Date().toISOString(),
      model: deps.engine.model,
      engine: deps.engine.name,
      costUsd: costUsd ?? 0,
      data,
    };
    writeCache(deps.cacheDir, analysis);
  }

  try {
    const text = JSON.stringify(analysis, null, 2);
    await deps.store.write(analysisDayPath(day), text, `AI-elemzés ${day}`);
    await deps.store.write(ANALYSIS_LATEST_PATH, text, `AI-elemzés (legfrissebb) ${day}`);
    return { analysis };
  } catch (e) {
    const m = (e as Error).message;
    console.error("analysis: upload failed:", m);
    const uploadError = /HTTP (401|403)\b/.test(m)
      ? "a GitHub-token nem írhatja a szinkron-repót. Adj meg írási jogú tokent NEWS_GITHUB_TOKEN néven a .notify/.env-ben."
      : m;
    return { analysis, uploadError };
  }
}
