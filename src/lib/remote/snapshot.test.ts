import { describe, expect, it } from "vitest";
import { pushSnapshot, readSnapshot, writeSnapshot } from "./snapshot";
import { RemoteConflictError, type RemoteFile, type RemoteStore } from "./types";
import { unionSnapshots } from "../syncMerge";
import { fixtureSnapshot } from "../../test/fixture";
import type { PortfolioSnapshot } from "../sync";

// An in-memory RemoteStore with real version/conflict semantics, plus a hook
// that lets "another device" write between our read and our write.
function memoryStore(initial?: PortfolioSnapshot) {
  let file: RemoteFile | null = initial
    ? { text: JSON.stringify(initial), version: "1" }
    : null;
  let beforeWrite: (() => void) | null = null;
  const log: string[] = [];
  const store: RemoteStore = {
    read: async () => {
      log.push("read");
      return file;
    },
    write: async (_p, text, _m, expected) => {
      log.push(`write:${expected === null ? "null" : (expected ?? "any")}`);
      beforeWrite?.();
      beforeWrite = null;
      if (expected === null && file) throw new RemoteConflictError();
      if (typeof expected === "string" && file?.version !== expected)
        throw new RemoteConflictError();
      file = { text, version: String(Number(file?.version ?? 0) + 1) };
      return file.version;
    },
  };
  return {
    store,
    log,
    current: () => (file ? (JSON.parse(file.text) as PortfolioSnapshot) : null),
    otherDeviceWrites: (snap: PortfolioSnapshot) => {
      beforeWrite = () => {
        file = { text: JSON.stringify(snap), version: String(Number(file?.version ?? 0) + 1) };
      };
    },
  };
}

const base = fixtureSnapshot();
const withTx = (id: string): PortfolioSnapshot => ({
  ...base,
  transactions: [...base.transactions, { ...base.transactions[0], id }],
});

describe("readSnapshot / writeSnapshot", () => {
  it("round-trips and reports the version", async () => {
    const m = memoryStore();
    expect(await readSnapshot(m.store, "data.json")).toBeNull();
    const v = await writeSnapshot(m.store, "data.json", base, null);
    const got = await readSnapshot(m.store, "data.json");
    expect(got?.sha).toBe(v);
    expect(got?.snapshot.transactions).toHaveLength(base.transactions.length);
  });

  it("refuses a corrupt snapshot", async () => {
    const m = memoryStore();
    await m.store.write("data.json", JSON.stringify({ version: 1 }), "m", null);
    await expect(readSnapshot(m.store, "data.json")).rejects.toThrow(/Sérült/);
  });
});

describe("pushSnapshot", () => {
  it("first push creates the file (create-only)", async () => {
    const m = memoryStore();
    const r = await pushSnapshot(m.store, "d", () => base, unionSnapshots);
    expect(r.hadRemote).toBe(false);
    expect(m.log).toEqual(["read", "write:null"]);
    expect(m.current()?.transactions).toHaveLength(base.transactions.length);
  });

  it("merges with the remote copy before writing", async () => {
    const m = memoryStore(withTx("remote-only"));
    const r = await pushSnapshot(m.store, "d", () => withTx("local-only"), unionSnapshots);
    expect(r.hadRemote).toBe(true);
    const ids = m.current()!.transactions.map((t) => t.id);
    expect(ids).toContain("remote-only");
    expect(ids).toContain("local-only");
  });

  it("another device writing in between: re-reads, re-merges, keeps both", async () => {
    const m = memoryStore(base);
    m.otherDeviceWrites(withTx("from-other-device"));
    const r = await pushSnapshot(m.store, "d", () => withTx("mine"), unionSnapshots);
    expect(m.log).toEqual(["read", "write:1", "read", "write:2"]);
    expect(r.hadRemote).toBe(true);
    const ids = m.current()!.transactions.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["from-other-device", "mine"]));
  });

  it("two devices creating the first file at once: the loser merges", async () => {
    const m = memoryStore();
    m.otherDeviceWrites(withTx("other-first"));
    await pushSnapshot(m.store, "d", () => withTx("mine"), unionSnapshots);
    const ids = m.current()!.transactions.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["other-first", "mine"]));
  });

  it("gives up after repeated conflicts, other errors surface at once", async () => {
    const always: RemoteStore = {
      read: async () => null,
      write: async () => {
        throw new RemoteConflictError();
      },
    };
    await expect(pushSnapshot(always, "d", () => base, unionSnapshots)).rejects.toBeInstanceOf(
      RemoteConflictError,
    );
    let writes = 0;
    const broken: RemoteStore = {
      read: async () => null,
      write: async () => {
        writes++;
        throw new Error("HTTP 500");
      },
    };
    await expect(pushSnapshot(broken, "d", () => base, unionSnapshots)).rejects.toThrow(/500/);
    expect(writes).toBe(1);
  });

  it("reads the local state afresh on every attempt", async () => {
    const m = memoryStore(base);
    m.otherDeviceWrites(withTx("x"));
    let calls = 0;
    await pushSnapshot(
      m.store,
      "d",
      () => {
        calls++;
        return withTx(`local-${calls}`);
      },
      unionSnapshots,
    );
    expect(calls).toBe(2);
  });
});
