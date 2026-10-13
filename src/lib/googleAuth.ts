// Google sign-in for the Drive appDataFolder sync, in the browser: Google
// Identity Services token client (scope drive.appdata — a hidden folder only
// this app sees). There is no refresh token in the browser: the access token
// lasts ~1 hour, and once it has lapsed the user reconnects with one tap
// (`reconnectGoogle`, which must run from a click — popups need a gesture).
// The token lives in this device's localStorage only; it is never part of a
// snapshot or backup.

import { RemoteAuthError } from "./remote/types";

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const CONFIG_KEY = "portfolio.googleSync";
const TOKEN_KEY = "portfolio.googleToken";
/** Treat a token as expired this long before it really is. */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleSyncConfig {
  /** The signed-in account, shown in Settings. */
  email: string;
  /** The snapshot's file name in the app folder. */
  path: string;
}

interface StoredToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

// Just the parts of the GIS API we use.
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
interface Oauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (r: TokenResponse) => void;
    error_callback: (e: { type: string }) => void;
  }): { requestAccessToken(o?: { prompt?: string; hint?: string }): void };
  revoke(token: string, done?: () => void): void;
}
type GoogleGlobal = { accounts?: { oauth2?: Oauth2 } };

/**
 * The OAuth client id baked into the build; empty = Google sign-in is off.
 * Written as a literal `import.meta.env…` chain so Vite and Vitest both
 * substitute it; the `?.` covers Node (tsx), where there is no env object.
 */
export function googleClientId(): string {
  return import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? "";
}

// ---- persistence (per device) ---------------------------------------------

export function loadGoogleSync(): GoogleSyncConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<GoogleSyncConfig>;
    return typeof c.email === "string"
      ? { email: c.email, path: c.path || "data.json" }
      : null;
  } catch {
    return null;
  }
}

export function saveGoogleSync(config: GoogleSyncConfig | null) {
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    // ignore storage failures
  }
}

function loadToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Partial<StoredToken>;
    return typeof t.accessToken === "string" && typeof t.expiresAt === "number"
      ? { accessToken: t.accessToken, expiresAt: t.expiresAt }
      : null;
  } catch {
    return null;
  }
}

function saveToken(token: StoredToken | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage failures
  }
}

/** Does a still-valid token exist (no popup needed)? */
export function hasValidGoogleToken(now = Date.now()): boolean {
  const t = loadToken();
  return !!t && t.expiresAt - EXPIRY_MARGIN_MS > now;
}

/**
 * The token for Drive calls. Never opens a popup (browsers block those
 * outside a click): an expired token is a RemoteAuthError, and Settings
 * offers the one-tap reconnect.
 */
export async function getGoogleAccessToken(): Promise<string> {
  const t = loadToken();
  if (!t || !hasValidGoogleToken())
    throw new RemoteAuthError(
      "A Google-hozzáférés lejárt — kapcsolódj újra a Beállításokban.",
    );
  return t.accessToken;
}

// ---- Google Identity Services ----------------------------------------------

let gsi: Promise<Oauth2> | null = null;

const loaded = () => (globalThis as { google?: GoogleGlobal }).google?.accounts?.oauth2;

function loadGsi(): Promise<Oauth2> {
  const ready = loaded();
  if (ready) return Promise.resolve(ready);
  gsi ??= new Promise<Oauth2>((resolve, reject) => {
    const fail = () => {
      gsi = null;
      reject(new Error("A Google-belépés nem tölthető be (offline?)."));
    };
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      const o = loaded();
      if (o) resolve(o);
      else fail();
    };
    s.onerror = fail;
    document.head.appendChild(s);
  });
  return gsi;
}

async function requestToken(prompt: string, hint?: string): Promise<StoredToken> {
  const clientId = googleClientId();
  if (!clientId) throw new Error("A Google-belépés nincs beállítva ebben a buildben.");
  const oauth2 = await loadGsi();
  return new Promise<StoredToken>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) =>
        r.access_token
          ? resolve({
              accessToken: r.access_token,
              expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
            })
          : reject(new Error(r.error_description || r.error || "Sikertelen Google-belépés.")),
      error_callback: (e) =>
        reject(
          new Error(
            e.type === "popup_closed"
              ? "A belépés megszakadt."
              : `Google-belépési hiba: ${e.type}`,
          ),
        ),
    });
    client.requestAccessToken({ prompt, ...(hint ? { hint } : {}) });
  });
}

const DRIVE = "https://www.googleapis.com/drive/v3";

/** The account's e-mail, best effort (only shown in Settings). */
async function fetchEmail(token: string): Promise<string> {
  try {
    const res = await fetch(`${DRIVE}/about?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { user?: { emailAddress?: string } };
    return data.user?.emailAddress ?? "";
  } catch {
    return "";
  }
}

/**
 * Sign in (from a click): choose the account, verify the app folder is
 * reachable (catches a Drive API that isn't enabled in the Cloud project),
 * and remember the account on this device.
 */
export async function signInWithGoogle(): Promise<GoogleSyncConfig> {
  const token = await requestToken("select_account");
  const probe = await fetch(
    `${DRIVE}/files?spaces=appDataFolder&pageSize=1&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token.accessToken}` } },
  );
  if (!probe.ok)
    throw new Error(`A Google Drive nem elérhető: HTTP ${probe.status} ${await probe.text()}`);
  saveToken(token);
  const config: GoogleSyncConfig = {
    email: (await fetchEmail(token.accessToken)) || "Google-fiók",
    path: "data.json",
  };
  saveGoogleSync(config);
  return config;
}

/** One-tap renewal of an expired token (from a click). */
export async function reconnectGoogle(): Promise<void> {
  const email = loadGoogleSync()?.email;
  const token = await requestToken("", email?.includes("@") ? email : undefined);
  saveToken(token);
}

/** Forget the account on this device and revoke the token (best effort). */
export async function signOutGoogle(): Promise<void> {
  const t = loadToken();
  saveToken(null);
  saveGoogleSync(null);
  const oauth2 = loaded();
  if (t && oauth2) {
    try {
      oauth2.revoke(t.accessToken);
    } catch {
      // revoking is a courtesy; the token expires on its own
    }
  }
}
