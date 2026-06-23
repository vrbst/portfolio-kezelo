// ---------------------------------------------------------------------------
// TBSZ (Tartós Befektetési Számla) tax timeline — Szja tv. 67/B § + Szocho tv.
//
// A TBSZ opened in the "gyűjtőév" Y:
//   • during Y you may still deposit (the collection year, ends 31 Dec Y);
//   • the 3-year lock runs to 31 Dec Y+3, the full 5-year lock to 31 Dec Y+5.
//
// Tax on the GAIN if the account is broken / withdrawn early. Since 2025 a
// social-contribution tax (szocho) is layered on top of the personal income tax
// (szja) for contracts concluded AFTER 2024-12-31 (collection year ≥ 2025).
// Accounts opened/re-fixed by 2024-12-31 stay szocho-free.
//
//                              régi (≤2024)         új (2025-től)
//   gyűjtőév / 3 év előtt:     15% szja             15% szja + 13% szocho = 28%
//   3–5 év között:             10% szja             10% szja +  8% szocho = 18%
//   5 év után:                 0% (adómentes)       0% (adómentes)
//
// At the 3-year turn a partial withdrawal is allowed while re-locking the rest.
// Sources: NAV (A tartós befektetésből származó jövedelem szochokötelezettsége).
// ---------------------------------------------------------------------------

export type TbszPhase = "collecting" | "locked" | "reduced" | "matured";

export interface TbszMilestone {
  key: "deposit" | "three" | "five";
  /** ISO date (end of the calendar year). */
  date: string;
  label: string;
  hint: string;
  done: boolean;
}

export interface TbszStatus {
  year: number;
  phase: TbszPhase;
  phaseLabel: string;
  /** Personal income tax (szja) on the gain if broken now (0–0.15). */
  szjaRate: number;
  /** Social-contribution tax (szocho) on the gain if broken now (0–0.13). */
  szochoRate: number;
  /** Total tax burden if broken now = szja + szocho (0–0.28). */
  taxRate: number;
  taxLabel: string;
  /** Szocho applies to contracts opened from 2025 (collection year ≥ 2025). */
  hasSzocho: boolean;
  milestones: TbszMilestone[];
  /** Next milestone not yet reached, if any. */
  next?: TbszMilestone;
  daysToNext?: number;
  /** 0–1 progress from the opening year to the 5-year maturity. */
  progress: number;
}

/** A "mi lenne, ha most eladnám" forgatókönyv egy adózási szakaszra. */
export interface TbszExitScenario {
  key: "early" | "three" | "five";
  label: string;
  /** Teljes adókulcs a hozamra ebben a forgatókönyvben (0–0.28). */
  taxRate: number;
  /** Levonandó adó (HUF) a jelenlegi hozamra vetítve. */
  taxHuf: number;
  /** Nettó, kézhez kapott érték (HUF) = bruttó − adó. */
  netHuf: number;
  /** Megtakarított adó a mostani szakaszhoz képest (csak jövőbeli szakaszra > 0). */
  savedVsNowHuf: number;
  /** A mostani szakaszhoz képest: már elmúlt / épp ez van / még jön. */
  state: "past" | "current" | "future";
}

/**
 * Net (after-tax) exit value of a TBSZ across ALL three tax tiers (before 3y,
 * 3–5y, after 5y), each on the CURRENT gain. The tier you're in is `current`
 * ("ha most eladnád"), earlier tiers are `past` (greyed out), later ones are
 * `future` with the tax you'd save by waiting. Only a positive gain is taxed.
 */
export function tbszExitScenarios(
  status: TbszStatus,
  grossValueHuf: number,
  gainHuf: number,
): TbszExitScenario[] {
  const taxableGain = Math.max(0, gainHuf);
  const rateByKey = {
    early: 0.15 + (status.hasSzocho ? 0.13 : 0), // gyűjtő / 3 év előtt
    three: 0.1 + (status.hasSzocho ? 0.08 : 0), // 3–5 év között
    five: 0, // 5 év után — adómentes
  } as const;
  const labelByKey = {
    early: "3 éves lekötés előtt",
    three: "3–5 év között (kedvezményes)",
    five: "5 év után — adómentes",
  } as const;

  // Which tier the account is in right now decides "current".
  const currentKey =
    status.phase === "matured"
      ? "five"
      : status.phase === "reduced"
        ? "three"
        : "early";

  const order = ["early", "three", "five"] as const;
  const curIdx = order.indexOf(currentKey);
  const currentTax = taxableGain * rateByKey[currentKey];

  return order.map((key, i) => {
    const taxHuf = taxableGain * rateByKey[key];
    const state: TbszExitScenario["state"] =
      i < curIdx ? "past" : i === curIdx ? "current" : "future";
    return {
      key,
      label: labelByKey[key],
      taxRate: rateByKey[key],
      taxHuf,
      netHuf: grossValueHuf - taxHuf,
      savedVsNowHuf: state === "future" ? currentTax - taxHuf : 0,
      state,
    };
  });
}

