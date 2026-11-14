import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error – a sima JS-forrás (a Workert kézzel töltjük fel), nincs típusa
import worker from "../worker/index.js";

type W = { fetch: (r: Request) => Promise<Response> };
const w = worker as W;
const call = (url: string, init?: RequestInit) => w.fetch(new Request(`https://proxy.example/?url=${encodeURIComponent(url)}`, init));

afterEach(() => vi.unstubAllGlobals());

describe("Worker-keményítés", () => {
  it("nem fogad el API-kulcsot az URL-ben (csak fejlécben)", async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response("{}");
    });
    await w.fetch(new Request("https://proxy.example/?url=" + encodeURIComponent("https://api.anthropic.com/v1/messages") + "&apikey=SECRET", { method: "POST", body: "{}" }));
    expect(seen[0]["x-api-key"]).toBeUndefined();
    await w.fetch(new Request("https://proxy.example/?url=" + encodeURIComponent("https://api.anthropic.com/v1/messages"), { method: "POST", body: "{}", headers: { "x-api-key": "K" } }));
    expect(seen[1]["x-api-key"]).toBe("K");
  });

  it("nem követi az átirányítást (nem engedélyezett hostra sem)", async () => {
    let redirect: unknown;
    vi.stubGlobal("fetch", async (_u: string, init: { redirect?: string }) => {
      redirect = init.redirect;
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });
    });
    await call("https://query1.finance.yahoo.com/v8/x");
    expect(redirect).toBe("manual");
  });

  it("a CORS-fejléc csak az app eredetét engedi", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}"));
    const ok = await call("https://api.frankfurter.app/latest", { headers: { Origin: "https://vrbst.github.io" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://vrbst.github.io");
    const evil = await call("https://api.frankfurter.app/latest", { headers: { Origin: "https://evil.example" } });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const pre = await w.fetch(new Request("https://proxy.example/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
