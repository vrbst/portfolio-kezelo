import { useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Upload } from "lucide-react";
import InfoTip from "../InfoTip";
import { usePortfolio } from "../../lib/store";
import { parseBackup } from "../../lib/backupRestore";
import type { BackupFile } from "../../lib/backup";
import { formatDateTime } from "../../lib/format";

/**
 * Restore from a "Teljes mentés fájlba" JSON: pick the file, see what it
 * holds, confirm. The file is merged into the current data — it brings back
 * what it contains and never deletes anything added since.
 */
export default function RestoreBackup() {
  const restoreBackup = usePortfolio((s) => s.restoreBackup);
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<BackupFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function pick(file: File | undefined) {
    setMsg(null);
    setPending(null);
    if (!file) return;
    try {
      setPending(parseBackup(await file.text()));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    // The same file can be picked again after a Mégse.
    if (input.current) input.current.value = "";
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      const { added } = await restoreBackup(pending);
      setMsg({ ok: true, text: `Visszatöltve. ${added} új tranzakció.` });
      setPending(null);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn-ghost" onClick={() => input.current?.click()} disabled={busy}>
        <Upload className="h-4 w-4" /> Mentés visszatöltése
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        data-testid="restore-input"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <InfoTip>
        Egy korábban letöltött „Teljes mentés” fájl beolvasztása a mostani
        adatba. Ami a mentésben van, az a mentés változatára áll vissza:
        számlák, értékpapírok (kötvény-paraméterek), célok és emlékeztetők
        azóta történt módosítását is felülírja. A mentés után hozzáadott
        adatot nem törli, és a már meglévő tranzakciókat nem cseréli le (a
        nyers kivonatsorok csak az új tranzakcióknál kerülnek vissza). Ha a
        szinkron be van kapcsolva, az eredmény felkerül a felhőbe is.
      </InfoTip>

      {pending && (
        <div
          className="mt-3 basis-full rounded-lg border border-[var(--color-border)] p-3 text-sm"
          data-testid="restore-confirm"
        >
          <p>
            Mentés ekkorról: <strong>{formatDateTime(pending.exportedAt)}</strong> —{" "}
            {pending.accounts.length} számla, {pending.transactions.length} tranzakció,{" "}
            {pending.instruments.length} értékpapír.
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Az egyező számlák, papírok, célok és emlékeztetők a mentés
            változatára állnak vissza; a mentés utáni új adatot nem töröljük.
          </p>
          <div className="mt-2 flex gap-2">
            <button className="btn-primary" onClick={confirm} disabled={busy}>
              Visszatöltés
            </button>
            <button className="btn-ghost" onClick={() => setPending(null)} disabled={busy}>
              Mégse
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p
          className={`mt-2 flex basis-full items-center gap-1.5 text-xs ${
            msg.ok ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"
          }`}
        >
          {msg.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {msg.text}
        </p>
      )}
    </>
  );
}
