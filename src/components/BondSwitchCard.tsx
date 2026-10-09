import { useMemo, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import InfoTip from "./InfoTip";
import { Card, Badge } from "./ui";
import { usePortfolio, useSavingsGoals, useToday } from "../lib/store";
import { formatDate, formatDateTime, formatMoney } from "../lib/format";
import { bondAdvice, bondMarket, type BondAdvice, type OfferView } from "../lib/bondSwitch";
import type { HoldingView } from "../lib/portfolio";

const pct = (x: number) => `${x.toFixed(2).replace(".", ",")}%`;
const pp = (x: number) => `${x.toFixed(2).replace(".", ",")} százalékpont`;

const offerName = (o: OfferView) => `${o.offer.type} ${o.offer.series}`;

function Verdict({ a }: { a: BondAdvice }) {
  const v = a.verdict;
  if (v.kind === "switch")
    return (
      <div className="text-sm">
        <div>
          <Badge tone="positive">Érdemes lehet cserélni</Badge>{" "}
          <span className="font-medium">→ {offerName(v.to)}</span> ({pct(v.to.yieldPct)}
          {v.to.floating ? ", változó" : ""}, lejár {formatDate(v.to.offer.maturity)})
        </div>
        <div className="mt-1 text-xs text-[var(--color-muted)]">
          +{pp(v.gapPct)}; a visszaváltási díj (<span className="amt">{formatMoney(v.saleCostHuf)}</span>){" "}
          {Math.max(1, Math.ceil(v.breakEvenMonths))} hónap alatt térül meg; {v.horizonYears.toFixed(1).replace(".", ",")} év
          alatt kb. <span className="amt">{formatMoney(v.gainHuf, "HUF", { sign: true })}</span> többlet.
        </div>
      </div>
    );
  if (v.kind === "maturing")
    return (
      <div className="text-sm">
        <Badge tone="warning">Lejár {v.days === 0 ? "ma" : `${v.days} nap múlva`}</Badge>{" "}
        {!v.goal ? (
          <span className="text-[var(--color-muted)]">a lenti listából választhatsz újrabefektetést</span>
        ) : (
          <span className="text-[var(--color-muted)]">
            a(z) <span className="priv">{v.goal.name}</span> célhoz tartozik ({formatDate(v.goal.targetDate)})
          </span>
        )}
        {v.goal && (
          <div className="mt-1 text-xs text-[var(--color-muted)]">
            {v.plan?.kind === "payout" ? (
              "A kifizetés a cél napján megérkezik — nem kell újra befektetni."
            ) : v.plan?.kind === "late" ? (
              <span className="text-[var(--color-warning)]">
                A kifizetés {v.plan.days} nappal a cél dátuma után érkezik — a célra időben nem lesz meg belőle.
              </span>
            ) : v.reinvest ? (
              <>
                A cél dátumáig lejáró legjobb kapható papír:{" "}
                <span className="font-medium text-[var(--color-text)]">{v.reinvest.name}</span> (
                {pct(v.reinvest.yieldPct)}
                {v.reinvest.floating ? ", változó" : ""}
                {v.reinvest.auctionDate ? `, aukció ${formatDate(v.reinvest.auctionDate)}` : ""}, lejár{" "}
                {formatDate(v.reinvest.maturity)}).
              </>
            ) : (
              "Nincs olyan kapható papír, ami a cél dátumáig lejár — a kifizetést tartsd készpénzben a célig."
            )}
          </div>
        )}
      </div>
    );
  const text = {
    "no-better": "Nincs nála érdemben magasabb hozamú kapható papír — tartsd meg.",
    fee: "Van magasabb kamatú papír, de a visszaváltási díj nem térülne meg a lejáratig.",
    "no-rate": "A kamata nem ismert, így nem összevethető — add meg a sorozat adatait.",
    tbill: "Diszkont kincstárjegy: általában a lejáratig érdemes tartani.",
  }[v.reason];
  return <div className="text-sm text-[var(--color-muted)]">{text}</div>;
}

export default function BondSwitchCard({ holdings }: { holdings: HoldingView[] }) {
  const file = usePortfolio((s) => s.bondRates);
  const today = useToday();
  const goals = useSavingsGoals();
  const advice = useMemo(() => bondAdvice(holdings, file, today, goals), [holdings, file, today, goals]);
  const market = useMemo(() => bondMarket(file, today), [file, today]);
  const [dkjSeries, setDkjSeries] = useState<string>();
  if (!market || (!advice.length && !market.offers.length && !market.dkj.length)) return null;
  const dkj = market.dkj.find((d) => d.series === dkjSeries) ?? market.dkj.find((d) => d.fresh) ?? market.dkj[0];

  return (
    <Card className="mt-6 p-5">
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Állampapír-ajánlatok</h2>
        <InfoTip>
          A tartott papírok kamatát összeveti a most kapható lakossági állampapírokkal (ÁKK-adat).
          Csere akkor jön szóba, ha az új papír legalább 0,25 százalékponttal többet hoz, és a lejárat
          előtti visszaváltási díj a mostani papír lejáratáig megtérül. A változó kamatú papíroknál
          (PMÁP, BMÁP) csak a mostani kamatperiódus kamata biztos. Az összevetés egyszerű kamattal számol,
          tájékoztató jellegű, nem befektetési tanács.
        </InfoTip>
      </div>

      {advice.length > 0 && (
        <ul className="mt-4 space-y-3">
          {advice.map((a) => (
            <li
              key={a.instrumentKey}
              className="rounded-lg bg-[var(--color-surface-2)]/50 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{a.instrument.name}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {a.ratePct != null ? `${pct(a.ratePct)}${a.floating ? " (változó)" : ""}` : "kamat: ?"}
                  {a.maturity ? ` · lejár ${formatDate(a.maturity)}` : ""}
                </span>
              </div>
              <div className="mt-1">
                <Verdict a={a} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {(market.offers.length > 0 || market.dkj.length > 0) && (
        <div className="mt-5" data-privacy="public">
          <h3 className="mb-2 text-sm font-semibold">Most kapható</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--color-muted)]">
                <tr>
                  <th className="py-1 pr-3 font-medium">Papír</th>
                  <th className="py-1 pr-3 text-right font-medium">Hozam</th>
                  <th className="py-1 text-right font-medium">Lejárat</th>
                </tr>
              </thead>
              <tbody>
                {market.offers.map((o) => (
                  <tr key={`${o.offer.type}|${o.offer.series}`} className="border-t border-[var(--color-border)]/50">
                    <td className="py-1.5 pr-3">
                      {offerName(o)}
                      {o.floating && <span className="ml-1 text-xs text-[var(--color-muted)]">változó</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {pct(o.yieldPct)}
                      {o.offer.ehm != null && <span className="ml-1 text-xs text-[var(--color-muted)]">EHM</span>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatDate(o.offer.maturity)}</td>
                  </tr>
                ))}
                {dkj && (
                  <tr className="border-t border-[var(--color-border)]/50">
                    <td className="py-1.5 pr-3">
                      <select
                        aria-label="DKJ-sorozat"
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-sm"
                        value={dkj.series}
                        onChange={(e) => setDkjSeries(e.target.value)}
                      >
                        {market.dkj.map((d) => (
                          <option key={d.series} value={d.series}>
                            DKJ {d.series}
                            {d.fresh ? "" : " (régi aukció)"}
                          </option>
                        ))}
                      </select>
                      <span className="ml-1 text-xs text-[var(--color-muted)]">aukció {formatDate(dkj.auctionDate)}</span>
                      {!dkj.fresh && (
                        <span className="ml-1 text-xs text-[var(--color-warning)]">
                          (régi aukció, a mai hozam eltérhet)
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{pct(dkj.avgYield)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatDate(dkj.maturity)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {market.updatedAt && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Forrás: ÁKK · frissítve {formatDateTime(market.updatedAt)}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
