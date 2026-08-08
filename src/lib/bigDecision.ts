// ---------------------------------------------------------------------------
// "Nagy döntés" — nagy egyszeri kiadás (pl. autócsere) hatása a jövőbeli
// portfólió-értékre, több forgatókönyv összehasonlításával.
//
// A modell a pénzmozgásra koncentrál (a jövőérték-KÜLÖNBSÉG a forgatókönyvek
// közt ebből pontos, mert az alap-növekedés minden forgatókönyvben azonos):
//   • Vétel (készpénz): a portfólió a kocsi árával + a finanszírozó eszközök
//     adójával/díjával csökken.  vagyoncsökkenés = ár + adó.
//   • Vétel (lízing): önerő + adó csökkenti a portfóliót, a havidíj a
//     megtakarítást csökkenti a futamidő alatt, az esetleges végső törlesztő
//     egyszeri kiadás a futam végén.
//   • Régi autó eladása: a kiváltás (hátralévő havidíjak + végső törlesztő)
//     levonása után a maradék visszakerül a portfólióba; a felszabaduló régi
//     havidíj a megtakarításba megy az eredeti lízing-lejáratig.
//   • FixMÁP-visszapótlás: ha fix állampapírhoz nyúlunk, kiszámoljuk, mikorra
//     épül vissza a kiindulási értékére (havi visszaforgatás + kupon, a megadott
//     hozamú új FixMÁP-ban).
//
// v1 — szándékosan átlátható közelítésekkel (célok/kupon finomítása jön).
// ---------------------------------------------------------------------------

import type { PortfolioSummary } from "./portfolio";
import type { SavingsGoal, SavingsProgress } from "./savings";
import { tbszStatus } from "./tbsz";

const BOND_TYPES = new Set(["gov_bond", "tbill"]);
/** "Fix" állampapír (FixMÁP) — a visszapótlás-követés alanya. */
const FIXMAP_TYPE = "gov_bond";

// ----- kis dátum-segédek (helyi éjfél, hó-granularitás) ---------------------
function parseDayMs(s: string | undefined): number {
  if (!s) return NaN;
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? NaN : d.getTime();
}
function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}
/** Hány havi lépés `fromMs`-től `toMs`-ig (a hó elejére kerekítve, ≥0). */
function monthsBetween(fromMs: number, toMs: number): number {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  return Math.max(
    0,
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()),
  );
}
const monthlyRate = (annual: number) => Math.pow(1 + annual, 1 / 12) - 1;

// ---------------------------------------------------------------------------
// Adatmodell
// ---------------------------------------------------------------------------

export interface CurrentCar {
  hasLease: boolean;
  /** A jelenlegi lízing vége (YYYY-MM-DD). */
  leaseEndDate: string;
  /** Havidíj (HUF). */
  monthlyHuf: number;
  /** Utolsó kiemelt (végső) törlesztő a lízing végén (HUF). */
  balloonHuf: number;
  /** Becsült eladási ár (HUF). */
  saleEstimateHuf: number;
}

export interface FundingLeg {
  id: string;
  /** Melyik eszközből (instrument key). "" = általános készpénz/növekedés. */
  instrumentKey: string;
  /** Ebből az eszközből kivont BRUTTÓ összeg (HUF). */
  amountHuf: number;
}

export interface NewLease {
  downPaymentHuf: number;
  monthlyHuf: number;
  termMonths: number;
  /** Végső kiemelt törlesztő a futam végén (HUF, 0 = nincs). */
  balloonHuf: number;
}

export type Financing = "cash" | "lease";

