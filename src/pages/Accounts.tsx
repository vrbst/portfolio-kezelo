import { useMemo } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Wallet, Landmark, ArrowRight } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import HoldingsPanel from "../components/HoldingsPanel";
import {
  PageHeader,
  Card,
  EmptyState,
  Badge,
  Delta,
  AnimatedAmount,
  Sparkline,
} from "../components/ui";
import { formatMoney, formatPercent, eurEquivalent } from "../lib/format";
import { accountKindLabel } from "../lib/labels";
import {
  accountReturn,
  isEmptyAccount,
  accountValueSpark,
  type AccountSummary,
} from "../lib/portfolio";
import { tbszStatus } from "../lib/tbsz";

export default function Accounts() {
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const historyFile = usePortfolio((s) => s.historyFile);
  const summary = usePortfolioSummary();
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);

  // Per-account value trend for the card sparklines (built once for all cards).
  const sparks = useMemo(() => {
    const instMap = new Map(instruments.map((i) => [i.key, i]));
    const out = new Map<string, number[]>();
    for (const a of summary.accounts) {
      if (isEmptyAccount(a)) continue;
      const s = accountValueSpark(
        a.account,
        transactions,
        instMap,
        prices,
        fx,
        historyFile,
      );
      if (s.length >= 2) out.set(a.account.id, s);
    }
    return out;
  }, [summary.accounts, transactions, instruments, prices, fx, historyFile]);

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title="Számlák" />
        <EmptyState
          title="Nincs számla"
          description="Importálj egy kivonatot, és a számláid itt jelennek meg."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importálás
            </Link>
          }
        />
      </div>
    );
  }

  const treasury = summary.accounts.filter(
    (a) => a.account.provider === "allamkincstar",
  );
  const investing = summary.accounts.filter(
    (a) => a.account.provider !== "allamkincstar",
  );

  return (
    <div>
      <PageHeader
        title="Számlák"
        subtitle="TBSZ és államkincstári számláid részletesen."
      />

      <Section
        title="Befektetési számlák"
        icon={<Wallet className="h-5 w-5" />}
        items={investing}
        eurHuf={eurHuf}
        sparks={sparks}
        totalHuf={summary.totalValueHuf}
      />
      <Section
        title="Magyar Államkincstár"
        icon={<Landmark className="h-5 w-5" />}
        items={treasury}
        sparks={sparks}
        totalHuf={summary.totalValueHuf}
      />

      <HoldingsPanel expandable />
    </div>
  );
}

function Section({
  title,
  icon,
  items,
  eurHuf,
  sparks,
  totalHuf,
}: {
  title: string;
  icon: React.ReactNode;
  items: AccountSummary[];
  /** When set, show an EUR equivalent under each account's value. */
  eurHuf?: number;
  sparks: Map<string, number[]>;
  totalHuf: number;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2 text-[var(--color-muted)]">
        {icon}
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          {title}
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((a, i) => {
          const ret = accountReturn(a);
          const empty = isEmptyAccount(a);
          const spark = sparks.get(a.account.id);
          const weight =
            totalHuf > 0 ? a.totalValueHuf / totalHuf : 0;
          const up = (ret ?? 0) >= 0;
          const tbsz =
            a.account.kind === "tbsz" && a.account.tbszYear
              ? tbszStatus(a.account.tbszYear)
              : undefined;
          return (
            <motion.div
              key={a.account.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Link to={`/accounts/${a.account.id}`}>
                <Card hover className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {a.account.name}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge tone="brand">
                          {accountKindLabel(a.account)}
                        </Badge>
                        {a.account.externalRef && (
                          <span className="text-xs text-[var(--color-muted)]">
                            {a.account.externalRef}
                          </span>
                        )}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                  </div>

                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-[var(--color-muted)]">
                        Teljes érték
                      </div>
                      <div className="amt font-display text-xl font-semibold tabular-nums">
                        <AnimatedAmount
                          value={a.totalValueHuf}
                          format={(n) => formatMoney(n)}
                        />
                      </div>
                      {eurEquivalent(a.totalValueHuf, eurHuf) && (
                        <div className="amt text-xs tabular-nums text-[var(--color-muted)]">
                          {eurEquivalent(a.totalValueHuf, eurHuf)}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {empty ? (
                        <Badge tone="neutral">üres</Badge>
                      ) : (
                        ret != null && <Delta pct={ret} className="text-sm" />
                      )}
                      {spark && (
                        <div className="h-8 w-24">
                          <Sparkline
                            data={spark}
                            stroke={
                              up
                                ? "var(--color-positive)"
                                : "var(--color-negative)"
                            }
                            className="h-full w-full"
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Weight bar: this account's share of the whole portfolio. */}
                  {!empty && weight > 0 && (
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--color-muted)]">
                        <span>a portfólió része</span>
                        <span className="tabular-nums">
                          {formatPercent(weight).replace("+", "")}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[var(--color-brand)] to-[var(--color-brand-2)]"
                          style={{ width: `${Math.min(weight * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {tbsz && (
                    <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-xs">
                      <span className="text-[var(--color-muted)]">
                        {tbsz.phaseLabel} · {Math.round(tbsz.taxRate * 100)}%
                        adó
                      </span>
                      {tbsz.next && (
                        <span className="text-[var(--color-muted)]">
                          {tbsz.next.label}: {tbsz.next.date.slice(0, 4)}
                        </span>
                      )}
                    </div>
                  )}
                </Card>
              </Link>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
