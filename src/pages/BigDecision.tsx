import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Car, Scale } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useSavingsGoals,
} from "../lib/store";
import { computeSavingsProgress } from "../lib/savings";
import {
  detectRecurringSavings,
  loadForecastSettings,
} from "../lib/forecast";
import {
  loadBigDecision,
  saveBigDecision,
  newScenario,
  buildAssetInfo,
  computeBigDecision,
  remainingDebtHuf,
  newId,
  type BigDecisionState,
  type Scenario,
  type FundingLeg,
  type EngineContext,
} from "../lib/bigDecision";
import BigDecisionChart, {
  SCENARIO_COLORS,
} from "../components/BigDecisionChart";
import { PageHeader, Card, AmountInput, Amt } from "../components/ui";
import { formatMoney, formatDate } from "../lib/format";

const field =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm";
const amtField = `${field} text-right tabular-nums`;
const label = "text-xs text-[var(--color-muted)]";

export default function BigDecision() {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const goals = useSavingsGoals();

  const [state, setState] = useState<BigDecisionState>(loadBigDecision);
  useEffect(() => saveBigDecision(state), [state]);

  // Finanszírozásra felkínált eszközök (a tartott állomány).
  const assetInfo = useMemo(() => buildAssetInfo(summary), [summary]);
  const assetList = useMemo(
    () =>
      [...assetInfo.values()].sort((a, b) => b.marketValueHuf - a.marketValueHuf),
    [assetInfo],
  );

  const goalProgress = useMemo(() => {
    const m = new Map(instruments.map((i) => [i.key, i]));
    return new Map(
      computeSavingsProgress(goals, accounts, transactions, m, prices, fx).map(
        (p) => [p.goal.id, p],
      ),
    );
  }, [goals, accounts, transactions, instruments, prices, fx]);

  const fs = loadForecastSettings();
  const detected = useMemo(
    () => detectRecurringSavings(transactions, fx),
    [transactions, fx],
  );
  const monthlySaving = fs.monthlySavingOverride ?? detected.monthlyHuf;

  const ctx: EngineContext = useMemo(
    () => ({
      summary,
      assetInfo,
      goals,
      goalProgress,
      monthlySavingHuf: monthlySaving,
      annualReturn: fs.annualReturn.real,
      bondRate: fs.reinvestBondRate,
      months: fs.months,
      now: new Date(),
    }),
    [summary, assetInfo, goals, goalProgress, monthlySaving, fs.annualReturn.real, fs.reinvestBondRate, fs.months],
  );

  const result = useMemo(() => computeBigDecision(ctx, state), [ctx, state]);
  const remainingDebt = remainingDebtHuf(state.car);

  // --- state helpers ---
  const setCar = (patch: Partial<BigDecisionState["car"]>) =>
    setState((s) => ({ ...s, car: { ...s.car, ...patch } }));
  const addScenario = () =>
    setState((s) => ({
      ...s,
      scenarios: [
        ...s.scenarios,
        newScenario(`Forgatókönyv ${s.scenarios.length + 1}`),
      ],
    }));
  const updateScenario = (id: string, patch: Partial<Scenario>) =>
    setState((s) => ({
      ...s,
      scenarios: s.scenarios.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  const removeScenario = (id: string) =>
    setState((s) => ({
      ...s,
      scenarios: s.scenarios.filter((x) => x.id !== id),
    }));

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title="Nagy döntés" />
        <Card className="p-6 text-sm text-[var(--color-muted)]">
          Előbb importálj adatokat, hogy legyen mihez viszonyítani a döntést.
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Nagy döntés"
        subtitle="Egy nagy kiadás (pl. autócsere) hatása a jövőbeli portfóliódra — több forgatókönyv összehasonlítva."
      />

      {/* Mostani autó — közös bemenetek */}
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Car className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Mostani autó</h2>
        </div>
        <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.car.hasLease}
            onChange={(e) => setCar({ hasLease: e.target.checked })}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          Van rajta lízing
        </label>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {state.car.hasLease && (
            <>
              <div className="flex flex-col gap-1">
                <span className={label}>Lízing vége</span>
                <input
                  type="date"
                  className={field}
                  value={state.car.leaseEndDate}
                  onChange={(e) => setCar({ leaseEndDate: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Havidíj (Ft)</span>
                <AmountInput
                  className={amtField}
                  value={String(state.car.monthlyHuf)}
                  onValueChange={(d) => setCar({ monthlyHuf: Number(d || 0) })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Végső törlesztő (Ft)</span>
                <AmountInput
                  className={amtField}
                  value={String(state.car.balloonHuf)}
                  onValueChange={(d) => setCar({ balloonHuf: Number(d || 0) })}
                />
              </div>
            </>
          )}
          <div className="flex flex-col gap-1">
            <span className={label}>Eladási ár (Ft)</span>
            <AmountInput
              className={amtField}
              value={String(state.car.saleEstimateHuf)}
              onValueChange={(d) => setCar({ saleEstimateHuf: Number(d || 0) })}
            />
          </div>
        </div>
        {state.car.hasLease && (
          <div className="mt-3 text-sm text-[var(--color-muted)]">
            Hátralévő tartozás most:{" "}
            <Amt className="font-semibold text-[var(--color-text)]">
              {formatMoney(remainingDebt)}
            </Amt>{" "}
            · nettó az eladásból ma:{" "}
            <Amt className="font-semibold text-[var(--color-text)]">
              {formatMoney(state.car.saleEstimateHuf - remainingDebt)}
            </Amt>
          </div>
        )}
      </Card>

      {/* Forgatókönyvek */}
      <div className="mt-4 space-y-4">
        {state.scenarios.map((scn, i) => (
          <ScenarioEditor
            key={scn.id}
            scn={scn}
            color={SCENARIO_COLORS[i % SCENARIO_COLORS.length]}
            assets={assetList}
            goals={goals}
            onChange={(patch) => updateScenario(scn.id, patch)}
            onRemove={() => removeScenario(scn.id)}
          />
        ))}
        <button className="btn-ghost" onClick={addScenario}>
          <Plus className="h-4 w-4" /> Új forgatókönyv
        </button>
      </div>

      {/* Eredmény */}
      {state.scenarios.length > 0 && (
        <Card className="mt-6 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Scale className="h-5 w-5 text-[var(--color-brand)]" />
            <h2 className="text-lg font-semibold">Összehasonlítás</h2>
            <span className="text-xs text-[var(--color-muted)]">
              jövőbeli vagyon a horizonton ({Math.round(fs.months / 12)} év)
            </span>
          </div>
          <BigDecisionChart
            baseline={result.baseline}
            scenarios={result.scenarios}
          />

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--color-muted)]">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-3 py-2 font-medium">Forgatókönyv</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Vagyon a horizonton
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    vs. maradok
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Adó/díj</th>
                  <th className="px-3 py-2 text-right font-medium">
                    FixMÁP-ból
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    FixMÁP visszapótolva
                  </th>
                </tr>
              </thead>
              <tbody>
                <ResultRow p={result.baseline} color="#8a93b2" />
                {result.scenarios.map((p, i) => (
                  <ResultRow
                    key={p.id}
                    p={p}
                    color={SCENARIO_COLORS[i % SCENARIO_COLORS.length]}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            A hozam-feltevés és a horizont az Előrejelzés oldaléból jön (reális
            hozam). A célok teljesülnek; a hiányt a céldátumon a FixMÁP-ból
            fedezzük. Ez egy első verzió — finomítjuk.
          </p>
        </Card>
      )}
    </div>
  );
}

function ResultRow({
  p,
  color,
}: {
  p: import("../lib/bigDecision").ScenarioProjection;
  color: string;
}) {
  const up = p.vsBaselineHuf >= 0;
  return (
    <tr className="border-b border-[var(--color-border)]/50 last:border-0">
      <td className="px-3 py-2.5">
        <span className="inline-flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: color }}
          />
          <span className="font-medium">{p.name}</span>
        </span>
      </td>
      <td className="amt px-3 py-2.5 text-right font-semibold tabular-nums">
        {formatMoney(p.horizonValueHuf)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {p.isBaseline ? (
          <span className="text-[var(--color-muted)]">—</span>
        ) : (
          <span
            className={
              up
                ? "text-[var(--color-positive)]"
                : "text-[var(--color-negative)]"
            }
          >
            <Amt>{formatMoney(p.vsBaselineHuf, "HUF", { sign: true })}</Amt>
          </span>
        )}
      </td>
      <td className="amt px-3 py-2.5 text-right tabular-nums text-[var(--color-muted)]">
        {p.taxPaidHuf > 0 ? formatMoney(p.taxPaidHuf) : "—"}
      </td>
      <td className="amt px-3 py-2.5 text-right tabular-nums text-[var(--color-muted)]">
        {p.fromFixmapHuf > 0 ? formatMoney(p.fromFixmapHuf) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-muted)]">
        {p.fromFixmapHuf > 0
          ? p.fixmapRecoverTs
            ? formatDate(new Date(p.fixmapRecoverTs).toISOString())
            : "5+ év"
          : "—"}
      </td>
    </tr>
  );
}

function ScenarioEditor({
  scn,
  color,
  assets,
  goals,
  onChange,
  onRemove,
}: {
  scn: Scenario;
  color: string;
  assets: import("../lib/bigDecision").AssetInfo[];
  goals: import("../lib/savings").SavingsGoal[];
  onChange: (patch: Partial<Scenario>) => void;
  onRemove: () => void;
}) {
  const setLease = (patch: Partial<Scenario["lease"]>) =>
    onChange({ lease: { ...scn.lease, ...patch } });
  const addLeg = () =>
    onChange({
      funding: [...scn.funding, { id: newId(), instrumentKey: "", amountHuf: 0 }],
    });
  const updateLeg = (id: string, patch: Partial<FundingLeg>) =>
    onChange({
      funding: scn.funding.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  const removeLeg = (id: string) =>
    onChange({ funding: scn.funding.filter((l) => l.id !== id) });
  const toggleGoal = (goalId: string) => {
    const has = scn.excludedGoalIds.includes(goalId);
    onChange({
      excludedGoalIds: has
        ? scn.excludedGoalIds.filter((g) => g !== goalId)
        : [...scn.excludedGoalIds, goalId],
    });
  };

  const fundLabel =
    scn.financing === "cash" ? "Finanszírozás (vételár)" : "Önerő fedezete";

  return (
    <Card className="p-5" hover>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: color }} />
        <input
          className={`${field} flex-1 font-medium`}
          value={scn.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button
          className="rounded-lg p-1.5 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-negative)]"
          onClick={onRemove}
          title="Forgatókönyv törlése"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <span className={label}>Új autó ára (Ft)</span>
          <AmountInput
            className={amtField}
            value={String(scn.newCarPriceHuf)}
            onValueChange={(d) => onChange({ newCarPriceHuf: Number(d || 0) })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className={label}>Vétel dátuma</span>
          <input
            type="date"
            className={field}
            value={scn.buyDate}
            onChange={(e) => onChange({ buyDate: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className={label}>Régi autó eladása</span>
          <input
            type="date"
            className={field}
            value={scn.sellDate}
            onChange={(e) => onChange({ sellDate: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className={label}>Finanszírozás</span>
          <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
            {(
              [
                ["cash", "Készpénz"],
                ["lease", "Lízing"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => onChange({ financing: k })}
                className={`flex-1 rounded-md px-2 py-1 transition ${
                  scn.financing === k
                    ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                    : "text-[var(--color-muted)]"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {scn.financing === "lease" && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className={label}>Önerő (Ft)</span>
            <AmountInput
              className={amtField}
              value={String(scn.lease.downPaymentHuf)}
              onValueChange={(d) => setLease({ downPaymentHuf: Number(d || 0) })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className={label}>Havidíj (Ft)</span>
            <AmountInput
              className={amtField}
              value={String(scn.lease.monthlyHuf)}
              onValueChange={(d) => setLease({ monthlyHuf: Number(d || 0) })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className={label}>Futamidő (hó)</span>
            <input
              type="number"
              min={0}
              className={amtField}
              value={scn.lease.termMonths}
              onChange={(e) =>
                setLease({ termMonths: Number(e.target.value || 0) })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className={label}>Végső törlesztő (Ft)</span>
            <AmountInput
              className={amtField}
              value={String(scn.lease.balloonHuf)}
              onValueChange={(d) => setLease({ balloonHuf: Number(d || 0) })}
            />
          </div>
        </div>
      )}

      {/* Finanszírozó eszközök */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className={label}>{fundLabel}</span>
          <button
            className="text-xs text-[var(--color-brand)] hover:underline"
            onClick={addLeg}
          >
            + eszköz
          </button>
        </div>
        <div className="space-y-2">
          {scn.funding.map((leg) => (
            <div key={leg.id} className="flex items-center gap-2">
              <select
                className={`${field} min-w-0 flex-1`}
                value={leg.instrumentKey}
                onChange={(e) => updateLeg(leg.id, { instrumentKey: e.target.value })}
              >
                <option value="">Válassz eszközt…</option>
                {assets.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.name} ({formatMoney(a.marketValueHuf)})
                  </option>
                ))}
              </select>
              <AmountInput
                className={`${amtField} w-32`}
                value={String(leg.amountHuf)}
                onValueChange={(d) =>
                  updateLeg(leg.id, { amountHuf: Number(d || 0) })
                }
              />
              <button
                className="rounded-lg p-1.5 text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                onClick={() => removeLeg(leg.id)}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {scn.funding.length === 0 && (
            <p className="text-xs text-[var(--color-muted)]">
              Add meg, melyik eszközből mennyit vonnál ki (pl. 3,5M DKJ + 5M
              FixMÁP).
            </p>
          )}
        </div>
      </div>

      {/* Kihagyott célok + FixMÁP-visszapótlás hozam */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {goals.length > 0 && (
          <div>
            <span className={label}>Ebben NEM számító célok</span>
            <div className="mt-1.5 space-y-1.5">
              {goals.map((g) => (
                <label
                  key={g.id}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={scn.excludedGoalIds.includes(g.id)}
                    onChange={() => toggleGoal(g.id)}
                    className="h-4 w-4 accent-[var(--color-brand)]"
                  />
                  <span className={scn.excludedGoalIds.includes(g.id) ? "line-through text-[var(--color-muted)]" : ""}>
                    {g.name} · <Amt>{formatMoney(g.targetHuf)}</Amt> ·{" "}
                    {formatDate(g.targetDate)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div>
          <span className={label}>FixMÁP-visszapótlás hozama</span>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="number"
              step="0.1"
              min={0}
              className={`${amtField} w-24`}
              value={+(scn.fixmapYieldPct * 100).toFixed(2)}
              onChange={(e) =>
                onChange({ fixmapYieldPct: Number(e.target.value || 0) / 100 })
              }
            />
            <span className="text-sm text-[var(--color-muted)]">% / év</span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Ilyen hozamú új FixMÁP-ba forgatjuk vissza a szabad pénzt (a célok
            feltöltése után).
          </p>
        </div>
      </div>
    </Card>
  );
}