export interface Scenario {
  id: string;
  name: string;
  newCarPriceHuf: number;
  /** Új autó vásárlásának dátuma. */
  buyDate: string;
  /** Régi autó eladásának dátuma (lehet később is, mint a vétel). */
  sellDate: string;
  financing: Financing;
  /** Készpénznél az árat, lízingnél az önerőt fedező eszköz-lábak. */
  funding: FundingLeg[];
  lease: NewLease;
  /** Ezek a meglévő célok NEM számítanak ebben a forgatókönyvben. */
  excludedGoalIds: string[];
  /** A visszapótló (új) FixMÁP hozama (tört, pl. 0.065). */
  fixmapYieldPct: number;
}

export interface BigDecisionState {
  car: CurrentCar;
  scenarios: Scenario[];
}

export const DEFAULT_STATE: BigDecisionState = {
  car: {
    hasLease: true,
    leaseEndDate: "",
    monthlyHuf: 0,
    balloonHuf: 0,
    saleEstimateHuf: 0,
  },
  scenarios: [],
};

const STORE_KEY = "pf-bigdecision";

export function loadBigDecision(): BigDecisionState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_STATE, scenarios: [] };
    const p = JSON.parse(raw) as Partial<BigDecisionState>;
    return {
      car: { ...DEFAULT_STATE.car, ...(p.car ?? {}) },
      scenarios: Array.isArray(p.scenarios) ? p.scenarios : [],
    };
  } catch {
    return { ...DEFAULT_STATE, scenarios: [] };
  }
}

