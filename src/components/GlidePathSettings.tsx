import { useCallback, useMemo, useState } from "react";
import { Route, Pencil, History } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useGlideVersions,
  useGlideState,
  useGlideHistory,
  useLiveGlideVersions,
  usePositionsAt,
  useMonthlyBudget,
  useToday,
  useBrokerFees,
  useReservedCash,
} from "../lib/store";
import { glideAmountSource } from "../lib/budget";
import {
  isInflowMode,
  newConfigGlobals,
  isActive,
  latestConfig,
  saveGlideVersion,
  type GlideConfig,
} from "../lib/glidePath";
import {
  bandBaseNote,
  bandBucket,
  bandLimits,
  checkDays,
  glideStateFrom,
  pathTargets,
  positionsFromSummary,
  type BandStatus,
  type BucketState,
  type Position,
} from "../lib/rebalance";
import { formatMoney } from "../lib/format";
import { addDaysIso } from "../lib/day";
import { BOND_TYPES, futureBondCashflows } from "../lib/bonds";
import { loadForecastSettings } from "../lib/forecast";
import {
  freezeInflowPath,
  projectGlide,
  REACH_TOLERANCE,
  type GlideProjection,
  type ProjectedInflow,
  type ProjectionInput,
} from "../lib/glideProjection";
import { Amt, Badge, Card } from "./ui";
import GlidePathChart from "./GlidePathChart";
import { BUCKET_COLORS, previewRows, type Row } from "./glideChartData";
import GlidePathEditor from "./GlidePathEditor";
import PrivateText from "./PrivateText";

const pct = (v: number) =>
  `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`;

/** How far the expected-weight projection looks for the arrival. */
const PROJECTION_YEARS = 15;

const MONTH_NAMES = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
/** "2031. ápr." */
const monthOf = (day: string) => `${day.slice(0, 4)}. ${MONTH_NAMES[+day.slice(5, 7) - 1]}`;

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
 * What moves the path, as the projection counts it: the monthly amount
 * month by month (what the other goals take, recomputed as they end), every
 * coupon of the next 12 months with the goals' share and the rest routed to
 * the path, and the redemptions until the final weights are reached.
 */
