import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE, STAMP_FILE, VENDORED_FILES, VENDOR_DIR, hashFiles } from "../sync-hub-client.mjs";

// vendor/hub-client/ is a compiled copy of the my-claude-hub's official client
// (see scripts/sync-hub-client.mjs). Two things are guarded: the files still match
// the VENDORED.json stamp (nobody edited the copy by hand — fix bugs in the hub
// repo), and — only as a warning — whether the hub next door has a newer build.
const stamp = JSON.parse(readFileSync(path.join(VENDOR_DIR, STAMP_FILE), "utf8")) as {
  package: string;
  files: Record<string, string>;
};

describe("vendor/hub-client", () => {
  it("the stamp lists every vendored file", () => {
    expect(Object.keys(stamp.files).sort()).toEqual([...VENDORED_FILES].sort());
    expect(stamp.package).toBe("my-claude-hub-client");
  });

  it("the files match the stamp (no hand edits)", () => {
    const now = hashFiles(VENDOR_DIR);
    for (const f of VENDORED_FILES) {
      expect(now[f], `${f} differs from the stamp — fix it in the hub repo, then: node scripts/sync-hub-client.mjs`).toBe(stamp.files[f]);
    }
  });

  it("warns (does not fail) when the hub next door has a newer build", () => {
    const dist = path.join(DEFAULT_SOURCE, "dist", "esm");
    if (!existsSync(path.join(dist, "client.js"))) return; // CI: no sibling folder
    const source = hashFiles(dist);
    const differing = VENDORED_FILES.filter((f) => source[f] !== stamp.files[f]);
    if (differing.length) console.warn(`The hub has a newer client build (${differing.join(", ")}). Update: node scripts/sync-hub-client.mjs`);
  });
});
