import { useState } from "react";
import {
Cloud,RefreshCw,
CloudUpload,
CloudDownload,
CheckCircle2,AlertTriangle
} from "lucide-react";
import { usePortfolio } from "../../lib/store";
import { Card,Badge } from "../ui";
import { formatDateTime } from "../../lib/format";
import { verifyAccess,type SyncConfig } from "../../lib/sync";


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

  const [form, setForm] = useState<SyncConfig>(
    syncConfig ?? { token: "", owner: "", repo: "", path: "data.json" },
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const connected = !!syncConfig;

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
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Szinkron (több eszköz)</h2>
        </div>
        {connected && <Badge tone="positive">kapcsolódva</Badge>}
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Egy <strong>privát</strong> GitHub repóba menti az adataidat
        (fine-grained token, Contents: read &amp; write). A token csak ezen az
        eszközön tárolódik, sosem kerül fel sehova.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-ghost" onClick={connect} disabled={syncing}>
          {connected ? "Újrakapcsolódás" : "Kapcsolódás"}
        </button>
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
