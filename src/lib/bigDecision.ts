// ---------------------------------------------------------------------------
// „Nagy döntés" — autócsere (Leaf lízing lezárása + Model 3 kp-s vétel) hatása
// a LIKVID portfólióra a lízing lejáratáig. A user validált Excel-modelljének
// (model3_valtas_modell) replikája, DE a hardkódolt okt. 31-i cél helyett az app
// VALÓS céljaival (kizárhatóan forgatókönyvenként).
//
// Részek:
//   1) Leaf eladás — végtörlesztés utáni equity.
//   2) Célfedezés — a megmaradó célokat a Leaf-equity + havi megtakarítás +
//      felszabaduló lízingdíj + kupon fedezi (dátum szerinti vízesés); a HIÁNYT a
//      céldátumon FixMÁP-visszaváltás pótolja (1% díj).
//   3) Váltás költsége a lejáratig: kieső 7%-os kupon + egyszeri díjak +
//      amortizáció-különbözet − a felszabaduló törlesztő 5%-os hozama.
//   4) FixMÁP-visszaépítés — havi tábla: törzs 7% + új befizetések 5%, negyedéves
//      kupon; VÁLTÁS (havi = megtakarítás + felszabaduló lízingdíj) vs ALAP (csak
//      megtakarítás; a lejárati hónapban a maradványérték a portfólióból). A
//      KÜLÖNBSÉG (alap − váltás) hónapról hónapra + mikorra 40M.
// ---------------------------------------------------------------------------

import type { PortfolioSummary } from "./portfolio";

const GOV_BOND = "gov_bond"; // FixMÁP
const TBILL = "tbill"; // DKJ

// ---------------------------------------------------------------------------
// Bemenetek (mind szerkeszthető)
// ---------------------------------------------------------------------------

export interface CarSwapInputs {
  m3Price: number; // Model 3 vételár (kp)
  leafSalePrice: number; // Leaf eladási ár (bruttó)
  leafDebt: number; // Leaf bruttó lízingtartozás a kiinduló napon
  monthlyLease: number; // Havi bruttó törlesztő
  paymentsBeforeSale: number; // Eladásig lement havi törlesztők száma
  closingFee: number; // Euroleasing lezárási díj
  fixmapRate: number; // FixMÁP éves kamat (törzs), negyedéves
  fixmapRedemptionFee: number; // FixMÁP visszaváltási díj
  dkjForCar: number; // DKJ autóra fordítva
  fixmapForCar: number; // Mostani FixMÁP-visszaváltás autóra
  monthlySaving: number; // Havi megtakarítás (törlesztőn felül)
  fixmapTrunk0: number; // FixMÁP kiinduló állomány (névérték)
  m3Value2029: number; // Model 3 becsült értéke a lejáratkor
  leafValue2029: number; // Leaf becsült értéke, ha megtartanád
  leafResidual2029: number; // Leaf maradványérték (bruttó) a lejáratkor
  newBondRate: number; // Új befizetések éves kamata
  saleMonth: string; // YYYY-MM  Leaf eladása + kiinduló visszaváltás
  rebuildStartMonth: string; // YYYY-MM  a FixMÁP-visszaépítés első hónapja
  leaseEndMonth: string; // YYYY-MM  a lízing lejárata (maradványérték itt)
  /** Ezek a meglévő célok NEM számítanak ebben a forgatókönyvben. */
  excludedGoalIds: string[];
}

export const DEFAULT_INPUTS: CarSwapInputs = {
  m3Price: 8_500_000,
  leafSalePrice: 6_500_000,
  leafDebt: 4_608_432,
  monthlyLease: 95_288,
  paymentsBeforeSale: 2,
  closingFee: 40_000,
  fixmapRate: 0.07,
  fixmapRedemptionFee: 0.01,
  dkjForCar: 3_500_000,
  fixmapForCar: 5_000_000,
  monthlySaving: 150_000,
  fixmapTrunk0: 40_000_000,
  m3Value2029: 6_100_000,
  leafValue2029: 4_500_000,
  leafResidual2029: 1_559_250,
  newBondRate: 0.05,
  saleMonth: "2026-09",
  rebuildStartMonth: "2026-11",
  leaseEndMonth: "2029-03",
  excludedGoalIds: [],
};

