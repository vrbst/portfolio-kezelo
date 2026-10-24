import type { CashflowItem } from "../lib/cashflow";
import { formatDate, formatMoney } from "../lib/format";

/**
 * The single items of one category: each can be taken out of the figures. Kept
 * on this device only (see cashflowItems.ts); the note and the account are
 * personal, so they blur in privacy mode.
 */
export default function CashflowItemList({
  name,
  items,
  skipped,
  onToggle,
}: {
  name: string;
  items: CashflowItem[];
  /** Ids of the items taken out. */
  skipped: Set<string>;
  onToggle: (item: CashflowItem) => void;
}) {
  const out = items.filter((i) => skipped.has(i.id)).length;
  return (
    <div className="bg-[var(--color-surface)]/50">
      <p className="px-4 py-2 text-xs text-[var(--color-muted)]" data-testid="cf-items-summary">
        {items.length} tétel{out > 0 ? `, ebből ${out} kihúzva` : ""}. A kihúzott tétel nem számít bele az összegekbe.
      </p>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--color-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-4 py-1.5 font-medium">Számít</th>
              <th className="px-2 py-1.5 font-medium">Dátum</th>
              <th className="px-2 py-1.5 text-right font-medium">Összeg</th>
              <th className="px-2 py-1.5 font-medium">Számla</th>
              <th className="px-2 py-1.5 font-medium">Megjegyzés</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const isOut = skipped.has(it.id);
              return (
                <tr
                  key={it.id}
                  data-testid="cf-item"
                  className={`border-b border-[var(--color-border)]/40 last:border-0 ${isOut ? "line-through opacity-50" : ""}`}
                >
                  <td className="px-4 py-1.5">
                    <input
                      type="checkbox"
                      checked={!isOut}
                      onChange={() => onToggle(it)}
                      aria-label={`${name}: ${it.day} tétel beleszámít (${it.note || "megjegyzés nélkül"})`}
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{formatDate(it.day)}</td>
                  <td className="amt whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatMoney(it.huf)}</td>
                  <td className="priv px-2 py-1.5 text-[var(--color-muted)]">{it.account}</td>
                  <td className="priv px-2 py-1.5">{it.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