export function saveBigDecision(s: BigDecisionState) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `bd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

export function newScenario(name: string): Scenario {
  return {
    id: newId(),
    name,
    newCarPriceHuf: 0,
    buyDate: "",
    sellDate: "",
    financing: "cash",
    funding: [],
    lease: { downPaymentHuf: 0, monthlyHuf: 0, termMonths: 48, balloonHuf: 0 },
    excludedGoalIds: [],
    fixmapYieldPct: 0.065,
  };
}

// ---------------------------------------------------------------------------
// Eszköz-kontextus (adó + FixMÁP-besorolás a portfólióból)
// ---------------------------------------------------------------------------

export interface AssetInfo {
  key: string;
  name: string;
  type: string;
  marketValueHuf: number;
  costBasisHuf: number;
  gainHuf: number;
  /** A tartó számla TBSZ-e (és a gyűjtőév), az adóhoz. */
  tbszYear?: number;
  /** Kötvény eladási költség (visszaváltási díj) tört, ha van. */
  saleCostPct?: number;
  maturity?: string;
  isFixmap: boolean;
}

/** Instrument-kulcsonkénti összegzés a portfólióból (adó + besorolás). */
export function buildAssetInfo(summary: PortfolioSummary): Map<string, AssetInfo> {
  const map = new Map<string, AssetInfo>();
  for (const acc of summary.accounts) {
    const isTbsz = acc.account.kind === "tbsz" && !!acc.account.tbszYear;
    for (const h of acc.holdings) {
      const inst = h.instrument;
      if (!inst || (h.quantity ?? 0) <= 0) continue;
      const ex = map.get(inst.key);
      const gain = h.unrealizedPlHuf ?? 0;
      if (ex) {
        ex.marketValueHuf += h.marketValueHuf ?? 0;
        ex.costBasisHuf += h.costBasisHuf ?? 0;
        ex.gainHuf += gain;
        if (isTbsz && ex.tbszYear == null) ex.tbszYear = acc.account.tbszYear;
      } else {
        map.set(inst.key, {
          key: inst.key,
          name: inst.name ?? inst.key,
          type: inst.type,
          marketValueHuf: h.marketValueHuf ?? 0,
          costBasisHuf: h.costBasisHuf ?? 0,
          gainHuf: gain,
          tbszYear: isTbsz ? acc.account.tbszYear : undefined,
          saleCostPct: inst.bond?.saleCostPct,
          maturity: inst.bond?.maturity ?? inst.maturity,
          isFixmap: inst.type === FIXMAP_TYPE,
        });
      }
    }
  }
  return map;
}

/**
 * Adó + díj egy eszközből kivont BRUTTÓ összegre, adott dátumon.
 *  • TBSZ: a hozamrészre a TBSZ-szakasz kulcsa (szja + szocho).
 *  • Retail állampapír (nem TBSZ): a hozam adómentes, de lejárat előtti
 *    eladásnál a visszaváltási díj levonódik.
 *  • Egyéb (nem TBSZ részvény/ETF): 15% árfolyamnyereség-adó a hozamrészre.
 */
export function fundingTaxHuf(
  info: AssetInfo | undefined,
  grossHuf: number,
  atMs: number,
): number {
  if (!info || grossHuf <= 0) return 0;
  const gainRatio =
    info.marketValueHuf > 0 ? Math.max(0, info.gainHuf) / info.marketValueHuf : 0;
  const taxableGain = grossHuf * gainRatio;
  let tax = 0;
  if (info.tbszYear) {
    tax += taxableGain * tbszStatus(info.tbszYear, new Date(atMs)).taxRate;
  } else if (BOND_TYPES.has(info.type)) {
    // Retail állampapír hozama adómentes; csak a visszaváltási díj.
    const matMs = parseDayMs(info.maturity);
    const beforeMaturity = !Number.isFinite(matMs) || atMs < matMs;
    const feePct =
      info.saleCostPct != null
        ? info.saleCostPct
        : info.type === "gov_bond"
          ? 0.01
          : 0;
    if (beforeMaturity) tax += grossHuf * feePct;
  } else {
    tax += taxableGain * 0.15; // sima árfolyamnyereség-adó
  }
  return tax;
}

// ---------------------------------------------------------------------------
// Projekció
// ---------------------------------------------------------------------------

export interface EngineContext {
  summary: PortfolioSummary;
  assetInfo: Map<string, AssetInfo>;
  goals: SavingsGoal[];
  goalProgress: Map<string, SavingsProgress>;
  /** Havi rendszeres megtakarítás (a lízing havidíja NÉLKÜL). */
  monthlySavingHuf: number;
  /** Éves várható hozam a növekedési eszközökre (tört). */
  annualReturn: number;
  /** Kötvények feltételezett éves hozama a görbéhez (tört). */
  bondRate: number;
  months: number;
  now: Date;
}

export interface ScenarioPoint {
  ts: number;
  value: number;
}

export interface ScenarioProjection {
  id: string;
  name: string;
  isBaseline: boolean;
  points: ScenarioPoint[];
  horizonValueHuf: number;
  /** Horizont-érték − baseline horizont-érték (a döntés valódi ára). */
  vsBaselineHuf: number;
  /** Fizetett adó/díj a finanszírozáshoz (HUF). */
  taxPaidHuf: number;
  /** FixMÁP-ból finanszírozott összeg (bruttó, HUF). */
  fromFixmapHuf: number;
  /** Mikorra épül vissza a FixMÁP a kiindulási értékére (ts, vagy null). */
  fixmapRecoverTs: number | null;
  /** Havi cashflow-változás a baseline-hoz képest (felszabaduló − új havidíj). */
  netMonthlyDeltaHuf: number;
}

interface OneOff {
  ms: number;
  /** Portfólió-változás (negatív = kiadás). Eszközből, adóval együtt. */
  deltaHuf: number;
  /** Mennyi ebből FixMÁP-ból jött (bruttó), a visszapótláshoz. */
  fromFixmapHuf?: number;
  /** Mennyi bruttót vontunk kötvényből ill. részvényből (a pot-oknak). */
  fromBondsHuf?: number;
}

/** A növekedési, kötvény- és FixMÁP-pot kezdőértékei. */
function startingPots(summary: PortfolioSummary, assetInfo: Map<string, AssetInfo>) {
  let fixmap = 0;
  let bondsNonFix = 0;
  for (const a of assetInfo.values()) {
    if (a.isFixmap) fixmap += a.marketValueHuf;
    else if (BOND_TYPES.has(a.type)) bondsNonFix += a.marketValueHuf;
  }
  const equity = summary.totalValueHuf - fixmap - bondsNonFix;
  return { equity, bondsNonFix, fixmap };
}

/** Egy forgatókönyv (vagy a baseline, ha `scn` null) havi projekciója. */
function projectOne(
  ctx: EngineContext,
  car: CurrentCar,
  scn: Scenario | null,
): Omit<ScenarioProjection, "vsBaselineHuf"> {
  const nowMs = new Date(
    ctx.now.getFullYear(),
    ctx.now.getMonth(),
    1,
  ).getTime();
  const pots = startingPots(ctx.summary, ctx.assetInfo);
  const rE = monthlyRate(ctx.annualReturn);
  const rB = monthlyRate(ctx.bondRate);

  const leaseEndMs = parseDayMs(car.leaseEndDate);
  const oneOffs: OneOff[] = [];
  // Havi megtakarítás-kiigazítás idősávok: [fromMs, toMs, deltaHuf].
  const savingBands: { from: number; to: number; delta: number }[] = [];
  let taxPaid = 0;
  let fromFixmap = 0;
  let netMonthlyDelta = 0;

  if (scn) {
    const buyMs = parseDayMs(scn.buyDate);
    const sellMs = parseDayMs(scn.sellDate);

    // --- Új autó megvétele (a portfólióból) ---
    const legTax = (leg: FundingLeg, atMs: number) => {
      const info = ctx.assetInfo.get(leg.instrumentKey);
      const t = fundingTaxHuf(info, leg.amountHuf, atMs);
      if (info?.isFixmap) fromFixmap += leg.amountHuf;
      const fromBonds = info && BOND_TYPES.has(info.type) ? leg.amountHuf : 0;
      return { tax: t, fromBonds };
    };
    if (Number.isFinite(buyMs)) {
      const cost =
        scn.financing === "cash" ? scn.newCarPriceHuf : scn.lease.downPaymentHuf;
      let tax = 0;
      let fromBonds = 0;
      for (const leg of scn.funding) {
        const r = legTax(leg, buyMs);
        tax += r.tax;
        fromBonds += r.fromBonds;
      }
      taxPaid += tax;
      // Nettó vagyonhatás = kiadás (ár/önerő) + adó, függetlenül attól, mennyi
      // bruttót adtunk el (a maradék készpénz bent marad).
      oneOffs.push({ ms: buyMs, deltaHuf: -(cost + tax), fromBondsHuf: fromBonds });
      // Lízingnél: havidíj a futam alatt (a megtakarítást csökkenti) + végső
      // törlesztő a futam végén.
      if (scn.financing === "lease") {
        const term = Math.max(0, Math.round(scn.lease.termMonths));
        savingBands.push({
          from: buyMs,
          to: addMonths(buyMs, term),
          delta: -scn.lease.monthlyHuf,
        });
        netMonthlyDelta -= scn.lease.monthlyHuf;
        if (scn.lease.balloonHuf > 0)
          oneOffs.push({
            ms: addMonths(buyMs, term),
            deltaHuf: -scn.lease.balloonHuf,
          });
      }
    }

    // --- Régi autó eladása: kiváltás, maradék vissza a portfólióba ---
    if (Number.isFinite(sellMs) && car.hasLease) {
      // Hátralévő tartozás az eladáskor = hátralévő havidíjak + végső törlesztő.
      const monthsLeft = Number.isFinite(leaseEndMs)
        ? monthsBetween(sellMs, leaseEndMs)
        : 0;
      const settlement = monthsLeft * car.monthlyHuf + car.balloonHuf;
      const netSale = car.saleEstimateHuf - settlement;
      oneOffs.push({ ms: sellMs, deltaHuf: netSale });
      // A felszabaduló régi havidíj az eladástól a lízing-lejáratig a
      // megtakarításba megy (utána úgyis nem lenne fizetés).
      if (Number.isFinite(leaseEndMs) && leaseEndMs > sellMs) {
        savingBands.push({
          from: sellMs,
          to: leaseEndMs,
          delta: car.monthlyHuf,
        });
        netMonthlyDelta += car.monthlyHuf;
      }
    } else if (Number.isFinite(sellMs)) {
      // Nincs lízing: a teljes eladási ár visszakerül.
      oneOffs.push({ ms: sellMs, deltaHuf: car.saleEstimateHuf });
    }
  } else {
    // Baseline: megtartom az autót → a végső törlesztő a lízing végén kiadás.
    if (car.hasLease && Number.isFinite(leaseEndMs) && car.balloonHuf > 0)
      oneOffs.push({ ms: leaseEndMs, deltaHuf: -car.balloonHuf });
  }

  // --- Havi szimuláció ---
  const points: ScenarioPoint[] = [];
  for (let i = 0; i <= ctx.months; i++) {
    const ms = addMonths(nowMs, i);
    const nextMs = addMonths(nowMs, i + 1);
    if (i > 0) {
      pots.equity *= 1 + rE;
      pots.bondsNonFix *= 1 + rB;
      pots.fixmap *= 1 + rB;
      // Havi megtakarítás + kiigazítás.
      let saving = ctx.monthlySavingHuf;
      for (const b of savingBands)
        if (ms >= b.from && ms < b.to) saving += b.delta;
      pots.equity += saving;
    }
    // Egyszeri események ebben a hónapban.
    for (const o of oneOffs) {
      if (o.ms >= ms && o.ms < nextMs) {
        if (o.deltaHuf < 0) {
          // Kiadás: a megjelölt kötvény-részt a két bond-potból (azonos hozam,
          // arányosan), a maradékot az equity-ből. A FixMÁP-visszapótlást a KPI
          // külön követi, nem ez a pot.
          let rem = -o.deltaHuf;
          const bondPool = pots.bondsNonFix + pots.fixmap;
          const fromBonds = Math.min(o.fromBondsHuf ?? 0, bondPool);
          if (bondPool > 0 && fromBonds > 0) {
            const fixShare = pots.fixmap / bondPool;
            pots.fixmap -= fromBonds * fixShare;
            pots.bondsNonFix -= fromBonds * (1 - fixShare);
          }
          rem -= fromBonds;
          pots.equity -= rem;
        } else {
          pots.equity += o.deltaHuf;
        }
      }
    }
    points.push({
      ts: ms,
      value: pots.equity + pots.bondsNonFix + pots.fixmap,
    });
  }

  // --- FixMÁP-visszapótlás dátuma ---
  const fixmapRecoverTs = scn
    ? computeFixmapRecovery(ctx, car, scn, fromFixmap, nowMs)
    : null;

  return {
    id: scn?.id ?? "baseline",
    name: scn?.name ?? "Maradok a mostani autónál",
    isBaseline: !scn,
    points,
    horizonValueHuf: points[points.length - 1]?.value ?? 0,
    taxPaidHuf: taxPaid,
    fromFixmapHuf: fromFixmap,
    fixmapRecoverTs,
    netMonthlyDeltaHuf: netMonthlyDelta,
  };
}

/**
 * Mikorra épül vissza a FixMÁP a mai összértékére. Közelítés (v1): a
 * megbontott FixMÁP (finanszírozás + célhiány) után a szabad havi cashflow (alap
 * megtakarítás + felszabaduló havidíj − új lízingdíj) és a FixMÁP-kupon a
 * megadott hozamú új FixMÁP-ba megy, MIUTÁN a megmaradt célok teljesültek.
 */
function computeFixmapRecovery(
  ctx: EngineContext,
  car: CurrentCar,
  scn: Scenario,
  fromFixmapFunding: number,
  nowMs: number,
): number | null {
  const pots = startingPots(ctx.summary, ctx.assetInfo);
  const fixmap0 = pots.fixmap;
  if (fixmap0 <= 0) return null;

  // Megmaradt célok (nem kizártak) hiánya, dátum szerint sorrendben. A havi
  // megtakarítás tölti; amit a céldátumig nem fed, azt a FixMÁP-ból csípjük le.
  const activeGoals = ctx.goals
    .filter((g) => !scn.excludedGoalIds.includes(g.id))
    .map((g) => ({ g, p: ctx.goalProgress.get(g.id) }))
    .filter((x) => x.p && x.p.gapHuf > 0)
    .sort(
      (a, b) => parseDayMs(a.g.targetDate) - parseDayMs(b.g.targetDate),
    );

  let goalShortfallFromFixmap = 0;
  let savingBudget = 0; // futó megtakarítás-keret (nagyon egyszerű modell)
  let cursor = nowMs;
  const monthly = ctx.monthlySavingHuf;
  for (const { g, p } of activeGoals) {
    const dateMs = parseDayMs(g.targetDate);
    if (!Number.isFinite(dateMs) || dateMs <= nowMs) continue;
    savingBudget += monthly * monthsBetween(cursor, dateMs);
    cursor = dateMs;
    const need = p!.gapHuf;
    const covered = Math.min(need, savingBudget);
    savingBudget -= covered;
    const short = need - covered;
    if (short > 0) goalShortfallFromFixmap += short;
  }

  const totalWithdraw = fromFixmapFunding + goalShortfallFromFixmap;
  if (totalWithdraw <= 0) return null; // a FixMÁP-hoz nem nyúltunk

  // Visszapótlás: a szabad havi (alap + nettó havi-delta) + FixMÁP-kupon (≈ a
  // hozam / 12 az állományra), a megadott hozamon kamatozva.
  const buyMs = parseDayMs(scn.buyDate);
  const startMs = Number.isFinite(buyMs) ? Math.max(buyMs, nowMs) : nowMs;
  const rF = monthlyRate(scn.fixmapYieldPct);
  const netMonthly =
    monthly +
    (scn.financing === "lease" ? -scn.lease.monthlyHuf : 0) +
    (car.hasLease ? car.monthlyHuf : 0); // felszabaduló havidíj (közelítés)
  let value = Math.max(0, fixmap0 - totalWithdraw);
  for (let i = 1; i <= 600; i++) {
    value *= 1 + rF;
    value += Math.max(0, netMonthly);
    if (value >= fixmap0) return addMonths(startMs, i);
  }
  return null; // 50 éven belül nem éri el
}

export interface BigDecisionResult {
  baseline: ScenarioProjection;
  scenarios: ScenarioProjection[];
}

/** Minden forgatókönyv (+ baseline) projekciója, a baseline-hoz mérve. */
export function computeBigDecision(
  ctx: EngineContext,
  state: BigDecisionState,
): BigDecisionResult {
  const baseline = projectOne(ctx, state.car, null) as ScenarioProjection;
  baseline.vsBaselineHuf = 0;
  const baseHorizon = baseline.horizonValueHuf;
  const scenarios = state.scenarios.map((scn) => {
    const p = projectOne(ctx, state.car, scn) as ScenarioProjection;
    p.vsBaselineHuf = p.horizonValueHuf - baseHorizon;
    return p;
  });
  return { baseline, scenarios };
}

/** A jelenlegi lízing hátralévő tartozása MOST (hátralévő havidíjak + végső). */
export function remainingDebtHuf(car: CurrentCar, now: Date = new Date()): number {
  if (!car.hasLease) return 0;
  const endMs = parseDayMs(car.leaseEndDate);
  if (!Number.isFinite(endMs)) return car.balloonHuf;
  const months = monthsBetween(now.getTime(), endMs);
  return months * car.monthlyHuf + car.balloonHuf;
}
