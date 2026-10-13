import { afterEach, describe, expect, it, vi } from "vitest";
import { driveStore } from "./drive";
import { githubStore } from "./github";
import { RemoteAuthError, RemoteConflictError } from "./types";
import type { SyncConfig } from "../sync";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- a tiny in-memory Google Drive (appDataFolder) ------------------------

interface FakeFile {
  id: string;
  name: string;
  text: string;
  version: number;
  createdTime: number;
}

function fakeDrive() {
  const files = new Map<string, FakeFile>();
  const calls: { method: string; url: string; auth: string | null }[] = [];
  let clock = 0;
  let nextId = 1;
  let status401 = false;

  function add(name: string, text: string) {
    const f = { id: `f${nextId++}`, name, text, version: 1, createdTime: ++clock };
    files.set(f.id, f);
    return f;
  }

  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = new URL(input);
    const headers = init.headers as Record<string, string>;
    calls.push({ method, url: input, auth: headers.Authorization ?? null });
    if (status401) return new Response("", { status: 401 });

    if (method === "GET" && url.pathname === "/drive/v3/files") {
      expect(url.searchParams.get("spaces")).toBe("appDataFolder");
      const name = url.searchParams
        .get("q")!
        .match(/^name='(.*)' and trashed=false$/)![1]
        .replace(/\\(.)/g, "$1");
      const hits = [...files.values()]
        .filter((f) => f.name === name)
        .sort((a, b) => a.createdTime - b.createdTime)
        .map((f) => ({ id: f.id, version: String(f.version), createdTime: String(f.createdTime) }));
      return Response.json({ files: hits });
    }
    const id = url.pathname.split("/").pop()!;
    if (method === "GET" && url.searchParams.get("alt") === "media") {
      const f = files.get(id);
      return f ? new Response(f.text) : new Response("", { status: 404 });
    }
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
      const body = String(init.body);
      const parts = body.split(/--b[^\r\n]*/).filter((p) => p.includes("Content-Type"));
      const [meta, content] = parts.map((p) => p.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""));
      const m = JSON.parse(meta) as { name: string; parents: string[] };
      expect(m.parents).toEqual(["appDataFolder"]);
      const f = add(m.name, content);
      return Response.json({ id: f.id, version: String(f.version), createdTime: String(f.createdTime) });
    }
    if (method === "PATCH") {
      const f = files.get(id);
      if (!f) return new Response("", { status: 404 });
      f.text = String(init.body);
      f.version += 1;
      return Response.json({ version: String(f.version) });
    }
    if (method === "DELETE") {
      return files.delete(id) ? new Response(null, { status: 204 }) : new Response("", { status: 404 });
    }
    return new Response("?", { status: 500 });
  });

  return {
    files,
    calls,
    add,
    expire: () => (status401 = true),
    byName: (name: string) => [...files.values()].filter((f) => f.name === name),
  };
}

const store = () => driveStore(async () => "tok");

describe("driveStore", () => {
  it("a missing file reads as null", async () => {
    fakeDrive();
    expect(await store().read("data.json")).toBeNull();
  });

  it("creates, reads back (UTF-8) and updates, bumping the version", async () => {
    const drive = fakeDrive();
    const s = store();
    const v1 = await s.write("data.json", '{"név":"árvíztűrő"}', "m", null);
    expect(await s.read("data.json")).toEqual({ text: '{"név":"árvíztűrő"}', version: v1 });
    const v2 = await s.write("data.json", "[2]", "m", v1);
    expect(v2).not.toBe(v1);
    expect((await s.read("data.json"))?.text).toBe("[2]");
    expect(drive.byName("data.json")).toHaveLength(1);
  });

  it("paths with slashes and quotes are plain file names", async () => {
    const drive = fakeDrive();
    const s = store();
    await s.write("news/2026-10-13's.json", "x", "m");
    expect(drive.byName("news/2026-10-13's.json")).toHaveLength(1);
    expect((await s.read("news/2026-10-13's.json"))?.text).toBe("x");
  });

  it("sends the bearer token on every call", async () => {
    const drive = fakeDrive();
    await store().write("a", "1", "m");
    expect(drive.calls.length).toBeGreaterThan(1);
    expect(drive.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("a stale expectedVersion is a conflict and changes nothing", async () => {
    const drive = fakeDrive();
    const s = store();
    const v1 = await s.write("data.json", "mine", "m", null);
    drive.byName("data.json")[0].version += 1; // another device wrote
    drive.byName("data.json")[0].text = "theirs";
    await expect(s.write("data.json", "late", "m", v1)).rejects.toBeInstanceOf(RemoteConflictError);
    expect(drive.byName("data.json")[0].text).toBe("theirs");
  });

  it("create-only (null) conflicts when the file exists; a vanished file conflicts on update", async () => {
    const drive = fakeDrive();
    const s = store();
    drive.add("data.json", "x");
    await expect(s.write("data.json", "y", "m", null)).rejects.toBeInstanceOf(RemoteConflictError);
    await expect(s.write("other.json", "y", "m", "3")).rejects.toBeInstanceOf(RemoteConflictError);
  });

  it("undefined overwrites unconditionally", async () => {
    const drive = fakeDrive();
    drive.add("data.json", "old");
    await store().write("data.json", "new", "m");
    expect(drive.byName("data.json")[0].text).toBe("new");
  });

  it("when two devices create the same file, the oldest stays and the newer one is removed", async () => {
    const drive = fakeDrive();
    const s = store();
    // The other device's file appears while ours is being created: simulate
    // by adding an OLDER duplicate right after our create call.
    const realFetch = globalThis.fetch;
    let injected = false;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (!injected && init?.method === "POST") {
        injected = true;
        const older = drive.add("data.json", "other device");
        older.createdTime = -1;
      }
      return res;
    });
    await expect(s.write("data.json", "mine", "m", null)).rejects.toBeInstanceOf(RemoteConflictError);
    const left = drive.byName("data.json");
    expect(left).toHaveLength(1);
    expect(left[0].text).toBe("other device");
  });

  it("an expired token is a RemoteAuthError", async () => {
    const drive = fakeDrive();
    drive.expire();
    await expect(store().read("data.json")).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(store().write("data.json", "x", "m")).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it("other HTTP errors surface with their status", async () => {
    vi.stubGlobal("fetch", async () => new Response("kvóta", { status: 403 }));
    await expect(store().read("data.json")).rejects.toThrow(/403/);
  });
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
