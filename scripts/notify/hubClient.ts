// The notifier's door to the local my-claude-hub (C:\Users\vrbst\WORK\my-claude-hub,
// docs/API.md): POST /ask with the app's key.
//
// The transport and the typed errors are the hub's own official client
// (my-claude-hub/packages/hub-client), kept as a compiled copy in vendor/hub-client/
// (update: scripts/sync-hub-client.mjs; stamp + hashes in VENDORED.json). A copy
// and not an npm dependency: a `file:` dependency would break `npm ci` on GitHub
// Actions. This file only adds what the app needs: the HUB_CODE names, the
// hubErrorCode() helper and the "no key" message that names this app's .env.
//
// Errors carry the hub's own `error.code` (never the CLI's text), so callers
// decide on codes: "quota_exhausted", "deadline_missed", "unreachable", …

import {
  UnauthorizedError,
  ask,
  asClaudeCodeResult,
  HubClientError,
  type AskOptions,
  type AskResult,
  type HubConnection as ClientConnection,
  type Priority,
} from "../../vendor/hub-client/index.js";

export { CliError, DeadlineMissedError, HubClientError, QuotaExhaustedError, errorFromResponse, requestCapMs } from "../../vendor/hub-client/index.js";

export const HUB_CODE = {
  badRequest: "bad_request",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  quotaExhausted: "quota_exhausted",
  rateLimited: "rate_limited",
  deadlineMissed: "deadline_missed",
  timeout: "timeout",
  cliError: "cli_error",
  unavailable: "unavailable",
  internalError: "internal_error",
  /** Client side: the hub could not be reached at all (nothing was sent). */
  unreachable: "unreachable",
  /** Client side: connected, then the connection broke / ran out of time. The hub may still be running the call. */
  connectionLost: "connection_lost",
  /** Client side: the hub answered 2xx, but not with JSON. */
  badResponse: "bad_response",
} as const;

export interface HubConnection {
  /** The hub's address, e.g. http://127.0.0.1:7420. */
  baseUrl: string;
  /** The app's key (mchk_…). */
  apiKey: string;
  /** Test seam: replaces the safety cap on one request. */
  capMs?: ClientConnection["capMs"];
}

export type HubPriority = Priority;
export type HubAskOptions = AskOptions;
export type HubAskResult = AskResult;

export function hubErrorCode(e: unknown): string | undefined {
  return e instanceof HubClientError ? e.code : undefined;
}

/** The answer as `claude -p --output-format json` prints it (without the hub's fields). */
export function toCliJson(res: HubAskResult): Record<string, unknown> {
  return { ...asClaudeCodeResult(res) };
}

/** One call to the hub (plain node:http: the answer can take 12+ minutes, which fetch would cut off). */
export function hubAsk(o: HubAskOptions, conn: HubConnection): Promise<HubAskResult> {
  if (!conn.apiKey) return Promise.reject(new UnauthorizedError("Nincs hub-kulcs: add meg a MY_CLAUDE_HUB_KEY-t a .notify/.env-ben."));
  return ask(o, conn);
}
