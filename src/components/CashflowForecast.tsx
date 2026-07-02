import { TrendingUp } from "lucide-react";
import { bondCashflowForecast } from "../lib/portfolio";
import { usePortfolioSummary } from "../lib/store";
import { formatMoney } from "../lib/format";
import { Card, Badge } from "./ui";

const MONTHS = [
  "január",
  "február",
  "március",
  "április",
  "május",
  "június",
  "július",
  "augusztus",
  "szeptember",
  "október",
  "november",
  "december",
];

/** "YYYY-MM" -> "2026. július" */
function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${y}. ${MONTHS[Number(m) - 1] ?? m}`;
}

/**
 * Forward 12-month forecast of bond inflows (coupons + maturities), bucketed by
 * month with a per-month bar. "Mennyi pénz jön be és mikor?" — the cashflow hub.
 */
export default function CashflowForecast() {
  const summary = usePortfolioSummary();
  const fc = bondCashflowForecast(summary);
  if (fc.totalHuf <= 0) return null;

  const maxMonth = Math.max(...fc.months.map((m) => m.totalHuf), 1);

  return (
    <Card className="mt-4 p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Következő 12 hónap</h2>
      </div>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Várható kamatok és lejáratok a kötvényeidből, ha lejáratig tartod őket.
      </p>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <span className="text-sm text-[var(--color-muted)]">Összesen: </span>
          <span className="amt text-xl font-semibold tabular-nums text-[var(--color-positive)]">
            {formatMoney(fc.totalHuf)}
          </span>
        </div>
        <div className="text-sm text-[var(--color-muted)] tabular-nums">
          kamat <span className="amt">{formatMoney(fc.couponHuf)}</span> ·
          lejárat <span className="amt">{formatMoney(fc.maturityHuf)}</span>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {fc.months.map((m) => (
          <details
            key={m.key}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/30"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 p-3">
              <span className="w-28 shrink-0 text-sm font-medium capitalize">
                {monthLabel(m.key)}
              </span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-brand)]"
                  style={{ width: `${(m.totalHuf / maxMonth) * 100}%` }}
                />
              </span>
              <span className="amt shrink-0 text-sm font-semibold tabular-nums">
                {formatMoney(m.totalHuf)}
              </span>
            </summary>
            <div className="space-y-1.5 border-t border-[var(--color-border)] px-3 py-2">
              {m.items
                .slice()
                .sort((a, b) => b.amountHuf - a.amountHuf)
                .map((it, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge tone={it.kind === "coupon" ? "neutral" : "brand"}>
                        {it.kind === "coupon" ? "kamat" : "lejárat"}
                      </Badge>
                      <span className="truncate text-[var(--color-muted)]">
                        {it.title}
                      </span>
                    </span>
                    <span className="amt shrink-0 tabular-nums text-[var(--color-positive)]">
                      +{formatMoney(it.amountHuf)}
                    </span>
                  </div>
                ))}
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}
