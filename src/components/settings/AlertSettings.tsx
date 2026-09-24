import { useState } from "react";
import {
Bell
} from "lucide-react";
import { usePortfolio } from "../../lib/store";
import { Card,AmountInput } from "../ui";


export default function AlertSettings() {
  const idleCashHuf = usePortfolio((s) => s.alertConfig.idleCashHuf);
  const tbszCheck = usePortfolio((s) => s.alertConfig.tbszCheck);
  const setIdleCashThreshold = usePortfolio((s) => s.setIdleCashThreshold);
  const setTbszCheckEnabled = usePortfolio((s) => s.setTbszCheckEnabled);
  const [draft, setDraft] = useState(String(idleCashHuf));

  function commit() {
    const v = Number(draft.replace(/\s/g, ""));
    if (Number.isFinite(v) && v > 0) setIdleCashThreshold(v);
    else setDraft(String(idleCashHuf));
  }

  return (
    <Card className="mt-4 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Figyelmeztetések</h2>
      </div>

      <label className="mb-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={tbszCheck}
          onChange={(e) => setTbszCheckEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand)]"
        />
        <span>
          <span className="text-sm">Idei TBSZ-nyitás ellenőrzése</span>
          <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
            Figyelmeztet, ha az idei gyűjtőévre még nincs TBSZ-ed (és zöld
            „Rendben" jelzést ad, ha megvan). Kikapcsolva egyik sem jelenik meg.
          </span>
        </span>
      </label>

      <div className="max-w-sm">
        <label className="flex flex-col gap-1">
          <span className="text-sm">Parlagon álló készpénz küszöbe</span>
          <span className="text-xs text-[var(--color-muted)]">
            Ha egy számlán ennél több készpénz áll, figyelmeztetés jelenik meg.
          </span>
          <div className="mt-1 flex items-center gap-2">
            <AmountInput
              value={draft}
              onValueChange={setDraft}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-right text-sm tabular-nums"
            />
            <span className="text-sm text-[var(--color-muted)]">Ft</span>
          </div>
        </label>
      </div>
      <p className="mt-4 text-xs text-[var(--color-muted)]">
        A figyelmeztetések állapota (elvetés) a felhős szinkronon át minden
        eszközödön egységes. A küszöb eszközönként állítható.
      </p>
    </Card>
  );
}
