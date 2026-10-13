import type { NewsEngine } from "../news/engine";
import type { NewsStore } from "../news/job";
import { runOutlookAi, type OutlookAiResult } from "./aiViews";
import { readAiState, recordAttempt, shouldRunOutlookAi, writeAiState } from "./aiState";
import type { OutlookTarget } from "./refresh";

export interface WeeklyOutlookDeps {
  engine: NewsEngine;
  store: NewsStore;
  /** .notify/outlook/ai-state.json: which week last succeeded. */
  stateFile: string;
}

export type WeeklyOutcome =
  | { status: "skipped" }
  | { status: "ok"; result: OutlookAiResult }
  | { status: "failed"; message: string; reason: "limit" | "error" };

/**
 * The 04:30 run and the 08:15 retry both come here: it runs only while this
 * ISO week has no successful run, and records the outcome. A manual run always
 * runs. The caller decides how loud a failure is (only the retry's matters).
 */
export async function weeklyOutlookAi(
  targets: OutlookTarget[],
  deps: WeeklyOutlookDeps,
  now: Date,
  opts: { manual?: boolean } = {},
): Promise<WeeklyOutcome> {
  const state = readAiState(deps.stateFile);
  if (!opts.manual && !shouldRunOutlookAi(state, now)) return { status: "skipped" };
  try {
    const result = await runOutlookAi(targets, deps, now);
    writeAiState(deps.stateFile, recordAttempt(state, now, { ok: true }));
    return { status: "ok", result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const next = recordAttempt(state, now, { ok: false, message });
    writeAiState(deps.stateFile, next);
    return { status: "failed", message, reason: next.lastAttempt?.reason ?? "error" };
  }
}
