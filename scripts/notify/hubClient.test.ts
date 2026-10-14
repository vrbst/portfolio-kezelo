import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_CODE, HubError, errorFromBody, hubAsk, hubErrorCode, requestCapMs, toCliJson, type HubConnection } from "./hubClient";

// A stand-in for the hub, answering as docs/API.md describes. No real hub, no claude.
type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let server: http.Server | undefined;
async function serve(handler: Handler): Promise<HubConnection> {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "mchk_test" };
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const err = (status: number, error: Record<string, unknown>): Handler => (_req, _body, res) => json(res, status, { error });

describe("hubAsk", () => {
  it("POSTs /ask with the Bearer key and the fields (deadline as ISO) and returns the answer", async () => {
    let seen: { method?: string; url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const conn = await serve((req, body, res) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      json(res, 200, { type: "result", subtype: "success", result: "szia", total_cost_usd: 0.5, call_id: 7, queued_ms: 1, run_ms: 2, stderr: "zaj" });
    });
    const deadline = new Date(2026, 9, 14, 8, 0);
    const res = await hubAsk({ prompt: "p", model: "sonnet", tools: [], timeout_s: 60, priority: "background", run_id: "r_1", deadline }, conn);
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/ask");
    expect(seen.auth).toBe("Bearer mchk_test");
    expect(seen.body).toEqual({ prompt: "p", model: "sonnet", tools: [], timeout_s: 60, priority: "background", run_id: "r_1", deadline: deadline.toISOString() });
    expect(res).toMatchObject({ result: "szia", call_id: 7 });
    // The hub's own fields never reach the CLI-shaped JSON; stderr never mixes into the answer.
    expect(toCliJson(res)).toEqual({ type: "result", subtype: "success", result: "szia", total_cost_usd: 0.5 });
  });

  it("maps every error code of docs/API.md and keeps the extra fields", async () => {
    const cases: [number, Record<string, unknown>][] = [
      [400, { code: "bad_request", message: "m", field: "x" }],
      [401, { code: "unauthorized", message: "m" }],
      [403, { code: "forbidden", message: "m", field: "model" }],
      [429, { code: "quota_exhausted", message: "m", reset_at: "2026-10-17T06:00:00.000Z", call_id: 3 }],
      [429, { code: "rate_limited", message: "m", retry_after_s: 30 }],
      [409, { code: "deadline_missed", message: "m", call_id: 4 }],
      [504, { code: "timeout", message: "m", run_ms: 5 }],
      [502, { code: "cli_error", message: "m", exit_code: 3, stderr_tail: "boom", cli_json: { result: "r" } }],
      [503, { code: "unavailable", message: "m" }],
      [500, { code: "internal_error", message: "m" }],
    ];
    for (const [status, body] of cases) {
      const conn = await serve(err(status, body));
      const e = await hubAsk({ prompt: "p" }, conn).catch((x) => x as HubError);
      expect(e).toBeInstanceOf(HubError);
      expect(e).toMatchObject({ code: body.code, status });
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it("quota_exhausted carries resetAt, cli_error carries the CLI's JSON and exit code", async () => {
    const q = errorFromBody(429, JSON.stringify({ error: { code: "quota_exhausted", message: "x", reset_at: "2026-10-17T06:00:00.000Z", call_id: 3 } }));
    expect(q.resetAt?.toISOString()).toBe("2026-10-17T06:00:00.000Z");
    expect(q.callId).toBe(3);
    const guessed = errorFromBody(429, JSON.stringify({ error: { code: "quota_exhausted", message: "x" } }));
    expect(guessed.resetAt).toBeNull();
    const c = errorFromBody(502, JSON.stringify({ error: { code: "cli_error", message: "x", exit_code: 3, stderr_tail: "boom", cli_json: { result: "r" } } }));
    expect(c).toMatchObject({ exitCode: 3, stderrTail: "boom", cliJson: { result: "r" } });
  });

  it("a non-JSON error body becomes a plain error with the HTTP status", async () => {
    const conn = await serve((_r, _b, res) => {
      res.writeHead(502);
      res.end("<html>bad gateway</html>");
    });
    const e = await hubAsk({ prompt: "p" }, conn).catch((x) => x as HubError);
    expect(e).toMatchObject({ code: "error", status: 502 });
    expect(hubErrorCode(e)).toBe("error");
  });

  it("an empty key is unauthorized without any network call", async () => {
    const e = await hubAsk({ prompt: "p" }, { baseUrl: "http://127.0.0.1:1", apiKey: "" }).catch((x) => x as HubError);
    expect(hubErrorCode(e)).toBe(HUB_CODE.unauthorized);
  });

  it("nothing listening → unreachable (the only code that may fall back)", async () => {
    const conn = await serve(err(200, {}));
    const closed = { ...conn };
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const e = await hubAsk({ prompt: "p" }, closed).catch((x) => x as HubError);
    expect(hubErrorCode(e)).toBe(HUB_CODE.unreachable);
  });

  it("an invalid address → unreachable", async () => {
    const e = await hubAsk({ prompt: "p" }, { baseUrl: "nem cím", apiKey: "k" }).catch((x) => x as HubError);
    expect(hubErrorCode(e)).toBe(HUB_CODE.unreachable);
  });

  it("connected, then the hub drops the connection → connection_lost, never unreachable", async () => {
    const conn = await serve((req) => req.socket.destroy());
    const e = await hubAsk({ prompt: "p" }, conn).catch((x) => x as HubError);
    expect(hubErrorCode(e)).toBe(HUB_CODE.connectionLost);
  });

  it("a response cut short → connection_lost", async () => {
    const conn = await serve((_r, _b, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "500" });
      res.write('{"result":"fél');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const e = await hubAsk({ prompt: "p" }, conn).catch((x) => x as HubError);
    expect(hubErrorCode(e)).toBe(HUB_CODE.connectionLost);
  });

  it("the safety cap ends a hung request as connection_lost", async () => {
    const conn = await serve(() => {
      /* never answers */
    });
    const e = await hubAsk({ prompt: "p", timeout_s: 1 }, { ...conn, capMs: 80 }).catch((x) => x as HubError);
    expect(hubErrorCode(e)).toBe(HUB_CODE.connectionLost);
  });
});

describe("requestCapMs", () => {
  const now = Date.UTC(2026, 9, 14, 6, 0);
  it("with a deadline: the time left + the run limit + 2 minutes", () => {
    expect(requestCapMs(720, new Date(now + 10 * 60_000), now)).toBe(10 * 60_000 + 720_000 + 2 * 60_000);
  });
  it("a deadline already past counts as no waiting time", () => {
    expect(requestCapMs(720, new Date(now - 60_000), now)).toBe(720_000 + 2 * 60_000);
  });
  it("without a deadline: the run limit + 15 minutes", () => {
    expect(requestCapMs(720, undefined, now)).toBe(720_000 + 15 * 60_000);
  });
});
