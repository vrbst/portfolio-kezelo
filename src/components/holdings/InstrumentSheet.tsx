import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Target, X } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useGoalNamesByInstrument,
  useMoveAlertSettings,
  useToday,
} from "../../lib/store";
import { rowsFor } from "../../lib/holdings";
import { BOND_TYPES } from "../../lib/bonds";
import { returnParts } from "../../lib/holdingReturn";
import { marketStats } from "../../lib/marketStats";
import { DEFAULT_MOVE_PCT, alertDaysPerMonth, dailyAbsMoves } from "../../lib/moveAlerts";
import { saveMoveAlertSettings } from "../../lib/planPrefs";
import { formatDate, formatMoney, formatNumber, formatPercent } from "../../lib/format";
import { instrumentTypeLabel } from "../../lib/labels";
import { Badge } from "../ui";
import InstrumentLogo from "../InstrumentLogo";
import HoldingPriceChart, { type BuyPoint } from "../HoldingPriceChart";
import PctInput from "../PctInput";
import { ReturnRows } from "./ReturnBreakdown";
import { BondLotsTable, LotsTable } from "./LotsTables";
import FundamentalsSection from "./FundamentalsSection";
import { useFundamentalsFile } from "../../lib/fundamentalsStore";

const QUOTED = new Set(["etf", "stock", "fund"]);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-[var(--color-border)] px-5 py-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, children, publicData = false }: { label: string; children: ReactNode; publicData?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums" data-privacy={publicData ? "public" : undefined}>
        {children}
      </div>
    </div>
  );
}

