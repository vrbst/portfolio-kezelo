import { describe, expect, it } from "vitest";
import { buildSyncTarget, readRemoteFile, type SyncTarget } from "./index";
import { pushWithMirror, readSnapshotWithFallback } from "./snapshot";
import {
  RemoteAuthError,
  RemoteConflictError,
  type RemoteFile,
  type RemoteStore,
} from "./types";
import { unionSnapshots } from "../syncMerge";
import { fixtureSnapshot } from "../../test/fixture";
import type { PortfolioSnapshot } from "../sync";

// A RemoteStore over a plain map, with optional failure injection.
function mapStore(
  files: Record<string, string> = {},
  fail?: () => Error | null,
): RemoteStore & { files: Record<string, string>; writes: string[] } {
  const versions: Record<string, number> = {};
  const writes: string[] = [];
  return {
    files,
    writes,
    read: async (path): Promise<RemoteFile | null> => {
      const err = fail?.();
      if (err) throw err;
      return path in files ? { text: files[path], version: String(versions[path] ?? 1) } : null;
    },
    write: async (path, text, _m, expected) => {
      const err = fail?.();
      if (err) throw err;
      if (expected === null && path in files) throw new RemoteConflictError();
      if (typeof expected === "string" && String(versions[path] ?? 1) !== expected)
        throw new RemoteConflictError();
      files[path] = text;
      versions[path] = (versions[path] ?? 0) + 1;
      writes.push(path);
      return String(versions[path]);
    },
  };
}

const target = (store: RemoteStore, mirror?: RemoteStore): SyncTarget => ({
  backend: "google",
  id: "drive:x",
  path: "data.json",
  store,
  ...(mirror
    ? { mirror: { backend: "github", id: "o/r", path: "data.json", store: mirror } }
    : {}),
});

describe("buildSyncTarget mirror", () => {
  const github = { token: "t", owner: "o", repo: "r", path: "gh.json" };
  const google = { email: "me@example.com", path: "data.json" };

  it("Google + GitHub: Drive is primary, the repo its mirror", () => {
    const t = buildSyncTarget(github, google)!;
    expect(t.backend).toBe("google");
    expect(t.mirror).toMatchObject({ backend: "github", id: "o/r", path: "gh.json" });
  });

  it("GitHub only or Google only: no mirror", () => {
    expect(buildSyncTarget(github, null)!.mirror).toBeUndefined();
    expect(buildSyncTarget(null, google)!.mirror).toBeUndefined();
  });
});

describe("readRemoteFile", () => {
  it("the primary wins when it has the file", async () => {
    const t = target(mapStore({ a: "drive" }), mapStore({ a: "github" }));
    expect((await readRemoteFile(t, "a"))?.text).toBe("drive");
  });

  it("a file missing on the primary comes from the mirror", async () => {
    const t = target(mapStore(), mapStore({ a: "github" }));
    expect((await readRemoteFile(t, "a"))?.text).toBe("github");
    expect(await readRemoteFile(t, "nowhere")).toBeNull();
  });

  it("a lapsed Google token falls back to the mirror, other errors do not", async () => {
    const expired = target(
      mapStore({}, () => new RemoteAuthError()),
      mapStore({ a: "github" }),
    );
    expect((await readRemoteFile(expired, "a"))?.text).toBe("github");
    const broken = target(
      mapStore({}, () => new Error("HTTP 500")),
      mapStore({ a: "github" }),
    );
    await expect(readRemoteFile(broken, "a")).rejects.toThrow(/500/);
  });

  it("without a mirror it is the plain read, errors included", async () => {
    expect(await readRemoteFile(target(mapStore()), "a")).toBeNull();
    await expect(
      readRemoteFile(target(mapStore({}, () => new RemoteAuthError())), "a"),
    ).rejects.toBeInstanceOf(RemoteAuthError);
  });
});

