import InfoTip from "../InfoTip";
import { useMemo } from "react";
import { usePortfolio, useValuedInstruments } from "../../lib/store";
import { purchaseLots, bondLots } from "../../lib/portfolio";
import { formatMoney, formatNumber, formatPercent, formatDate } from "../../lib/format";

export function LotsTable({ instrumentKey, accountId }: { instrumentKey: string; accountId?: string }) {
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = useValuedInstruments();
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);

  const result = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    return purchaseLots(instrumentKey, transactions, map, prices, fx);
  }, [instrumentKey, transactions, instruments, prices, fx]);

  const { currency, hadSells } = result;
  const lots = accountId ? result.lots.filter((l) => l.accountId === accountId) : result.lots;
  if (lots.length === 0)
    return (
      <p className="text-xs text-[var(--color-muted)]">
        Nincs rögzített vétel ehhez az eszközhöz.
      </p>
    );

  const foreign = currency !== "HUF";

  return (
    <div className="overflow-x-auto">
      <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">
        {lots.length} vétel
      </div>
      <table className="w-full min-w-[460px] table-fixed text-xs">
        <colgroup>
          <col className="w-[16%]" />
          <col className="w-[13%]" />
          <col className="w-[17%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead className="text-left text-[var(--color-muted)]">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Dátum</th>
            <th className="py-1.5 pr-3 text-right font-medium">Darab</th>
            <th className="py-1.5 pr-3 text-right font-medium">
              Vételár{foreign ? ` (${currency})` : ""}
            </th>
            <th className="py-1.5 pr-3 text-right font-medium">
              Bekerülés (Ft)
            </th>
            <th className="py-1.5 pr-3 text-right font-medium">
              Mai érték (Ft)
            </th>
            <th className="py-1.5 text-right font-medium">Hozam</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {lots.map((lot, i) => {
            const partial = lot.quantity < lot.originalQuantity - 1e-9;
            return (
              <tr
                key={`${lot.date}:${lot.accountId}:${i}`}
                className="border-t border-[var(--color-border)]/40"
              >
                <td className="py-1.5 pr-3">{formatDate(lot.date)}</td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatNumber(lot.quantity, 4)}
                  {partial && (
                    <div className="text-[10px] text-[var(--color-muted)]">
                      eredetileg {formatNumber(lot.originalQuantity, 4)}
                    </div>
                  )}
                </td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatMoney(lot.unitCostCcy, currency, {
                    decimals: foreign ? 2 : 0,
                  })}
                  {foreign && (
                    <div className="text-[10px] text-[var(--color-muted)]">
                      {formatNumber(lot.fxAtBuy, 1)} Ft/{currency}
                    </div>
                  )}
                </td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatMoney(lot.costHuf)}
                </td>
                <td className="amt py-1.5 pr-3 text-right">
                  {lot.currentValueHuf != null
                    ? formatMoney(lot.currentValueHuf)
                    : "—"}
                </td>
                <td className="py-1.5 text-right">
                  {lot.plHuf != null ? (
                    <span
                      className={
                        lot.plHuf >= 0
                          ? "text-[var(--color-positive)]"
                          : "text-[var(--color-negative)]"
                      }
                    >
                      <span className="amt">
                        {formatMoney(lot.plHuf, "HUF", { sign: true })}
                      </span>
                      {lot.plPct != null && (
                        <div className="text-[10px]">
                          ({formatPercent(lot.plPct)})
                        </div>
                      )}
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
      <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        Hogyan számolunk?
        <InfoTip>
          A bekerülés a vételkori árfolyamon rögzül; a hozam az azóta eltelt ár-
          és árfolyamváltozást tartalmazza.
          {hadSells &&
            " Az időközben eladott mennyiséget levontuk (a legrégebbi vételből kezdve), így csak a ténylegesen meglévő tételek látszanak: egy TBSZ-be költöztetés (eladás + azonnali visszavásárlás) így kiesik."}
        </InfoTip>
      </p>
    </div>
  );
}

export function BondLotsTable({ instrumentKey, accountId }: { instrumentKey: string; accountId?: string }) {
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = useValuedInstruments();

  const result = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    return bondLots(instrumentKey, transactions, map);
  }, [instrumentKey, transactions, instruments]);

  const { hadRedemptions, maturity, nextCoupon, couponRate, needsData } = result;
  const lots = accountId ? result.lots.filter((l) => l.accountId === accountId) : result.lots;
  if (lots.length === 0)
    return (
      <p className="text-xs text-[var(--color-muted)]">
        Nincs rögzített vétel ehhez az eszközhöz.
      </p>
    );

  return (
    <div className="overflow-x-auto">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <span className="font-medium">{lots.length} vétel</span>
        {maturity && <span>Lejárat: {formatDate(maturity)}</span>}
        {couponRate != null && (
          <span>Kamat: {(couponRate * 100).toFixed(2)}% / év</span>
        )}
        {nextCoupon && <span>Köv. kamat: {formatDate(nextCoupon)}</span>}
      </div>
      <table className="w-full min-w-[460px] table-fixed text-xs">
        <colgroup>
          <col className="w-[16%]" />
          <col className="w-[17%]" />
          <col className="w-[13%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead className="text-left text-[var(--color-muted)]">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Dátum</th>
            <th className="py-1.5 pr-3 text-right font-medium">Névérték</th>
            <th className="py-1.5 pr-3 text-right font-medium">Vételár</th>
            <th className="py-1.5 pr-3 text-right font-medium">
              Bekerülés (Ft)
            </th>
            <th className="py-1.5 pr-3 text-right font-medium">
              Mai érték (Ft)
            </th>
            <th className="py-1.5 text-right font-medium">Hozam</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {lots.map((lot, i) => {
            const partial = lot.faceValue < lot.originalFaceValue - 1e-9;
            return (
              <tr
                key={`${lot.date}:${lot.accountId}:${i}`}
                className="border-t border-[var(--color-border)]/40"
              >
                <td className="py-1.5 pr-3">{formatDate(lot.date)}</td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatMoney(lot.faceValue)}
                  {partial && (
                    <div className="text-[10px] font-normal text-[var(--color-muted)]">
                      eredetileg {formatMoney(lot.originalFaceValue)}
                    </div>
                  )}
                </td>
                <td className="amt py-1.5 pr-3 text-right text-[var(--color-muted)]">
                  {(lot.pricePct * 100).toFixed(2)}%
                </td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatMoney(lot.costHuf)}
                </td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatMoney(lot.currentValueHuf)}
                  {lot.redeemableValueHuf != null && (
                    <div
                      className="text-[10px] font-normal text-[var(--color-muted)]"
                      title="Ennyit kapnál, ha ma visszaváltanád"
                    >
                      most: {formatMoney(lot.redeemableValueHuf)}
                    </div>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  <span
                    className={
                      lot.gainHuf >= 0
                        ? "text-[var(--color-positive)]"
                        : "text-[var(--color-negative)]"
                    }
                  >
                    <span className="amt">
                      {formatMoney(lot.gainHuf, "HUF", { sign: true })}
                    </span>
                    <div className="text-[10px]">({formatPercent(lot.gainPct)})</div>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {needsData && (
        <p className="mt-2 text-xs text-[var(--color-warning,#fbbf24)]">
          Hiányzó sorozat-adatok miatt névértéken számol — add meg a kamatot és
          az első kamatfizetést a Beállítások → Állampapír sorozatok alatt.
        </p>
      )}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        Hogyan számolunk?
        <InfoTip>
          A „mai érték" diszkont kincstárjegynél a névérték felé araszoló
          felhalmozott érték, fix állampapírnál a névérték + felhalmozott kamat;
          ezzel számol a portfólió összértéke is. A „most" sor a lejárat előtti
          visszaváltási díjjal csökkentett, ténylegesen kifizetendő összeg.
          {hadRedemptions &&
            " Az időközben lejárt/visszaváltott névértéket levontuk (a legrégebbi vételből kezdve), így csak a jelenlegi készlet látszik."}
        </InfoTip>
      </p>
    </div>
  );
}