/** End of the given calendar year (31 Dec, last moment). */
function yearEnd(year: number): Date {
  return new Date(year, 11, 31, 23, 59, 59);
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function tbszStatus(year: number, now: Date = new Date()): TbszStatus {
  // Szocho on the szja-taxable TBSZ gain applies only to contracts concluded
  // after 2024-12-31 (collection year 2025+). Older accounts stay szocho-free.
  const hasSzocho = year >= 2025;
  const earlySzocho = hasSzocho ? 0.13 : 0; // break before the 3-year milestone
  const reducedSzocho = hasSzocho ? 0.08 : 0; // 3–5 year window

  const depositEnd = yearEnd(year);
  const threeEnd = yearEnd(year + 3);
  const fiveEnd = yearEnd(year + 5);

  // Milestone hint reflects the rate that applies *after* the 3-year turn.
  const threeHint = hasSzocho
    ? "Innentől a hozam adója 18%-ra csökken (10% szja + 8% szocho). Részkivét lehetséges."
    : "Innentől a hozam adója 10%-ra csökken (szja, szocho nélkül). Részkivét lehetséges.";

  const milestones: TbszMilestone[] = [
    {
      key: "deposit",
      date: depositEnd.toISOString(),
      label: "Gyűjtőév vége",
      hint: "Utolsó nap, amikor befizethetsz erre a TBSZ-re.",
      done: now > depositEnd,
    },
    {
      key: "three",
      date: threeEnd.toISOString(),
      label: "3 éves lekötés",
      hint: threeHint,
      done: now > threeEnd,
    },
    {
      key: "five",
      date: fiveEnd.toISOString(),
      label: "5 éves lejárat",
      hint: "A teljes hozam adómentes — sem szja, sem szocho.",
      done: now > fiveEnd,
    },
  ];

  let phase: TbszPhase;
  let phaseLabel: string;
  let szjaRate: number;
  let szochoRate: number;
  if (now <= depositEnd) {
    phase = "collecting";
    phaseLabel = "Gyűjtési időszak";
    szjaRate = 0.15;
    szochoRate = earlySzocho;
  } else if (now <= threeEnd) {
    phase = "locked";
    phaseLabel = "Lekötés (3 év előtt)";
    szjaRate = 0.15;
    szochoRate = earlySzocho;
  } else if (now <= fiveEnd) {
    phase = "reduced";
    phaseLabel = "Kedvezményes szakasz";
    szjaRate = 0.1;
    szochoRate = reducedSzocho;
  } else {
    phase = "matured";
    phaseLabel = "Lejárt — adómentes";
    szjaRate = 0;
    szochoRate = 0;
  }

  const taxRate = szjaRate + szochoRate;

  let taxLabel: string;
  if (phase === "matured") {
    taxLabel = "A hozam teljesen adómentes (0% szja, 0% szocho).";
  } else {
    const breakdown = hasSzocho
      ? `${pct(taxRate)} (${pct(szjaRate)} szja + ${pct(szochoRate)} szocho)`
      : `${pct(szjaRate)} szja (szocho nélkül)`;
    taxLabel =
      phase === "collecting"
        ? `Megszakításkor ${breakdown} a hozamra. A gyűjtőévben még befizethetsz.`
        : phase === "reduced"
          ? `Kivétkor ${breakdown} a hozamra.`
          : `Megszakításkor ${breakdown} a hozamra.`;
  }

  const next = milestones.find((m) => !m.done);
  const daysToNext = next ? daysBetween(now, new Date(next.date)) : undefined;

  const start = new Date(year, 0, 1).getTime();
  const span = fiveEnd.getTime() - start;
  const progress = Math.max(0, Math.min(1, (now.getTime() - start) / span));

  return {
    year,
    phase,
    phaseLabel,
    szjaRate,
    szochoRate,
    taxRate,
    taxLabel,
    hasSzocho,
    milestones,
    next,
    daysToNext,
    progress,
  };
}
