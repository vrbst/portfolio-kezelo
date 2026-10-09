import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Layers, Target, Wallet } from "lucide-react";
import { usePortfolio, usePortfolioSummary, useGoalNamesByInstrument } from "../../lib/store";
import { bondPricePct, rowsFor, type ConsolidatedHolding } from "../../lib/holdings";
import { BOND_TYPES } from "../../lib/bonds";
import { returnParts } from "../../lib/holdingReturn";
import { formatDate, formatMoney, formatNumber } from "../../lib/format";
import { instrumentTypeLabel } from "../../lib/labels";
import { Badge, Card } from "../ui";
import InstrumentLogo from "../InstrumentLogo";
import ReturnBreakdown from "./ReturnBreakdown";
import InstrumentSheet from "./InstrumentSheet";

export const HOLDINGS_PANEL_ID = "holdings-panel";

const CASH_ROW_MIN_HUF = 1000;

const isBondRow = (h: ConsolidatedHolding) => !!h.instrument && BOND_TYPES.has(h.instrument.type);
const maturityOf = (h: ConsolidatedHolding) => h.instrument?.bond?.maturity ?? h.instrument?.maturity;

export default function HoldingsTable({
  accountId,
  variant = "compact",
  maxBodyHeight,
  fill = false,
  title = "Eszközeim",
  showTotals = false,
}: {
  accountId?: string;
  variant?: "compact" | "full";
  maxBodyHeight?: string;
  fill?: boolean;
  title?: string;
  showTotals?: boolean;
}) {
  const summary = usePortfolioSummary();
  const fx = usePortfolio((s) => s.fx);
  const goals = useGoalNamesByInstrument();
  const navigate = useNavigate();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rows = useMemo(() => rowsFor(summary, accountId), [summary, accountId]);
  const acc = accountId ? summary.accounts.find((a) => a.account.id === accountId) : undefined;
  const total = acc ? acc.totalValueHuf : summary.totalValueHuf;
  const full = variant === "full";

  const cashRows = accountId
    ? []
    : summary.accounts
        .filter((a) => a.cashValueHuf >= CASH_ROW_MIN_HUF)
        .map((a) => ({
          account: a.account,
          valueHuf: a.cashValueHuf,
          foreign: Object.entries(a.cash).filter(([ccy, amt]) => ccy !== "HUF" && Math.abs(amt) > 1e-6),
        }))
        .sort((a, b) => b.valueHuf - a.valueHuf);

  if (rows.length === 0 && cashRows.length === 0) {
    if (!accountId) return null;
    return (
      <Card className="p-6 text-sm text-[var(--color-muted)]">Nincs nyitott pozíció ezen a számlán.</Card>
    );
  }

  const allBonds = rows.length > 0 && rows.every(isBondRow);
  const showReturn = !allBonds;
  const fullCell = "hidden md:table-cell";
  const bar = (value: number) => {
    const w = total > 0 ? Math.min((value / total) * 100, 100) : 0;
    return w > 0
      ? {
          backgroundImage: `linear-gradient(to right, color-mix(in srgb, var(--color-brand) 10%, transparent) ${w}%, transparent ${w}%)`,
        }
      : undefined;
  };
  const sum = (f: (h: ConsolidatedHolding) => number) => rows.reduce((s, h) => s + f(h), 0);
  const totalRedeemable = sum((h) => h.redeemableValueHuf ?? h.marketValueHuf);

  return (
    <Card
      id={fill ? HOLDINGS_PANEL_ID : undefined}
      className={`overflow-hidden ${fill ? "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 p-6 pb-3">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <span className="text-xs text-[var(--color-muted)]">
          {accountId ? "koppints egy sorra a részletekért" : "számlákon átívelve · koppints a részletekért"}
        </span>
      </div>
      <div
        data-holdings-body={fill || undefined}
        className={`${maxBodyHeight ? "overflow-auto" : "overflow-x-auto"} ${
          fill ? "xl:min-h-0 xl:flex-1 xl:!max-h-none" : ""
        }`}
        style={maxBodyHeight ? { maxHeight: maxBodyHeight } : undefined}
      >
        <table className="w-full text-sm">
          <thead
            className={`text-left text-xs text-[var(--color-muted)] ${
              maxBodyHeight ? "sticky top-0 z-10 bg-[var(--color-surface)]" : ""
            }`}
          >
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-4 py-3 font-medium">Eszköz</th>
              <th className="px-4 py-3 text-right font-medium">{allBonds ? "Névérték" : "Mennyiség"}</th>
              {full && <th className={`${fullCell} px-4 py-3 text-right font-medium`}>Árfolyam</th>}
              {full && <th className={`${fullCell} px-4 py-3 text-right font-medium`}>Bekerülés</th>}
              <th className="px-4 py-3 text-right font-medium">Érték</th>
              {showReturn && <th className="px-4 py-3 text-right font-medium">Hozam</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const bond = isBondRow(h);
              const maturity = maturityOf(h);
              const name = h.instrument?.name ?? h.instrumentKey;
              const unitHuf =
                h.currentPrice != null && h.currency !== "HUF" ? h.currentPrice * (fx[h.currency] ?? 0) : undefined;
              return (
                <tr
                  key={h.instrumentKey}
                  className="cursor-pointer border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40"
                  style={bar(h.marketValueHuf)}
                  onClick={() => setOpenKey(h.instrumentKey)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <InstrumentLogo instrument={h.instrument} />
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="text-left font-medium hover:text-[var(--color-brand)]"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenKey(h.instrumentKey);
                          }}
                        >
                          {name}
                        </button>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-muted)]">
                          {h.instrument && <Badge tone="neutral">{instrumentTypeLabel[h.instrument.type]}</Badge>}
                          {!accountId && h.accountCount > 1 && <span>{h.accountCount} számlán</span>}
                          {maturity && <span>lejárat: {formatDate(maturity)}</span>}
                          {(goals.get(h.instrumentKey) ?? []).map((goalName) => (
                            <span
                              key={goalName}
                              className="priv inline-flex items-center gap-1 rounded-full bg-[var(--color-brand)]/15 px-2 py-0.5 text-[var(--color-brand)]"
                              title="Középtávú célhoz rendelve"
                            >
                              <Target className="h-3 w-3" />
                              {goalName}
                            </span>
                          ))}
                          {h.bondNeedsData && (
                            <Link
                              to="/settings"
                              onClick={(e) => e.stopPropagation()}
                              title="Add meg a sorozat adatait a pontos értékhez"
                            >
                              <Badge tone="warning">névértéken — sorozat-adat hiányzik</Badge>
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="amt px-4 py-3 text-right tabular-nums">{formatNumber(h.quantity, bond ? 0 : 4)}</td>
                  {full && (
                    <td className={`${fullCell} px-4 py-3 text-right tabular-nums text-[var(--color-muted)]`}>
                      {h.currentPrice != null && !bond ? (
                        <>
                          <div className="text-[var(--color-text)]" data-privacy="public">
                            {formatMoney(h.currentPrice, h.currency, {
                              decimals: h.currency === "HUF" ? 0 : 2,
                            })}
                          </div>
                          {unitHuf != null && <div className="text-xs opacity-70" data-privacy="public">≈ {formatMoney(unitHuf)}</div>}
                        </>
                      ) : bond && bondPricePct(h) != null ? (
                        <div>{bondPricePct(h)!.toFixed(2)}%</div>
                      ) : (
                        <span>—</span>
                      )}
                    </td>
                  )}
                  {full && (
                    <td className={`${fullCell} amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]`}>
                      <div>{formatMoney(h.costBasisHuf)}</div>
                      {h.currency !== "HUF" && (
                        <div className="text-xs opacity-70">{formatMoney(h.costBasisCcy, h.currency)}</div>
                      )}
                      {!bond && h.quantity > 0 && (
                        <div className="mt-1 text-xs opacity-70">
                          átlagár:{" "}
                          {formatMoney(h.costBasisCcy / h.quantity, h.currency, {
                            decimals: h.currency === "HUF" ? 0 : 2,
                          })}
                        </div>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    <div className="amt">{formatMoney(h.marketValueHuf)}</div>
                    {h.currency !== "HUF" && h.marketValueCcy != null && (
                      <div className="amt text-xs font-normal text-[var(--color-muted)]">
                        {formatMoney(h.marketValueCcy, h.currency)}
                      </div>
                    )}
                    {h.redeemableValueHuf != null && (
                      <div
                        className="amt text-xs font-normal text-[var(--color-muted)]"
                        title="Ennyit kapnál, ha ma visszaváltanád (a lejárat előtti visszaváltási díjjal csökkentve)"
                      >
                        most: {formatMoney(h.redeemableValueHuf)}
                      </div>
                    )}
                  </td>
                  {showReturn && (
                    <td className="px-4 py-3 text-right tabular-nums">
                      <ReturnBreakdown r={bond ? null : returnParts(h, fx)} />
                    </td>
                  )}
                </tr>
              );
            })}
            {cashRows.map((c) => (
              <tr
                key={`cash:${c.account.id}`}
                className="cursor-pointer border-b border-[var(--color-border)]/50 last:border-0 hover:bg-[var(--color-surface-2)]/40"
                style={bar(c.valueHuf)}
                onClick={() => navigate(`/accounts/${c.account.id}`)}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--color-brand)]/15 text-[var(--color-brand)]">
                      <Wallet className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium">Készpénz</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                        <Badge tone="neutral">Pénzszámla</Badge>
                        <span className="priv">{c.account.name}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-[var(--color-muted)]">—</td>
                {full && <td className={`${fullCell} px-4 py-3`} />}
                {full && <td className={`${fullCell} px-4 py-3`} />}
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  <div className="amt">{formatMoney(c.valueHuf)}</div>
                  {c.foreign.map(([ccy, amt]) => (
                    <div key={ccy} className="amt text-xs font-normal text-[var(--color-muted)]">
                      {formatMoney(amt, ccy)}
                    </div>
                  ))}
                </td>
                {showReturn && (
                  <td className="px-4 py-3 text-right">
                    <span className="text-[var(--color-muted)]">—</span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {showTotals && rows.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-[var(--color-border)] font-semibold">
                <td className="px-4 py-3">Összesen</td>
                <td className="amt px-4 py-3 text-right tabular-nums">
                  {formatNumber(sum((h) => h.quantity), allBonds ? 0 : 4)}
                </td>
                {full && <td className={fullCell} />}
                {full && (
                  <td className={`${fullCell} amt px-4 py-3 text-right tabular-nums text-[var(--color-muted)]`}>
                    {formatMoney(sum((h) => h.costBasisHuf))}
                  </td>
                )}
                <td className="amt px-4 py-3 text-right tabular-nums">
                  {formatMoney(sum((h) => h.marketValueHuf))}
                  {Math.abs(totalRedeemable - sum((h) => h.marketValueHuf)) >= 0.5 && (
                    <div
                      className="text-xs font-normal text-[var(--color-muted)]"
                      title="Ennyit kapnál, ha ma mindent visszaváltanál (a lejárat előtti visszaváltási díjjal csökkentve)"
                    >
                      most: {formatMoney(totalRedeemable)}
                    </div>
                  )}
                </td>
                {showReturn && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {openKey && (
        <InstrumentSheet instrumentKey={openKey} accountId={accountId} onClose={() => setOpenKey(null)} />
      )}
    </Card>
  );
}
