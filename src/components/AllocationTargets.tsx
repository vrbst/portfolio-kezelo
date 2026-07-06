import { useEffect, useMemo, useState } from "react";
import { Crosshair, Pencil, Check, X, Trash2, BellPlus } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { assetClassLabel } from "../lib/labels";
import type { AssetClass } from "../lib/portfolio";
import {
  computeDrift,
  dcaSplit,
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
  const drift = useMemo(
    () => (targets ? computeDrift(summary, targets) : []),
    [summary, targets],
  );
  const split = useMemo(
    () =>
      targets && monthlySaving > 0
        ? dcaSplit(summary, targets, monthlySaving)
        : [],
    [summary, targets, monthlySaving],
  );

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
    const actual = new Map(
      computeDrift(summary, targets ?? {}).map((r) => [r.key, r.actualPct]),
    );
    const d: Partial<Record<AssetClass, string>> = {};
    for (const k of ALL_CLASSES) {
      const v = targets?.[k] ?? actual.get(k) ?? 0;
      d[k] = v > 0.0005 ? String(Math.round(v * 100)) : "";
    }
    setDraft(d);
    setEditing(true);
  }

  const draftSum = ALL_CLASSES.reduce((s, k) => s + (Number(draft[k]) || 0), 0);

  function saveEdit() {
    if (draftSum <= 0) return;
    const t: Partial<Record<AssetClass, number>> = {};
    for (const k of ALL_CLASSES) {
      const v = Number(draft[k]) || 0;
      if (v > 0) t[k] = v / draftSum; // normalise to 100%
    }
    const next = { targets: t };
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
          <div className="space-y-2">
            {ALL_CLASSES.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-[var(--color-muted)]">
                  {assetClassLabel[k]}
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
                  value={draft[k] ?? ""}
                  placeholder="0"
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [k]: e.target.value }))
                  }
                />
                <span className="w-4 text-sm text-[var(--color-muted)]">%</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Összesen: {Math.round(draftSum)}%
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
