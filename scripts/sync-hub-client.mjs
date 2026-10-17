#!/usr/bin/env node
// Copies the my-claude-hub's official client into vendor/hub-client/.
//
// Why a copy and not a dependency: the client lives in the my-claude-hub repo
// (packages/hub-client, compiled ESM in dist/esm). A `file:../my-claude-hub/...`
// dependency would break `npm ci` on GitHub Actions (no sibling folder there).
// So the compiled files are committed with a stamp (vendor/hub-client/
// VENDORED.json): where they came from, which version, and each file's hash.
// scripts/notify/vendorHubClient.test.ts checks the hashes, so a hand-edited
// copy is caught at once. Fix bugs in the hub repo, not in the copy.
//
// Update after rebuilding the client (in my-claude-hub: npm run build:client):
//   node scripts/sync-hub-client.mjs [--from ..\my-claude-hub\packages\hub-client]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VENDOR_DIR = path.join(ROOT, "vendor", "hub-client");
export const STAMP_FILE = "VENDORED.json";
export const DEFAULT_SOURCE = path.resolve(ROOT, "..", "my-claude-hub", "packages", "hub-client");

/** The copied files: the client's whole ESM build, without its package.json. */
export const VENDORED_FILES = ["client", "errors", "index", "sse", "transport"].flatMap((n) => [`${n}.js`, `${n}.d.ts`]);

/** SHA-256 after normalising line endings, so a CRLF checkout does not fake a difference. */
export function normalizedHash(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function hashFiles(dir, files = VENDORED_FILES) {
  return Object.fromEntries(files.map((f) => [f, normalizedHash(readFileSync(path.join(dir, f), "utf8"))]));
}

function hubCommit(sourceDir) {
  try {
    return execFileSync("git", ["-C", sourceDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Copies the client build and writes the stamp. */
export function syncHubClient({ source = DEFAULT_SOURCE, target = VENDOR_DIR } = {}) {
  const dist = path.join(source, "dist", "esm");
  if (!existsSync(dist)) throw new Error(`No compiled client: ${dist} (in my-claude-hub run: npm run build:client)`);
  const version = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).version;
  mkdirSync(target, { recursive: true });
  for (const f of VENDORED_FILES) {
    writeFileSync(path.join(target, f), readFileSync(path.join(dist, f), "utf8").replace(/\r\n/g, "\n"), "utf8");
  }
  const stamp = {
    package: "my-claude-hub-client",
    version,
    source: "my-claude-hub/packages/hub-client/dist/esm",
    hubCommit: hubCommit(source),
    files: hashFiles(target),
  };
  writeFileSync(path.join(target, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  return stamp;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--from");
  const source = i > 0 ? path.resolve(process.argv[i + 1]) : DEFAULT_SOURCE;
  try {
    const stamp = syncHubClient({ source });
    console.log(`hub-client ${stamp.version} (hub commit: ${stamp.hubCommit ?? "unknown"}) → ${path.relative(ROOT, VENDOR_DIR)}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
