// A thin client for the local my-claude-hub (C:\Users\vrbst\WORK\my-claude-hub,
// docs/API.md): POST /ask with the app's key. Deliberately not the hub's own
// npm package — a `file:` dependency would break `npm ci` on GitHub Actions.
//
// Errors carry the hub's own `error.code` (never the CLI's text), so callers
// decide on codes: "quota_exhausted", "deadline_missed", "unreachable", …

import http from "node:http";
import https from "node:https";

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
} as const;

export interface HubConnection {
  /** The hub's address, e.g. http://127.0.0.1:7420. */
  baseUrl: string;
  /** The app's key (mchk_…). */
  apiKey: string;
  /** Test seam: replaces the safety cap on one request. */
  capMs?: number;
}

export type HubPriority = "interactive" | "normal" | "background";

/** The POST /ask fields we use (docs/API.md). */
export interface HubAskOptions {
  prompt: string;
  model?: string;
  json_schema?: Record<string, unknown>;
  /** [] = no tools at all. */
  tools?: string[];
  allowed_tools?: string[];
  /** Runtime limit of the call itself (not the time spent queued). */
  timeout_s?: number;
  priority?: HubPriority;
  /** If the call cannot start by then: deadline_missed. */
  deadline?: Date;
  run_id?: string;
}

/** `claude -p --output-format json` plus the hub's additions. */
export interface HubAskResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  call_id: number;
  queued_ms: number;
  run_ms: number;
  stderr: string;
  [key: string]: unknown;
}

export class HubError extends Error {
  readonly code: string;
  readonly status: number;
  readonly callId?: number;
  /** quota_exhausted: when the hold ends (the hub's estimate). */
  readonly resetAt?: Date | null;
  readonly retryAfterS?: number | null;
  readonly exitCode?: number | null;
  readonly stderrTail?: string;
  /** cli_error: the CLI's own JSON, if it printed one. */
  readonly cliJson?: Record<string, unknown> | null;

  constructor(
    code: string,
    status: number,
    message: string,
    extra: Partial<Pick<HubError, "callId" | "resetAt" | "retryAfterS" | "exitCode" | "stderrTail" | "cliJson">> = {},
  ) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export function hubErrorCode(e: unknown): string | undefined {
  return e instanceof HubError ? e.code : undefined;
}

/** The hub's JSON error body (docs/API.md "Hibák") → a HubError. */
export function errorFromBody(status: number, text: string): HubError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const e = (body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : undefined) ?? {};
  const code = typeof e.code === "string" ? e.code : "error";
  const message = typeof e.message === "string" ? e.message : `A hub HTTP ${status} választ adott.`;
  const resetAt = typeof e.reset_at === "string" ? new Date(e.reset_at) : null;
  return new HubError(code, status, message, {
    ...(typeof e.call_id === "number" ? { callId: e.call_id } : {}),
    ...(code === HUB_CODE.quotaExhausted ? { resetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null } : {}),
    ...(typeof e.retry_after_s === "number" ? { retryAfterS: e.retry_after_s } : {}),
    ...(typeof e.exit_code === "number" ? { exitCode: e.exit_code } : {}),
    ...(typeof e.stderr_tail === "string" ? { stderrTail: e.stderr_tail } : {}),
    ...(e.cli_json && typeof e.cli_json === "object" ? { cliJson: e.cli_json as Record<string, unknown> } : {}),
  });
}

/**
 * Longest one request may stay open: the time left until the deadline (the
 * call may wait in the hub's queue that long) + its run limit + 2 minutes; with
 * no deadline the run limit + 15 minutes. A safety net against a hung socket.
 */
export function requestCapMs(timeoutS: number, deadline: Date | undefined, now: number): number {
  const run = timeoutS * 1000;
  return deadline ? Math.max(0, deadline.getTime() - now) + run + 2 * 60_000 : run + 15 * 60_000;
}

/** The answer as `claude -p --output-format json` prints it (without the hub's fields). */
export function toCliJson(res: HubAskResult): Record<string, unknown> {
  const { call_id: _c, queued_ms: _q, run_ms: _r, stderr: _s, ...cli } = res;
  return cli;
}

/** Default run limit when the caller gives none (the hub's own default is the profile's). */
const DEFAULT_TIMEOUT_S = 900;

/**
 * One call to the hub. Plain node:http (not fetch): the answer can take 12+
 * minutes and fetch drops a connection with no response headers after 5, which
 * would look like "unreachable" and trigger a second, direct call.
 */
export function hubAsk(o: HubAskOptions, conn: HubConnection, now = Date.now()): Promise<HubAskResult> {
  if (!conn.apiKey) {
    return Promise.reject(
      new HubError(HUB_CODE.unauthorized, 401, "Nincs hub-kulcs: add meg a MY_CLAUDE_HUB_KEY-t a .notify/.env-ben."),
    );
  }
  const { deadline, ...rest } = o;
  const payload = JSON.stringify({ ...rest, ...(deadline ? { deadline: deadline.toISOString() } : {}) });
  const cap = conn.capMs ?? requestCapMs(o.timeout_s ?? DEFAULT_TIMEOUT_S, deadline, now);

  return new Promise<HubAskResult>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/ask", conn.baseUrl);
    } catch {
      return reject(new HubError(HUB_CODE.unreachable, 0, `Érvénytelen hub-cím: ${conn.baseUrl}`));
    }
    let connected = false;
    let settled = false;
    // Created after the request (a synchronous throw of lib.request must not leave
    // a timer running), yet `done` may run before it exists: hence `let`.
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "POST",
        agent: false, // a fresh socket per call: no stale keep-alive connection to confuse the error kind
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${conn.apiKey}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) =>
          done(() => reject(new HubError(HUB_CODE.connectionLost, 0, `A hub kapcsolata megszakadt a válasz közben: ${e.message}`))),
        );
        res.on("close", () => {
          if (res.complete) return;
          done(() => reject(new HubError(HUB_CODE.connectionLost, 0, "A hub lezárta a kapcsolatot a válasz vége előtt.")));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return done(() => reject(errorFromBody(status, text)));
          try {
            done(() => resolve(JSON.parse(text) as HubAskResult));
          } catch {
            done(() => reject(new HubError(HUB_CODE.connectionLost, status, `A hub válasza nem JSON: ${text.slice(0, 200)}`)));
          }
        });
      },
    );
    timer = setTimeout(() => {
      done(() =>
        reject(new HubError(HUB_CODE.connectionLost, 0, `A hub ${Math.round(cap / 1000)} s alatt sem válaszolt (biztonsági korlát).`)),
      );
      req.destroy();
    }, cap);
    req.on("socket", (s) => {
      if (!s.connecting) connected = true;
      else s.once("connect", () => (connected = true));
    });
    req.on("error", (e) =>
      done(() =>
        reject(
          connected
            ? new HubError(HUB_CODE.connectionLost, 0, `A hub kapcsolata megszakadt: ${e.message}`)
            : new HubError(HUB_CODE.unreachable, 0, `A hub nem érhető el (${conn.baseUrl}): ${(e as NodeJS.ErrnoException).code ?? e.message}`),
        ),
      ),
    );
    req.end(payload);
  });
}
