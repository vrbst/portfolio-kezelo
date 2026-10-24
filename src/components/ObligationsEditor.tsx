import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Obligation } from "../lib/forecast";
import { todayLocal } from "../lib/day";
import { formatMoney } from "../lib/format";
import { AmountInput } from "./ui";
import InfoTip from "./InfoTip";

const FIELD =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm";

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** "2027-05" → "2027. 05." */
const label = (m: string) => `${m.slice(0, 4)}. ${m.slice(5, 7)}.`;

/** The month after "YYYY-MM". */
const after = (m: string) => {
  const y = +m.slice(0, 4);
  const mo = +m.slice(5, 7);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};

/**
 * Known fixed monthly costs that end (an instalment, a lease). When one is paid
 * off, its amount is free to save: the forecast steps the monthly saving up.
 * The name is personal, so it blurs in privacy mode with the amounts.
 */
export default function ObligationsEditor({
  value,
  onChange,
}: {
  value: Obligation[];
  onChange: (next: Obligation[]) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState("");
  const thisMonth = todayLocal().slice(0, 7);

  const monthly = Number(amount.replace(/\s/g, "").replace(",", "."));
  const valid = Number.isFinite(monthly) && monthly > 0 && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= thisMonth;

  function add() {
    if (!valid) return;
    onChange(
      [...value, { id: newId(), name: name.trim() || undefined, monthlyHuf: monthly, endMonth: month }].sort((a, b) =>
        a.endMonth.localeCompare(b.endMonth),
      ),
    );
    setName("");
    setAmount("");
    setMonth("");
  }

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-3" data-testid="obligations">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)]">
        Lejáró kötelezettségek
        <InfoTip>
          Ismert, fix havi költség, ami véget ér (részlet, lízing). Lejárata után a havi megtakarítás ennyivel nő az
          előrejelzésben. A fenti havi összeg a mostani, még terhelt szint legyen.
        </InfoTip>
      </p>

      {value.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-sm">
          {value.map((o) => {
            const over = o.endMonth < thisMonth;
            return (
              <li key={o.id} data-testid="obligation" className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 ${over ? "opacity-50" : ""}`}>
                <span className="priv font-medium">{o.name || "Kötelezettség"}</span>
                <span className="amt tabular-nums">{formatMoney(o.monthlyHuf)}/hó</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {over ? "lejárt" : `utolsó fizetés ${label(o.endMonth)}, ${label(after(o.endMonth))}-tól szabad`}
                </span>
                <button
                  className="btn-ghost ml-auto"
                  aria-label={`${o.name || "Kötelezettség"} törlése`}
                  onClick={() => onChange(value.filter((x) => x.id !== o.id))}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Név (pl. lízing)"
          aria-label="Kötelezettség neve"
          className={`${FIELD} min-w-0 flex-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <AmountInput
          placeholder="Havi összeg (Ft)"
          aria-label="Kötelezettség havi összege"
          className={`${FIELD} w-32 text-right tabular-nums`}
          value={amount}
          onValueChange={setAmount}
        />
        <input
          type="month"
          aria-label="Utolsó fizetés hónapja"
          className={FIELD}
          min={thisMonth}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
        <button className="btn-ghost" onClick={add} disabled={!valid} aria-label="Kötelezettség hozzáadása">
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
