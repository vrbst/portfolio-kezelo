import { useMemo, useState } from "react";
import { Check, Plus, Trash2, X, ChevronDown, ChevronRight } from "lucide-react";
import {
  validateConfig,
  isCashKey,
  cashCurrency,
  DEFAULT_QTY_DECIMALS,
  type Bucket,
  type Cost,
  type CostRule,
  type GlideConfig,
  type InstrumentRule,
} from "../lib/glidePath";
import {
  bandLimits,
  bandWidth,
  checkDays,
  pathTargets,
  resolveSnapshotStarts,
  type Position,
  type PositionsAt,
} from "../lib/rebalance";
import { AmountInput, Amt } from "./ui";
import { formatMoney } from "../lib/format";
import { GlideBucketChart } from "./GlidePathChart";
import { BUCKET_COLORS, previewRows } from "./glideChartData";

const INPUT =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm tabular-nums disabled:opacity-40";
const LABEL = "text-xs text-[var(--color-muted)]";

/**
 * A percentage field over a FRACTION value (0.05 ↔ "5"). Keeps the typed text
 * while it parses to the same number, so "5," or "12.5" can be typed freely;
 * empty reports undefined, garbage reports NaN (validation flags it).
 */
export function PctInput({
  value,
  onChange,
  className = "w-20",
  placeholder,
  disabled,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const fmt = (v?: number) =>
    v == null || !Number.isFinite(v) ? "" : String(Math.round(v * 10000) / 100);
  const [text, setText] = useState(fmt(value));
  const [seen, setSeen] = useState(value);
  // The value changed from outside (e.g. another version loaded) → show it.
  if (!Object.is(seen, value)) {
    setSeen(value);
    setText(fmt(value));
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      className={`${INPUT} text-right ${className}`}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        const t = e.target.value;
        const n = parseFloat(t.replace(",", "."));
        const v = t.trim() === "" ? undefined : Number.isFinite(n) ? n / 100 : NaN;
        setText(t);
        setSeen(v);
        onChange(v);
      }}
    />
  );
}

/** Buy / sell cost (% and/or flat Ft). Empty everywhere = no override. */
function CostFields({
  value,
  onChange,
}: {
  value: CostRule | undefined;
  onChange: (v: CostRule | undefined) => void;
}) {
  const side = (s: "buy" | "sell", patch: Partial<Cost>) => {
    const merged: Cost = { ...(value?.[s] ?? {}), ...patch };
    const clean: Cost | undefined =
      merged.pct == null && merged.fixedHuf == null ? undefined : merged;
    const next: CostRule = { ...(value ?? {}), [s]: clean };
    if (!next.buy) delete next.buy;
    if (!next.sell) delete next.sell;
    onChange(next.buy || next.sell ? next : undefined);
  };
  const row = (s: "buy" | "sell", label: string) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`${LABEL} w-24`}>{label}</span>
      <PctInput
        value={value?.[s]?.pct}
        onChange={(pct) => side(s, { pct })}
        className="w-16"
        placeholder="0"
      />
      <span className={LABEL}>% +</span>
      <AmountInput
        value={value?.[s]?.fixedHuf != null ? String(value[s]!.fixedHuf) : ""}
        onValueChange={(raw) =>
          side(s, { fixedHuf: raw === "" ? undefined : Number(raw) })
        }
        className={`${INPUT} w-24 text-right`}
        placeholder="0"
      />
      <span className={LABEL}>Ft</span>
    </div>
  );
  return (
    <div className="space-y-1.5">
      {row("buy", "Vétel")}
      {row("sell", "Eladás / visszaváltás")}
    </div>
  );
}

