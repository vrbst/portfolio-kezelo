// The AI behind the daily news digest, behind an interface so the run can
// switch to the API later (or a fake in the tests). Today: Claude Code in
// print mode (`claude -p`) on the owner's subscription, with web search, and
// its structured output bound to NEWS_JSON_SCHEMA.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { NEWS_JSON_SCHEMA } from "../../../src/lib/newsSchema";
import { usageFromClaudeOutput, type AiUsage } from "../aiUsage";

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
  bin: string;
  model: string;
  schema?: object;
  /** Claude Code tools to allow; "" = none (default: the web research tools). */
  tools?: string;
  onRun?: (run: EngineRun) => void;
}): NewsEngine {
  return {
    name: "claude-code",
    model: opts.model,
    run: (prompt) =>
      new Promise((resolveRun, rejectRun) => {
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
        const resolve = (r: EngineResult) => {
          report(true);
          resolveRun(r);
        };
        const reject = (e: Error) => {
          report(false, e.message.slice(0, 200));
          rejectRun(e);
        };
        const tools = opts.tools ?? "WebSearch,WebFetch";
        const args = [
          "-p",
          "--output-format", "json",
          "--model", opts.model,
          // Only reading the web (or nothing): nothing that touches this machine.
          "--tools", tools,
          ...(tools ? ["--allowedTools", tools] : []),
          "--json-schema", JSON.stringify(opts.schema ?? NEWS_JSON_SCHEMA),
        ];
        // Outside the repo: the project's CLAUDE.md is about coding, not news.
        const child = spawn(opts.bin, args, { cwd: tmpdir(), windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`A Claude Code nem végzett ${ENGINE_TIMEOUT_MS / 60_000} percen belül.`));
        }, ENGINE_TIMEOUT_MS);
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`A Claude Code nem indítható (${opts.bin}): ${e.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          usage = usageFromClaudeOutput(out);
          if (code !== 0 && !out.trim())
            return reject(new Error(`A Claude Code ${code} kóddal állt le: ${err.trim().slice(0, 300)}`));
          try {
            resolve(parseClaudeCodeOutput(out));
          } catch (e) {
            reject(e as Error);
          }
        });
        // The prompt goes on stdin: no command-line length limit on Windows.
        child.stdin.end(prompt, "utf8");
      }),
  };
}
