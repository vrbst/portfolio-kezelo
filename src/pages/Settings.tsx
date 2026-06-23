import { useState } from "react";
import {
  Trash2,
  Database,
  Cloud,
  ShieldCheck,
  LineChart,
  RefreshCw,
  CloudUpload,
  CloudDownload,
  CheckCircle2,
  AlertTriangle,
  Landmark,
  Sparkles,
  Bell,
  Target,
  Plus,
} from "lucide-react";
import { usePortfolio, useGoalProgress } from "../lib/store";
import { PageHeader, Card, Badge } from "../components/ui";
import { formatDateTime, formatNumber, formatMoney } from "../lib/format";
import { instrumentTypeLabel } from "../lib/labels";
import { PERIOD_LABEL, type GoalPeriod } from "../lib/goals";
import { verifyAccess, type SyncConfig } from "../lib/sync";
import {
  AI_MODELS,
  loadAiKey,
  saveAiKey,
  loadAiModel,
  saveAiModel,
} from "../lib/ai";
import type { BondTerms, Instrument, InstrumentType } from "../lib/model";

const PRICED_TYPES = new Set(["etf", "stock", "fund"]);
const BOND_TYPES = new Set(["gov_bond", "tbill"]);

export default function Settings() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const clearAll = usePortfolio((s) => s.clearAll);
  const [confirming, setConfirming] = useState(false);

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
        </Card>

        <SyncSettings />
      </div>

      <AiSettings />

      <AlertSettings />

      <GoalsSettings />

      <PriceSettings />

      <BondSeriesSettings />

      <Card className="mt-4 border-[var(--color-negative)]/30 p-6">
        <div className="mb-2 flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-[var(--color-negative)]" />
          <h2 className="text-lg font-semibold">Veszélyes zóna</h2>
        </div>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          Az összes helyi adat végleges törlése. Ez nem vonható vissza.
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

