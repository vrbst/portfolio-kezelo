// Which RemoteStore a device syncs with. Google Drive wins when the device is
// signed in with Google; otherwise the GitHub repo, if configured. The two
// configs live under separate localStorage keys (the GitHub one in its
// original format), so dropping the Google key is the way back.
//
// While both are configured the GitHub repo is the MIRROR: every push also
// goes there (a safety net, and what the bot reads until it moves to Drive),
// and a file missing on Drive is read from it.

import type { SyncConfig } from "../sync";
import { getGoogleAccessToken, type GoogleSyncConfig } from "../googleAuth";
import { driveStore } from "./drive";
import { githubStore } from "./github";
import { RemoteAuthError, type RemoteFile, type RemoteStore } from "./types";

export interface SyncTarget {
  backend: "google" | "github";
  /** Stable name of the place (cache keys, change detection). */
  id: string;
  /** The snapshot file. */
  path: string;
  store: RemoteStore;
  /** Secondary copy that every push also goes to (GitHub, next to Drive). */
  mirror?: SyncTarget;
}

export function buildSyncTarget(
  github: SyncConfig | null,
  google: GoogleSyncConfig | null,
): SyncTarget | null {
  const gh: SyncTarget | null = github
    ? {
        backend: "github",
        id: `${github.owner}/${github.repo}`,
        path: github.path,
        store: githubStore(github),
      }
    : null;
  if (google)
    return {
      backend: "google",
      id: `drive:${google.email}`,
      path: google.path,
      store: driveStore(getGoogleAccessToken),
      ...(gh ? { mirror: gh } : {}),
    };
  return gh;
}

/**
 * Read any file of the sync store. With a mirror, a file that isn't on the
 * primary yet — or a primary that can't be reached because the Google token
 * lapsed — is read from the mirror instead.
 */
export async function readRemoteFile(
  target: SyncTarget,
  path: string,
): Promise<RemoteFile | null> {
  try {
    const file = await target.store.read(path);
    if (file || !target.mirror) return file;
  } catch (e) {
    if (!(e instanceof RemoteAuthError) || !target.mirror) throw e;
  }
  return target.mirror.store.read(path);
}
