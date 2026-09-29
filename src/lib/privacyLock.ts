/**
 * Privacy-mode lock: hiding the amounts is always free, showing them again
 * needs the lock password or — if registered — the device's biometric unlock
 * (fingerprint / Face ID via a WebAuthn platform authenticator).
 *
 * Device-local (localStorage), NOT synced: a WebAuthn credential only exists on
 * the device that created it. There is no server, so this is a local gate
 * against a casual onlooker, not cryptographic protection of the data.
 */

const KEY = "pf-privacy-lock";
const ITERATIONS = 150_000;

interface LockConfig {
  /** base64 PBKDF2 salt and SHA-256 derived hash of the password. */
  salt: string;
  hash: string;
  iterations: number;
  /** base64 WebAuthn credential id, when biometric unlock is registered. */
  credentialId?: string;
}

const enc = new TextEncoder();

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

function load(): LockConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LockConfig) : null;
  } catch {
    return null;
  }
}

function save(c: LockConfig | null) {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable — the lock simply won't persist
  }
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return toB64(bits);
}

export function hasLock(): boolean {
  return load() != null;
}

export function hasBiometric(): boolean {
  return !!load()?.credentialId;
}

/** Set (or replace) the lock password. Drops nothing else. */
export async function setLockPassword(password: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, ITERATIONS);
  save({ ...load(), salt: toB64(salt), hash, iterations: ITERATIONS });
}

export async function verifyPassword(password: string): Promise<boolean> {
  const c = load();
  if (!c) return true;
  const hash = await derive(password, fromB64(c.salt), c.iterations);
  return hash === c.hash;
}

export function removeLock() {
  save(null);
}

/** Can this device do a user-verifying platform unlock (fingerprint etc.)? */
export async function biometricSupported(): Promise<boolean> {
  try {
    return (
      window.isSecureContext &&
      typeof PublicKeyCredential !== "undefined" &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

/** Create a platform credential for this device; needs a lock password first. */
export async function registerBiometric(): Promise<void> {
  const c = load();
  if (!c) throw new Error("Előbb állíts be jelszót.");
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Portfólió-kezelő" },
      user: { id: randomBytes(16), name: "portfolio", displayName: "Portfólió" },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "discouraged",
      },
      timeout: 60_000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("A regisztráció megszakadt.");
  save({ ...c, credentialId: toB64(cred.rawId) });
}

export function removeBiometric() {
  const c = load();
  if (c) save({ ...c, credentialId: undefined });
}

/** Ask the device for fingerprint / Face ID. Resolves true only on a verified user. */
export async function verifyBiometric(): Promise<boolean> {
  const id = load()?.credentialId;
  if (!id) return false;
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: "public-key", id: fromB64(id) }],
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  // authenticatorData flags byte (offset 32): bit 2 = User Verified.
  const data = new Uint8Array(
    (cred.response as AuthenticatorAssertionResponse).authenticatorData,
  );
  return data.length > 32 && (data[32] & 0x04) !== 0;
}
