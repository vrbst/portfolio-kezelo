// Which RemoteStore a device syncs with. Google Drive wins when the device is
// signed in with Google; otherwise the GitHub repo, if configured. The two
// configs live under separate localStorage keys (the GitHub one in its
// original format), so dropping the Google key is the way back.

import type { SyncConfig } from "../sync";
import { getGoogleAccessToken, type GoogleSyncConfig } from "../googleAuth";
import { driveStore } from "./drive";
import { githubStore } from "./github";
import type { RemoteStore } from "./types";

export interface SyncTarget {
  backend: "google" | "github";
  /** Stable name of the place (cache keys, change detection). */
  id: string;
  /** The snapshot file. */
  path: string;
  store: RemoteStore;
}

export function buildSyncTarget(
  github: SyncConfig | null,
  google: GoogleSyncConfig | null,
): SyncTarget | null {
  if (google)
    return {
      backend: "google",
      id: `drive:${google.email}`,
      path: google.path,
      store: driveStore(getGoogleAccessToken),
    };
  if (github)
    return {
      backend: "github",
      id: `${github.owner}/${github.repo}`,
      path: github.path,
      store: githubStore(github),
    };
  return null;
}
