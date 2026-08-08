import { useEffect, useMemo, useRef, useState } from "react";
import { Car, Landmark, Scale, CalendarClock } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useSavingsGoals,
} from "../lib/store";
import { computeSavingsProgress } from "../lib/savings";
import {
  loadCarSwap,
  saveCarSwap,
  computeCarSwap,
  prefillFromPortfolio,
  type CarSwapInputs,
  type GoalInput,
} from "../lib/bigDecision";
import BigDecisionChart from "../components/BigDecisionChart";
import { PageHeader, Card, AmountInput, Amt } from "../components/ui";
import { formatMoney, formatDate } from "../lib/format";

const inputCls =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm";
const amtCls = `${inputCls} w-full text-right tabular-nums`;
const labelCls = "text-xs text-[var(--color-muted)]";

export default function BigDecision() {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const goals = useSavingsGoals();

  const [inp, setInp] = useState<CarSwapInputs>(loadCarSwap);
  useEffect(() => saveCarSwap(inp), [inp]);

  // Első betöltéskor a FixMÁP/DKJ névértéket a portfólióból előtöltjük.
  const prefilled = useRef(!!localStorage.getItem("pf-cardecision"));
  useEffect(() => {
    if (prefilled.current || accounts.length === 0) return;
    const pf = prefillFromPortfolio(summary);
    setInp((s) => ({
      ...s,
      fixmapTrunk0: pf.fixmapTrunk0 || s.fixmapTrunk0,
      dkjForCar: pf.dkjFace || s.dkjForCar,
    }));
    prefilled.current = true;
  }, [summary, accounts.length]);

  const set = (patch: Partial<CarSwapInputs>) => setInp((s) => ({ ...s, ...patch }));

  // Valós célok az appból (hiánnyal, dátummal).
  const goalInputs = useMemo<GoalInput[]>(() => {
    const m = new Map(instruments.map((i) => [i.key, i]));
    return computeSavingsProgress(goals, accounts, transactions, m, prices, fx).map(
      (p) => ({
        id: p.goal.id,
        name: p.goal.name,
        targetHuf: p.goal.targetHuf,
        gapHuf: p.gapHuf,
        ts: new Date(p.goal.targetDate).getTime(),
      }),
    );
  }, [goals, accounts, transactions, instruments, prices, fx]);

  const res = useMemo(
    () => computeCarSwap(inp, goalInputs),
    [inp, goalInputs],
  );

  const toggleGoal = (id: string) =>
    setInp((s) => ({
      ...s,
      excludedGoalIds: s.excludedGoalIds.includes(id)
        ? s.excludedGoalIds.filter((x) => x !== id)
        : [...s.excludedGoalIds, id],
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
        subtitle="Autócsere (lízing lezárása + készpénzes vétel) hatása a likvid portfólióra a lízing lejáratáig — a te modelled szerint."
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label="Nettó többletköltség"
          value={formatMoney(res.cost.netExtraCost)}
          sub="a lejáratig"
          negative
        />
        <Kpi
          label="Havi szinten"
          value={formatMoney(res.cost.monthlyCost)}
          sub="a jobb autó ára / hó"
          negative
        />
        <Kpi
          label="Portfólió-különbség"
          value={formatMoney(res.finalDiffHuf)}
          sub="alap − váltás a lejáratkor"
          negative
        />
        <Kpi
          label="FixMÁP visszaépítve"
          value={
            res.reach40Ts
              ? formatDate(new Date(res.reach40Ts).toISOString())
              : "lejáratig nem"
          }
          sub={`cél: ${formatMoney(inp.fixmapTrunk0)}`}
        />
      </div>

      {/* Grafikon */}
      <Card className="mt-4 p-5">
        <div className="mb-1 flex items-center gap-2">
          <Scale className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">FixMÁP-állomány a lejáratig</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Váltás (autócsere) vs. maradok. A törzs 7%-on, az új befizetések{" "}
          {(inp.newBondRate * 100).toFixed(1)}%-on; a piros sáv a különbség.
        </p>
        <BigDecisionChart
          rows={res.rebuild}
          target={inp.fixmapTrunk0}
          reach40Ts={res.reach40Ts}
        />
      </Card>

      {/* Célok */}
      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Meglévő célok</h2>
          <span className="text-xs text-[var(--color-muted)]">
            kipipálva = ebben a forgatókönyvben nem számít
          </span>
        </div>
        {goalInputs.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            Nincs középtávú cél a Célok oldalon.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--color-muted)]">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-3 py-2 font-medium">Kihagy</th>
                  <th className="px-3 py-2 font-medium">Cél</th>
                  <th className="px-3 py-2 text-right font-medium">Összeg</th>
                  <th className="px-3 py-2 font-medium">Dátum</th>
                  <th className="px-3 py-2 text-right font-medium">Hiány ma</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Megtak.-ból
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    FixMÁP-ból
                  </th>
                </tr>
              </thead>
              <tbody>
                {goalInputs.map((g) => {
                  const excluded = inp.excludedGoalIds.includes(g.id);
                  const cov = res.goalCoverage.find((c) => c.id === g.id);
                  return (
                    <tr
                      key={g.id}
                      className="border-b border-[var(--color-border)]/50 last:border-0"
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={excluded}
                          onChange={() => toggleGoal(g.id)}
                          className="h-4 w-4 accent-[var(--color-brand)]"
                        />
                      </td>
                      <td
                        className={`px-3 py-2 font-medium ${
                          excluded
                            ? "text-[var(--color-muted)] line-through"
                            : ""
                        }`}
                      >
                        {g.name}
                      </td>
                      <td className="amt px-3 py-2 text-right tabular-nums">
                        {formatMoney(g.targetHuf)}
                      </td>
                      <td className="px-3 py-2 text-[var(--color-muted)]">
                        {formatDate(new Date(g.ts).toISOString())}
                      </td>
                      <td className="amt px-3 py-2 text-right tabular-nums text-[var(--color-muted)]">
                        {formatMoney(g.gapHuf)}
                      </td>
                      <td className="amt px-3 py-2 text-right tabular-nums text-[var(--color-muted)]">
                        {excluded ? "—" : cov ? formatMoney(cov.savingsApplied) : "—"}
                      </td>
                      <td className="amt px-3 py-2 text-right tabular-nums">
                        {excluded ? (
                          "—"
                        ) : cov && cov.shortfall > 0 ? (
                          <span className="text-[var(--color-warning,#fbbf24)]">
                            {formatMoney(cov.shortfall)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Költség-dekompozíció + Leaf eladás */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-lg font-semibold">A váltás költsége</h2>
          <Row label="Kieső FixMÁP-kupon (7%)" value={res.cost.foregoneCoupon} neg />
          <Row label="Egyszeri díjak (visszaváltás + lezárás)" value={res.cost.oneOffFees} neg />
          <Row label="Amortizáció-különbözet (M3 − Leaf)" value={res.cost.depreciationDiff} neg />
          <Row label="Felszabaduló törlesztő hozama (levon)" value={res.cost.reinvestedReturn} pos />
          <div className="my-2 border-t border-[var(--color-border)]" />
          <Row label="Nettó többletköltség a lejáratig" value={res.cost.netExtraCost} neg bold />
          <Row label="Portfólió-különbség (autók értéke nélkül)" value={res.cost.portfolioDiff} neg />
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 text-lg font-semibold">Leaf eladás + FixMÁP</h2>
          <Row label="Tartozás az eladáskor" value={res.leafDebtAtSale} neg />
          <Row label="Végtörlesztés (+ lezárási díj)" value={res.settlement} neg />
          <Row label="Nálad maradó equity" value={res.leafEquity} pos bold />
          <div className="my-2 border-t border-[var(--color-border)]" />
          <Row label="FixMÁP autóra fordítva" value={-inp.fixmapForCar} neg />
          <Row label="FixMÁP célok hiányára" value={-res.goalShortfallTotal} neg />
          <Row label="FixMÁP-állomány a visszaépítés indulásakor" value={res.fixmapAfterAll} bold />
        </Card>
      </div>

      {/* Bemenetek */}
      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Car className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Feltételezések</h2>
          <button
            className="ml-auto text-xs text-[var(--color-brand)] hover:underline"
            onClick={() => {
              const pf = prefillFromPortfolio(summary);
              set({ fixmapTrunk0: pf.fixmapTrunk0, dkjForCar: pf.dkjFace });
            }}
          >
            FixMÁP/DKJ újratöltése a portfólióból
          </button>
        </div>

        <Section title="Autó">
          <Huf label="Model 3 ára (kp)" v={inp.m3Price} on={(n) => set({ m3Price: n })} />
          <Huf label="Leaf eladási ár" v={inp.leafSalePrice} on={(n) => set({ leafSalePrice: n })} />
          <Huf label="Leaf lízingtartozás" v={inp.leafDebt} on={(n) => set({ leafDebt: n })} />
          <Huf label="Havi törlesztő" v={inp.monthlyLease} on={(n) => set({ monthlyLease: n })} />
          <Num label="Lement törlesztők eladásig" v={inp.paymentsBeforeSale} on={(n) => set({ paymentsBeforeSale: n })} />
          <Huf label="Lezárási díj" v={inp.closingFee} on={(n) => set({ closingFee: n })} />
          <Huf label="Model 3 értéke a lejáratkor" v={inp.m3Value2029} on={(n) => set({ m3Value2029: n })} />
          <Huf label="Leaf értéke (ha megtartod)" v={inp.leafValue2029} on={(n) => set({ leafValue2029: n })} />
          <Huf label="Leaf maradványérték a lejáratkor" v={inp.leafResidual2029} on={(n) => set({ leafResidual2029: n })} />
        </Section>

        <Section title="FixMÁP / megtakarítás">
          <Huf label="FixMÁP kiinduló állomány" v={inp.fixmapTrunk0} on={(n) => set({ fixmapTrunk0: n })} />
          <Huf label="DKJ autóra" v={inp.dkjForCar} on={(n) => set({ dkjForCar: n })} />
          <Huf label="FixMÁP autóra" v={inp.fixmapForCar} on={(n) => set({ fixmapForCar: n })} />
          <Huf label="Havi megtakarítás" v={inp.monthlySaving} on={(n) => set({ monthlySaving: n })} />
          <Pct label="FixMÁP kamat (törzs)" v={inp.fixmapRate} on={(n) => set({ fixmapRate: n })} />
          <Pct label="Új befizetés kamata" v={inp.newBondRate} on={(n) => set({ newBondRate: n })} />
          <Pct label="FixMÁP visszaváltási díj" v={inp.fixmapRedemptionFee} on={(n) => set({ fixmapRedemptionFee: n })} />
        </Section>

        <Section title="Dátumok">
          <MonthF label="Leaf eladása" v={inp.saleMonth} on={(s2) => set({ saleMonth: s2 })} />
          <MonthF label="Visszaépítés indul" v={inp.rebuildStartMonth} on={(s2) => set({ rebuildStartMonth: s2 })} />
          <MonthF label="Lízing lejárata" v={inp.leaseEndMonth} on={(s2) => set({ leaseEndMonth: s2 })} />
        </Section>
      </Card>

      <p className="mt-3 text-xs text-[var(--color-muted)]">
        A modell a te Excel-logikádat követi (kp-s vétel): a törzs 7%-on, az új
        befizetések + kuponok friss papírban, a felszabaduló lízingdíj a
        megtakarításhoz adódik. A célokat az app Célok oldaláról veszi. A
        lízinges változat és a több-forgatókönyv összevetés a következő lépés.
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  negative = false,
}: {
  label: string;
  value: string;
  sub?: string;
  negative?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div
        className={`amt font-display mt-1 text-xl font-semibold tabular-nums ${
          negative ? "text-[var(--color-negative)]" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-[var(--color-muted)]">{sub}</div>}
    </Card>
  );
}

function Row({
  label,
  value,
  neg = false,
  pos = false,
  bold = false,
}: {
  label: string;
  value: number;
  neg?: boolean;
  pos?: boolean;
  bold?: boolean;
}) {
  const color = neg
    ? "text-[var(--color-negative)]"
    : pos
      ? "text-[var(--color-positive)]"
      : "";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className={bold ? "font-medium" : "text-[var(--color-muted)]"}>
        {label}
      </span>
      <Amt className={`tabular-nums ${bold ? "font-semibold" : ""} ${color}`}>
        {formatMoney(value)}
      </Amt>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title === "FixMÁP / megtakarítás" ? (
          <Landmark className="h-3.5 w-3.5" />
        ) : null}
        {title}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

function Huf({
  label,
  v,
  on,
}: {
  label: string;
  v: number;
  on: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      <AmountInput className={amtCls} value={String(v)} onValueChange={(d) => on(Number(d || 0))} />
    </label>
  );
}

function Num({
  label,
  v,
  on,
}: {
  label: string;
  v: number;
  on: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      <input
        type="number"
        className={amtCls}
        value={v}
        onChange={(e) => on(Number(e.target.value || 0))}
      />
    </label>
  );
}

function Pct({
  label,
  v,
  on,
}: {
  label: string;
  v: number;
  on: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label} (%)</span>
      <input
        type="number"
        step="0.1"
        className={amtCls}
        value={+(v * 100).toFixed(3)}
        onChange={(e) => on(Number(e.target.value || 0) / 100)}
      />
    </label>
  );
}

function MonthF({
  label,
  v,
  on,
}: {
  label: string;
  v: string;
  on: (s: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      <input
        type="month"
        className={inputCls}
        value={v}
        onChange={(e) => on(e.target.value)}
      />
    </label>
  );
}