describe("pushWithMirror", () => {
  const base = fixtureSnapshot();
  const withTx = (id: string): PortfolioSnapshot => ({
    ...base,
    transactions: [...base.transactions, { ...base.transactions[0], id }],
  });
  const ids = (store: { files: Record<string, string> }) =>
    (JSON.parse(store.files["data.json"]) as PortfolioSnapshot).transactions.map((t) => t.id);

  it("writes the primary and the mirror", async () => {
    const drive = mapStore();
    const gh = mapStore();
    const r = await pushWithMirror(target(drive, gh), () => withTx("mine"), unionSnapshots);
    expect(r.mirrorError).toBeUndefined();
    expect(ids(drive)).toContain("mine");
    expect(ids(gh)).toContain("mine");
  });

  it("the mirror also gets what only the primary held (merged), and keeps its own", async () => {
    const drive = mapStore({ "data.json": JSON.stringify(withTx("only-on-drive")) });
    const gh = mapStore({ "data.json": JSON.stringify(withTx("only-on-github")) });
    await pushWithMirror(target(drive, gh), () => withTx("mine"), unionSnapshots);
    for (const store of [drive, gh])
      expect(ids(store)).toEqual(
        expect.arrayContaining(["mine", "only-on-drive"]),
      );
    expect(ids(gh)).toContain("only-on-github");
  });

  it("a failing mirror is reported, the primary still succeeds", async () => {
    const drive = mapStore();
    const gh = mapStore({}, () => new Error("GitHub-hiba: HTTP 401"));
    const r = await pushWithMirror(target(drive, gh), () => withTx("mine"), unionSnapshots);
    expect(r.mirrorError).toMatch(/401/);
    expect(ids(drive)).toContain("mine");
  });

  it("a failing primary throws and leaves the mirror untouched", async () => {
    const drive = mapStore({}, () => new Error("HTTP 500"));
    const gh = mapStore();
    await expect(
      pushWithMirror(target(drive, gh), () => withTx("mine"), unionSnapshots),
    ).rejects.toThrow(/500/);
    expect(gh.writes).toEqual([]);
  });

  it("no mirror: just the primary", async () => {
    const drive = mapStore();
    const r = await pushWithMirror(target(drive), () => withTx("mine"), unionSnapshots);
    expect(r.mirrorError).toBeUndefined();
    expect(ids(drive)).toContain("mine");
  });
});

describe("pushWithMirror when the Google token lapsed", () => {
  const snap = fixtureSnapshot();
  const ids = (store: { files: Record<string, string> }) =>
    (JSON.parse(store.files["data.json"]) as PortfolioSnapshot).transactions.map((t) => t.id);

  it("the mirror still takes the data, and the auth error is what surfaces", async () => {
    const drive = mapStore({}, () => new RemoteAuthError());
    const gh = mapStore();
    await expect(pushWithMirror(target(drive, gh), () => snap, unionSnapshots)).rejects.toBeInstanceOf(
      RemoteAuthError,
    );
    expect(ids(gh)).toEqual(snap.transactions.map((t) => t.id));
  });

  it("a mirror that fails too doesn't replace the original error", async () => {
    const drive = mapStore({}, () => new RemoteAuthError());
    const gh = mapStore({}, () => new Error("HTTP 500"));
    await expect(pushWithMirror(target(drive, gh), () => snap, unionSnapshots)).rejects.toBeInstanceOf(
      RemoteAuthError,
    );
  });

  it("without a mirror it's just the auth error", async () => {
    const drive = mapStore({}, () => new RemoteAuthError());
    await expect(pushWithMirror(target(drive), () => snap, unionSnapshots)).rejects.toBeInstanceOf(
      RemoteAuthError,
    );
  });
});

describe("readSnapshotWithFallback", () => {
  const snap = fixtureSnapshot();
  const file = JSON.stringify(snap);

  it("reads the primary when it works", async () => {
    const r = await readSnapshotWithFallback(
      target(mapStore({ "data.json": file }), mapStore({ "data.json": "{}" })),
    );
    expect(r?.fromMirror).toBe(false);
    expect(r?.snapshot.transactions).toHaveLength(snap.transactions.length);
  });

  it("a lapsed token reads the GitHub mirror instead, marked as such", async () => {
    const r = await readSnapshotWithFallback(
      target(
        mapStore({}, () => new RemoteAuthError()),
        mapStore({ "data.json": file }),
      ),
    );
    expect(r?.fromMirror).toBe(true);
    expect(r?.snapshot.transactions).toHaveLength(snap.transactions.length);
  });

  it("no snapshot on the primary is null, not a reason to look elsewhere", async () => {
    expect(await readSnapshotWithFallback(target(mapStore(), mapStore({ "data.json": file })))).toBeNull();
  });

  it("a lapsed token without a mirror, and other errors, surface", async () => {
    await expect(
      readSnapshotWithFallback(target(mapStore({}, () => new RemoteAuthError()))),
    ).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(
      readSnapshotWithFallback(
        target(
          mapStore({}, () => new Error("HTTP 500")),
          mapStore({ "data.json": file }),
        ),
      ),
    ).rejects.toThrow(/500/);
  });
});
