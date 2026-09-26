import { useCallback, useMemo, useState } from "react";
import { Route, Pencil, History } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useGlideVersions,
  useGlideState,
  useGlideHistory,
  usePositionsAt,
  useToday,
} from "../lib/store";
import {
  defaultGlobals,
  isActive,
  latestConfig,
  saveGlideVersion,
  type GlideConfig,
} from "../lib/glidePath";
import {
  bandLimits,
  checkDays,
  pathTargets,
  positionsFromSummary,
  type BandStatus,
  type BucketState,
  type Position,
} from "../lib/rebalance";
import { formatMoney } from "../lib/format";
import { BOND_TYPES } from "../lib/bonds";
import { Amt, Badge, Card } from "./ui";
import GlidePathChart from "./GlidePathChart";
import { BUCKET_COLORS, previewRows } from "./glideChartData";
import GlidePathEditor from "./GlidePathEditor";

const pct = (v: number) =>
  `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`;

const STATUS: Record<BandStatus, { label: string; tone: "positive" | "warning" | "neutral" }> = {
  within: { label: "Sávon belül", tone: "positive" },
  below: { label: "Sáv alatt", tone: "warning" },
  above: { label: "Sáv fölött", tone: "warning" },
  empty: { label: "Nincs adat", tone: "neutral" },
};

const FREQ_LABEL = { monthly: "havonta", quarterly: "negyedévente" } as const;

/** Actual weight on a track, with the band shaded and the path target marked. */
function BandBar({ b, color }: { b: BucketState; color: string }) {
  const w = (v: number) => `${Math.min(100, Math.max(0, v * 100))}%`;
  return (
    <div className="relative mt-1 h-2 rounded-full bg-[var(--color-surface-2)]">
      <div
        className="absolute inset-y-0 rounded-full"
        style={{ left: w(b.low), width: w(b.high - b.low), background: color, opacity: 0.25 }}
        title={`Sáv: ${pct(b.low)} – ${pct(b.high)}`}
      />
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: w(b.weight), background: color }}
      />
      <div
        className="absolute -inset-y-0.5 w-0.5 rounded bg-[var(--color-text)]/70"
        style={{ left: w(b.target) }}
        title={`Pályacél: ${pct(b.target)}`}
      />
    </div>
  );
}

/**
 * Glide-path card on the Goals page: per-bucket status against today's path
 * target and band, the weight history chart, the saved versions, and the
 * editor. Suggestions (what to buy/sell) live in the Teendők panel.
 */
