import type { NewsEngine } from "../news/engine";
import type { NewsStore } from "../news/job";
import { extractPendingDocs, type DocsResult } from "./aiDocs";
import { listPending } from "./issuerDocs";
import { runOutlookAi, type OutlookAiResult } from "./aiViews";
import { readAiState, recordAttempt, shouldRunOutlookAi, writeAiState } from "./aiState";
import type { OutlookTarget } from "./refresh";

export interface WeeklyOutlookDeps {
  engine: NewsEngine;
  store: NewsStore;
  /** .notify/outlook/ai-state.json: which week last succeeded. */
  stateFile: string;
  /** Reads the issuers' pending consensus documents (no web tools); without it they wait. */
  docEngine?: NewsEngine;
  /** .notify/outlook: where those pending documents are. */
  docsDir?: string;
}

export type WeeklyOutcome =
  | { status: "skipped" }
  | { status: "ok"; result: OutlookAiResult; docs?: DocsResult }
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
  // Never fatal: the week's run does not depend on the documents, and a
  // document that fails stays pending (the 08:15 retry tries it again).
  const docs = async (): Promise<DocsResult | undefined> => {
    if (!deps.docEngine || !deps.docsDir) return undefined;
    try {
      return await extractPendingDocs({ engine: deps.docEngine, store: deps.store, dir: deps.docsDir }, now);
    } catch (e) {
      console.error("outlook-docs failed:", (e as Error).message);
      return undefined;
    }
  };
  if (!opts.manual && !shouldRunOutlookAi(state, now)) {
    // The week is done; only a document still waiting is worth a (small) run.
    if (!deps.docEngine || !deps.docsDir || !listPending(deps.docsDir).length) return { status: "skipped" };
    const d = await docs();
    return d?.done.length ? { status: "ok", result: { assets: 0, views: 0 }, docs: d } : { status: "skipped" };
  }
  try {
    const result = await runOutlookAi(targets, deps, now);
    writeAiState(deps.stateFile, recordAttempt(state, now, { ok: true }));
    return { status: "ok", result, docs: await docs() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const next = recordAttempt(state, now, { ok: false, message });
    writeAiState(deps.stateFile, next);
    return { status: "failed", message, reason: next.lastAttempt?.reason ?? "error" };
  }
}
