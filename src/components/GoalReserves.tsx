import { useState } from "react";
import { AlertTriangle, Plus, Trash2, Wallet } from "lucide-react";
import { usePortfolio, useToday } from "../lib/store";
import {
  settleReserveConflict,
  type CashReserve,
  type ReserveConflict,
  type SavingsGoal,
  type SavingsProgress,
} from "../lib/savings";
import { accountLabel } from "../lib/accountRules";
import { AmountInput, Amt } from "./ui";
import { formatDate, formatMoney } from "../lib/format";

const INPUT =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs";

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * "Félretett készpénz" on a savings goal card: cash set aside by hand (it
 * counts toward the goal and is not free cash for investing), the money
 * counted automatically (a matured payout, coupons in the hold-cash window),
 * and a warning when a buy of the goal's instrument may have been paid from
 * a reserve — answered with one click, never lowered automatically.
 */
export default function GoalReserves({
  progress: p,
  conflicts,
  onChange,
}: {
  progress: SavingsProgress;
  conflicts: ReserveConflict[];
  onChange: (patch: Partial<SavingsGoal>) => void;
}) {
  const g = p.goal;
  const accounts = usePortfolio((s) => s.accounts);
  const today = useToday();
  const reserves = g.reserves ?? [];
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");

  const labelOf = (id?: string) => {
    const a = id ? accounts.find((x) => x.id === id) : undefined;
    return a ? accountLabel(a) : "bankszámla / máshol";
  };
  const setReserves = (next: CashReserve[]) => onChange({ reserves: next });
  const add = () => {
    const huf = Number(amount);
    if (!(huf > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setReserves([
      ...reserves,
      {
        id: newId(),
        amountHuf: Math.round(huf),
        date,
        accountId: accountId || undefined,
        note: note.trim() || undefined,
      },
    ]);
    setAmount("");
    setNote("");
  };
  const papers = p.assignedValueHuf - p.autoCashHuf - p.reservedHuf;

  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] p-2 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Wallet className="h-3.5 w-3.5 text-[var(--color-brand)]" /> Félretett készpénz
      </div>
      <div className="mb-1 text-[var(--color-muted)]">
        Most a célra: papírok <Amt>{formatMoney(papers)}</Amt>
        {p.autoCashHuf >= 1 && (
          <>
            {" "}· automatikusan <Amt>{formatMoney(p.autoCashHuf)}</Amt>
          </>
        )}{" "}
        · félretéve <Amt>{formatMoney(p.reservedHuf)}</Amt>
      </div>
      {p.autoCashHuf >= 1 && (
        <p className="mb-1 text-[var(--color-muted)]">
          Az „automatikusan” rész a lejárt papír kifizetése, a tartási
          időszakban jóváírt kamat és a célhoz rendelt, már jóváírt kupon —
          ezeket ne rögzítsd félretételként.
        </p>
      )}

      {conflicts.map((c) => (
        <div
          key={c.buyTxId}
          className="mb-1 rounded-lg border border-[var(--color-warning,#fbbf24)]/40 bg-[var(--color-warning,#fbbf24)]/5 p-2"
        >
          <div className="flex items-start gap-1.5 text-[var(--color-warning,#fbbf24)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Lehetséges kettős számolás: vétel <Amt>{formatMoney(c.buyHuf)}</Amt> (
              {formatDate(c.buyDay)}), félretétel <Amt>{formatMoney(c.reserveHuf)}</Amt> ugyanazon a
              számlán — felhasználtad a félretett pénzt?
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button
              className="btn-ghost text-xs"
              onClick={() => onChange({ reserves: settleReserveConflict(g, c, true).reserves })}
            >
              Igen — csökkentsd {formatMoney(Math.min(c.buyHuf, c.reserveHuf))}-tal
            </button>
            <button
              className="btn-ghost text-xs"
              onClick={() => onChange({ reserves: settleReserveConflict(g, c, false).reserves })}
            >
              Nem, külön pénzből volt
            </button>
          </div>
        </div>
      ))}

      {reserves.length > 0 && (
        <ul className="mb-1 space-y-1">
          {[...reserves]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                <span className="tabular-nums text-[var(--color-muted)]">{formatDate(r.date)}</span>
                <AmountInput
                  className={`${INPUT} w-24 text-right tabular-nums`}
                  value={String(r.amountHuf)}
                  onValueChange={(v) =>
                    setReserves(reserves.map((x) => (x.id === r.id ? { ...x, amountHuf: Number(v) || 0 } : x)))
                  }
                />
                <span>Ft · {labelOf(r.accountId)}</span>
                {r.note && <span className="text-[var(--color-muted)]">· {r.note}</span>}
                {r.date > today && <span className="text-[var(--color-muted)]">(még nem számít)</span>}
                <button
                  className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                  onClick={() => setReserves(reserves.filter((x) => x.id !== r.id))}
                  title="Félretétel törlése"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <AmountInput
          placeholder="Összeg (Ft)"
          className={`${INPUT} w-24 text-right tabular-nums`}
          value={amount}
          onValueChange={setAmount}
        />
        <select className={INPUT} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">bankszámla / máshol</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(a)}
            </option>
          ))}
        </select>
        <input type="date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
        <input
          type="text"
          className={`${INPUT} min-w-[6rem] flex-1`}
          placeholder="megjegyzés (opcionális)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn-ghost text-xs" onClick={add} disabled={!(Number(amount) > 0)}>
          <Plus className="h-3.5 w-3.5" /> Félretettem
        </button>
      </div>
      <p className="mt-1 text-[var(--color-muted)]">
        A félretett összeg a céldátumig a célba számít, és a számláján nem számít
        szabad készpénznek (nem javasol belőle befektetést). Parlagon álló
        készpénzként csak akkor nem jelez, ha a céldátum a beállított türelmi
        időn (alapból 30 nap) belül van. Ha belőle veszed meg a cél papírját,
        csökkentsd.
      </p>
    </div>
  );
}
