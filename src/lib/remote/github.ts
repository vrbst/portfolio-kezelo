// RemoteStore on the private GitHub repo (Contents API) — a thin wrapper over
// getRepoFile / putRepoFile, which stay the single place that talks to GitHub.

import { getRepoFile, putRepoFile, type SyncConfig } from "../sync";
import {
  RemoteAuthError,
  RemoteConflictError,
  type RemoteStore,
} from "./types";

export function githubStore(config: SyncConfig): RemoteStore {
  return {
    read: async (path) => {
      try {
        const f = await getRepoFile(config, path);
        return f ? { text: f.text, version: f.sha } : null;
      } catch (e) {
        throw asRemoteError(e);
      }
    },
    write: async (path, text, message, expectedVersion) => {
      try {
        // Unconditional overwrite needs the current sha; null = create only.
        const sha =
          expectedVersion === undefined
            ? (await getRepoFile(config, path))?.sha
            : (expectedVersion ?? undefined);
        return await putRepoFile(config, path, text, message, sha);
      } catch (e) {
        throw asRemoteError(e);
      }
    },
  };
}

function asRemoteError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  if (/HTTP 401/.test(e.message)) return new RemoteAuthError(e.message);
  // 409: stale sha. 422 "sha wasn't supplied": the file appeared meanwhile.
  if (/HTTP 409/.test(e.message) || /HTTP 422.*sha/i.test(e.message))
    return new RemoteConflictError();
  return e;
}
