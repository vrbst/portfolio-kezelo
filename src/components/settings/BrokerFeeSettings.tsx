import { Percent } from "lucide-react";
import { usePortfolio, useBrokerFees } from "../../lib/store";
import { providerLabel } from "../../lib/incomeFlow";
import { saveBrokerFees, type BrokerFee } from "../../lib/planPrefs";
import type { Cost } from "../../lib/glidePath";
import { AmountInput, Card } from "../ui";
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
    store(provider, cur);
  };

  /** Keep a provider only while it has any fee set. */
  const store = (provider: string, fee: BrokerFee) => {
    const next = { ...fees };
    const empty = !fee.buy && !fee.sell && fee.fxPct == null && fee.transferFixedHuf == null;
    if (empty) delete next[provider];
    else next[provider] = fee;
    saveBrokerFees(next);
  };
  const setMove = (provider: string, patch: Pick<BrokerFee, "fxPct" | "transferFixedHuf">) => {
    const v = "fxPct" in patch ? patch.fxPct : patch.transferFixedHuf;
    if (v != null && !(Number.isFinite(v) && v >= 0)) return;
    const cur: BrokerFee = { ...(fees[provider] ?? {}), ...patch };
    if (cur.fxPct == null) delete cur.fxPct;
    if (cur.transferFixedHuf == null) delete cur.transferFixedHuf;
    store(provider, cur);
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
        bróker → a célpálya általános díja → 0. Üres = nincs megadva. A
        devizaváltás akkor számít, ha a pénz devizája eltér a vett papírétól
        (pl. forint-befizetésből EUR-os ETF) — ha a vételi díjad eddig ezt is
        tartalmazta, csökkentsd. Az utalási díj a számláról kiutalt pénzre jár.
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
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">devizaváltás</span>
              <PctInput
                value={fees[p]?.fxPct}
                onChange={(v) => setMove(p, { fxPct: v })}
                placeholder="–"
              />
              <span className="text-xs text-[var(--color-muted)]">%</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">utalás</span>
              <AmountInput
                value={fees[p]?.transferFixedHuf != null ? String(fees[p].transferFixedHuf) : ""}
                onValueChange={(raw) =>
                  setMove(p, { transferFixedHuf: raw === "" ? undefined : Number(raw) })
                }
                className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
              />
              <span className="text-xs text-[var(--color-muted)]">Ft</span>
            </label>
          </div>
        ))}
      </div>
    </Card>
  );
}
