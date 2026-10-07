import type { Instrument } from "../../src/lib/model";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import { BOND_TYPES } from "../../src/lib/bonds";
import { addDaysIso, toLocalDay } from "../../src/lib/day";
import {
  auctionsFor,
  buyableOffers,
  familyOfType,
  latestDkjAuction,
  maturityOf,
  periodFor,
  type BondRatesFile,
  type InterestPeriod,
  type RetailOffer,
} from "../../src/lib/bondRates";
import { esc, mft, shortName } from "./reports";
import type { Context } from "./data";
import type { State } from "./state";

export const MATURITY_NOTICE_DAYS = [30, 7] as const;
export const BOND_RATES_STALE_DAYS = 7;

const dayMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / 86_400_000);

const pctText = (x: number) => `${x.toFixed(2).replace(".", ",")}%`;
const MONTHS3 = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
const shortDay = (d: string) => `${MONTHS3[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}.`;
const fullDay = (d: string) => `${d.slice(0, 4)}. ${shortDay(d)}`;

function offerRate(o: RetailOffer): string {
  if (o.rateMin != null && o.rateMax != null && o.rateMin !== o.rateMax)
    return `${pctText(o.rateMin)}–${pctText(o.rateMax)}`;
  return o.rateMin != null ? pctText(o.rateMin) : esc(o.rateText);
}

export function offerLines(file: BondRatesFile, today: string): string[] {
  const lines = buyableOffers(file, today).map(
    (o) =>
      `• ${esc(o.type)} ${esc(o.series)}: ${offerRate(o)}` +
      (o.ehm != null ? ` (EHM ${pctText(o.ehm)})` : "") +
      (o.currency !== "HUF" ? `, ${esc(o.currency)}` : "") +
      (o.maturity ? `, lejár ${fullDay(o.maturity)}` : ""),
  );
  const dkj = latestDkjAuction(file, today);
  if (dkj)
    lines.push(
      `• DKJ ${esc(dkj.series)}: ${pctText(dkj.avgYield)} (aukció ${shortDay(dkj.auctionDate)}` +
        (dkj.maturity ? `, lejár ${fullDay(dkj.maturity)}` : "") +
        ")",
    );
  return lines;
}

function ownRateLine(inst: Instrument, file: BondRatesFile): string | undefined {
  if (inst.type === "tbill") {
    const a = auctionsFor(inst, file)[0];
    return a
      ? `A sorozat legutóbbi aukciós átlaghozama: ${pctText(a.avgYield)} (${shortDay(a.auctionDate)})`
      : undefined;
  }
  const r = inst.bond?.couponRate;
  return r != null ? `A lejáró papírod kamata: ${pctText(r * 100)}` : undefined;
}

const whenText = (days: number) => (days === 0 ? "ma" : days === 1 ? "holnap" : `${days} nap múlva`);

export function maturityNoticeText(
  inst: Instrument,
  valueHuf: number,
  maturity: string,
  days: number,
  file: BondRatesFile,
  today: string,
): string {
  const offers = offerLines(file, today);
  return [
    `⏳ <b>Lejár ${whenText(days)}: ${shortName(inst.name)}</b> (${fullDay(maturity)}, ${mft(valueHuf)})`,
    ownRateLine(inst, file),
    offers.length ? `Most kapható:\n${offers.join("\n")}` : "Most nincs adat a kapható állampapírokról.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function periodNoticeText(inst: Instrument, prevRate: number, p: InterestPeriod): string {
  const change =
    Math.abs(prevRate - p.rate) < 1e-9
      ? `a kamat változatlan: ${pctText(p.rate)}`
      : `${pctText(prevRate)} → <b>${pctText(p.rate)}</b>`;
  const pay = p.paymentDate ?? p.periodEnd;
  return `🔄 <b>${shortName(inst.name)}: új kamatperiódus</b> (kezdete: ${fullDay(p.periodStart)})\n${change}, következő kamatfizetés: ${fullDay(pay)}`;
}

export function bondNoticeMessages(ctx: Context, st: State): string[] {
  const file = ctx.bondRates;
  const now = ctx.at;
  const today = toLocalDay(now);
  const held = consolidatedHoldings(ctx.summary).filter(
    (h) => h.quantity > 1e-9 && h.instrument && BOND_TYPES.has(h.instrument.type),
  );
  const out: string[] = [];

  if (file && held.length) {
    const age = file.updatedAt ? (now.getTime() - Date.parse(file.updatedAt)) / 86_400_000 : Infinity;
    const last = st.warned.bondRates;
    if (age > BOND_RATES_STALE_DAYS) {
      if (!last || now.getTime() - Date.parse(last) > 7 * 86_400_000) {
        st.warned.bondRates = now.toISOString();
        out.push(
          `🏦 Az állampapír-kamatfájl ${BOND_RATES_STALE_DAYS}+ napja nem frissült – lehet, hogy az ÁKK-lekérés hibára futott, vagy megváltozott az ÁKK oldala.`,
        );
      }
    } else delete st.warned.bondRates;
  }
  if (!file) return out;

  const notices = (st.bondNotices ??= {});
  const sent = (notices.maturity ??= {});
  const periods = (notices.periods ??= {});
  const periodLines: string[] = [];
  for (const h of held) {
    const inst = h.instrument!;
    const maturity = maturityOf(inst);
    if (maturity) {
      const days = daysBetween(today, maturity);
      const due = MATURITY_NOTICE_DAYS.filter((d) => days >= 0 && days <= d);
      const stage = due.length ? Math.min(...due) : undefined;
      if (stage != null && !sent[`${h.instrumentKey}|${maturity}|${stage}`]) {
        for (const d of due) sent[`${h.instrumentKey}|${maturity}|${d}`] = maturity;
        out.push(maturityNoticeText(inst, h.marketValueHuf, maturity, days, file, today));
      }
    }
    const p = periodFor(inst, file);
    if (p && familyOfType(p.type) !== "FixMÁP" && p.periodStart <= today) {
      const prev = periods[h.instrumentKey];
      if (prev && prev.start < p.periodStart) periodLines.push(periodNoticeText(inst, prev.rate, p));
      if (!prev || prev.start < p.periodStart) periods[h.instrumentKey] = { start: p.periodStart, rate: p.rate };
    }
  }
  if (periodLines.length) out.push(periodLines.join("\n\n"));

  const cutoff = addDaysIso(today, -30);
  for (const [id, maturity] of Object.entries(sent)) if (maturity < cutoff) delete sent[id];
  const heldKeys = new Set(held.map((h) => h.instrumentKey));
  for (const key of Object.keys(periods)) if (!heldKeys.has(key)) delete periods[key];
  return out;
}
