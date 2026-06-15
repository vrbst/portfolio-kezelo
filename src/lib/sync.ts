// Cross-device sync via a PRIVATE GitHub repo (Contents API).
// The portfolio snapshot lives as a JSON file in a repo only you can read.
// The token is stored locally (per device) — never committed, never synced.

import type { Account, Instrument, Transaction } from './model'
import type { AlertState } from './alerts'
import type { Goal } from './goals'

const API = 'https://api.github.com'
const CONFIG_KEY = 'portfolio.syncConfig'

export interface SyncConfig {
  token: string
  owner: string
  repo: string
  path: string
  branch?: string
}

export interface PortfolioSnapshot {
  version: 1
  exportedAt: string
  accounts: Account[]
  instruments: Instrument[]
  transactions: Transaction[]
  manualPrices: Record<string, number>
  /** Alert history (seen / dismissed), synced across devices. */
  alertState?: AlertState
  /** Fixed savings goals (DCA), synced across devices. */
  goals?: Goal[]
}

export function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    return raw ? (JSON.parse(raw) as SyncConfig) : null
  } catch {
    return null
  }
}

export function saveSyncConfig(config: SyncConfig | null) {
  if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  else localStorage.removeItem(CONFIG_KEY)
}

const AUTOSYNC_KEY = 'portfolio.autoSync'

/** Auto-push after import/edits is on by default once sync is configured. */
export function loadAutoSync(): boolean {
  try {
    return localStorage.getItem(AUTOSYNC_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveAutoSync(enabled: boolean) {
  try {
    localStorage.setItem(AUTOSYNC_KEY, enabled ? 'true' : 'false')
  } catch {
    // ignore storage failures
  }
}

// ---- UTF-8 safe base64 (GitHub wants base64 content) ----------------------
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function fromBase64(b64: string): string {
  const clean = b64.replace(/\n/g, '')
  const bin = atob(clean)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function ghFetch(
  config: SyncConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
  })
}

/** Quick credential / access check. Returns the login on success. */
export async function verifyAccess(config: SyncConfig): Promise<string> {
  const res = await ghFetch(
    config,
    `/repos/${config.owner}/${config.repo}`,
  )
  if (res.status === 404)
    throw new Error('A repó nem található vagy a token nem fér hozzá.')
  if (res.status === 401)
    throw new Error('Érvénytelen token.')
  if (!res.ok) throw new Error(`GitHub hiba: HTTP ${res.status}`)
  const data = (await res.json()) as { full_name: string }
  return data.full_name
}

/** Read the snapshot file. Returns null if it doesn't exist yet. */
export async function getRemoteSnapshot(
  config: SyncConfig,
): Promise<{ snapshot: PortfolioSnapshot; sha: string } | null> {
  const ref = config.branch ? `?ref=${config.branch}` : ''
  const res = await ghFetch(
    config,
    `/repos/${config.owner}/${config.repo}/contents/${config.path}${ref}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Letöltés sikertelen: HTTP ${res.status}`)
  const data = (await res.json()) as { content: string; sha: string }
  const snapshot = JSON.parse(fromBase64(data.content)) as PortfolioSnapshot
  return { snapshot, sha: data.sha }
}

/** Write the snapshot file (create or update). */
export async function putRemoteSnapshot(
  config: SyncConfig,
  snapshot: PortfolioSnapshot,
  sha?: string,
): Promise<string> {
  const body = {
    message: `portfólió mentés ${snapshot.exportedAt}`,
    content: toBase64(JSON.stringify(snapshot, null, 2)),
    sha,
    branch: config.branch,
  }
  const res = await ghFetch(
    config,
    `/repos/${config.owner}/${config.repo}/contents/${config.path}`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Feltöltés sikertelen: HTTP ${res.status} ${txt}`)
  }
  const data = (await res.json()) as { content: { sha: string } }
  return data.content.sha
}
