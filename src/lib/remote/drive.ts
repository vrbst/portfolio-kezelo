// RemoteStore on the Google Drive appDataFolder (scope drive.appdata): a
// hidden, per-app folder only this app can see. Plain fetch, so it runs in
// the browser and in the Node bot alike. A "path" such as news/index.json is
// simply the file's name — the folder is flat.
//
// Drive has no conditional write, so a version check before the PATCH narrows
// the race but doesn't close it; the snapshot merge is a union, so a lost race
// is repaired by the next push. Two devices that create the same file at once
// are resolved afterwards: the oldest file wins, the newer one is deleted.

import {
  RemoteAuthError,
  RemoteConflictError,
  type RemoteStore,
} from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const JSON_TYPE = "application/json; charset=UTF-8";

interface DriveFile {
  id: string;
  version: string;
  createdTime: string;
}

export function driveStore(getToken: () => Promise<string>): RemoteStore {
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 401) throw new RemoteAuthError();
    return res;
  }

  async function fail(what: string, res: Response): Promise<never> {
    throw new Error(`${what} sikertelen: HTTP ${res.status} ${await res.text()}`);
  }

  /** Files with this name, oldest first. */
  async function find(name: string): Promise<DriveFile[]> {
    const q = `name='${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed=false`;
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q,
      fields: "files(id,version,createdTime)",
      orderBy: "createdTime",
      pageSize: "10",
    });
    const res = await call(`${API}/files?${params}`);
    if (!res.ok) return fail("Keresés", res);
    return ((await res.json()) as { files: DriveFile[] }).files ?? [];
  }

  async function remove(id: string) {
    const res = await call(`${API}/files/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) await fail("Törlés", res);
  }

  async function create(name: string, text: string): Promise<DriveFile> {
    const boundary = `b${Math.random().toString(36).slice(2)}${Date.now()}`;
    const body =
      `--${boundary}\r\nContent-Type: ${JSON_TYPE}\r\n\r\n` +
      JSON.stringify({ name, parents: ["appDataFolder"] }) +
      `\r\n--${boundary}\r\nContent-Type: ${JSON_TYPE}\r\n\r\n` +
      text +
      `\r\n--${boundary}--`;
    const res = await call(
      `${UPLOAD}/files?uploadType=multipart&fields=id,version,createdTime`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    if (!res.ok) return fail("Feltöltés", res);
    return (await res.json()) as DriveFile;
  }

  return {
    read: async (path) => {
      const [file] = await find(path);
      if (!file) return null;
      // Version first, content second: if it changes in between we hold an
      // older version with newer content, and the next write just conflicts.
      const res = await call(`${API}/files/${file.id}?alt=media`);
      if (res.status === 404) return null;
      if (!res.ok) return fail("Letöltés", res);
      return { text: await res.text(), version: file.version };
    },

    write: async (path, text, _message, expectedVersion) => {
      const files = await find(path);
      const [file] = files;
      if (expectedVersion === null && file) throw new RemoteConflictError();
      if (typeof expectedVersion === "string") {
        if (!file || file.version !== expectedVersion)
          throw new RemoteConflictError();
      }
      if (!file) {
        const created = await create(path, text);
        // Created at the same time as another device? Oldest file wins.
        const all = await find(path);
        if (all.length > 1 && all[0].id !== created.id) {
          await remove(created.id);
          throw new RemoteConflictError();
        }
        return created.version;
      }
      const res = await call(
        `${UPLOAD}/files/${file.id}?uploadType=media&fields=version`,
        { method: "PATCH", headers: { "Content-Type": JSON_TYPE }, body: text },
      );
      if (res.status === 404) throw new RemoteConflictError();
      if (!res.ok) return fail("Feltöltés", res);
      return ((await res.json()) as { version: string }).version;
    },
  };
}
