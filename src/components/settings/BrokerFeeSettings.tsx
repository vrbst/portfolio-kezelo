import { Percent } from "lucide-react";
import { usePortfolio, useBrokerFees } from "../../lib/store";
import { saveBrokerFees } from "../../lib/planPrefs";
import { providerLabel } from "../../lib/incomeFlow";
import type { Cost } from "../../lib/glidePath";
import { Card } from "../ui";
import { PctInput } from "../GlidePathEditor";

/**
 * Buy / sell cost per broker — used for any trade the glide path's bucket rule
 * (or a bond's own redemption cost) doesn't price, e.g. a DCA buy of an ETF
 * outside the glide path. Order: bucket rule → bond redemption → broker →
 * general default → 0. Synced across devices.
 */
export default function BrokerFeeSettings() {
  const accounts = usePortfolio((s) => s.accounts);
  const fees = useBrokerFees();
  const providers = [...new Set(accounts.map((a) => a.provider))].sort();
  if (providers.length === 0) return null;

  const set = (provider: string, side: "buy" | "sell", pct: number | undefined) => {
    // Mid-typing garbage (NaN) or a negative fee is never stored.
    if (pct != null && !(Number.isFinite(pct) && pct >= 0)) return;
    const cur = { ...(fees[provider] ?? {}) };
    const cost: Cost | undefined = pct == null ? undefined : { pct };
    if (cost) cur[side] = cost;
    else delete cur[side];
    const next = { ...fees };
    if (cur.buy || cur.sell) next[provider] = cur;
    else delete next[provider];
    saveBrokerFees(next);
  };

  return (
    <Card className="mt-4 p-6">
      <div className="mb-2 flex items-center gap-2">
        <Percent className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Bróker díjak</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Vételi és eladási díj brókerenként. Akkor számít, ha a célpálya
        csoportszabálya (vagy az állampapír saját visszaváltási díja) nem ad
        díjat — pl. a célpályán kívüli DCA-vételeknél. Sorrend: csoportszabály →
        bróker → a célpálya általános díja → 0. Üres = nincs megadva.
      </p>
      <div className="space-y-3">
        {providers.map((p) => (
          <div key={p} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-28 font-medium">{providerLabel(p)}</span>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">vétel</span>
              <PctInput
                value={fees[p]?.buy?.pct}
                onChange={(v) => set(p, "buy", v)}
                placeholder="–"
              />
              <span className="text-xs text-[var(--color-muted)]">%</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">eladás</span>
              <PctInput
                value={fees[p]?.sell?.pct}
                onChange={(v) => set(p, "sell", v)}
                placeholder="–"
              />
              <span className="text-xs text-[var(--color-muted)]">%</span>
            </label>
          </div>
        ))}
      </div>
    </Card>
  );
}
