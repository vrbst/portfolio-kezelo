import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOKEN_EVENT,
  getGoogleAccessToken,
  googleTokenExpiresAt,
  hasValidGoogleToken,
  loadGoogleSync,
  preloadGoogle,
  reconnectGoogle,
  saveGoogleSync,
  signInWithGoogle,
  signOutGoogle,
} from "./googleAuth";
import { buildSyncTarget } from "./remote";
import { RemoteAuthError } from "./remote/types";

// The browser bits (localStorage, Google Identity Services, fetch) are faked.

const TOKEN_KEY = "portfolio.googleToken";
const CONFIG_KEY = "portfolio.googleSync";

let storage: Map<string, string>;

interface TokenRequest {
  scope: string;
  clientId: string;
  options?: { prompt?: string; hint?: string };
}

/** Fake GIS; `respond` decides what the "popup" returns. */
function fakeGoogle(respond: (req: TokenRequest) => unknown) {
  const requests: TokenRequest[] = [];
  const revoked: string[] = [];
  vi.stubGlobal("google", {
    accounts: {
      oauth2: {
        initTokenClient: (c: {
          client_id: string;
          scope: string;
          callback: (r: unknown) => void;
          error_callback: (e: { type: string }) => void;
        }) => ({
          requestAccessToken: (options?: TokenRequest["options"]) => {
            const req = { scope: c.scope, clientId: c.client_id, options };
            requests.push(req);
            const r = respond(req) as { error_callback?: string } | undefined;
            if (r && "error_callback" in r) c.error_callback({ type: r.error_callback! });
            else c.callback(r);
          },
        }),
        revoke: (t: string) => revoked.push(t),
      },
    },
  });
  return { requests, revoked };
}

function fakeDriveFetch(opts: { probeStatus?: number; email?: string | null } = {}) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    if (url.includes("/about"))
      return opts.email === null
        ? new Response("", { status: 403 })
        : Response.json({ user: { emailAddress: opts.email ?? "me@example.com" } });
    return new Response(opts.probeStatus && opts.probeStatus !== 200 ? "nope" : '{"files":[]}', {
      status: opts.probeStatus ?? 200,
    });
  });
  return urls;
}

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the stored access token", () => {
  const put = (expiresAt: number) =>
    storage.set(TOKEN_KEY, JSON.stringify({ accessToken: "tok", expiresAt }));

  it("is returned while valid", async () => {
    put(Date.now() + 10 * 60_000);
    expect(hasValidGoogleToken()).toBe(true);
    expect(await getGoogleAccessToken()).toBe("tok");
  });

  it("missing, expired or about to expire is a RemoteAuthError (no popup)", async () => {
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(RemoteAuthError);
    put(Date.now() - 1000);
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(RemoteAuthError);
    put(Date.now() + 30_000); // inside the 60 s safety margin
    expect(hasValidGoogleToken()).toBe(false);
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it("garbage in storage is treated as no token", async () => {
    storage.set(TOKEN_KEY, "{nem json");
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(RemoteAuthError);
  });
});

describe("the Google sync config", () => {
  it("round-trips, defaults the path and ignores garbage", () => {
    expect(loadGoogleSync()).toBeNull();
    saveGoogleSync({ email: "a@b.hu", path: "x.json" });
    expect(loadGoogleSync()).toEqual({ email: "a@b.hu", path: "x.json" });
    storage.set(CONFIG_KEY, JSON.stringify({ email: "a@b.hu" }));
    expect(loadGoogleSync()?.path).toBe("data.json");
    storage.set(CONFIG_KEY, JSON.stringify({ nope: 1 }));
    expect(loadGoogleSync()).toBeNull();
    storage.set(CONFIG_KEY, "{");
    expect(loadGoogleSync()).toBeNull();
    saveGoogleSync(null);
    expect(storage.has(CONFIG_KEY)).toBe(false);
  });
});

describe("signInWithGoogle", () => {
  it("asks for the appdata scope, verifies the folder, stores token + account", async () => {
    const gis = fakeGoogle(() => ({ access_token: "at1", expires_in: 3600 }));
    const urls = fakeDriveFetch({ email: "me@example.com" });
    const cfg = await signInWithGoogle();
    expect(cfg).toEqual({ email: "me@example.com", path: "data.json" });
    expect(gis.requests[0]).toMatchObject({
      scope: "https://www.googleapis.com/auth/drive.appdata",
      clientId: "cid.apps.googleusercontent.com",
      options: { prompt: "select_account" },
    });
    expect(urls.some((u) => u.includes("spaces=appDataFolder"))).toBe(true);
    expect(hasValidGoogleToken()).toBe(true);
    expect(loadGoogleSync()).toEqual(cfg);
  });

  it("works without an e-mail (about is best effort)", async () => {
    fakeGoogle(() => ({ access_token: "at1" }));
    fakeDriveFetch({ email: null });
    expect((await signInWithGoogle()).email).toBe("Google-fiók");
  });

  it("a Drive that is not reachable (API off) fails and stores nothing", async () => {
    fakeGoogle(() => ({ access_token: "at1" }));
    fakeDriveFetch({ probeStatus: 403 });
    await expect(signInWithGoogle()).rejects.toThrow(/Drive nem elérhető: HTTP 403/);
    expect(storage.size).toBe(0);
  });

  it("a closed popup and a denied consent are readable errors", async () => {
    fakeGoogle(() => ({ error_callback: "popup_closed" }));
    await expect(signInWithGoogle()).rejects.toThrow(/megszakadt/);
    fakeGoogle(() => ({ error: "access_denied", error_description: "Elutasítva" }));
    await expect(signInWithGoogle()).rejects.toThrow(/Elutasítva/);
    expect(storage.size).toBe(0);
  });

  it("is off when the build has no client id", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    fakeGoogle(() => ({ access_token: "x" }));
    await expect(signInWithGoogle()).rejects.toThrow(/nincs beállítva/);
  });
});

