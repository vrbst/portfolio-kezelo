// The old way: `claude -p` started right here. Only the engine's fallback uses
// it, when the my-claude-hub cannot be reached (MY_CLAUDE_HUB_FALLBACK=1).
// It bypasses the hub's queue and quota guard, so it is a stop-gap.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { HUB_CODE, HubError } from "../hubClient";

export interface DirectOptions {
  bin: string;
  model: string;
  schema: object;
  /** Comma-separated Claude Code tools; "" = none. */
  tools: string;
  timeoutMs: number;
}

/** Runs `claude -p --output-format json` with the prompt on stdin; resolves with its stdout. */
export function runClaudeDirect(o: DirectOptions, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format", "json",
      "--model", o.model,
      // Only reading the web (or nothing): nothing that touches this machine.
      "--tools", o.tools,
      ...(o.tools ? ["--allowedTools", o.tools] : []),
      "--json-schema", JSON.stringify(o.schema),
    ];
    // Outside the repo: the project's CLAUDE.md is about coding, not news.
    const child = spawn(o.bin, args, { cwd: tmpdir(), windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`A Claude Code nem végzett ${o.timeoutMs / 60_000} percen belül.`));
    }, o.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`A Claude Code nem indítható (${o.bin}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim())
        return reject(new Error(`A Claude Code ${code} kóddal állt le: ${err.trim().slice(0, 300)}`));
      resolve(out);
    });
    // The prompt goes on stdin: no command-line length limit on Windows.
    child.stdin.end(prompt, "utf8");
  });
}

/** Usage-limit style failures of the Claude CLI's text. */
const QUOTA_TEXT =
  /usage limit|rate.?limit|limit reached|limit will reset|\b(?:HTTP|status|error)\W{0,3}429\b|\b429 too many|overloaded_error|credit balance is too low|quota (?:exceeded|exhausted)|exceeded your quota/i;

/**
 * The direct path has no hub error codes, so the CLI's text is read here — and
 * only here — and turned into the code everything else decides on.
 */
export function tagDirectError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  return err instanceof HubError || !QUOTA_TEXT.test(err.message)
    ? err
    : new HubError(HUB_CODE.quotaExhausted, 0, err.message, { resetAt: null });
}
