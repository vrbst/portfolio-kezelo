import { Fragment, useMemo, useState } from "react";
import { Layers, ChevronRight } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { consolidatedHoldings, purchaseLots, bondLots } from "../lib/portfolio";
import { Card, Badge, Delta } from "./ui";
import {
  formatMoney,
  formatNumber,
  formatPercent,
  formatDate,
} from "../lib/format";
import { instrumentTypeLabel } from "../lib/labels";

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

/**
 * Consolidated holdings: every instrument aggregated across all accounts, so the
 * same ETF held in several accounts shows one combined total. When `expandable`,
 * non-bond rows unfold to the individual purchases (lots). Amounts respect
 * privacy mode (.amt); percentages stay readable.
 */
export default function HoldingsPanel({
  expandable = false,
}: {
  expandable?: boolean;
}) {
  const summary = usePortfolioSummary();
  const rows = consolidatedHoldings(summary);
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (rows.length === 0) return null;

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-6 pb-3">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Eszközeim</h2>
        </div>
        <span className="text-xs text-[var(--color-muted)]">
          {expandable
            ? "nyisd le a vásárlásaidért"
            : "instrumentumonként, számlákon átívelve"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--color-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-4 py-3 font-medium">Eszköz</th>
              <th className="px-4 py-3 text-right font-medium">Mennyiség</th>
              <th className="px-4 py-3 text-right font-medium">Érték</th>
              <th className="px-4 py-3 text-right font-medium">
                Nem realizált
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const isBond = h.instrument
                ? BOND_TYPES.has(h.instrument.type)
                : false;
              const pct =
                h.costBasisHuf > 0
                  ? h.unrealizedPlHuf / h.costBasisHuf
                  : undefined;
              const canExpand = expandable;
              const isOpen = open.has(h.instrumentKey);
              return (
                <Fragment key={h.instrumentKey}>
                  <tr
                    className={`border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40 ${
                      canExpand ? "cursor-pointer" : ""
                    }`}
                    onClick={
                      canExpand ? () => toggle(h.instrumentKey) : undefined
                    }
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {canExpand && (
                          <ChevronRight
                            className={`h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform ${
                              isOpen ? "rotate-90" : ""
                            }`}
                          />
                        )}
                        <div className="font-medium">
                          {h.instrument?.name ?? h.instrumentKey}
                        </div>
                      </div>
                      <div
                        className={`mt-0.5 flex items-center gap-2 text-xs text-[var(--color-muted)] ${
                          canExpand ? "pl-5" : ""
                        }`}
                      >
                        {h.instrument && (
                          <Badge tone="neutral">
                            {instrumentTypeLabel[h.instrument.type]}
                          </Badge>
                        )}
                        {h.accountCount > 1 && (
                          <span>{h.accountCount} számlán</span>
                        )}
                      </div>
                    </td>
                    <td className="amt px-4 py-3 text-right tabular-nums">
                      {formatNumber(h.quantity, isBond ? 0 : 4)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      <div className="amt">{formatMoney(h.marketValueHuf)}</div>
                      {h.currency !== "HUF" && h.marketValueCcy != null && (
                        <div className="amt text-xs font-normal text-[var(--color-muted)]">
                          {formatMoney(h.marketValueCcy, h.currency)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {/* Bonds: mark-to-market oscillates with the coupon cycle,
                          so the unrealized figure is meaningless — same as the
                          Államkincstár page, we hide it. */}
                      {!isBond && Math.abs(h.unrealizedPlHuf) > 0.5 ? (
                        <Delta
                          value={h.unrealizedPlHuf}
                          pct={pct}
                          className="text-xs"
                        />
                      ) : (
                        <span className="text-[var(--color-muted)]">—</span>
                      )}
                    </td>
                  </tr>
                  {canExpand && isOpen && (
                    <tr className="border-b border-[var(--color-border)]/50 last:border-0">
                      <td
                        colSpan={4}
                        className="bg-[var(--color-surface-2)]/30 px-4 py-3"
                      >
                        {isBond ? (
                          <BondLotsTable instrumentKey={h.instrumentKey} />
                        ) : (
                          <LotsTable instrumentKey={h.instrumentKey} />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function LotsTable({ instrumentKey }: { instrumentKey: string }) {
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);

  const result = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    return purchaseLots(instrumentKey, transactions, map, prices, fx);
  }, [instrumentKey, transactions, instruments, prices, fx]);

  const { lots, currency, hadSells } = result;
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
        Vásárlásaim ({lots.length} db)
      </div>
      <table className="w-full min-w-[560px] text-xs">
        <thead className="text-left text-[var(--color-muted)]">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Dátum</th>
            <th className="py-1.5 pr-3 text-right font-medium">Darab</th>
            <th className="py-1.5 pr-3 text-right font-medium">
              Vételár{foreign ? ` (${currency})` : ""}
            </th>
            {foreign && (
              <th className="py-1.5 pr-3 text-right font-medium">Árf. (Ft)</th>
            )}
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
                    <span className="ml-1 text-[10px] text-[var(--color-muted)]">
                      (eredetileg {formatNumber(lot.originalQuantity, 4)})
                    </span>
                  )}
                </td>
                <td className="amt py-1.5 pr-3 text-right">
                  {formatMoney(lot.unitCostCcy, currency, {
                    decimals: foreign ? 2 : 0,
                  })}
                </td>
                {foreign && (
                  <td className="amt py-1.5 pr-3 text-right text-[var(--color-muted)]">
                    {formatNumber(lot.fxAtBuy, 1)}
                  </td>
                )}
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
                        <span className="ml-1">
                          ({formatPercent(lot.plPct)})
                        </span>
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
      {hadSells && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Az időközben eladott mennyiséget levontuk (a legrégebbi vételből
          kezdve), így csak a ténylegesen meglévő tételek látszanak — egy
          TBSZ-be költöztetés (eladás + azonnali visszavásárlás) így kiesik.
        </p>
      )}
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        A bekerülés a vételkori árfolyamon rögzül; a hozam az azóta eltelt ár-
        és árfolyamváltozást tartalmazza.
      </p>
    </div>
  );
}

function BondLotsTable({ instrumentKey }: { instrumentKey: string }) {
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);

  const result = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    return bondLots(instrumentKey, transactions, map);
  }, [instrumentKey, transactions, instruments]);

  const { lots, hadRedemptions, maturity, nextCoupon, couponRate, needsData } =
    result;
  if (lots.length === 0)
    return (
      <p className="text-xs text-[var(--color-muted)]">
        Nincs rögzített vétel ehhez az eszközhöz.
      </p>
    );

  return (
    <div className="overflow-x-auto">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <span className="font-medium">Vásárlásaim ({lots.length} db)</span>
        {maturity && <span>Lejárat: {formatDate(maturity)}</span>}
        {couponRate != null && (
          <span>Kamat: {(couponRate * 100).toFixed(2)}% / év</span>
        )}
        {nextCoupon && <span>Köv. kamat: {formatDate(nextCoupon)}</span>}
      </div>
      <table className="w-full min-w-[560px] text-xs">
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
                    <span className="ml-1 text-[10px] text-[var(--color-muted)]">
                      (eredetileg {formatMoney(lot.originalFaceValue)})
                    </span>
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
                    <span className="ml-1">({formatPercent(lot.gainPct)})</span>
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
      {hadRedemptions && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Az időközben lejárt/visszaváltott névértéket levontuk (a legrégebbi
          vételből kezdve), így csak a jelenlegi készlet látszik.
        </p>
      )}
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        A „mai érték" a most visszaváltható összeg: diszkont kincstárjegynél a
        névérték felé araszoló felhalmozott érték, fix állampapírnál a névérték
        + felhalmozott kamat, lejárat előtt a visszaváltási díjjal csökkentve.
      </p>
    </div>
  );
}