describe("reconnectGoogle / signOutGoogle", () => {
  it("renews the token silently-by-default, hinting the known account", async () => {
    saveGoogleSync({ email: "me@example.com", path: "data.json" });
    const gis = fakeGoogle(() => ({ access_token: "fresh", expires_in: 3600 }));
    await reconnectGoogle();
    expect(gis.requests[0].options).toEqual({ prompt: "", hint: "me@example.com" });
    expect(await getGoogleAccessToken()).toBe("fresh");
  });

  it("sign-out forgets the account and revokes the token", async () => {
    fakeGoogle(() => ({ access_token: "at1" }));
    fakeDriveFetch();
    await signInWithGoogle();
    const gis = fakeGoogle(() => undefined);
    await signOutGoogle();
    expect(gis.revoked).toEqual(["at1"]);
    expect(storage.size).toBe(0);
  });
});

describe("buildSyncTarget", () => {
  const github = { token: "t", owner: "o", repo: "r", path: "data.json" };
  const google = { email: "me@example.com", path: "data.json" };

  it("nothing configured: no sync", () => {
    expect(buildSyncTarget(null, null)).toBeNull();
  });

  it("GitHub only: the repo", () => {
    expect(buildSyncTarget(github, null)).toMatchObject({ backend: "github", id: "o/r" });
  });

  it("Google wins over GitHub; dropping it falls back to the repo", () => {
    expect(buildSyncTarget(github, google)).toMatchObject({
      backend: "google",
      // The mirror is part of the id, so caches and refresh loops restart when it changes.
      id: "drive:me@example.com+o/r",
      path: "data.json",
    });
    expect(buildSyncTarget(null, google)?.id).toBe("drive:me@example.com");
    expect(buildSyncTarget(github, null)?.backend).toBe("github");
  });

  it("the Google target reads through the stored token (expired = auth error)", async () => {
    const target = buildSyncTarget(null, google)!;
    await expect(target.store.read("data.json")).rejects.toBeInstanceOf(RemoteAuthError);
  });
});

describe("token expiry and change events", () => {
  it("reports when the stored token lapses (null without one)", () => {
    expect(googleTokenExpiresAt()).toBeNull();
    storage.set(TOKEN_KEY, JSON.stringify({ accessToken: "t", expiresAt: 123456 }));
    expect(googleTokenExpiresAt()).toBe(123456);
  });

  it("sign-in, reconnect and sign-out announce the change (views re-evaluate)", async () => {
    const events: string[] = [];
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) });
    fakeGoogle(() => ({ access_token: "at1", expires_in: 3600 }));
    fakeDriveFetch();
    await signInWithGoogle();
    expect(events).toEqual([TOKEN_EVENT]);
    await reconnectGoogle();
    expect(events).toEqual([TOKEN_EVENT, TOKEN_EVENT]);
    await signOutGoogle();
    expect(events).toEqual([TOKEN_EVENT, TOKEN_EVENT, TOKEN_EVENT]);
  });
});

describe("preloadGoogle", () => {
  function fakeDocument() {
    const scripts: { src?: string }[] = [];
    vi.stubGlobal("document", {
      createElement: () => ({}) as { src?: string },
      head: { appendChild: (s: { src?: string }) => scripts.push(s) },
    });
    return scripts;
  }

  it("fetches the Google script ahead of the click, once", () => {
    const scripts = fakeDocument();
    preloadGoogle();
    preloadGoogle();
    expect(scripts.map((s) => s.src)).toEqual(["https://accounts.google.com/gsi/client"]);
  });

  it("does nothing when the build has no client id, or the script is already there", () => {
    const scripts = fakeDocument();
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    preloadGoogle();
    expect(scripts).toEqual([]);
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    fakeGoogle(() => ({ access_token: "x" }));
    preloadGoogle();
    expect(scripts).toEqual([]);
  });

  it("outside a browser it quietly does nothing", () => {
    expect(() => preloadGoogle()).not.toThrow();
  });
});
