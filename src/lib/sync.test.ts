import { afterEach, describe, expect, it, vi } from "vitest";
import { getRemoteSnapshot, getRepoFile, putRemoteSnapshot, putRepoFile, type SyncConfig } from "./sync";
import { fixtureSnapshot } from "../test/fixture";

// The GitHub Contents API calls with a fake fetch: the generic file
// read/write and the snapshot built on them.

const config: SyncConfig = { token: "t", owner: "o", repo: "r", path: "data.json" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

describe("getRepoFile", () => {
  it("decodes UTF-8 content and returns the sha", async () => {
    const calls = fakeFetch(() => Response.json({ content: b64("árvíztűrő") + "\n", sha: "s1" }));
    expect(await getRepoFile(config, "news/index.json")).toEqual({ text: "árvíztűrő", sha: "s1" });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/contents/news/index.json");
  });

  it("a missing file is null, other errors throw", async () => {
    fakeFetch(() => new Response("", { status: 404 }));
    expect(await getRepoFile(config, "x")).toBeNull();
    fakeFetch(() => new Response("", { status: 401 }));
    await expect(getRepoFile(config, "x")).rejects.toThrow(/401/);
  });

  it("refetches a big file as raw", async () => {
    const calls = fakeFetch((_u, init) =>
      (init?.headers as Record<string, string>).Accept === "application/vnd.github.raw+json"
        ? new Response("nagy")
        : Response.json({ content: "", sha: "s2" }),
    );
    expect(await getRepoFile(config, "x")).toEqual({ text: "nagy", sha: "s2" });
    expect(calls).toHaveLength(2);
  });
});

describe("putRepoFile", () => {
  it("PUTs base64 content with the message and sha", async () => {
    const calls = fakeFetch(() => Response.json({ content: { sha: "new" } }));
    expect(await putRepoFile(config, "news/a.json", "ő", "üzenet", "old")).toBe("new");
    expect(calls[0].init?.method).toBe("PUT");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ message: "üzenet", sha: "old", content: b64("ő") });
  });
});

describe("the snapshot on top of them", () => {
  it("reads, validates and writes data.json as before", async () => {
    const snap = fixtureSnapshot();
    const calls = fakeFetch((_u, init) =>
      init?.method === "PUT"
        ? Response.json({ content: { sha: "s4" } })
        : Response.json({ content: b64(JSON.stringify(snap)), sha: "s3" }),
    );
    const got = await getRemoteSnapshot(config);
    expect(got?.sha).toBe("s3");
    expect(got?.snapshot.transactions).toHaveLength(snap.transactions.length);
    expect(await putRemoteSnapshot(config, snap, "s3")).toBe("s4");
    expect(calls[1].url).toBe("https://api.github.com/repos/o/r/contents/data.json");
    expect(JSON.parse(String(calls[1].init?.body)).message).toBe(`portfólió mentés ${snap.exportedAt}`);
  });

  it("refuses a corrupt snapshot", async () => {
    fakeFetch(() => Response.json({ content: b64(JSON.stringify({ version: 1 })), sha: "s" }));
    await expect(getRemoteSnapshot(config)).rejects.toThrow(/Sérült/);
  });
});