export default function InstrumentSheet({
  instrumentKey,
  accountId,
  onClose,
}: {
  instrumentKey: string;
  accountId?: string;
  onClose: () => void;
}) {
  const summary = usePortfolioSummary();
  const transactions = usePortfolio((s) => s.transactions);
  const fx = usePortfolio((s) => s.fx);
  const quote = usePortfolio((s) => s.liveQuotes[instrumentKey]);
  const history = usePortfolio((s) => s.historyFile);
  const priceName = usePortfolio((s) => s.priceFile?.prices[instrumentKey]?.name);
  const goals = useGoalNamesByInstrument().get(instrumentKey) ?? [];
  const moveSettings = useMoveAlertSettings();
  const today = useToday();
  const fundamentals = useFundamentalsFile();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const row = useMemo(
    () => rowsFor(summary, accountId).find((h) => h.instrumentKey === instrumentKey),
    [summary, accountId, instrumentKey],
  );
  const split = useMemo(
    () =>
      summary.accounts.flatMap((a) => {
        const h = a.holdings.find((x) => x.instrumentKey === instrumentKey && x.quantity > 1e-9);
        return h ? [{ account: a.account, h }] : [];
      }),
    [summary, instrumentKey],
  );
  const buys = useMemo(() => {
    const out: BuyPoint[] = [];
    for (const t of transactions) {
      if (t.type !== "buy" || t.instrumentKey !== instrumentKey || !t.quantity) continue;
      if (accountId && t.accountId !== accountId) continue;
      const price = t.pricePerUnit ?? (t.grossAmount ?? 0) / t.quantity;
      if (price > 0) out.push({ date: t.date, price });
    }
    return out;
  }, [transactions, instrumentKey, accountId]);

  const inst = row?.instrument;
  const bond = !!inst && BOND_TYPES.has(inst.type);
  const quoted = !!inst && QUOTED.has(inst.type);
  const series = history?.prices[instrumentKey];
  const price = quote?.price ?? row?.currentPrice;
  const dayChange = quote?.prevClose && quote.price ? quote.price / quote.prevClose - 1 : undefined;
  const stats = quoted ? marketStats(series, today, price) : null;
  const ret = row && !bond ? returnParts(row, fx) : null;
  const threshold = moveSettings.byKey[instrumentKey];
  const thresholdDefault = moveSettings.positionPct ?? DEFAULT_MOVE_PCT;
  const perMonth = alertDaysPerMonth(dailyAbsMoves(series), threshold ?? thresholdDefault);
  const maturity = inst?.bond?.maturity ?? inst?.maturity;
  const ccyDecimals = row?.currency === "HUF" ? 0 : 2;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={inst?.name ?? instrumentKey}
        className="sheet-up absolute inset-0 overflow-y-auto bg-[var(--color-surface)] pb-[env(safe-area-inset-bottom)] shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,100vw)] md:border-l md:border-[var(--color-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <InstrumentLogo instrument={inst} />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold leading-snug">{inst?.name ?? instrumentKey}</h2>
            {priceName && priceName !== inst?.name && (
              <div className="text-xs text-[var(--color-muted)]">{priceName}</div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-muted)]">
              {inst && <Badge tone="neutral">{instrumentTypeLabel[inst.type]}</Badge>}
              {inst?.ticker && <span>{inst.ticker}</span>}
              {inst?.isin && <span>{inst.isin}</span>}
              {maturity && <span>lejárat: {formatDate(maturity)}</span>}
            </div>
          </div>
          <button className="btn-ghost -mr-2 shrink-0" onClick={onClose} aria-label="Bezárás">
            <X className="h-4 w-4" />
          </button>
        </header>

        {!row ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">Ez a papír már nincs a portfólióban.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-3">
              {price != null && !bond && (
                <Stat label="Árfolyam" publicData>
                  {formatMoney(price, row.currency, { decimals: ccyDecimals })}
                  {dayChange != null && (
                    <span
                      className={`ml-1.5 text-xs ${
                        dayChange >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"
                      }`}
                    >
                      {formatPercent(dayChange)} ma
                    </span>
                  )}
                </Stat>
              )}
              <Stat label={bond ? "Névérték" : "Mennyiség"}>
                <span className="amt">{formatNumber(row.quantity, bond ? 0 : 4)}</span>
              </Stat>
              <Stat label="Érték">
                <span className="amt">{formatMoney(row.marketValueHuf)}</span>
                {row.redeemableValueHuf != null && (
                  <div className="amt text-xs font-normal text-[var(--color-muted)]">
                    most: {formatMoney(row.redeemableValueHuf)}
                  </div>
                )}
              </Stat>
              <Stat label="Bekerülés">
                <span className="amt">{formatMoney(row.costBasisHuf)}</span>
              </Stat>
              {!bond && row.quantity > 0 && (
                <Stat label="Átlagár">
                  <span className="amt">
                    {formatMoney(row.costBasisCcy / row.quantity, row.currency, { decimals: ccyDecimals })}
                  </span>
                </Stat>
              )}
            </div>

            {ret && (
              <Section title="Hozam">
                <div className="max-w-sm text-sm">
                  <ReturnRows r={ret} />
                </div>
              </Section>
            )}

            {stats && (
              <Section title="Piaci adatok (1 év)">
                <div data-privacy="public">
                  <div className="flex justify-between text-xs text-[var(--color-muted)]">
                    <span>min {formatMoney(stats.low, row.currency, { decimals: ccyDecimals })}</span>
                    <span>max {formatMoney(stats.high, row.currency, { decimals: ccyDecimals })}</span>
                  </div>
                  <div className="relative mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)]">
                    <span
                      className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-brand)]"
                      style={{ left: `${stats.rangePos * 100}%` }}
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                    <Stat label="A csúcstól" publicData>
                      {stats.fromHigh > -0.0005 ? "csúcson" : formatPercent(stats.fromHigh, 1)}
                    </Stat>
                    {stats.typicalMovePct != null && (
                      <Stat label="Jellemző napi mozgás" publicData>
                        {formatNumber(stats.typicalMovePct, 1)}%
                      </Stat>
                    )}
                    <Stat label="Adat kezdete" publicData>
                      {formatDate(stats.sinceDay)}
                    </Stat>
                  </div>
                </div>
              </Section>
            )}

            <FundamentalsSection f={fundamentals?.items[instrumentKey]} error={fundamentals?.errors[instrumentKey]} />

            {series && series.length >= 2 && (
              <Section title="Árfolyam és vételeid">
                <div data-privacy="public">
                  <HoldingPriceChart series={series} currency={row.currency} fxSeries={history?.fx?.["EUR"]} buys={buys} />
                </div>
              </Section>
            )}

            {quoted && (
              <Section title="Nagy mozgás riasztás (Telegram)">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <PctInput
                    key={String(threshold)}
                    label={`${inst?.name ?? instrumentKey} küszöbe`}
                    value={threshold}
                    placeholder={thresholdDefault}
                    onCommit={(v) => {
                      const byKey = { ...moveSettings.byKey };
                      if (v === undefined) delete byKey[instrumentKey];
                      else byKey[instrumentKey] = v;
                      saveMoveAlertSettings({ ...moveSettings, byKey });
                    }}
                  />
                  <span className="text-xs text-[var(--color-muted)]">
                    {threshold == null ? "alapérték · " : ""}
                    {perMonth != null && `~${formatNumber(perMonth, perMonth < 10 ? 1 : 0)} riasztás havonta az elmúlt év alapján`}
                  </span>
                </div>
              </Section>
            )}

            {(goals.length > 0 || (!accountId && split.length > 1)) && (
              <Section title="Hol van és mire">
                {goals.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2 text-xs">
                    {goals.map((g) => (
                      <span
                        key={g}
                        className="priv inline-flex items-center gap-1 rounded-full bg-[var(--color-brand)]/15 px-2 py-0.5 text-[var(--color-brand)]"
                      >
                        <Target className="h-3 w-3" />
                        {g}
                      </span>
                    ))}
                  </div>
                )}
                {!accountId && split.length > 1 && (
                  <ul className="space-y-1.5 text-sm">
                    {split.map(({ account, h }) => (
                      <li key={account.id} className="flex items-center justify-between gap-3">
                        <Link to={`/accounts/${account.id}`} className="priv truncate hover:text-[var(--color-brand)]" onClick={onClose}>
                          {account.name}
                        </Link>
                        <span className="amt shrink-0 tabular-nums">
                          {formatNumber(h.quantity, bond ? 0 : 4)} · {formatMoney(h.marketValueHuf ?? 0)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            <Section title="Vásárlásaim">
              {bond ? (
                <BondLotsTable instrumentKey={instrumentKey} accountId={accountId} />
              ) : (
                <LotsTable instrumentKey={instrumentKey} accountId={accountId} />
              )}
            </Section>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
