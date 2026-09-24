import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Trash2, Database, Download, Upload, ShieldCheck } from "lucide-react";
import { usePortfolio } from "../lib/store";
import { PageHeader, Card } from "../components/ui";
import { formatDateTime } from "../lib/format";
import { downloadBackup } from "../lib/backup";

import SyncSettings from "../components/settings/SyncSettings";
import AiSettings from "../components/settings/AiSettings";
import PriceSettings from "../components/settings/PriceSettings";
import BondSeriesSettings from "../components/settings/BondSeriesSettings";
import AlertSettings from "../components/settings/AlertSettings";

export default function Settings() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const clearAll = usePortfolio((s) => s.clearAll);
  const syncOn = usePortfolio((s) => s.syncConfig != null);
  const [confirming, setConfirming] = useState(false);

  // Build stamp comes from a runtime-fetched version.json (see vite.config.ts)
  // so it never lands in the precached bundle and can't trigger a bogus PWA
  // "new version" prompt on price-only deploys. In dev the file is absent.
  const [build, setBuild] = useState<{ builtAt?: string; sha?: string } | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}version.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (alive) setBuild(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <PageHeader title="Beállítások" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Database className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Tárolt adatok</h2>
          </div>
          <dl className="space-y-2 text-sm">
            <Row label="Számlák" value={accounts.length} />
            <Row label="Tranzakciók" value={transactions.length} />
            <Row label="Értékpapírok" value={instruments.length} />
          </dl>
          <p className="mt-4 flex items-start gap-2 text-xs text-[var(--color-muted)]">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-positive)]" />
            Minden adat a böngésződ helyi tárolójában (IndexedDB) marad, nem
            kerül szerverre.
          </p>
          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <div className="flex flex-wrap gap-2">
              {/* The mobile tab bar has no Importálás entry (no room) — this
                  link keeps the import flow reachable on a phone. */}
              <Link to="/import" className="btn-ghost md:hidden">
                <Upload className="h-4 w-4" /> Importálás
              </Link>
              <button
                className="btn-ghost"
                onClick={downloadBackup}
                disabled={transactions.length === 0}
              >
                <Download className="h-4 w-4" /> Teljes mentés fájlba (JSON)
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              A teljes történet egy fájlban: tranzakciók (a nyers
              kivonatsorokkal), számlák, értékpapírok, célok, emlékeztetők,
              figyelmeztetés-előzmények, cél-allokáció és
              előrejelzés-beállítások. A szinkron-token és az API-kulcs nem
              kerül bele.
            </p>
          </div>
          <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-muted)]">
            Build: {build?.builtAt ? formatDateTime(build.builtAt) : "—"} ·{" "}
            {build?.sha ?? "dev"}
          </p>
        </Card>

        <SyncSettings />
      </div>

      <AiSettings />

      <AlertSettings />

      <PriceSettings />

      <BondSeriesSettings />

      <Card className="mt-4 border-[var(--color-negative)]/30 p-6">
        <div className="mb-2 flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-[var(--color-negative)]" />
          <h2 className="text-lg font-semibold">Veszélyes zóna</h2>
        </div>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          Az összes helyi adat végleges törlése. Ez nem vonható vissza.
          {syncOn &&
            " A szinkron ezen az eszközön is lekapcsol, hogy a felhőből ne töltődjön vissza minden. A felhőben lévő mentés megmarad: újracsatlakozva onnan visszaállítható."}
        </p>
        {confirming ? (
          <div className="flex items-center gap-3">
            <button
              className="btn bg-[var(--color-negative)] text-white hover:brightness-110"
              onClick={async () => {
                await clearAll();
                setConfirming(false);
              }}
            >
              Igen, töröljem mindet
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              Mégse
            </button>
          </div>
        ) : (
          <button
            className="btn-ghost border-[var(--color-negative)]/40 text-[var(--color-negative)]"
            onClick={() => setConfirming(true)}
          >
            Összes adat törlése
          </button>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-border)]/50 pb-2">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
