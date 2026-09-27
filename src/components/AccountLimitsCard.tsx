import { useState } from "react";
import { Lock } from "lucide-react";
import type { Account } from "../lib/model";
import { useAccountLimits } from "../lib/store";
import { saveAccountLimits } from "../lib/planPrefs";
import { tbszLimitSuggestion, type AccountLimit } from "../lib/accountRules";
import { Card } from "./ui";

const INPUT =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm";
const LABEL = "text-xs text-[var(--color-muted)]";

/**
 * "Számlakorlátok": until when money may not leave the account, and from when
 * it takes no deposits — the monthly plan and the band rule respect both.
 * Synced; a TBSZ gets a one-click prefill (saved only with "Mentés").
 */
export default function AccountLimitsCard({ account }: { account: Account }) {
  const limits = useAccountLimits();
  const saved = limits[account.id] ?? {};
  const [draft, setDraft] = useState<AccountLimit | null>(null);
  const cur = draft ?? saved;
  const suggestion = tbszLimitSuggestion(account);
  const set = (patch: Partial<AccountLimit>) => setDraft({ ...cur, ...patch });

  const save = () => {
    const clean: AccountLimit = {};
    if (cur.noOutflowUntil) {
      clean.noOutflowUntil = cur.noOutflowUntil;
      if (cur.noOutflowNote?.trim()) clean.noOutflowNote = cur.noOutflowNote.trim();
    }
    if (cur.noDepositFrom) {
      clean.noDepositFrom = cur.noDepositFrom;
      if (cur.noDepositNote?.trim()) clean.noDepositNote = cur.noDepositNote.trim();
    }
    const next = { ...limits };
    if (Object.keys(clean).length) next[account.id] = clean;
    else delete next[account.id];
    saveAccountLimits(next);
    setDraft(null);
  };

  return (
    <Card className="mt-6 p-5">
      <div className="mb-2 flex items-center gap-2">
        <Lock className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Számlakorlátok</h2>
      </div>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        A havi terv és a sávszabály ezeket betartja: nem javasol pénzkivitelt a
        számláról a megadott napig, és nem javasol befizetést a megadott naptól.
        Üresen nincs korlát.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <div className={LABEL}>A pénz nem hagyhatja el a számlát eddig (ezt a napot is beleértve)</div>
          <input
            type="date"
            className={INPUT}
            value={cur.noOutflowUntil ?? ""}
            onChange={(e) => set({ noOutflowUntil: e.target.value || undefined })}
          />
          <input
            type="text"
            className={`${INPUT} w-full`}
            placeholder="megjegyzés (opcionális)"
            value={cur.noOutflowNote ?? ""}
            onChange={(e) => set({ noOutflowNote: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <div className={LABEL}>Befizetés nem lehetséges ettől a naptól</div>
          <input
            type="date"
            className={INPUT}
            value={cur.noDepositFrom ?? ""}
            onChange={(e) => set({ noDepositFrom: e.target.value || undefined })}
          />
          <input
            type="text"
            className={`${INPUT} w-full`}
            placeholder="megjegyzés (opcionális)"
            value={cur.noDepositNote ?? ""}
            onChange={(e) => set({ noDepositNote: e.target.value })}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-primary text-sm" disabled={!draft} onClick={save}>
          Mentés
        </button>
        {draft && (
          <button className="btn-ghost text-sm" onClick={() => setDraft(null)}>
            Mégse
          </button>
        )}
        {suggestion && (
          <button
            className="btn-ghost text-sm"
            onClick={() => setDraft({ ...cur, ...suggestion })}
            title="Előtölti a TBSZ szabályai szerint — csak a Mentés után él."
          >
            TBSZ-javaslat: befizetés {suggestion.noDepositFrom}-tól tilos, kivét{" "}
            {suggestion.noOutflowUntil}-ig tilos
          </button>
        )}
      </div>
    </Card>
  );
}
