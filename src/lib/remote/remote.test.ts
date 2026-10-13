import { afterEach, describe, expect, it, vi } from "vitest";
import { githubStore } from "./github";
import { RemoteAuthError, RemoteConflictError } from "./types";
import type { SyncConfig } from "../sync";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- githubStore ----------------------------------------------------------

const config: SyncConfig = { token: "t", owner: "o", repo: "r", path: "data.json" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("githubStore", () => {
  it("maps the sha to version", async () => {
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? Response.json({ content: { sha: "new" } })
        : Response.json({ content: b64("ő"), sha: "s1" }),
    );
    const s = githubStore(config);
    expect(await s.read("x")).toEqual({ text: "ő", version: "s1" });
    expect(await s.write("x", "t", "m", "s1")).toBe("new");
  });

  it("sends the expected version as sha; undefined looks the current sha up first", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ content: { sha: "n" } });
      }
      return Response.json({ content: b64("x"), sha: "cur" });
    });
    const s = githubStore(config);
    await s.write("x", "t", "m", "given");
    await s.write("x", "t", "m");
    await s.write("x", "t", "m", null);
    expect(bodies.map((b) => (b as { sha?: string }).sha)).toEqual(["given", "cur", undefined]);
  });

  it("409 / 422-sha are conflicts, 401 is an auth error, others pass through", async () => {
    const failWith = (status: number, text = "") =>
      vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) =>
        init?.method === "PUT" ? new Response(text, { status }) : new Response("", { status: 404 }),
      );
    const s = githubStore(config);
    failWith(409);
    await expect(s.write("x", "t", "m", "old")).rejects.toBeInstanceOf(RemoteConflictError);
    failWith(422, '{"message":"\\"sha\\" wasn\'t supplied."}');
    await expect(s.write("x", "t", "m", null)).rejects.toBeInstanceOf(RemoteConflictError);
    failWith(401);
    await expect(s.write("x", "t", "m", "old")).rejects.toBeInstanceOf(RemoteAuthError);
    failWith(500);
    await expect(s.write("x", "t", "m", "old")).rejects.toThrow(/500/);
  });
});
