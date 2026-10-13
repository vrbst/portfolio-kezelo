// The switch from the GitHub sync to Google Drive, step by step, with a
// complete back-out: whatever fails, the device ends up with the sync it had
// before (GitHub if it had one, otherwise none) — never half-way. The steps
// are injected so the order and the rollback can be tested without a browser.

import type { GoogleSyncConfig } from "./googleAuth";

export interface MigrationSteps {
  /** Choose the account, check Drive is reachable, remember it on this device. */
  signIn(): Promise<GoogleSyncConfig>;
  /** A GitHub sync is configured on this device. */
  hasGithub: boolean;
  /** Take in everything the GitHub copy holds (GitHub is still the target). */
  pullGithub(): Promise<unknown>;
  /** Make Drive the active sync target. */
  activate(config: GoogleSyncConfig): void;
  pullDrive(): Promise<unknown>;
  /** Push to Drive (the push also refreshes the GitHub mirror). */
  pushAll(): Promise<unknown>;
  /** Forget the Google sign-in; if it was already `activated`, drop the target too. */
  rollback(activated: boolean): Promise<void>;
}

export async function migrateToGoogle(s: MigrationSteps): Promise<void> {
  // A failed sign-in stored nothing, so there is nothing to undo here.
  const config = await s.signIn();
  let activated = false;
  try {
    if (s.hasGithub) await s.pullGithub();
    s.activate(config);
    activated = true;
    await s.pullDrive();
    await s.pushAll();
  } catch (e) {
    await s.rollback(activated).catch(() => undefined);
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      activated
        ? `A Google Drive-ra átállás nem sikerült, visszavontam (${
            s.hasGithub ? "a GitHub-szinkron aktív maradt" : "a szinkron ki van kapcsolva"
          }): ${why}`
        : `A GitHub-adatok beolvasása nem sikerült, a Google-belépést visszavontam: ${why}`,
      { cause: e },
    );
  }
}
