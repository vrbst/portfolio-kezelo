// Client of the local AI bridge (scripts/notify/analysis/bridge.ts): the "Új elemzés" button runs
// the analysis on the my-claude-hub (Claude Code, the subscription) instead of the paid API. The
// bridge listens on this machine's loopback only, so the button exists only where it answers.

import { validateNightly, type NightlyAnalysis } from "./aiAnalysis";

export const BRIDGE_URL = "http://127.0.0.1:47811";
const SERVICE = "portfolio-ai-bridge";

/** Whether the bridge answers (fast: it is on this machine or not at all). */
export async function bridgeAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(1500);
    const r = await fetch(`${BRIDGE_URL}/health`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
    if (!r.ok) return false;
    return ((await r.json()) as { service?: unknown }).service === SERVICE;
  } catch {
    return false;
  }
}

export interface BridgeAnalysis {
  analysis: NightlyAnalysis;
  /** The analysis exists, but could not be uploaded to the sync repo. */
  uploadError?: string;
}

/** A new analysis through the hub; the call takes minutes. Errors carry the bridge's message. */
export async function runBridgeAnalysis(signal?: AbortSignal): Promise<BridgeAnalysis> {
  let r: Response;
  try {
    r = await fetch(`${BRIDGE_URL}/analysis`, {
      method: "POST",
      headers: { "x-portfolio-bridge": "1" },
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new Error("Leállítva.", { cause: e });
    throw new Error(
      `Nem érem el a helyi hidat (${(e as Error).message}). Indítsd el: npm run ai-bridge`,
      { cause: e },
    );
  }
  const body = (await r.json().catch(() => null)) as {
    analysis?: unknown;
    uploadError?: string;
    error?: { message?: string };
  } | null;
  if (!r.ok || !body?.analysis)
    throw new Error(body?.error?.message ?? `A híd hibát adott (${r.status}).`);
  return { analysis: validateNightly(body.analysis), uploadError: body.uploadError };
}