export default function GlidePathSettings() {
  const versions = useGlideVersions();
  const state = useGlideState(versions);
  const history = useGlideHistory(versions);
  const summary = usePortfolioSummary();
  const instruments = usePortfolio((s) => s.instruments);
  const fx = usePortfolio((s) => s.fx);

  const cfg = latestConfig(versions);
  const active = isActive(cfg);
  const today = useToday();

  const [editing, setEditing] = useState<GlideConfig | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [chartId, setChartId] = useState<string | undefined>();

  const held: Position[] = useMemo(
    () => positionsFromSummary(summary, fx, editing?.bondsAtFace ?? true, today),
    [summary, fx, editing?.bondsAtFace, today],
  );
  const names = useMemo(
    () => new Map(instruments.map((i) => [i.key, i.name])),
    [instruments],
  );
  const bondKeys = useMemo(
    () => new Set(instruments.filter((i) => BOND_TYPES.has(i.type)).map((i) => i.key)),
    [instruments],
  );

  const positionsAt = usePositionsAt();

  const startEdit = useCallback(
    (from?: GlideConfig) => {
      const base = from ?? cfg;
      setEditing(
        base
          ? { ...structuredClone(base), validFrom: today }
          : {
              id: "",
              validFrom: today,
              savedAt: "",
              buckets: [],
              instruments: {},
              ...defaultGlobals(),
            },
      );
      setShowVersions(false);
    },
    [cfg, today],
  );

  function save(next: GlideConfig) {
    saveGlideVersion({
      ...next,
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
    });
    setEditing(null);
  }

  if (summary.totalValueHuf <= 0 && !cfg) return null;

  const colorOf = (id: string) =>
    BUCKET_COLORS[Math.max(0, (cfg?.buckets ?? []).findIndex((b) => b.id === id)) % BUCKET_COLORS.length];
  const selected = chartId && cfg?.buckets.some((b) => b.id === chartId) ? chartId : cfg?.buckets[0]?.id;
  const unassigned = (state?.unassigned ?? []).filter((p) => Math.abs(p.valueHuf) > 0.5);
  const unassignedHuf = unassigned.reduce((s, p) => s + p.valueHuf, 0);
  const nextCheck = cfg
    ? checkDays(cfg.checkFrequency, today, `${+today.slice(0, 4) + 1}${today.slice(4)}`).find((d) => d > today)
    : undefined;
  const sortedVersions = [...versions].reverse();
  // The path ahead (latest version): monthly until the last end date.
  const bucket = cfg?.buckets.find((b) => b.id === selected);
  const future =
    cfg && bucket
      ? previewRows(
          checkDays(
            "monthly",
            today,
            cfg.buckets.reduce((m, b) => (b.endDate > m ? b.endDate : m), today),
          ),
          (day) => bandLimits(bucket, day, pathTargets(cfg, day).get(bucket.id) ?? 0),
        )
      : [];

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Route className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Célpálya</h2>
        </div>
        {!editing && (
          <div className="flex items-center gap-1">
            {versions.length > 0 && (
              <button
                className="btn-ghost px-2 py-1.5"
                onClick={() => setShowVersions((v) => !v)}
                title="Korábbi verziók"
              >
                <History className="h-4 w-4" />
              </button>
            )}
            {active && (
              <button className="btn-ghost px-2 py-1.5" onClick={() => startEdit()} title="Szerkesztés">
                <Pencil className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <GlidePathEditor
          key={editing.id + editing.savedAt}
          initial={editing}
          held={held}
          names={names}
          bondKeys={bondKeys}
          positionsAt={positionsAt}
          today={today}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : !active ? (
        <div>
          <p className="text-sm text-[var(--color-muted)]">
            Hozz létre eszközcsoportokat (pl. Részvény, Állampapír), add meg a
            végső célsúlyukat, és hogy milyen pályán, meddig érjék el. Az app
            sávot tart a pálya körül, és javasolja, hová menjen a bejövő pénz —
            végrehajtani soha nem hajt végre semmit.
          </p>
          <button className="btn-primary mt-3" onClick={() => startEdit()}>
            Célpálya beállítása
          </button>
        </div>
      ) : (
        <div>
          <div className="mt-2 space-y-3">
            {state?.buckets.map((b) => (
              <div key={b.bucket.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorOf(b.bucket.id) }} />
                    {b.bucket.name}
                    <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
                  </span>
                  <span className="tabular-nums text-[var(--color-muted)]">
                    {pct(b.weight)}{" "}
                    <span className="text-xs">
                      / pálya {pct(b.target)} ({pct(b.low)}–{pct(b.high)})
                    </span>
                  </span>
                </div>
                <BandBar b={b} color={colorOf(b.bucket.id)} />
                <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                  <Amt>{formatMoney(b.valueHuf)}</Amt> · végső cél {pct(b.bucket.finalWeight)}{" "}
                  ({b.bucket.endDate})
                </div>
              </div>
            ))}
          </div>

          {unassigned.length > 0 && (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Csoporton kívül: <Amt>{formatMoney(unassignedHuf)}</Amt> (
              {unassigned.map((p) => p.name).join(", ")}) — kimarad a súlyokból.
            </p>
          )}
          {cfg && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Ellenőrzés {FREQ_LABEL[cfg.checkFrequency]}
              {nextCheck ? ` (következő: ${nextCheck})` : ""} · min.{" "}
              <Amt>{formatMoney(cfg.minTradeHuf)}</Amt> · visszaállítás{" "}
              {cfg.restoreTo === "path" ? "a pályacélig" : "a sávhatárig"} · érvényes{" "}
              {cfg.validFrom}-tól
            </p>
          )}

          {cfg && selected && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-[var(--color-muted)]">
                  Súly a pályához képest
                </span>
                {cfg.buckets.map((b) => (
                  <button
                    key={b.id}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      b.id === selected
                        ? "border-[var(--color-brand)] bg-[var(--color-brand)]/15"
                        : "border-[var(--color-border)] text-[var(--color-muted)]"
                    }`}
                    onClick={() => setChartId(b.id)}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
              <GlidePathChart
                history={history}
                bucketId={selected}
                color={colorOf(selected)}
                future={future}
              />
            </div>
          )}
        </div>
      )}

      {showVersions && !editing && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-3">
          <p className="mb-2 text-xs font-medium text-[var(--color-muted)]">
            Mentett verziók (a grafikon minden napra az akkor érvényeset használja)
          </p>
          <ul className="space-y-2 text-xs">
            {sortedVersions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{v.validFrom}-tól</span>{" "}
                  <span className="text-[var(--color-muted)]">
                    (mentve {v.savedAt.slice(0, 16).replace("T", " ")}):{" "}
                    {v.buckets.length
                      ? v.buckets.map((b) => `${b.name} ${pct(b.finalWeight)}`).join(" / ")
                      : "kikapcsolva"}
                  </span>
                </span>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => startEdit(v)}>
                  Szerkesztés ebből
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
