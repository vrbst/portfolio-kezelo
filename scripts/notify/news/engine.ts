// The AI behind the daily news digest, behind an interface so the run can
// switch to the API later (or a fake in the tests). Today: Claude Code in
// print mode (`claude -p`) on the owner's subscription, with web search, and
// its structured output bound to NEWS_JSON_SCHEMA — started by the local
// my-claude-hub (one queue, quota guard, history), see hubClient.ts. There is no
// direct `claude -p` fallback: an unreachable hub is an error like any other.

import { NEWS_JSON_SCHEMA } from "../../../src/lib/newsSchema";
import { usageFromClaudeOutput, usageFromClaudeResult, type AiUsage } from "../aiUsage";
import {
  HUB_CODE,
  HubError,
  hubAsk,
  toCliJson,
  type HubAskOptions,
  type HubAskResult,
  type HubConnection,
} from "../hubClient";

export interface EngineResult {
  /** The structured answer (already parsed), or the raw text to parse. */
  output: unknown;
  /** What the run would cost at API list prices (Claude Code reports it). */
  costUsd?: number;
}

export interface NewsEngine {
  /** Short name stored with the digest, e.g. "claude-code". */
  name: string;
  model: string;
  run(prompt: string): Promise<EngineResult>;
}

/** Longest the AI may research; the tg-hub job's own limit is above this. */
export const ENGINE_TIMEOUT_MS = 12 * 60_000;

/** The result object `claude -p --output-format json` prints. */
interface ClaudeCodeResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

/** stdout of `claude -p --output-format json` → the answer (exported for tests). */
export function parseClaudeCodeOutput(stdout: string): EngineResult {
  let r: ClaudeCodeResult;
  try {
    r = JSON.parse(stdout) as ClaudeCodeResult;
  } catch {
    throw new Error(`A Claude Code kimenete nem JSON: ${stdout.slice(0, 200)}`);
  }
  if (r.is_error || (r.subtype && r.subtype !== "success"))
    throw new Error(`A Claude Code hibával állt le (${r.subtype ?? "error"}): ${String(r.result ?? "").slice(0, 300)}`);
  return {
    output: r.structured_output ?? r.result,
    costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
  };
}

export interface EngineRun {
  ok: boolean;
  error?: string;
  durationMs: number;
  usage?: AiUsage;
}

export function claudeCodeEngine(opts: {
  model: string;
  schema?: object;
  /** Claude Code tools to allow; "" = none (default: the web research tools). */
  tools?: string;
  /** Searchable in the hub's history and logs (the tg-hub request id). */
  runId?: string;
  priority?: HubAskOptions["priority"];
  /**
   * The call must start before this (the hub answers deadline_missed otherwise).
   * Absolute, so a job making several calls gives each only the time that is left.
   */
  deadline?: Date;
  hub?: HubConnection;
  onRun?: (run: EngineRun) => void;
  /** Test seams. */
  askImpl?: (o: HubAskOptions, c: HubConnection) => Promise<HubAskResult>;
  now?: () => number;
}): NewsEngine {
  return {
    name: "claude-code",
    model: opts.model,
    run: async (prompt) => {
      const started = Date.now();
      let usage: AiUsage | undefined;
      let reported = false;
      const report = (ok: boolean, error?: string) => {
        if (reported) return;
        reported = true;
        try {
          opts.onRun?.({
            ok,
            ...(error ? { error } : {}),
            durationMs: Date.now() - started,
            ...(usage ? { usage } : {}),
          });
        } catch (e) {
          console.error("ai-usage:", (e as Error).message);
        }
      };
      const toolsText = opts.tools ?? "WebSearch,WebFetch";
      const tools = toolsText.split(",").map((t) => t.trim()).filter(Boolean);
      const schema = (opts.schema ?? NEWS_JSON_SCHEMA) as Record<string, unknown>;
      try {
        if (opts.deadline && (opts.now?.() ?? Date.now()) > opts.deadline.getTime())
          throw new HubError(
            HUB_CODE.deadlineMissed,
            409,
            "A hívás már nem fér bele a job idejébe (a hub sora foglalt volt); a következő futás pótolja.",
          );
        const res = await (opts.askImpl ?? hubAsk)(
          {
            prompt,
            model: opts.model,
            // Only reading the web (or nothing): nothing that touches this machine.
            // The empty list is an explicit "no tools".
            tools,
            ...(tools.length ? { allowed_tools: tools } : {}),
            json_schema: schema,
            timeout_s: ENGINE_TIMEOUT_MS / 1000,
            priority: opts.priority ?? "normal",
            ...(opts.runId ? { run_id: opts.runId } : {}),
            ...(opts.deadline ? { deadline: opts.deadline } : {}),
          },
          opts.hub ?? { baseUrl: "", apiKey: "" },
        );
        // The same shape as the CLI's own stdout: the existing parsers stay as they are.
        const stdout = JSON.stringify(toCliJson(res));
        usage = usageFromClaudeOutput(stdout);
        const result = parseClaudeCodeOutput(stdout);
        report(true);
        return result;
      } catch (e) {
        // A CLI failure that still printed JSON carries its usage.
        if (e instanceof HubError && e.code === HUB_CODE.cliError && e.cliJson) usage = usageFromClaudeResult(e.cliJson);
        report(false, (e as Error).message.slice(0, 200));
        throw e;
      }
    },
  };
}
