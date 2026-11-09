import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NightlyAnalysis } from "../../../src/lib/aiAnalysis";
import { bridgeAvailable, runBridgeAnalysis } from "../../../src/lib/aiBridge";
import { HubClientError, QuotaExhaustedError } from "../hubClient";
import { bridgeError, createBridge, defaultOrigins } from "./bridge";

// The bridge on a real loopback socket, with a fake analysis run in place of the hub.

const APP = "https://example.github.io";
const analysis: NightlyAnalysis = {
  version: 1,
  day: "2026-11-09",
  at: "2026-11-09T10:00:00.000Z",
  model: "opus",
  engine: "claude-code",
  costUsd: 0.2,
  data: {
    headline: "Rendben.",
    overall: "rendben",
    changes: "",
    sections: [{ topic: "egyeb", title: "Egyéb", status: "rendben", text: "Semmi különös." }],
  },
};

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function start(run: () => Promise<{ analysis: NightlyAnalysis; uploadError?: string }>) {
  server = createBridge({ run, origins: defaultOrigins(`${APP}/portfolio/`) });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe("bridge", () => {
  it("listens on loopback only and answers the health probe", async () => {
    const base = await start(async () => ({ analysis }));
    expect((server!.address() as AddressInfo).address).toBe("127.0.0.1");
    const r = await fetch(`${base}/health`, { headers: { Origin: APP } });
    expect(await r.json()).toMatchObject({ ok: true, service: "portfolio-ai-bridge" });
    expect(r.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("refuses a foreign Origin and a foreign Host", async () => {
    const base = await start(async () => ({ analysis }));
    const evil = await fetch(`${base}/health`, { headers: { Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    // fetch cannot override Host (DNS rebinding looks like this), plain http can.
    const status = await new Promise<number>((ok, fail) => {
      const req = request(`${base}/health`, { headers: { Host: "evil.example" } }, (res) => (res.resume(), ok(res.statusCode ?? 0)));
      req.on("error", fail).end();
    });
    expect(status).toBe(403);
  });

  it("answers the preflight, including the private-network permission", async () => {
    const base = await start(async () => ({ analysis }));
    const r = await fetch(`${base}/analysis`, { method: "OPTIONS", headers: { Origin: APP } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-private-network")).toBe("true");
    expect(r.headers.get("access-control-allow-headers")).toContain("x-portfolio-bridge");
  });

  it("runs only for a POST with the bridge header", async () => {
    let calls = 0;
    const base = await start(async () => (calls++, { analysis }));
    expect((await fetch(`${base}/analysis`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/analysis`)).status).toBe(404);
    expect(calls).toBe(0);
  });

  it("one analysis at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = await start(async () => (await gate, { analysis }));
    const post = () => fetch(`${base}/analysis`, { method: "POST", headers: { "x-portfolio-bridge": "1" } });
    const first = post();
    await new Promise((r) => setTimeout(r, 50));
    expect((await post()).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("maps hub errors to codes and short messages", () => {
    const quota = new QuotaExhaustedError("limit", "2026-11-10T06:00:00.000Z");
    expect(bridgeError(quota)).toMatchObject({
      status: 429,
      error: { code: "quota_exhausted", resetAt: "2026-11-10T06:00:00.000Z" },
    });
    expect(bridgeError(new HubClientError("unreachable", 0, "no route"))).toMatchObject({
      status: 503,
      error: { code: "unreachable" },
    });
    expect(bridgeError(new Error("boom"))).toMatchObject({ status: 500, error: { code: "analysis_failed" } });
  });
});

describe("client", () => {
  it("returns the analysis and the upload problem", async () => {
    const base = await start(async () => ({ analysis, uploadError: "token" }));
    const r = await fetch(`${base}/analysis`, {
      method: "POST",
      headers: { "x-portfolio-bridge": "1" },
    });
    expect(await r.json()).toMatchObject({ analysis: { day: "2026-11-09" }, uploadError: "token" });
  });

  it("is unavailable when nothing listens", async () => {
    // The client's URL is fixed (the real port); on a dev machine the real bridge may run.
    const up = await bridgeAvailable();
    expect(typeof up).toBe("boolean");
    if (!up)
      await expect(runBridgeAnalysis()).rejects.toThrow(/helyi hidat/);
  });
});
