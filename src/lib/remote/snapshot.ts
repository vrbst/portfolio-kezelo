// The portfolio snapshot on top of any RemoteStore (GitHub or Drive): read +
// validate, write, and the merge-then-push loop with conflict retry. The
// stored JSON is the same for every backend.

import { validateSnapshot, type PortfolioSnapshot } from "../sync";
import type { SyncTarget } from "./index";
import { RemoteAuthError, RemoteConflictError, type RemoteStore } from "./types";

/** Read and validate the snapshot. Null if it doesn't exist yet. */
export async function readSnapshot(
  store: RemoteStore,
  path: string,
): Promise<{ snapshot: PortfolioSnapshot; sha: string } | null> {
  const file = await store.read(path);
  if (!file) return null;
  return { snapshot: validateSnapshot(JSON.parse(file.text)), sha: file.version };
}

/** Write the snapshot; `expected` as in RemoteStore.write. Returns the version. */
export function writeSnapshot(
  store: RemoteStore,
  path: string,
  snapshot: PortfolioSnapshot,
  expected?: string | null,
): Promise<string> {
  return store.write(
    path,
    JSON.stringify(snapshot, null, 2),
    `portfólió mentés ${snapshot.exportedAt}`,
    expected,
  );
}

/**
 * Merge with whatever is on the remote FIRST, so a push never overwrites
 * another device's data. If another device wrote between our read and our
 * write (RemoteConflictError), re-read + re-merge — up to two retries.
 * `local` is called afresh on every attempt so edits made meanwhile are kept.
 */
export async function pushSnapshot(
  store: RemoteStore,
  path: string,
  local: () => PortfolioSnapshot,
  merge: (remote: PortfolioSnapshot, local: PortfolioSnapshot) => PortfolioSnapshot,
): Promise<{ snapshot: PortfolioSnapshot; sha: string; hadRemote: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const existing = await readSnapshot(store, path);
    const mine = local();
    const snapshot = existing ? merge(existing.snapshot, mine) : mine;
    try {
      const sha = await writeSnapshot(store, path, snapshot, existing?.sha ?? null);
      return { snapshot, sha, hadRemote: existing != null };
    } catch (e) {
      if (!(e instanceof RemoteConflictError) || attempt >= 2) throw e;
    }
  }
}

type Merge = (remote: PortfolioSnapshot, local: PortfolioSnapshot) => PortfolioSnapshot;

/**
 * Push to the target; if it has a mirror, push there too. The primary decides
 * success — a failing mirror is only reported (`mirrorError`), never thrown,
 * so the safety net can't block the real sync. The mirror gets what the
 * primary ended up with, merged with the local state of the moment.
 */
export async function pushWithMirror(
  target: SyncTarget,
  local: () => PortfolioSnapshot,
  merge: Merge,
): Promise<{
  snapshot: PortfolioSnapshot;
  sha: string;
  hadRemote: boolean;
  mirrorError?: string;
}> {
  let primary: Awaited<ReturnType<typeof pushSnapshot>>;
  try {
    primary = await pushSnapshot(target.store, target.path, local, merge);
  } catch (e) {
    // The Google token lapsed: the mirror can still take the data, so an edit
    // made now isn't left on this device only. The auth error still surfaces.
    if (e instanceof RemoteAuthError && target.mirror) {
      try {
        await pushSnapshot(target.mirror.store, target.mirror.path, local, merge);
      } catch {
        /* the original error is the one to report */
      }
    }
    throw e;
  }
  if (!target.mirror) return primary;
  try {
    await pushSnapshot(
      target.mirror.store,
      target.mirror.path,
      () => merge(primary.snapshot, local()),
      merge,
    );
    return primary;
  } catch (e) {
    return { ...primary, mirrorError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read the snapshot for the startup pull. If the primary can't be reached
 * because the Google token lapsed, take the GitHub mirror's copy (a Google
 * device keeps it fresh) instead of leaving the device without any cloud
 * state until the user reconnects. `fromMirror` tells the caller not to
 * treat the version marker as the primary's.
 */
export async function readSnapshotWithFallback(target: SyncTarget): Promise<{
  snapshot: PortfolioSnapshot;
  sha: string;
  fromMirror: boolean;
} | null> {
  try {
    const r = await readSnapshot(target.store, target.path);
    return r ? { ...r, fromMirror: false } : null;
  } catch (e) {
    if (!(e instanceof RemoteAuthError) || !target.mirror) throw e;
    const m = await readSnapshot(target.mirror.store, target.mirror.path);
    return m ? { ...m, fromMirror: true } : null;
  }
}
