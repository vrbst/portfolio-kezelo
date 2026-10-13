// Which RemoteStore a device syncs with: the private GitHub repo, if configured.

import type { SyncConfig } from "../sync";
import { githubStore } from "./github";
import type { RemoteStore } from "./types";

export interface SyncTarget {
  /** Stable name of the place (cache keys, change detection). */
  id: string;
  /** The snapshot file. */
  path: string;
  store: RemoteStore;
}

export function buildSyncTarget(github: SyncConfig | null): SyncTarget | null {
  if (!github) return null;
  return {
    id: `${github.owner}/${github.repo}`,
    path: github.path,
    store: githubStore(github),
  };
}
