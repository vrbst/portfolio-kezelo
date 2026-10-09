import { Delta, HoverPopup } from "../ui";
import { formatMoney, formatPercent } from "../../lib/format";
import type { ReturnParts } from "../../lib/holdingReturn";


function TipRow({ label, value, pct, sign }: { label: string; value: string; pct?: number; sign: number }) {
  const color = sign >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]";
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className={`whitespace-nowrap tabular-nums ${color}`}>
        <span className="amt">{value}</span>
        {pct != null && <span className="ml-1 opacity-80">{formatPercent(pct)}</span>}
      </span>
    </div>
  );
}

export function ReturnRows({ r }: { r: ReturnParts }) {
  return (
    <>
      <TipRow label="Teljes hozam" value={formatMoney(r.total, "HUF", { sign: true })} pct={r.totalPct} sign={r.total} />
      {r.ccyReturn != null && (
        <TipRow
          label={`Jegyzési deviza hozam (${r.currency})`}
          value={formatMoney(r.ccyReturn, r.currency, { sign: true })}
          pct={r.ccyPct}
          sign={r.ccyReturn}
        />
      )}
      {r.fxEffect != null && (
        <TipRow
          label="Devizahatás"
          value={formatMoney(r.fxEffect, "HUF", { sign: true })}
          pct={r.fxPct}
          sign={r.fxEffect}
        />
      )}
    </>
  );
}

export default function ReturnBreakdown({ r }: { r: ReturnParts | null }) {
  if (!r) return <span className="text-[var(--color-muted)]">—</span>;
  const pill = (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 ${
        r.total >= 0 ? "bg-[var(--color-positive)]/10" : "bg-[var(--color-negative)]/10"
      }`}
    >
      <Delta value={r.total} pct={r.totalPct} className="text-xs" />
    </span>
  );
  if (r.ccyReturn == null && r.fxEffect == null) return pill;
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <HoverPopup
        content={
          <div className="text-xs">
            <div className="mb-1.5 font-medium">Hozam összetétele</div>
            <ReturnRows r={r} />
          </div>
        }
      >
        {pill}
      </HoverPopup>
    </span>
  );
}
