import { useEffect, useMemo, useState } from "react";
import { Crosshair, Pencil, Check, X, Trash2, BellPlus } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { assetClassLabel } from "../lib/labels";
import { allocationByClass, type AssetClass } from "../lib/portfolio";
import {
  computeDrift,
  dcaSplit,
  includedClasses,
  loadAllocationSettings,
  saveAllocationSettings,
  type AllocationSettings,
} from "../lib/allocation";
import { detectRecurringSavings, loadForecastSettings } from "../lib/forecast";
import { PREFS_EVENT } from "../lib/prefs";
import { Card } from "./ui";
import { formatMoney } from "../lib/format";

const ALL_CLASSES: AssetClass[] = ["equity", "crypto", "bond", "tbill", "cash"];

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Target allocation card: actual vs. target share per asset class, and a
 * buy-only rebalancing hint — how to split the next monthly saving so the
 * portfolio drifts back toward the targets without selling (no tax event).
 */
export default function AllocationTargets() {
  const summary = usePortfolioSummary();
  const transactions = usePortfolio((s) => s.transactions);
  const fx = usePortfolio((s) => s.fx);

  const [settings, setSettings] = useState<AllocationSettings | null>(
    loadAllocationSettings,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<AssetClass, string>>>({});
  // Which classes participate in the target allocation (checkbox in edit mode).
  const [include, setInclude] = useState<Set<AssetClass>>(new Set());

  // A sync pull may bring newer targets from another device — reload them.
  useEffect(() => {
    const onPrefs = (e: Event) => {
      if ((e as CustomEvent<{ source?: string }>).detail?.source === "remote")
        setSettings(loadAllocationSettings());
    };
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);

  // Same monthly saving as the Forecast page: manual override, else detected.
  const monthlySaving = useMemo(() => {
    const fs = loadForecastSettings();
    const det = detectRecurringSavings(transactions, fx);
    return Math.round(fs.monthlySavingOverride ?? det.monthlyHuf);
  }, [transactions, fx]);

  const targets = settings?.targets ?? null;
  const included = useMemo(
    () => (settings ? includedClasses(settings) : []),
    [settings],
  );
  const drift = useMemo(
    () => (settings ? computeDrift(summary, settings.targets, included) : []),
    [summary, settings, included],
  );
  const split = useMemo(
    () =>
      settings && monthlySaving > 0
        ? dcaSplit(summary, settings.targets, monthlySaving, included)
        : [],
    [summary, settings, monthlySaving, included],
  );

  // Held classes that are NOT managed — named so the user sees what's ignored.
  const excludedLabel = useMemo(() => {
    if (!settings) return "";
    const inc = new Set(included);
    return allocationByClass(summary)
      .filter((s) => s.value > 0 && !inc.has(s.key as AssetClass))
      .map((s) => assetClassLabel[s.key as AssetClass])
      .join(", ");
  }, [summary, settings, included]);

  // One-click reminder from the suggestion — appears among the alerts (and
  // syncs). The month in the title keeps one reminder per month.
  const addReminder = usePortfolio((s) => s.addReminder);
  const reminders = usePortfolio((s) => s.reminders);
  const reminderTitle = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `Havi vásárlás (${d.getFullYear()}. ${mm}.) – cél-allokáció`;
  }, []);
  const reminderAdded = reminders.some((r) => r.title === reminderTitle);

  function saveReminder() {
    void addReminder({
      severity: "info",
      title: reminderTitle,
      detail: `${formatMoney(monthlySaving)} javasolt elosztása: ${split
        .map((s) => `${assetClassLabel[s.key]} ${formatMoney(s.amountHuf)}`)
        .join(", ")}.`,
      to: "/forecast",
    });
  }

  if (summary.totalValueHuf <= 0) return null;

  function startEdit() {
    const valueByClass = new Map(
      allocationByClass(summary).map((s) => [s.key, s.value]),
    );
    // Default include: the previously managed classes, else every held class
    // (the user then unchecks the ones to ignore — e.g. a T-bill parking spot).
    const inc = new Set<AssetClass>(
      settings
        ? includedClasses(settings)
        : ALL_CLASSES.filter((k) => (valueByClass.get(k) ?? 0) > 0),
    );
    // Prefill % as each included class's share WITHIN the included subset, so
    // the starting numbers already sum to ~100 for the managed classes.
    const incTotal = [...inc].reduce(
      (s, k) => s + (valueByClass.get(k) ?? 0),
      0,
    );
    const d: Partial<Record<AssetClass, string>> = {};
    for (const k of ALL_CLASSES) {
      const share =
        inc.has(k) && incTotal > 0 ? (valueByClass.get(k) ?? 0) / incTotal : 0;
      const v = settings?.targets[k] ?? share;
      d[k] = v > 0.0005 ? String(Math.round(v * 100)) : "";
    }
    setInclude(inc);
    setDraft(d);
    setEditing(true);
  }

  const draftSum = [...include].reduce(
    (s, k) => s + (Number(draft[k]) || 0),
    0,
  );

  function toggleInclude(k: AssetClass) {
    setInclude((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  function saveEdit() {
    const inc = ALL_CLASSES.filter((k) => include.has(k));
    const sum = inc.reduce((s, k) => s + (Number(draft[k]) || 0), 0);
    if (sum <= 0) return;
    const t: Partial<Record<AssetClass, number>> = {};
    for (const k of inc) {
      const v = Number(draft[k]) || 0;
      if (v > 0) t[k] = v / sum; // normalise to 100% within the included set
    }
    const next: AllocationSettings = { targets: t, included: inc };
    saveAllocationSettings(next);
    setSettings(next);
    setEditing(false);
  }

  function clearTargets() {
    saveAllocationSettings(null);
    setSettings(null);
    setEditing(false);
  }

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Crosshair className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Cél-allokáció</h2>
        </div>
        {targets && !editing && (
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost px-2 py-1.5"
              onClick={startEdit}
              title="Célok szerkesztése"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              className="btn-ghost px-2 py-1.5"
              onClick={clearTargets}
              title="Célok törlése"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {!targets && !editing && (
        <div>
          <p className="text-sm text-[var(--color-muted)]">
            Állítsd be, milyen arányban szeretnéd tartani az eszközosztályokat —
            az app mutatja az elcsúszást, és megmondja, mibe menjen a következő
            havi megtakarítás (eladás és adóesemény nélkül).
          </p>
          <button className="btn-primary mt-3" onClick={startEdit}>
            Célok beállítása
          </button>
        </div>
      )}

      {editing && (
        <div>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Pipáld ki, mely eszközosztályokra állítasz célt — csak ezek
            számítanak a 100%-ba és az arányokba. A többit (pl. parkoló DKJ,
            kripto, készpénz) az app figyelmen kívül hagyja.
          </p>
          <div className="space-y-2">
            {ALL_CLASSES.map((k) => {
              const on = include.has(k);
              return (
                <div key={k} className="flex items-center gap-2">
                  <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleInclude(k)}
                    />
                    <span
                      className={
                        on ? "" : "text-[var(--color-muted)] line-through"
                      }
                    >
                      {assetClassLabel[k]}
                    </span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={!on}
                    className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums disabled:opacity-40"
                    value={draft[k] ?? ""}
                    placeholder="0"
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [k]: e.target.value }))
                    }
                  />
                  <span className="w-4 text-sm text-[var(--color-muted)]">
                    %
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Kiválasztott összesen: {Math.round(draftSum)}%
            {Math.round(draftSum) !== 100 && draftSum > 0
              ? " — mentéskor 100%-ra arányosítjuk."
              : ""}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="btn-primary"
              onClick={saveEdit}
              disabled={draftSum <= 0}
            >
              <Check className="h-4 w-4" /> Mentés
            </button>
            <button className="btn-ghost" onClick={() => setEditing(false)}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {targets && !editing && (
        <div>
          <div className="mt-2 space-y-3">
            {drift.map((r) => {
              const over = r.driftHuf > 0;
              const off = Math.abs(r.driftHuf);
              const showDelta =
                off > Math.max(summary.totalValueHuf * 0.005, 5000);
              return (
                <div key={r.key}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span>{assetClassLabel[r.key]}</span>
                    <span className="tabular-nums text-[var(--color-muted)]">
                      {pct(r.actualPct)}{" "}
                      <span className="text-xs">/ cél {pct(r.targetPct)}</span>
                    </span>
                  </div>
                  <div className="relative mt-1 h-2 rounded-full bg-[var(--color-surface-2)]">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-brand)]"
                      style={{
                        width: `${Math.min(r.actualPct * 100, 100)}%`,
                      }}
                    />
                    <div
                      className="absolute -inset-y-0.5 w-0.5 rounded bg-[var(--color-text)]/70"
                      style={{
                        left: `${Math.min(r.targetPct * 100, 100)}%`,
                      }}
                      title={`Cél: ${pct(r.targetPct)}`}
                    />
                  </div>
                  {showDelta && (
                    <div
                      className={`amt mt-0.5 text-xs tabular-nums ${
                        over
                          ? "text-[var(--color-muted)]"
                          : "text-[var(--color-warning,#fbbf24)]"
                      }`}
                    >
                      {over
                        ? `+${formatMoney(off)} túlsúly`
                        : `${formatMoney(off)} hiányzik a célhoz`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {excludedLabel && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Az arányok a kiválasztott osztályokon belül értendők; kihagyva:{" "}
              {excludedLabel}.
            </p>
          )}

          {split.length > 0 && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <p className="text-xs font-medium text-[var(--color-muted)]">
                A következő{" "}
                <span className="amt">{formatMoney(monthlySaving)}</span> havi
                megtakarítás javasolt elosztása
              </p>
              <ul className="mt-1.5 space-y-1 text-sm tabular-nums">
                {split.map((s) => (
                  <li key={s.key} className="flex justify-between gap-3">
                    <span className="text-[var(--color-muted)]">
                      {assetClassLabel[s.key]}
                    </span>
                    <span className="amt font-medium text-[var(--color-positive)]">
                      {formatMoney(s.amountHuf)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Csak vétellel közelít a célhoz — eladást (adóeseményt) nem
                javasol.
              </p>
              <button
                className="btn-ghost mt-2 text-xs"
                onClick={saveReminder}
                disabled={reminderAdded}
                title={
                  reminderAdded
                    ? "Erre a hónapra már felvetted"
                    : "A javaslat felvétele a figyelmeztetések közé"
                }
              >
                <BellPlus className="h-4 w-4" />
                {reminderAdded
                  ? "Felvéve a figyelmeztetések közé"
                  : "Felvétel figyelmeztetésnek"}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