function addMonths(day: string, months: number): string {
  let y = +day.slice(0, 4);
  let m = +day.slice(5, 7) - 1 + months;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export interface EditorRow {
  key: string;
  name: string;
  valueHuf: number;
}

/**
 * Glide-path editor: buckets (weights, start, dates, interpolation, band,
 * cost), instrument assignment with the sellable / accepts-contribution
 * flags, the global settings, live validation and a path preview. Saving
 * appends a new dated version — earlier ones stay for the history.
 */
export default function GlidePathEditor({
  initial,
  held,
  names,
  bondKeys,
  positionsAt,
  today,
  onSave,
  onCancel,
}: {
  initial: GlideConfig;
  /** Positions held today (instruments + cash), for assignment and warnings. */
  held: Position[];
  /** Instrument key → display name (for assigned-but-not-held rows). */
  names: Map<string, string>;
  /** Bonds / T-bills: units are face HUF, so "fractional" makes no sense. */
  bondKeys: Set<string>;
  positionsAt: PositionsAt;
  today: string;
  onSave: (cfg: GlideConfig) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<GlideConfig>(initial);
  const [openCost, setOpenCost] = useState<Record<string, boolean>>({});
  const [previewId, setPreviewId] = useState<string | undefined>(
    initial.buckets[0]?.id,
  );

  const heldKeys = useMemo(
    () => held.filter((p) => Math.abs(p.valueHuf) > 0.5).map((p) => p.key),
    [held],
  );

  const finalSum = draft.buckets.reduce(
    (s, b) => s + (Number.isFinite(b.finalWeight) ? b.finalWeight : 0),
    0,
  );

  const setBucket = (id: string, patch: Partial<Bucket>) =>
    setDraft((d) => ({
      ...d,
      buckets: d.buckets.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    }));
  const setRule = (key: string, rule: InstrumentRule | undefined) =>
    setDraft((d) => {
      const instruments = { ...d.instruments };
      if (rule) instruments[key] = rule;
      else delete instruments[key];
      return { ...d, instruments };
    });

  function addBucket() {
    const id = crypto.randomUUID();
    const last = draft.buckets[draft.buckets.length - 1];
    const b: Bucket = {
      id,
      name: "",
      finalWeight: Math.max(0, 1 - finalSum),
      start: { mode: "snapshot", date: today },
      startDate: last?.startDate ?? today,
      endDate: last?.endDate ?? `${+today.slice(0, 4) + 5}${today.slice(4)}`,
      interpolation: "linear",
      band: { kind: "abs", pp: 0.05 },
    };
    setDraft((d) => ({ ...d, buckets: [...d.buckets, b] }));
    setPreviewId((p) => p ?? id);
  }

  function removeBucket(id: string) {
    setDraft((d) => ({
      ...d,
      buckets: d.buckets.filter((b) => b.id !== id),
      instruments: Object.fromEntries(
        Object.entries(d.instruments).filter(([, r]) => r.bucketId !== id),
      ),
    }));
    if (previewId === id) setPreviewId(undefined);
  }

  // Rows: everything held, plus instruments assigned earlier but sold since.
  const rows: EditorRow[] = useMemo(() => {
    const out = new Map<string, EditorRow>();
    for (const p of held)
      out.set(p.key, { key: p.key, name: p.name, valueHuf: p.valueHuf });
    for (const key of Object.keys(draft.instruments))
      if (!out.has(key))
        out.set(key, {
          key,
          name: isCashKey(key)
            ? `Készpénz ${cashCurrency(key)}`
            : (names.get(key) ?? key),
          valueHuf: 0,
        });
    return [...out.values()].sort((a, b) => b.valueHuf - a.valueHuf);
  }, [held, draft.instruments, names]);

  // Preview with snapshot starts resolved (history lookups are cached upstream).
  const previewCfg = useMemo(
    () => resolveSnapshotStarts(draft, positionsAt),
    [draft, positionsAt],
  );
  const preview = useMemo(() => {
    const b = previewCfg.buckets.find((x) => x.id === previewId);
    if (!b || !previewCfg.buckets.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(x.endDate)))
      return null;
    const from = previewCfg.buckets.reduce((m, x) => (x.startDate < m ? x.startDate : m), b.startDate);
    const to = previewCfg.buckets.reduce((m, x) => (x.endDate > m ? x.endDate : m), b.endDate);
    const days = [from, ...checkDays("monthly", from, addMonths(to, 3)).filter((d) => d > from)];
    return previewRows(days, (day) => {
      const t = pathTargets(previewCfg, day).get(b.id) ?? 0;
      const w = bandWidth(b, t);
      return {
        ...bandLimits(b, day, t),
        computed: [Math.max(0, t - w.computed), Math.min(1, t + w.computed)],
        minApplied: w.minApplied,
      };
    });
  }, [previewCfg, previewId]);

  // Month ranges of the preview where the minimum band sets the width.
  const minRanges = useMemo(() => {
    if (!preview) return [];
    const out: [string, string][] = [];
    for (const r of preview) {
      if (!r.minApplied) continue;
      const last = out[out.length - 1];
      const prevDay = preview[preview.indexOf(r) - 1]?.day;
      if (last && last[1] === prevDay) last[1] = r.day;
      else out.push([r.day, r.day]);
    }
    return out;
  }, [preview]);

  // Validate the resolved copy, so snapshot starts are known.
  const check = useMemo(
    () => validateConfig(previewCfg, heldKeys),
    [previewCfg, heldKeys],
  );

  const bucketColor = (id: string) =>
    BUCKET_COLORS[Math.max(0, draft.buckets.findIndex((b) => b.id === id)) % BUCKET_COLORS.length];

  return (
    <div className="space-y-5">
      {/* ---- Buckets ---- */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Eszközcsoportok</h3>
        <div className="space-y-3">
          {draft.buckets.map((b) => {
            const snap = previewCfg.buckets.find((x) => x.id === b.id)?.start;
            return (
              <div
                key={b.id}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: bucketColor(b.id) }}
                  />
                  <input
                    className={`${INPUT} min-w-0 flex-1`}
                    value={b.name}
                    placeholder="Csoport neve (pl. Részvény)"
                    onChange={(e) => setBucket(b.id, { name: e.target.value })}
                  />
                  <span className={LABEL}>Végső cél</span>
                  <PctInput
                    value={b.finalWeight}
                    onChange={(v) => setBucket(b.id, { finalWeight: v ?? 0 })}
                  />
                  <span className={LABEL}>%</span>
                  <button
                    className="btn-ghost px-2 py-1.5"
                    title="Csoport törlése"
                    onClick={() => removeBucket(b.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <div className={LABEL}>Kezdő súly</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select
                        className={INPUT}
                        value={b.start.mode}
                        onChange={(e) =>
                          setBucket(b.id, {
                            start:
                              e.target.value === "manual"
                                ? { mode: "manual", weight: b.finalWeight }
                                : { mode: "snapshot", date: b.startDate || today },
                          })
                        }
                      >
                        <option value="snapshot">Tényleges arány ekkor:</option>
                        <option value="manual">Kézi érték:</option>
                      </select>
                      {b.start.mode === "snapshot" ? (
                        <>
                          <input
                            type="date"
                            className={INPUT}
                            value={b.start.date}
                            onChange={(e) =>
                              setBucket(b.id, {
                                start: { mode: "snapshot", date: e.target.value },
                              })
                            }
                          />
                          <span className={LABEL}>
                            {snap?.mode === "snapshot" && snap.resolvedWeight != null
                              ? `= ${(snap.resolvedWeight * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`
                              : "nincs adat"}
                          </span>
                        </>
                      ) : (
                        <>
                          <PctInput
                            value={b.start.weight}
                            onChange={(v) =>
                              setBucket(b.id, { start: { mode: "manual", weight: v ?? 0 } })
                            }
                          />
                          <span className={LABEL}>%</span>
                        </>
                      )}
                    </div>
                  </label>

                  <label className="space-y-1">
                    <div className={LABEL}>Pálya (kezdő → záró dátum)</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="date"
                        className={INPUT}
                        value={b.startDate}
                        onChange={(e) => setBucket(b.id, { startDate: e.target.value })}
                      />
                      <span className={LABEL}>→</span>
                      <input
                        type="date"
                        className={INPUT}
                        value={b.endDate}
                        onChange={(e) => setBucket(b.id, { endDate: e.target.value })}
                      />
                    </div>
                  </label>

                  <label className="space-y-1">
                    <div className={LABEL}>Átmenet</div>
                    <select
                      className={INPUT}
                      value={b.interpolation}
                      onChange={(e) =>
                        setBucket(b.id, { interpolation: e.target.value as Bucket["interpolation"] })
                      }
                    >
                      <option value="linear">Lineáris (naponta)</option>
                      <option value="step-quarter">Lépcsős – negyedévente</option>
                      <option value="step-year">Lépcsős – évente</option>
                    </select>
                  </label>

                  <label className="space-y-1">
                    <div className={LABEL}>Sáv</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select
                        className={INPUT}
                        value={b.band.kind}
                        onChange={(e) =>
                          setBucket(b.id, {
                            band:
                              e.target.value === "abs"
                                ? { kind: "abs", pp: 0.05, minPp: b.band.minPp }
                                : { kind: "rel", pct: 0.2, minPp: b.band.minPp },
                          })
                        }
                      >
                        <option value="abs">Abszolút (± százalékpont)</option>
                        <option value="rel">Relatív (a célsúly ±%-a)</option>
                      </select>
                      <span className={LABEL}>±</span>
                      <PctInput
                        value={b.band.kind === "abs" ? b.band.pp : b.band.pct}
                        onChange={(v) =>
                          setBucket(b.id, {
                            band:
                              b.band.kind === "abs"
                                ? { ...b.band, pp: v ?? 0 }
                                : { ...b.band, pct: v ?? 0 },
                          })
                        }
                        className="w-16"
                      />
                      <span className={LABEL}>{b.band.kind === "abs" ? "%pont" : "%"}</span>
                      {b.band.kind === "rel" && (
                        <select
                          className={INPUT}
                          value={b.band.base ?? "path"}
                          title="Mihez képest számolja a relatív sávot"
                          onChange={(e) =>
                            b.band.kind === "rel" &&
                            setBucket(b.id, {
                              band: { ...b.band, base: e.target.value as "path" | "final" },
                            })
                          }
                        >
                          <option value="path">a mai pályacélé</option>
                          <option value="final">a végső célsúlyé</option>
                        </select>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={LABEL} title="A sáv soha nem keskenyebb ennél — kis pályacélnál a relatív sáv különben túl szűk lenne.">
                        de legalább ±
                      </span>
                      <PctInput
                        value={b.band.minPp}
                        onChange={(v) => setBucket(b.id, { band: { ...b.band, minPp: v } })}
                        className="w-16"
                        placeholder="0"
                      />
                      <span className={LABEL}>%pont</span>
                    </div>
                  </label>

                  <label className="space-y-1">
                    <div className={LABEL} title="Ha a sávon kívüli eltérés az utolsó jelzés óta legalább ennyivel nő, újra jelez (az időszakon belül is). Üresen a globális érték él.">
                      Újrajelzési lépcső (csoportra)
                    </div>
                    <div className="flex items-center gap-1.5">
                      <PctInput
                        value={b.realertStepPp}
                        onChange={(v) => setBucket(b.id, { realertStepPp: v })}
                        className="w-16"
                        placeholder={String(Math.round(draft.realertStepPp * 10000) / 100)}
                      />
                      <span className={LABEL}>%pont (üresen: globális)</span>
                    </div>
                  </label>
                </div>

                <button
                  className="mt-2 flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  onClick={() => setOpenCost((o) => ({ ...o, [b.id]: !o[b.id] }))}
                >
                  {openCost[b.id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  Csoportszintű költség {b.cost ? "(beállítva)" : "(alapértelmezett)"}
                </button>
                {openCost[b.id] && (
                  <div className="mt-2">
                    <CostFields value={b.cost} onChange={(cost) => setBucket(b.id, { cost })} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button className="btn-ghost text-sm" onClick={addBucket}>
            <Plus className="h-4 w-4" /> Új csoport
          </button>
          <span
            className={`text-xs tabular-nums ${
              Math.abs(finalSum - 1) > 0.0001 && draft.buckets.length
                ? "text-[var(--color-negative)]"
                : "text-[var(--color-muted)]"
            }`}
          >
            Végső célsúlyok összesen:{" "}
            {(finalSum * 100).toLocaleString("hu-HU", { maximumFractionDigits: 2 })}%
          </span>
        </div>
      </section>

      {/* ---- Preview ---- */}
      {preview && draft.buckets.length > 0 && (
        <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">A pálya előnézete</h3>
            {draft.buckets.map((b) => (
              <button
                key={b.id}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  b.id === previewId
                    ? "border-[var(--color-brand)] bg-[var(--color-brand)]/15"
                    : "border-[var(--color-border)] text-[var(--color-muted)]"
                }`}
                onClick={() => setPreviewId(b.id)}
              >
                {b.name || "(névtelen)"}
              </button>
            ))}
          </div>
          <GlideBucketChart rows={preview} color={bucketColor(previewId!)} height="h-44" />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Satírozva a tényleges sáv; szaggatott vonallal a minimum nélküli, számított sáv.{" "}
            {minRanges.length
              ? `A minimális sáv él: ${minRanges.map(([a, z]) => (a === z ? a.slice(0, 7) : `${a.slice(0, 7)} – ${z.slice(0, 7)}`)).join(", ")}.`
              : "A minimális sáv sehol nem szélesíti a sávot."}
          </p>
        </section>
      )}

      {/* ---- Instruments ---- */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Instrumentumok</h3>
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          Minden tétel legfeljebb egy csoportba tartozhat. A csoporton kívüli
          tételek (pl. parkoló készpénz) kimaradnak a súlyokból — a szabad
          készpénz a bejövő pénz forrása.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--color-muted)]">
                <th className="py-1 pr-2 font-medium">Tétel</th>
                <th className="py-1 pr-2 text-right font-medium">Érték</th>
                <th className="py-1 pr-2 font-medium">Csoport</th>
                <th className="py-1 pr-2 text-center font-medium" title="Eladható újrasúlyozáshoz">Eladható</th>
                <th className="py-1 pr-2 text-center font-medium" title="Fogad befizetést (kupon, osztalék, megtakarítás)">Befizetés</th>
                <th className="py-1 pr-2 font-medium" title="A bróker tört darabot is kezel: a javaslat nem kerekít egészre, csak a megadott tizedesjegyig (lefelé)">Tört darab</th>
                <th className="py-1 font-medium">Költség</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rule = draft.instruments[r.key];
                const costKey = `i:${r.key}`;
                return (
                  <tr key={r.key} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1.5 pr-2">{r.name}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      <Amt>{formatMoney(r.valueHuf)}</Amt>
                    </td>
                    <td className="py-1.5 pr-2">
                      <select
                        className={INPUT}
                        value={rule?.bucketId ?? ""}
                        onChange={(e) =>
                          setRule(
                            r.key,
                            e.target.value
                              ? rule
                                ? { ...rule, bucketId: e.target.value }
                                : { sellable: true, acceptsContributions: true, bucketId: e.target.value }
                              : undefined,
                          )
                        }
                      >
                        <option value="">— nincs csoportban —</option>
                        {draft.buckets.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name || "(névtelen)"}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 pr-2 text-center">
                      <input
                        type="checkbox"
                        disabled={!rule}
                        checked={rule?.sellable ?? false}
                        onChange={(e) => rule && setRule(r.key, { ...rule, sellable: e.target.checked })}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-center">
                      <input
                        type="checkbox"
                        disabled={!rule}
                        checked={rule?.acceptsContributions ?? false}
                        onChange={(e) =>
                          rule && setRule(r.key, { ...rule, acceptsContributions: e.target.checked })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      {(() => {
                        const na = !rule || isCashKey(r.key) || bondKeys.has(r.key);
                        return (
                          <span className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              disabled={na}
                              checked={!na && !!rule?.fractional}
                              onChange={(e) =>
                                rule && setRule(r.key, { ...rule, fractional: e.target.checked })
                              }
                            />
                            {!na && rule?.fractional && (
                              <>
                                <input
                                  type="number"
                                  min={0}
                                  max={8}
                                  step={1}
                                  className={`${INPUT} w-14 text-right`}
                                  value={rule.qtyDecimals ?? DEFAULT_QTY_DECIMALS}
                                  onChange={(e) =>
                                    setRule(r.key, {
                                      ...rule,
                                      qtyDecimals: e.target.value === "" ? undefined : Number(e.target.value),
                                    })
                                  }
                                />
                                <span className={LABEL}>tizedes</span>
                              </>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-1.5">
                      {rule && !isCashKey(r.key) && (
                        <>
                          <button
                            className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
                            onClick={() => setOpenCost((o) => ({ ...o, [costKey]: !o[costKey] }))}
                          >
                            {openCost[costKey] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            {rule.cost ? "egyedi" : "öröklött"}
                          </button>
                          {openCost[costKey] && (
                            <div className="mt-1.5">
                              <CostFields
                                value={rule.cost}
                                onChange={(cost) => setRule(r.key, { ...rule, cost })}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Globals ---- */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Általános beállítások</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <div className={LABEL}>Ellenőrzés gyakorisága</div>
            <select
              className={INPUT}
              value={draft.checkFrequency}
              onChange={(e) =>
                setDraft((d) => ({ ...d, checkFrequency: e.target.value as GlideConfig["checkFrequency"] }))
              }
            >
              <option value="monthly">Havonta</option>
              <option value="quarterly">Negyedévente</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className={LABEL}>Minimális tranzakcióméret</div>
            <div className="flex items-center gap-1.5">
              <AmountInput
                value={String(draft.minTradeHuf)}
                onValueChange={(raw) => setDraft((d) => ({ ...d, minTradeHuf: Number(raw) || 0 }))}
                className={`${INPUT} w-32 text-right`}
              />
              <span className={LABEL}>Ft</span>
            </div>
          </label>
          <label className="space-y-1">
            <div className={LABEL}>Sávon kívül visszaállítás</div>
            <select
              className={INPUT}
              value={draft.restoreTo}
              onChange={(e) => setDraft((d) => ({ ...d, restoreTo: e.target.value as GlideConfig["restoreTo"] }))}
            >
              <option value="path">a pályacélig</option>
              <option value="band">csak a sávhatárig</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className={LABEL} title="Egy tranzakciót nem javasol, ha a becsült költsége több, mint a korrigált eltérés ennyi százaléka.">
              Költség/haszon küszöb
            </div>
            <div className="flex items-center gap-1.5">
              <PctInput
                value={draft.maxCostRatio}
                onChange={(v) => setDraft((d) => ({ ...d, maxCostRatio: v ?? 0 }))}
              />
              <span className={LABEL}>% a korrekcióból</span>
            </div>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.bondsAtFace}
              onChange={(e) => setDraft((d) => ({ ...d, bondsAtFace: e.target.checked }))}
            />
            Állampapírok névértéken (nem a felhalmozott értéken)
          </label>
          <label className="space-y-1">
            <div className={LABEL} title="Ha egy sávon kívüli csoport eltérése az utolsó jelzés óta legalább ennyivel nő, újra jelez — az időszakon belül és az elvetett jelzés után is. 0 = kikapcsolva.">
              Újrajelzési lépcső (mélyülő eltérésnél)
            </div>
            <div className="flex items-center gap-1.5">
              <PctInput
                value={draft.realertStepPp}
                onChange={(v) => setDraft((d) => ({ ...d, realertStepPp: v ?? 0 }))}
              />
              <span className={LABEL}>%pont (0 = ki)</span>
            </div>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.deepAlertsInQuietHours}
              onChange={(e) => setDraft((d) => ({ ...d, deepAlertsInQuietHours: e.target.checked }))}
            />
            Mélyülő jelzés a csendes órákban is (különben reggel jön)
          </label>
          <label className="space-y-1">
            <div className={LABEL}>Érvényes ettől a naptól</div>
            <input
              type="date"
              className={INPUT}
              value={draft.validFrom}
              onChange={(e) => setDraft((d) => ({ ...d, validFrom: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-3">
          <div className={`${LABEL} mb-1`}>
            Alapértelmezett költség (ha a csoport vagy az instrumentum nem ad meg
            mást; állampapírnál a sorozat saját visszaváltási költsége érvényes)
          </div>
          <CostFields
            value={draft.defaultCost}
            onChange={(c) => setDraft((d) => ({ ...d, defaultCost: c ?? {} }))}
          />
        </div>
      </section>

      {/* ---- Validation & actions ---- */}
      {(check.errors.length > 0 || check.warnings.length > 0) && (
        <ul className="space-y-1 text-xs">
          {check.errors.map((e, i) => (
            <li key={`e${i}`} className="text-[var(--color-negative)]">• {e.message}</li>
          ))}
          {check.warnings.map((w, i) => (
            <li key={`w${i}`} className="text-[var(--color-warning)]">• {w.message}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          disabled={check.errors.length > 0}
          onClick={() => onSave(previewCfg)}
        >
          <Check className="h-4 w-4" /> Mentés új verzióként
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          <X className="h-4 w-4" /> Mégse
        </button>
        {draft.buckets.length === 0 && (
          <span className="text-xs text-[var(--color-muted)]">
            Csoportok nélkül mentve a célpálya kikapcsol.
          </span>
        )}
      </div>
    </div>
  );
}
