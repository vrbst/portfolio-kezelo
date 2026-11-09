// The local bridge of the app's "Új elemzés" button. The browser cannot reach the my-claude-hub
// (it refuses any request with a foreign Origin), so this small loopback server stands between
// them: the app (opened on THIS machine) asks it for a new analysis, it runs the same job as the
// nightly one on the hub (Claude Code, the subscription) and answers with the result.
//
// "Only on this machine" is structural: the server listens on 127.0.0.1 only, and the app shows
// its button only when it can see the bridge. Beyond that: Host and Origin are checked (DNS
// rebinding, foreign sites), and the POST needs a header no plain form / <img> can send, so the
// browser always makes a CORS preflight first.
//
//   npm run ai-bridge

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hubErrorCode, HUB_CODE, QuotaExhaustedError } from "../hubClient";
import type { AnalysisRun } from "./job";

export const BRIDGE_PORT = 47811;
export const BRIDGE_SERVICE = "portfolio-ai-bridge";
/** Required on POST /analysis (forces a CORS preflight). */
export const BRIDGE_HEADER = "x-portfolio-bridge";

export interface BridgeOptions {
  /** One fresh analysis (the hub call). */
  run: () => Promise<AnalysisRun>;
  /** Web origins allowed to call the bridge (the deployed app, the dev servers). */
  origins: string[];
  port?: number;
}

export interface BridgeError {
  code: string;
  message: string;
  /** quota_exhausted: when the hub lets calls through again. */
  resetAt?: string;
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

/** The origins of the deployed app and of Vite's dev / preview servers. */
export function defaultOrigins(appUrl: string): string[] {
  const out = new Set<string>();
  try {
    out.add(new URL(appUrl).origin);
  } catch {
    /* no valid APP_URL: only the dev servers */
  }
  for (const port of [5173, 4173])
    for (const host of LOCAL_HOSTS) out.add(`http://${host}:${port}`);
  return [...out];
}

/** A hub / load failure as a short Hungarian message with a stable code. */
export function bridgeError(e: unknown): { status: number; error: BridgeError } {
  const code = hubErrorCode(e);
  if (e instanceof QuotaExhaustedError)
    return {
      status: 429,
      error: {
        code: HUB_CODE.quotaExhausted,
        message: "Elfogyott az előfizetés kerete, a hub visszatartja a hívásokat.",
        ...(e.resetAt ? { resetAt: e.resetAt.toISOString() } : {}),
      },
    };
  if (code === HUB_CODE.unreachable)
    return { status: 503, error: { code, message: "A my-claude-hub nem érhető el, indítsd el." } };
  if (code === HUB_CODE.unauthorized)
    return { status: 502, error: { code, message: "A hub nem fogadta el az app kulcsát (MY_CLAUDE_HUB_KEY a .notify/.env-ben)." } };
  if (code)
    return { status: 502, error: { code, message: e instanceof Error ? e.message : "A hub hibát jelzett." } };
  return {
    status: 500,
    error: { code: "analysis_failed", message: e instanceof Error ? e.message : String(e) },
  };
}

export function createBridge(opts: BridgeOptions): Server {
  let running = false;
  const port = () => (server.address() as { port: number } | null)?.port ?? opts.port ?? BRIDGE_PORT;

  const send = (res: ServerResponse, status: number, body: unknown, cors: Record<string, string>) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors });
    res.end(JSON.stringify(body));
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // DNS rebinding: only our own loopback names.
    const host = req.headers.host ?? "";
    if (!LOCAL_HOSTS.some((h) => host === `${h}:${port()}`)) return send(res, 403, { error: { code: "forbidden", message: "Idegen Host." } }, {});

    const origin = req.headers.origin;
    // No Origin: not a browser page (curl, a script on this machine) — allowed, it is local anyway.
    if (origin !== undefined && !opts.origins.includes(origin))
      return send(res, 403, { error: { code: "forbidden", message: "Idegen Origin." } }, {});
    const cors: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, vary: "Origin" }
      : {};

    const url = new URL(req.url ?? "/", "http://local");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": `content-type, ${BRIDGE_HEADER}`,
        // Chrome's private-network access: a public page may call loopback only if told so.
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600",
      });
      return void res.end();
    }

    if (req.method === "GET" && url.pathname === "/health")
      return send(res, 200, { ok: true, service: BRIDGE_SERVICE, running }, cors);

    if (req.method === "POST" && url.pathname === "/analysis") {
      if (req.headers[BRIDGE_HEADER] !== "1")
        return send(res, 403, { error: { code: "forbidden", message: "Hiányzó fejléc." } }, cors);
      if (running)
        return send(res, 409, { error: { code: "busy", message: "Már fut egy elemzés." } }, cors);
      running = true;
      try {
        const r = await opts.run();
        return send(res, 200, { analysis: r.analysis, ...(r.uploadError ? { uploadError: r.uploadError } : {}) }, cors);
      } catch (e) {
        console.error("bridge: analysis failed:", e instanceof Error ? e.message : e);
        const b = bridgeError(e);
        return send(res, b.status, { error: b.error }, cors);
      } finally {
        running = false;
      }
    }
    send(res, 404, { error: { code: "not_found", message: "Nincs ilyen útvonal." } }, cors);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("bridge: unexpected:", e);
      if (!res.headersSent) send(res, 500, { error: { code: "internal_error", message: "Belső hiba." } }, {});
      else res.end();
    });
  });
  return server;
}
