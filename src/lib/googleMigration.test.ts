import { describe, expect, it } from "vitest";
import { migrateToGoogle, type MigrationSteps } from "./googleMigration";

const cfg = { email: "me@example.com", path: "data.json" };

/** Steps that log their calls; `failAt` makes one of them throw. */
function steps(opts: { hasGithub: boolean; failAt?: string; rollbackFails?: boolean }) {
  const log: string[] = [];
  const step = (name: string) => async () => {
    log.push(name);
    if (opts.failAt === name) throw new Error(`${name} elbukott`);
  };
  const s: MigrationSteps = {
    hasGithub: opts.hasGithub,
    signIn: async () => {
      log.push("signIn");
      if (opts.failAt === "signIn") throw new Error("signIn elbukott");
      return cfg;
    },
    pullGithub: step("pullGithub"),
    activate: (c) => {
      expect(c).toBe(cfg);
      log.push("activate");
    },
    pullDrive: step("pullDrive"),
    pushAll: step("pushAll"),
    rollback: async (activated) => {
      log.push(`rollback(${activated})`);
      if (opts.rollbackFails) throw new Error("rollback is elbukott");
    },
  };
  return { s, log };
}

describe("migrateToGoogle", () => {
  it("with a GitHub sync: GitHub first, then Drive, then the push", async () => {
    const { s, log } = steps({ hasGithub: true });
    await migrateToGoogle(s);
    expect(log).toEqual(["signIn", "pullGithub", "activate", "pullDrive", "pushAll"]);
  });

  it("without one: no GitHub step", async () => {
    const { s, log } = steps({ hasGithub: false });
    await migrateToGoogle(s);
    expect(log).toEqual(["signIn", "activate", "pullDrive", "pushAll"]);
  });

  it("a failed sign-in stores nothing, so there's nothing to roll back", async () => {
    const { s, log } = steps({ hasGithub: true, failAt: "signIn" });
    await expect(migrateToGoogle(s)).rejects.toThrow(/signIn elbukott/);
    expect(log).toEqual(["signIn"]);
  });

  it("GitHub unreadable: Drive is never activated, the sign-in is undone", async () => {
    const { s, log } = steps({ hasGithub: true, failAt: "pullGithub" });
    await expect(migrateToGoogle(s)).rejects.toThrow(
      /GitHub-adatok beolvasása nem sikerült, a Google-belépést visszavontam: pullGithub elbukott/,
    );
    expect(log).toEqual(["signIn", "pullGithub", "rollback(false)"]);
  });

  it.each(["pullDrive", "pushAll"])(
    "%s fails after activation: fully rolled back, GitHub stays",
    async (failAt) => {
      const { s, log } = steps({ hasGithub: true, failAt });
      await expect(migrateToGoogle(s)).rejects.toThrow(
        new RegExp(`visszavontam \\(a GitHub-szinkron aktív maradt\\): ${failAt} elbukott`),
      );
      expect(log.at(-1)).toBe("rollback(true)");
    },
  );

  it("with no GitHub to fall back on, the message says the sync is off", async () => {
    const { s } = steps({ hasGithub: false, failAt: "pushAll" });
    await expect(migrateToGoogle(s)).rejects.toThrow(/a szinkron ki van kapcsolva/);
  });

  it("a rollback that itself fails doesn't hide the real reason", async () => {
    const { s } = steps({ hasGithub: true, failAt: "pullDrive", rollbackFails: true });
    await expect(migrateToGoogle(s)).rejects.toThrow(/pullDrive elbukott/);
  });

  it("keeps the original error as the cause", async () => {
    const { s } = steps({ hasGithub: false, failAt: "pullDrive" });
    const err = (await migrateToGoogle(s).catch((e: Error) => e)) as Error;
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("pullDrive elbukott");
  });
});
