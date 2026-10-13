import InfoTip from "../InfoTip";
import { useEffect, useState } from "react";
import {
  Cloud,
  RefreshCw,
  CloudUpload,
  CloudDownload,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { usePortfolio } from "../../lib/store";
import { Card, Badge } from "../ui";
import { formatDateTime } from "../../lib/format";
import { verifyAccess, type SyncConfig } from "../../lib/sync";
import { downloadBackup } from "../../lib/backup";
import {
  googleClientId,
  preloadGoogle,
  signInWithGoogle,
  signOutGoogle,
} from "../../lib/googleAuth";
import { migrateToGoogle } from "../../lib/googleMigration";
import { useGoogleTokenValid } from "../../lib/useGoogleToken";

export default function SyncSettings() {
  const syncConfig = usePortfolio((s) => s.syncConfig);
  const setSyncConfig = usePortfolio((s) => s.setSyncConfig);
  const pushToCloud = usePortfolio((s) => s.pushToCloud);
  const pullFromCloud = usePortfolio((s) => s.pullFromCloud);
  const syncing = usePortfolio((s) => s.syncing);
  const lastSyncedAt = usePortfolio((s) => s.lastSyncedAt);
  const autoSync = usePortfolio((s) => s.autoSync);
  const setAutoSync = usePortfolio((s) => s.setAutoSync);
  const syncError = usePortfolio((s) => s.syncError);
  const googleSync = usePortfolio((s) => s.googleSync);
  const setGoogleSync = usePortfolio((s) => s.setGoogleSync);
  const reconnectGoogleSession = usePortfolio((s) => s.reconnectGoogleSession);
  const syncTarget = usePortfolio((s) => s.syncTarget);
  const mirrorError = usePortfolio((s) => s.mirrorError);

  const [form, setForm] = useState<SyncConfig>(
    syncConfig ?? { token: "", owner: "", repo: "", path: "data.json" },
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [backupFirst, setBackupFirst] = useState(true);

  const connected = !!syncTarget;
  // Without a client id baked into the build the Google button stays hidden.
  const googleAvailable = googleClientId() !== "" || googleSync != null;
  const googleTokenOk = useGoogleTokenValid();

  // Load the Google script before the click: the sign-in popup must open
  // inside the click itself (Safari / iOS blocks it after a download wait).
  useEffect(() => {
    if (googleAvailable && !googleSync) preloadGoogle();
  }, [googleAvailable, googleSync]);

  const update = (patch: Partial<SyncConfig>) =>
    setForm((f) => ({ ...f, ...patch }));

  async function connect() {
    setMsg(null);
    try {
      const full = await verifyAccess(form);
      setSyncConfig({ ...form, path: form.path || "data.json" });
      setMsg({ ok: true, text: `Kapcsolódva: ${full}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function googleSignIn() {
    setMsg(null);
    try {
      // A restore point of this device's data, before anything moves.
      if (backupFirst) downloadBackup();
      await migrateToGoogle({
        signIn: signInWithGoogle,
        hasGithub: !!syncConfig,
        pullGithub: pullFromCloud,
        activate: setGoogleSync,
        pullDrive: pullFromCloud,
        pushAll: pushToCloud,
        rollback: async (activated) => {
          if (activated) setGoogleSync(null);
          await signOutGoogle();
        },
      });
      setMsg({
        ok: true,
        text: syncConfig
          ? "Kapcsolódva a Google Drive-hoz; a GitHub tartalékként frissül tovább."
          : "Kapcsolódva a Google Drive-hoz.",
      });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function googleReconnect() {
    setMsg(null);
    try {
      await reconnectGoogleSession();
      setMsg({ ok: true, text: "A Google-hozzáférés megújítva." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function googleSignOut() {
    setMsg(null);
    await signOutGoogle();
    // Another sync left? The store then checks it against the cloud right away.
    setGoogleSync(null);
    setMsg({
      ok: true,
      text: syncConfig
        ? "Kilépve a Google-ból; a GitHub-szinkron lett az aktív."
        : "Kilépve a Google-ból. A Drive-on lévő mentés megmaradt.",
    });
  }

  async function doPush() {
    setMsg(null);
    try {
      await pushToCloud();
      setMsg({ ok: true, text: "Feltöltve a privát repóba." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function doPull() {
    setMsg(null);
    try {
      const { added } = await pullFromCloud();
      setMsg({ ok: true, text: `Letöltve. ${added} új tranzakció.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Szinkron (több eszköz)</h2>
          <InfoTip>
            Google-fiókod rejtett appmappájába (Drive) menti az adataidat, amit
            csak ez az app lát; vagy egy <strong>privát</strong> GitHub repóba
            (fine-grained token, Contents: read &amp; write). A hozzáférés csak
            ezen az eszközön tárolódik, sosem kerül fel sehova.
          </InfoTip>
        </div>
        {connected && <Badge tone="positive">kapcsolódva</Badge>}
      </div>

      {googleAvailable && (
        <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="google-sync">
          {googleSync ? (
            <>
              <span className="text-sm">
                Google Drive: <span className="priv">{googleSync.email}</span>
              </span>
              {!googleTokenOk && (
                <button className="btn-primary" onClick={googleReconnect} disabled={syncing}>
                  Kapcsolódj újra
                </button>
              )}
              <button className="btn-ghost" onClick={googleSignOut} disabled={syncing}>
                Kilépés
              </button>
            </>
          ) : (
            <>
              <button className="btn-primary" onClick={googleSignIn} disabled={syncing}>
                Belépés Google-lal
              </button>
              <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <input
                  type="checkbox"
                  checked={backupFirst}
                  onChange={(e) => setBackupFirst(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-brand)]"
                />
                Előtte biztonsági mentés letöltése
              </label>
            </>
          )}
        </div>
      )}

      <details open={!googleSync} className="mb-1">
        <summary className="cursor-pointer text-sm text-[var(--color-muted)]">
          GitHub-repó {googleSync ? "(tartalék)" : ""}
        </summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:col-span-2"
          type="password"
          placeholder="GitHub token (github_pat_…)"
          value={form.token}
          onChange={(e) => update({ token: e.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          placeholder="Felhasználónév (owner)"
          value={form.owner}
          onChange={(e) => update({ owner: e.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          placeholder="Repó neve (pl. portfolio-data)"
          value={form.repo}
          onChange={(e) => update({ repo: e.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:col-span-2"
          placeholder="Fájl útvonal (data.json)"
          value={form.path}
          onChange={(e) => update({ path: e.target.value })}
        />
      </div>
        <button className="btn-ghost mt-2" onClick={connect} disabled={syncing}>
          {syncConfig ? "Újrakapcsolódás" : "Kapcsolódás"}
        </button>
      </details>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          onClick={doPush}
          disabled={!connected || syncing}
        >
          <CloudUpload className="h-4 w-4" /> Feltöltés
        </button>
        <button
          className="btn-ghost"
          onClick={doPull}
          disabled={!connected || syncing}
        >
          <CloudDownload className="h-4 w-4" /> Letöltés
        </button>
        {syncing && (
          <RefreshCw className="h-4 w-4 animate-spin text-[var(--color-muted)]" />
        )}
      </div>

      {connected && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          <span>Automatikus feltöltés import és szerkesztés után</span>
        </label>
      )}

      {lastSyncedAt && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Utolsó szinkron: {formatDateTime(lastSyncedAt)}
          {autoSync && connected ? " · auto" : ""}
        </p>
      )}
      {syncError && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-negative)]">
          <AlertTriangle className="h-4 w-4" />
          Auto-szinkron hiba: {syncError}
        </p>
      )}
      {mirrorError && googleSync && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-negative)]">
          <AlertTriangle className="h-4 w-4" />
          A GitHub-tartalék nem frissült: {mirrorError}
        </p>
      )}
      {msg && (
        <p
          className={`mt-2 flex items-center gap-1.5 text-xs ${
            msg.ok
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]"
          }`}
        >
          {msg.ok ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          {msg.text}
        </p>
      )}
    </Card>
  );
}
