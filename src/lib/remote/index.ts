// Which RemoteStore a device's sync config points at. Today only the GitHub
// repo; the Google Drive backend plugs in here.

import type { SyncConfig } from "../sync";
import { githubStore } from "./github";
import type { RemoteStore } from "./types";

export function remoteStoreFor(config: SyncConfig): RemoteStore {
  return githubStore(config);
}