function SyncSettings() {
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

function AiSettings() {
  const [key, setKey] = useState(loadAiKey());
  const [model, setModel] = useState(loadAiModel());
  const [saved, setSaved] = useState(false);

  const connected = loadAiKey().length > 0;

  function save() {
    saveAiKey(key.trim());
    saveAiModel(model);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function onModelChange(id: string) {
    setModel(id);
    saveAiModel(id); // persist immediately so it applies even without re-saving the key
  }

  const activeModel = AI_MODELS.find((m) => m.id === model);

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">AI elemzés</h2>
        </div>
        {connected && <Badge tone="positive">beállítva</Badge>}
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Add meg a saját Claude API-kulcsodat az AI elemzéshez és a kérdezz
        funkcióhoz az Áttekintés oldalon. A kulcs{" "}
        <strong>csak ezen az eszközön</strong> tárolódik (mint a szinkron
        token), sosem kerül a felhőbe. Kulcsot a{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-brand)] hover:underline"
        >
          console.anthropic.com
        </a>{" "}
        oldalon készíthetsz. Hívásonként csak aggregált pillanatkép megy el
        (tranzakciók soha), így pár doll&aacute;r is sok lekérésre elég.
      </p>

      <input
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        type="password"
        placeholder="Claude API-kulcs (sk-ant-…)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />

      <div className="mt-3">
        <span className="mb-1.5 block text-xs text-[var(--color-muted)]">
          Modell
        </span>
        <div className="flex flex-col gap-2">
          {AI_MODELS.map((m) => (
            <label
              key={m.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${
                model === m.id
                  ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10"
                  : "border-[var(--color-border)] bg-[var(--color-surface-2)]/40 hover:border-[var(--color-brand)]/30"
              }`}
            >
              <input
                type="radio"
                name="ai-model"
                value={m.id}
                checked={model === m.id}
                onChange={() => onModelChange(m.id)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-[var(--color-muted)]">
                  {m.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={save}>
          Mentés
        </button>
        {connected && (
          <button
            className="btn-ghost"
            onClick={() => {
              saveAiKey("");
              setKey("");
            }}
          >
            Kulcs törlése
          </button>
        )}
        {saved && (
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-positive)]">
            <CheckCircle2 className="h-4 w-4" />
            Mentve · {activeModel?.label}
          </span>
        )}
      </div>
    </Card>
  );
}

function PriceSettings() {
  const instruments = usePortfolio((s) => s.instruments);
  const priceFile = usePortfolio((s) => s.priceFile);
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const pricesLoading = usePortfolio((s) => s.pricesLoading);
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt);
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);

  const priced = instruments.filter((i) => PRICED_TYPES.has(i.type));

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LineChart className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Árfolyamok</h2>
        </div>
        <button
          className="btn-ghost"
          onClick={() => refreshPrices()}
          disabled={pricesLoading}
        >
          <RefreshCw
            className={`h-4 w-4 ${pricesLoading ? "animate-spin" : ""}`}
          />
          Frissítés
        </button>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Automatikus forrás: Yahoo Finance (ETF) + frankfurter.app (EUR/HUF
        {eurHuf ? ` = ${formatNumber(eurHuf, 2)}` : ""}).
        {priceUpdatedAt && ` Frissítve: ${formatDateTime(priceUpdatedAt)}.`}
      </p>

      {priced.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Még nincs árazható értékpapír (ETF/részvény) importálva.
        </p>
      ) : (
        <div className="space-y-2">
          {priced.map((inst) => {
            const auto = priceFile?.prices[inst.key];
            return (
              <div
                key={inst.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {inst.ticker || inst.name}
                    <Badge tone="neutral">
                      {instrumentTypeLabel[inst.type]}
                    </Badge>
                  </div>
                  {auto?.symbol && (
                    <div className="text-xs text-[var(--color-muted)]">
                      {auto.symbol}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  {auto ? (
                    <div className="amt font-semibold tabular-nums">
                      {formatNumber(auto.price, 2)}{" "}
                      <span className="text-xs font-normal text-[var(--color-muted)]">
                        {auto.currency}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--color-muted)]">
                      Nincs automatikus ár
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

const INTERVALS = [
  { months: 12, label: "éves" },
  { months: 6, label: "féléves" },
  { months: 3, label: "negyedéves" },
  { months: 1, label: "havi" },
];

const inputCls =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm";

function BondSeriesSettings() {
  const instruments = usePortfolio((s) => s.instruments);
  const updateInstrument = usePortfolio((s) => s.updateInstrument);

  const bonds = instruments.filter((i) => BOND_TYPES.has(i.type));
  if (bonds.length === 0) return null;

  const setBond = (inst: Instrument, patch: Partial<BondTerms>) =>
    updateInstrument(inst.key, { bond: { ...inst.bond, ...patch } });

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex items-center gap-2">
        <Landmark className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Állampapír sorozatok</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        A pontos értékeléshez add meg a sorozat adatait: kibocsátás, éves kamat,
        kamatperiódus és az első kamatfizetés dátuma — ebből számoljuk a
        felhalmozott kamatot a kupon-ütemterv szerint. Az érték a lejárat előtti
        eladási költséggel csökkentve jelenik meg (alapból a névérték 1%-a),
        vagyis a most realizálható összeg. Hétvégén a következő hétfői nappal
        számolunk (mint a MobilKincstár). Az első (tört) kamat összegét kézzel
        is megadhatod (a MÁK-érték), mert a tört periódus nem számolható
        forintra pontosan. A diszkont kincstárjegyek automatikusan a vételár →
        névérték akkrécióval értékelődnek.
      </p>

      <div className="space-y-3">
        {bonds.map((inst) => {
          const isTbill = inst.type === "tbill";
          const b = inst.bond ?? {};
          const missing = !isTbill && b.couponRate == null;
          return (
            <div
              key={inst.key}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{inst.name}</span>
                <Badge tone="neutral">{instrumentTypeLabel[inst.type]}</Badge>
                {missing && <Badge tone="warning">hiányzó adat</Badge>}
                {!isTbill && !missing && <Badge tone="positive">megadva</Badge>}
                <span className="text-xs text-[var(--color-muted)]">
                  lejárat: {(b.maturity ?? inst.maturity)?.slice(0, 10) ?? "—"}
                </span>
              </div>

              {isTbill ? (
                <p className="text-xs text-[var(--color-muted)]">
                  Diszkont kincstárjegy — automatikus akkréció a lejáratig (
                  {inst.maturity?.slice(0, 10) ?? "ismeretlen lejárat"}).
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Lejárat">
                    <input
                      type="date"
                      className={inputCls}
                      value={(b.maturity ?? inst.maturity)?.slice(0, 10) ?? ""}
                      onChange={(e) =>
                        setBond(inst, { maturity: e.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="Kibocsátás">
                    <input
                      type="date"
                      className={inputCls}
                      value={b.issueDate?.slice(0, 10) ?? ""}
                      onChange={(e) =>
                        setBond(inst, {
                          issueDate: e.target.value || undefined,
                        })
                      }
                    />
                  </Field>
                  <Field label="Éves kamat %">
                    <input
                      type="number"
                      step="any"
                      className={`${inputCls} w-24 text-right`}
                      defaultValue={
                        b.couponRate != null ? b.couponRate * 100 : ""
                      }
                      placeholder="pl. 7.04"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setBond(inst, {
                          couponRate: v === "" ? undefined : Number(v) / 100,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Kamatperiódus">
                    <select
                      className={inputCls}
                      value={b.couponIntervalMonths ?? 12}
                      onChange={(e) =>
                        setBond(inst, {
                          couponIntervalMonths: Number(e.target.value),
                        })
                      }
                    >
                      {INTERVALS.map((iv) => (
                        <option key={iv.months} value={iv.months}>
                          {iv.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Első kamatfizetés">
                    <input
                      type="date"
                      className={inputCls}
                      value={b.firstCouponDate?.slice(0, 10) ?? ""}
                      onChange={(e) =>
                        setBond(inst, {
                          firstCouponDate: e.target.value || undefined,
                        })
                      }
                    />
                  </Field>
                  <Field label="Eladási költség %">
                    <input
                      type="number"
                      step="any"
                      className={`${inputCls} w-24 text-right`}
                      defaultValue={
                        b.saleCostPct != null ? b.saleCostPct * 100 : ""
                      }
                      placeholder="1"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setBond(inst, {
                          saleCostPct: v === "" ? undefined : Number(v) / 100,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Első kamat (Ft)">
                    <input
                      type="number"
                      step="any"
                      className={`${inputCls} w-32 text-right`}
                      defaultValue={b.firstCouponHuf ?? ""}
                      placeholder="becsült"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setBond(inst, {
                          firstCouponHuf: v === "" ? undefined : Number(v),
                        });
                      }}
                    />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}

function AlertSettings() {
  const idleCashHuf = usePortfolio((s) => s.alertConfig.idleCashHuf);
  const tbszCheck = usePortfolio((s) => s.alertConfig.tbszCheck);
  const setIdleCashThreshold = usePortfolio((s) => s.setIdleCashThreshold);
  const setTbszCheckEnabled = usePortfolio((s) => s.setTbszCheckEnabled);
  const [draft, setDraft] = useState(String(idleCashHuf));

  function commit() {
    const v = Number(draft.replace(/\s/g, ""));
    if (Number.isFinite(v) && v > 0) setIdleCashThreshold(v);
    else setDraft(String(idleCashHuf));
  }

  return (
    <Card className="mt-4 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Figyelmeztetések</h2>
      </div>

      <label className="mb-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={tbszCheck}
          onChange={(e) => setTbszCheckEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand)]"
        />
        <span>
          <span className="text-sm">Idei TBSZ-nyitás ellenőrzése</span>
          <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
            Figyelmeztet, ha az idei gyűjtőévre még nincs TBSZ-ed (és zöld
            „Rendben" jelzést ad, ha megvan). Kikapcsolva egyik sem jelenik meg.
          </span>
        </span>
      </label>

      <div className="max-w-sm">
        <label className="flex flex-col gap-1">
          <span className="text-sm">Parlagon álló készpénz küszöbe</span>
          <span className="text-xs text-[var(--color-muted)]">
            Ha egy számlán ennél több készpénz áll, figyelmeztetés jelenik meg.
          </span>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={10000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm tabular-nums"
            />
            <span className="text-sm text-[var(--color-muted)]">Ft</span>
          </div>
        </label>
      </div>
      <p className="mt-4 text-xs text-[var(--color-muted)]">
        A figyelmeztetések állapota (elvetés) a felhős szinkronon át minden
        eszközödön egységes. A küszöb eszközönként állítható.
      </p>
    </Card>
  );
}

const PERIODS: GoalPeriod[] = [1, 3, 6, 12];

function GoalsSettings() {
  const instruments = usePortfolio((s) => s.instruments);
  const addGoal = usePortfolio((s) => s.addGoal);
  const removeGoal = usePortfolio((s) => s.removeGoal);
  const progress = useGoalProgress();

  const investable = instruments.filter((i) => i.type !== "cash");
  // Distinct types present → "buy any instrument of this type" category goals
  // (e.g. DKJ, where each issuance is a different series/ISIN).
  const categoryTypes = [...new Set(investable.map((i) => i.type))];
  const [target, setTarget] = useState("");
  const [periodMonths, setPeriodMonths] = useState<GoalPeriod>(1);
  const [amount, setAmount] = useState("");

  // Target is encoded as `type:<t>` (category) or `key:<isin>` (specific), so
  // the two kinds never collide in the single <select>.
  const defaultTarget = categoryTypes[0]
    ? `type:${categoryTypes[0]}`
    : investable[0]
      ? `key:${investable[0].key}`
      : "";
  const sel = target || defaultTarget;
  const amountNum = Number(amount.replace(/\s/g, ""));
  const canAdd = !!sel && Number.isFinite(amountNum) && amountNum > 0;

  function submit() {
    if (!canAdd) return;
    if (sel.startsWith("type:")) {
      addGoal({
        instrumentType: sel.slice(5) as InstrumentType,
        periodMonths,
        amountHuf: amountNum,
      });
    } else {
      addGoal({
        instrumentKey: sel.slice(4),
        periodMonths,
        amountHuf: amountNum,
      });
    }
    setAmount("");
  }

  const fieldClass =
    "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm";

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex items-center gap-2">
        <Target className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Megtakarítási célok</h2>
      </div>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Rendszeres (DCA) cél egy konkrét eszközre vagy egy egész kategóriára
        (pl. „DKJ – összes", így nem kell minden új sorozatot külön kijelölni).
        Az app figyelmeztet, ha az adott időszakban még nincs meg. A hónap
        utolsó munkanapi vétele már a következő időszakba számít.
      </p>

      {progress.length > 0 && (
        <div className="mb-5 space-y-3">
          {progress.map((p) => {
            const pct = p.done ? 100 : Math.min(100, Math.round(p.ratio * 100));
            return (
              <div
                key={p.goal.id}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      {p.done && (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-positive)]" />
                      )}
                      <span className="truncate">{p.instrumentName}</span>
                      <Badge tone="neutral">
                        {PERIOD_LABEL[p.goal.periodMonths]}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {p.periodLabel}
                    </div>
                  </div>
                  <button
                    onClick={() => removeGoal(p.goal.id)}
                    title="Cél törlése"
                    className="shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-negative)]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                  <div
                    className={`h-full rounded-full ${
                      p.done
                        ? "bg-[var(--color-positive)]"
                        : "bg-[var(--color-brand)]"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-xs tabular-nums">
                  <span className="amt">
                    {formatMoney(p.investedHuf)} / {formatMoney(p.targetHuf)}
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {p.done
                      ? "Teljesítve ✓"
                      : `még ${formatMoney(p.remainingHuf)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {investable.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Előbb importálj adatokat, hogy legyen mihez célt rendelni.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">Eszköz</span>
            <select
              value={sel}
              onChange={(e) => setTarget(e.target.value)}
              className={fieldClass}
            >
              {categoryTypes.length > 0 && (
                <optgroup label="Kategória – minden ilyen eszköz">
                  {categoryTypes.map((t) => (
                    <option key={t} value={`type:${t}`}>
                      {instrumentTypeLabel[t]} (összes)
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Konkrét eszköz">
                {investable.map((i) => (
                  <option key={i.key} value={`key:${i.key}`}>
                    {i.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">Időszak</span>
            <select
              value={periodMonths}
              onChange={(e) =>
                setPeriodMonths(Number(e.target.value) as GoalPeriod)
              }
              className={fieldClass}
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">
              Összeg (Ft)
            </span>
            <input
              type="number"
              min={0}
              step={10000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="100000"
              className={`${fieldClass} w-36 tabular-nums`}
            />
          </label>
          <button
            onClick={submit}
            disabled={!canAdd}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> Hozzáad
          </button>
        </div>
      )}
    </Card>
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
