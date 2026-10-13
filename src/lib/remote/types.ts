// A tiny file store the sync layer talks to. Two backends implement it: the
// private GitHub repo (github.ts) and the Google Drive appDataFolder
// (drive.ts). The stored bytes are identical, so either one can be restored
// into the other.

export interface RemoteFile {
  text: string;
  /** Opaque change marker: the GitHub blob sha / the Drive file version. */
  version: string;
}

export interface RemoteStore {
  /** The file, or null if it doesn't exist yet. */
  read(path: string): Promise<RemoteFile | null>;
  /**
   * Write a file and return its new version. `expectedVersion`:
   *  - a string: only overwrite that exact version (else RemoteConflictError);
   *  - null: only create (else RemoteConflictError if it already exists);
   *  - undefined: overwrite unconditionally.
   * `message` is the commit message (GitHub); Drive ignores it.
   */
  write(
    path: string,
    text: string,
    message: string,
    expectedVersion?: string | null,
  ): Promise<string>;
}

/** Someone else changed the file since we read it — re-read, merge, retry. */
export class RemoteConflictError extends Error {
  constructor(message = "Ütközés: a távoli fájl közben megváltozott.") {
    super(message);
    this.name = "RemoteConflictError";
  }
}

/** The credentials are missing, expired or revoked. */
export class RemoteAuthError extends Error {
  constructor(message = "A hozzáférés lejárt vagy érvénytelen.") {
    super(message);
    this.name = "RemoteAuthError";
  }
}