function InflowSummary({
  inflows,
  today,
  until,
  names,
  nowHuf,
}: {
  inflows: ProjectedInflow[];
  today: string;
  until?: string;
  names: Map<string, string>;
  /** This month's amount (today's budget split). */
  nowHuf: number;
}) {
  const [open, setOpen] = useState(false);
  const yearAhead = addDaysIso(today, 365);
  const coupons = inflows.filter((x) => x.kind === "coupon" && x.day <= yearAhead);
  const couponTotal = coupons.reduce((s, x) => s + (x.totalHuf ?? x.amountHuf), 0);
  const couponPath = coupons.reduce((s, x) => s + x.amountHuf, 0);
  const couponGoals = couponTotal - couponPath;
  // The months the monthly amount changes (it is recomputed every month).
  const steps = inflows
    .filter((x) => x.kind === "monthly")
    .filter((x, i, all) => i === 0 || Math.abs(x.amountHuf - all[i - 1].amountHuf) >= 1)
    .slice(0, 4);
  const maturities = inflows.filter((x) => x.kind === "maturity" && (!until || x.day <= until));
  const nameOf = (key?: string) => names.get(key ?? "") ?? key ?? "";
  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted)]">
      <div className="mb-1 font-medium text-[var(--color-text)]">Mi viszi a pályát</div>
      <ul className="space-y-1">
        <li>
          Havi összeg — ebben a hónapban <Amt>{formatMoney(nowHuf)}</Amt>
          {steps.map((x) => (
            <span key={x.day}>
              ; {monthOf(x.day)}-tól <Amt>{formatMoney(x.amountHuf)}</Amt>/hó
              {(x.otherHuf ?? 0) > 0 && (
                <>
                  {" "}(a többi cél <Amt>{formatMoney(x.otherHuf ?? 0)}</Amt>-ot visz el)
                </>
              )}
            </span>
          ))}
          . A vetítés hónapról hónapra számol: a lejárt célok részét már a pályára teszi.
          {steps.every((x) => x.amountHuf <= 0) && (
            <span className="text-[var(--color-warning)]">
              {" "}A célokon felül nem marad semmi — fix összeget a szerkesztőben, a
              „Célpálya havi összege” mezőnél adhatsz.
            </span>
          )}
        </li>
        <li>
          Kuponok a következő 12 hónapban: {coupons.length} db, összesen{" "}
          <Amt>{formatMoney(couponTotal)}</Amt>
          {couponGoals >= 1 && (
            <>
              , ebből célokhoz <Amt>{formatMoney(couponGoals)}</Amt>
            </>
          )}
          , a pályára <Amt>{formatMoney(couponPath)}</Amt>. Beérkezéskor jelzés jön
          (Teendők → „Beérkezett”, és a bot).{" "}
          {coupons.length > 0 && (
            <button className="underline hover:text-[var(--color-text)]" onClick={() => setOpen((v) => !v)}>
              {open ? "Részletek elrejtése" : "Részletek"}
            </button>
          )}
          {open && (
            <table className="mt-1 w-full tabular-nums">
              <tbody>
                {coupons.map((x) => (
                  <tr key={`${x.day}-${x.instrumentKey}`} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-0.5 pr-2 whitespace-nowrap">{x.day}</td>
                    <td className="py-0.5 pr-2">{nameOf(x.instrumentKey)}</td>
                    <td className="py-0.5 pr-2 text-right whitespace-nowrap">
                      <Amt>{formatMoney(x.totalHuf ?? x.amountHuf)}</Amt>
                    </td>
                    <td className="py-0.5">
                      {(x.goals ?? []).map((g) => (
                        <span key={g.name}>
                          <PrivateText text={g.name} />: <Amt>{formatMoney(g.huf)}</Amt>
                          {" · "}
                        </span>
                      ))}
                      pályára <Amt>{formatMoney(x.amountHuf)}</Amt>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </li>
        {maturities.length > 0 && (
          <li>
            Lejárat:{" "}
            {maturities.map((x, i) => (
              <span key={`${x.day}-${x.instrumentKey}`}>
                {i > 0 && ", "}
                {nameOf(x.instrumentKey)} ({x.day}, <Amt>{formatMoney(x.amountHuf)}</Amt>)
              </span>
            ))}{" "}
            — ez is a célpálya felé megy.
          </li>
        )}
      </ul>
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

  // The path as measured (moved by the money that came in) — for the chart;
  // `cfg` is the stored plan, the one the editor edits.
  const liveVersions = useLiveGlideVersions(versions);

  const cfg = latestConfig(versions);
  const liveCfg = useMemo(() => latestConfig(liveVersions), [liveVersions]);
  const active = isActive(cfg);
  const today = useToday();
  const { breakdown, savings } = useMonthlyBudget();
  const amountSource = glideAmountSource(breakdown, cfg);

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

  // Expected weights from the inflows (free coupons and redemptions, the
  // monthly amount, DCA into a bucket): flat prices and the Forecast page's
  // "reális" return.
  const transactions = usePortfolio((s) => s.transactions);
  const dcaGoals = usePortfolio((s) => s.goals);
  // Everything the projection needs besides the config and its state.
  const projInputs = useMemo(
    () => ({
      instruments: new Map(instruments.map((i) => [i.key, i])),
      cashflows: futureBondCashflows(summary, new Date(), transactions),
      savings,
      dcaGoals,
      budgetHuf: breakdown.budgetHuf,
      today,
      until: `${+today.slice(0, 4) + PROJECTION_YEARS}${today.slice(4)}`,
    }),
    [instruments, summary, transactions, savings, dcaGoals, breakdown.budgetHuf, today],
  );
  const projection = useMemo(() => {
    if (!state || !cfg || !isActive(cfg)) return undefined;
    const base: Omit<ProjectionInput, "annualReturn"> = { ...projInputs, cfg, state };
    const real = loadForecastSettings().annualReturn.real;
    return {
      zero: projectGlide({ ...base, annualReturn: 0 }),
      real: projectGlide({ ...base, annualReturn: real }),
      realPct: real,
    };
  }, [state, cfg, projInputs]);

  // "inflows" mode: the path the draft's inflows draw from today's weights
  // (the editor previews it; the saved version keeps it frozen).
  const fees = useBrokerFees();
  const reserved = useReservedCash();
  const freeze = useCallback(
    (draft: GlideConfig): Pick<GlideConfig, "inflowPath" | "inflowReached"> => {
      const st = glideStateFrom([draft], summary, fx, today, fees, reserved);
      if (!st || st.totalHuf <= 0) return { inflowPath: undefined, inflowReached: undefined };
      return freezeInflowPath({ ...projInputs, cfg: draft, state: st });
    },
    [summary, fx, today, fees, reserved, projInputs],
  );

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
              ...newConfigGlobals(),
            },
      );
      setShowVersions(false);
    },
    [cfg, today],
  );

  function save(next: GlideConfig) {
    // The user's own save — never the automatic flag of the version it was
    // edited from (that would make it droppable, see dropSeeded).
    const { seeded: _seeded, ...own } = next;
    saveGlideVersion({
      ...own,
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
    });
    setEditing(null);
  }

  if (summary.totalValueHuf <= 0 && !cfg) return null;

  const colorOf = (id: string) =>
    BUCKET_COLORS[Math.max(0, (cfg?.buckets ?? []).findIndex((b) => b.id === id)) % BUCKET_COLORS.length];
  // Two buckets mirror each other (they always add up to 100%): one chart,
  // the first bucket on the left axis and its pair on the right.
  const pair = cfg?.buckets.length === 2 ? cfg.buckets : undefined;
  const selected = pair
    ? pair[0].id
    : chartId && cfg?.buckets.some((b) => b.id === chartId)
      ? chartId
      : cfg?.buckets[0]?.id;
  const unassigned = (state?.unassigned ?? []).filter((p) => Math.abs(p.valueHuf) > 0.5);
  const unassignedHuf = unassigned.reduce((s, p) => s + p.valueHuf, 0);
  const nextCheck = cfg
    ? checkDays(cfg.checkFrequency, today, `${+today.slice(0, 4) + 1}${today.slice(4)}`).find((d) => d > today)
    : undefined;
  const sortedVersions = [...versions].reverse();
  // The path ahead (latest version): monthly until the last end date — or
  // until the inflows-only projection arrives, when that is later.
  const bucket = cfg?.buckets.find((b) => b.id === selected);
  const inflows = !!cfg && isInflowMode(cfg);
  const pathEnd = !cfg
    ? today
    : inflows
      ? (cfg.inflowPath?.[cfg.inflowPath.length - 1]?.day ?? today)
      : cfg.buckets.reduce((m, b) => (b.endDate > m ? b.endDate : m), today);
  // The inflow path's arrival month (frozen on save), for the status lines.
  const inflowEnd = inflows && cfg.inflowReached ? pathEnd : undefined;
  const chartEnd = [pathEnd, projection?.zero.reachedOn ?? ""].reduce((m, d) => (d > m ? d : m));
  const projAt = (p: GlideProjection | undefined) =>
    new Map((p?.points ?? []).map((x) => [x.day, x.weights]));
  const zeroAt = projAt(projection?.zero);
  const realAt = projAt(projection?.real);
  const future: Row[] =
    liveCfg && bucket
      ? previewRows(checkDays("monthly", today, chartEnd), (day) =>
          bandLimits(bandBucket(liveCfg, bucket), day, pathTargets(liveCfg, day).get(bucket.id) ?? 0),
        ).map((r) => ({
          ...r,
          // In "inflows" mode the path ahead IS the inflows-only plan — drawn once.
          projZero: inflows ? undefined : zeroAt.get(r.day)?.[bucket.id],
          projReal: realAt.get(r.day)?.[bucket.id],
        }))
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
          freeze={freeze}
          outOfBandNow={(state?.buckets ?? [])
            .filter((b) => b.status === "below" || b.status === "above")
            .map((b) => b.bucket.name)}
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
                      / pálya {pct(b.target)} ({pct(b.low)}–{pct(b.high)}
                      {bandBaseNote(b) && `; ${bandBaseNote(b)}`})
                    </span>
                  </span>
                </div>
                <BandBar b={b} color={colorOf(b.bucket.id)} />
                <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                  <Amt>{formatMoney(b.valueHuf)}</Amt> · végső cél {pct(b.bucket.finalWeight)}{" "}
                  {inflows
                    ? `(befizetésekből: ${inflowEnd ? monthOf(inflowEnd) : `${PROJECTION_YEARS} éven belül nem`})`
                    : `(${b.bucket.endDate})`}
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
              {cfg.restoreTo === "path" ? "a pályacélig" : "a sávhatárig"}
              {cfg.buckets.some((b) => b.aboveMode || b.belowMode) && " (csoportonként eltérhet)"} · érvényes{" "}
              {cfg.validFrom}-tól
            </p>
          )}
          {amountSource && (
            <p
              className={`mt-1 text-xs ${
                breakdown.glideMode === "legacy" ? "text-[var(--color-warning)]" : "text-[var(--color-muted)]"
              }`}
            >
              <PrivateText text={amountSource} amounts />
            </p>
          )}
          {projection && (
            <InflowSummary
              inflows={projection.zero.inflows}
              today={today}
              until={projection.zero.reachedOn}
              names={names}
              nowHuf={breakdown.glideHuf}
            />
          )}

          {cfg && selected && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-[var(--color-muted)]">
                  {pair ? `${pair[0].name} / ${pair[1].name} aránya a pályához képest` : "Súly a pályához képest"}
                </span>
                {!pair && cfg.buckets.map((b) => (
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
                pathFrom={inflows ? cfg.inflowPath?.[0]?.day : undefined}
                goalDay={inflows ? inflowEnd : bucket?.endDate}
                goal={bucket ? bucket.finalWeight / (cfg.buckets.reduce((s, b) => s + b.finalWeight, 0) || 1) : undefined}
                mirror={pair ? { name: pair[1].name, color: colorOf(pair[1].id) } : undefined}
                name={bucket?.name}
              />
              {projection && (
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--color-text)]">Várható arány</span>{" "}
                  (pontozott vonalak: élénk = csak befizetés, halvány = hozammal) — a
                  végső célsúlyok elérése (±{(REACH_TOLERANCE * 100).toLocaleString("hu-HU")} százalékpont):
                  csak befizetésből{" "}
                  <span className="font-medium text-[var(--color-text)]">
                    {projection.zero.reachedOn ? monthOf(projection.zero.reachedOn) : `${PROJECTION_YEARS} éven belül nem`}
                  </span>
                  , évi {pct(projection.realPct)} hozammal{" "}
                  <span className="font-medium text-[var(--color-text)]">
                    {projection.real.reachedOn ? monthOf(projection.real.reachedOn) : `${PROJECTION_YEARS} éven belül nem`}
                  </span>{" "}
                  {inflows
                    ? "(a pálya a mentéskor számolt, csak befizetésből vonal — a sáv ehhez mér; frissíteni új mentéssel lehet)."
                    : `(a pálya vége: ${monthOf(pathEnd)}).`}{" "}
                  Számol a szabad kuponokkal és
                  lejáratokkal, a célpálya havi összegével (a célok lejártával
                  újraszámolva) és a csoportba tartozó DCA vételekkel; a célhoz
                  rendelt kupon és lejárat kimarad. A pénz a végső célsúlyok felé
                  megy; az állampapír és a készpénz értéke nem változik, a hozam
                  (az Előrejelzés „reális” forgatókönyve) csak a többire vonatkozik.
                </p>
              )}
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