const STORE_KEY = "pf-cardecision";

export function loadCarSwap(): CarSwapInputs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_INPUTS };
    const p = JSON.parse(raw) as Partial<CarSwapInputs>;
    if (typeof p.m3Price !== "number") return { ...DEFAULT_INPUTS };
    return {
      ...DEFAULT_INPUTS,
      ...p,
      excludedGoalIds: Array.isArray(p.excludedGoalIds) ? p.excludedGoalIds : [],
    };
  } catch {
    return { ...DEFAULT_INPUTS };
  }
}

export function saveCarSwap(s: CarSwapInputs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Előtölthető a portfólióból: FixMÁP névérték, DKJ névérték. */
export function prefillFromPortfolio(summary: PortfolioSummary): {
  fixmapTrunk0: number;
  dkjFace: number;
} {
  let fixmap = 0;
  let dkj = 0;
  for (const acc of summary.accounts) {
    for (const h of acc.holdings) {
      const t = h.instrument?.type;
      if (t === GOV_BOND) fixmap += h.quantity ?? 0;
      else if (t === TBILL) dkj += h.quantity ?? 0;
    }
  }
  return { fixmapTrunk0: Math.round(fixmap), dkjFace: Math.round(dkj) };
}

// ---------------------------------------------------------------------------
// Célok (az appból)
// ---------------------------------------------------------------------------

export interface GoalInput {
  id: string;
  name: string;
  targetHuf: number;
  /** Hiány ma (targetHuf − a hozzárendelt eszközök vetített értéke). */
  gapHuf: number;
  /** A célhoz rendelt DKJ jelenlegi értéke — ha ezt autóra fordítjuk, a cél
   * fedezete csökken, a hiány nő. */
  dkjBackingHuf: number;
  /** Céldátum (ms). */
  ts: number;
}

// ---------------------------------------------------------------------------
// Számítás
// ---------------------------------------------------------------------------

export interface GoalCoverageRow {
  id: string;
  name: string;
  targetHuf: number;
  ts: number;
  gapHuf: number;
  /** A célra fordított megtakarítás/kupon a céldátumig. */
  savingsApplied: number;
  /** A céldátumon a FixMÁP-ból pótolt hiány. */
  shortfall: number;
}

export interface SwitchCost {
  foregoneCoupon: number;
  oneOffFees: number;
  depreciationDiff: number;
  reinvestedReturn: number;
  netExtraCost: number;
  monthlyCost: number;
  portfolioDiff: number;
}

export interface RebuildRow {
  month: string;
  ts: number;
  switchTotal: number;
  baseTotal: number;
  diff: number;
  reached40: boolean;
}

export interface CarSwapResult {
  leafDebtAtSale: number;
  settlement: number;
  leafEquity: number;
  fixmapAfterCarRedemption: number;
  goalCoverage: GoalCoverageRow[];
  goalShortfallTotal: number;
  fixmapAfterAll: number;
  cost: SwitchCost;
  rebuild: RebuildRow[];
  reach40Ts: number | null;
  finalDiffHuf: number;
}

function parseYm(s: string): { y: number; m: number } {
  const m = s.match(/^(\d{4})-(\d{1,2})$/);
  return m ? { y: +m[1], m: +m[2] } : { y: 2026, m: 1 };
}
function ymTs(y: number, m: number): number {
  return new Date(y, m - 1, 1).getTime();
}
function monthsBetweenYm(a: string, b: string): number {
  const x = parseYm(a);
  const y = parseYm(b);
  return Math.max(0, (y.y - x.y) * 12 + (y.m - x.m));
}
const isCouponMonth = (m: number) => m === 1 || m === 4 || m === 7 || m === 10;

export function computeCarSwap(
  inp: CarSwapInputs,
  goals: GoalInput[],
  now: Date = new Date(),
): CarSwapResult {
  // --- 1) Leaf eladás ---
  const leafDebtAtSale = inp.leafDebt - inp.paymentsBeforeSale * inp.monthlyLease;
  const settlement = leafDebtAtSale + inp.closingFee;
  const leafEquity = inp.leafSalePrice - settlement;
  const fixmapAfterCarRedemption = inp.fixmapTrunk0 - inp.fixmapForCar;

  // --- 2) Célfedezés (valós célok, kizárva a jelöltek) ---
  const saleTs = ymTs(parseYm(inp.saleMonth).y, parseYm(inp.saleMonth).m);
  const active = goals
    .filter((g) => !inp.excludedGoalIds.includes(g.id))
    .filter((g) => g.ts > now.getTime())
    .sort((a, b) => a.ts - b.ts);

  // Az autóra fordított DKJ elveszi a hozzá rendelt cél(ok) fedezetét → a hiány
  // annyival nő. A dkjForCar-t a legközelebbi DKJ-fedezetű célra osztjuk elsőként
  // (ahogy a te modelledben a DKJ az okt./Babaváró célra gyűlt).
  let dkjLeft = inp.dkjForCar;
  const effGap = new Map<string, number>();
  for (const g of active) {
    const cut = Math.min(dkjLeft, g.dkjBackingHuf || 0);
    dkjLeft -= cut;
    effGap.set(g.id, Math.max(0, g.gapHuf) + cut);
  }

  const coverage = new Map<string, { applied: number; shortfall: number }>();
  let trunk = fixmapAfterCarRedemption;
  let budget = 0;
  let leafAdded = false;
  // Havi vízesés a mostani hónaptól az utolsó céldátumig.
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  const lastTs = active.length ? active[active.length - 1].ts : 0;
  for (let guard = 0; guard < 600 && active.length; guard++) {
    const ts = ymTs(y, m);
    if (ts >= saleTs && !leafAdded) {
      budget += leafEquity;
      leafAdded = true;
    }
    budget += inp.monthlySaving;
    if (ts >= saleTs) budget += inp.monthlyLease; // felszabaduló lízingdíj
    if (isCouponMonth(m)) budget += (trunk * inp.fixmapRate) / 4; // kupon
    // Az ebben a hónapban esedékes célok kifizetése (dátum szerint).
    for (const g of active) {
      const gy = new Date(g.ts).getFullYear();
      const gm = new Date(g.ts).getMonth() + 1;
      if (gy === y && gm === m && !coverage.has(g.id)) {
        const gap = effGap.get(g.id) ?? 0;
        const applied = Math.min(gap, Math.max(0, budget));
        budget -= applied;
        const rawShort = Math.max(0, gap - applied);
        const cut = Math.min(trunk, rawShort); // FixMÁP-ból pótolt hiány
        trunk -= cut;
        coverage.set(g.id, { applied, shortfall: cut });
      }
    }
    if (ts >= lastTs) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  const goalCoverage: GoalCoverageRow[] = active
    .filter((g) => (effGap.get(g.id) ?? 0) > 0)
    .map((g) => {
      const c = coverage.get(g.id) ?? { applied: 0, shortfall: 0 };
      return {
        id: g.id,
        name: g.name,
        targetHuf: g.targetHuf,
        ts: g.ts,
        gapHuf: effGap.get(g.id) ?? 0, // a váltásnál érvényes hiány (DKJ-vesztéssel)
        savingsApplied: c.applied,
        shortfall: c.shortfall,
      };
    });
  const goalShortfallTotal = goalCoverage.reduce((s, g) => s + g.shortfall, 0);
  const fixmapAfterAll = trunk;

  // --- 3) Váltás költsége a lejáratig ---
  const monthsSaleToEnd = monthsBetweenYm(inp.saleMonth, inp.leaseEndMonth);
  const foregoneGoal = goalCoverage.reduce((s, g) => {
    const gm = `${new Date(g.ts).getFullYear()}-${new Date(g.ts).getMonth() + 1}`;
    const months = monthsBetweenYm(gm, inp.leaseEndMonth);
    return s + (g.shortfall * inp.fixmapRate * months) / 12;
  }, 0);
  const foregoneCoupon =
    (inp.fixmapForCar * inp.fixmapRate * monthsSaleToEnd) / 12 + foregoneGoal;
  const oneOffFees =
    (inp.fixmapForCar + goalShortfallTotal) * inp.fixmapRedemptionFee +
    inp.closingFee;
  const depreciationDiff =
    inp.m3Price - inp.m3Value2029 - (inp.leafSalePrice - inp.leafValue2029);
  const reinvestedReturn =
    (inp.monthlyLease *
      monthsSaleToEnd *
      inp.newBondRate *
      (monthsSaleToEnd / 2)) /
    12;
  const netExtraCost =
    foregoneCoupon + oneOffFees + depreciationDiff - reinvestedReturn;
  const cost: SwitchCost = {
    foregoneCoupon,
    oneOffFees,
    depreciationDiff,
    reinvestedReturn,
    netExtraCost,
    monthlyCost: monthsSaleToEnd > 0 ? netExtraCost / monthsSaleToEnd : 0,
    portfolioDiff: netExtraCost + (inp.m3Value2029 - inp.leafValue2029),
  };

  // --- 4) FixMÁP-visszaépítés + KÜLÖNBSÉG ---
  const start = parseYm(inp.rebuildStartMonth);
  const end = parseYm(inp.leaseEndMonth);
  const rebuild: RebuildRow[] = [];
  let reach40Ts: number | null = null;
  const switchTrunk = fixmapAfterAll;
  const baseTrunk = inp.fixmapTrunk0;
  let switchNew = 0;
  let baseNew = 0;
  const qOld = inp.fixmapRate / 4;
  const qNew = inp.newBondRate / 4;
  let ry = start.y;
  let rm = start.m;
  for (let guard = 0; guard < 600; guard++) {
    const ts = ymTs(ry, rm);
    const coupon = isCouponMonth(rm);
    // VÁLTÁS: havi = megtakarítás + felszabaduló lízingdíj
    const sOpen = switchNew;
    const sCoupon = coupon ? switchTrunk * qOld + sOpen * qNew : 0;
    switchNew = sOpen + (inp.monthlySaving + inp.monthlyLease) + sCoupon;
    const switchTotal = switchTrunk + switchNew;
    // ALAP: csak megtakarítás; a lejárati hónapban a maradványérték kifizetése
    const bOpen = baseNew;
    const bCoupon = coupon ? baseTrunk * qOld + bOpen * qNew : 0;
    const residual = ry === end.y && rm === end.m ? -inp.leafResidual2029 : 0;
    baseNew = bOpen + inp.monthlySaving + bCoupon + residual;
    const baseTotal = baseTrunk + baseNew;

    const reached40 = switchTotal >= inp.fixmapTrunk0;
    if (reached40 && reach40Ts == null) reach40Ts = ts;
    rebuild.push({
      month: `${ry}-${String(rm).padStart(2, "0")}`,
      ts,
      switchTotal,
      baseTotal,
      diff: baseTotal - switchTotal,
      reached40,
    });
    if (ry === end.y && rm === end.m) break;
    rm++;
    if (rm > 12) {
      rm = 1;
      ry++;
    }
  }

  return {
    leafDebtAtSale,
    settlement,
    leafEquity,
    fixmapAfterCarRedemption,
    goalCoverage,
    goalShortfallTotal,
    fixmapAfterAll,
    cost,
    rebuild,
    reach40Ts,
    finalDiffHuf: rebuild[rebuild.length - 1]?.diff ?? 0,
  };
}
