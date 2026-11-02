import { useState } from "react";
import { CircleCheck, Pencil, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import InfoTip from "./InfoTip";
import { Badge, Card } from "./ui";
import { useAllRefills, useMonthlyBudget, useRefillProgress, useValuedInstruments } from "../lib/store";
import {
  refillFinishLabel,
  refillMonthHuf,
  saveRefills,
  type RefillGoal,
  type RefillProgress,
  type RefillStatus,
} from "../lib/refill";
import { formatDate, formatMoney } from "../lib/format";
import { todayLocal } from "../lib/day";
import RefillEditorDialog from "./refill/RefillEditorDialog";

const STATUS: Record<RefillStatus, { tone: "neutral" | "brand" | "positive" | "warning"; text: string }> = {
  planned: { tone: "neutral", text: "Tervezett kivét" },
  awaiting: { tone: "warning", text: "Importálásra vár" },
  refilling: { tone: "brand", text: "Visszapótlás folyik" },
  done: { tone: "positive", text: "Visszapótolva" },
};

function paceText(g: RefillGoal): string {
  const p = g.pace;
  if (p.kind === "months") return `${p.months} hónap alatt`;
  if (p.kind === "monthly") return `havi ${formatMoney(p.huf)}`;
  return "minél hamarabb";
}

/**
 * Refill goals ("Visszapótlás"): money taken (or to be taken) out of the
 * portfolio, put back by the monthly saving first. Each card: the withdrawal
 * (day, source, cash; for a bond the face sold), how much is back, this
 * month's part and when it ends at its pace.
 */
export default function RefillTargets() {
  const all = useAllRefills();
  const progress = useRefillProgress();
  const { breakdown } = useMonthlyBudget();
  const [editing, setEditing] = useState<string | "new" | null>(null);

  const persist = (next: RefillGoal[]) => saveRefills(next);
  const closed = all.filter((g) => g.closedAt);
  const edited = editing && editing !== "new" ? all.find((g) => g.id === editing) : undefined;

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Undo2 className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Visszapótlás</h2>
        <InfoTip>
          Ha pénzt veszel ki a portfólióból (most vagy egy későbbi napon), itt beállíthatod, hogy a havi
          megtakarítás a szokásos elosztás helyett először ezt pótolja vissza — alapból a célpálya szerint.
          Állampapírnál az app a kivét napjára kiszámolja az eladandó névértéket, és a célokhoz rendelt
          kuponokat már előre a kisebb összeggel számolja.
        </InfoTip>
        <button className="btn-ghost ml-auto text-sm" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> Új kivét
        </button>
      </div>

      {progress.length === 0 && closed.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          Nincs visszapótlandó kivét. Ha hozzá kell nyúlnod a portfólióhoz, vedd fel itt: mikor, miből és
          mennyit — az app megmutatja, mit jelent, és beütemezi a visszapótlást.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-4">
          {progress.map((p) => (
            <RefillCard
              key={p.goal.id}
              p={p}
              budgetHuf={breakdown.budgetHuf}
              onEdit={() => setEditing(p.goal.id)}
              onClose={() => persist(all.map((g) => (g.id === p.goal.id ? { ...g, closedAt: todayLocal() } : g)))}
              onRemove={() => persist(all.filter((g) => g.id !== p.goal.id))}
            />
          ))}
          {closed.map((g) => (
            <div key={g.id} className="rounded-xl border border-[var(--color-border)] p-3 opacity-60">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="priv font-medium">{g.name}</span>
                  <div className="text-xs text-[var(--color-muted)]">
                    Lezárva {formatDate(g.closedAt!)} · kivét {formatDate(g.withdrawal.day)},{" "}
                    <span className="amt">{formatMoney(g.withdrawal.amountHuf)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    title="Újranyitás"
                    aria-label="Újranyitás"
                    onClick={() =>
                      persist(
                        all.map((x) => {
                          if (x.id !== g.id) return x;
                          const { closedAt: _c, ...rest } = x;
                          return rest;
                        }),
                      )
                    }
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                    title="Törlés"
                    aria-label="Törlés"
                    onClick={() => persist(all.filter((x) => x.id !== g.id))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (editing === "new" || edited) && (
        <RefillEditorDialog
          goal={edited}
          goals={all}
          onSave={(g) => persist(all.some((x) => x.id === g.id) ? all.map((x) => (x.id === g.id ? g : x)) : [...all, g])}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function RefillCard({
  p,
  budgetHuf,
  onEdit,
  onClose,
  onRemove,
}: {
  p: RefillProgress;
  budgetHuf: number;
  onEdit: () => void;
  onClose: () => void;
  onRemove: () => void;
}) {
  const g = p.goal;
  const instruments = useValuedInstruments();
  const [confirming, setConfirming] = useState<"close" | "remove" | null>(null);
  const status = STATUS[p.status];
  const finish = refillFinishLabel(p, budgetHuf);
  const w = g.withdrawal;
  const targetName =
    g.target.kind === "instrument" ? (instruments.find((i) => i.key === p.buyKey)?.name ?? p.targetLabel) : p.targetLabel;

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3" data-testid="refill-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="priv font-medium">{g.name}</span>
            <Badge tone={status.tone}>{status.text}</Badge>
          </div>
          <div className="text-xs text-[var(--color-muted)]">
            Kivét: {formatDate(p.withdrawnDay)} ·{" "}
            <span className={g.withdrawal.source.kind === "cash" ? "priv" : undefined}>{p.sourceLabel}</span> · <span className="amt">{formatMoney(w.amountHuf)}</span>
            {w.faceHuf != null && (
              <>
                {" "}
                (névérték <span className="amt">{formatMoney(w.faceHuf)}</span>
                {(w.costHuf ?? 0) >= 1 && (
                  <>
                    , költség <span className="amt">{formatMoney(w.costHuf!)}</span>
                  </>
                )}
                )
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
            onClick={onEdit}
            title="Szerkesztés"
            aria-label="Visszapótlás szerkesztése"
          >
            <Pencil className="h-4 w-4" />
          </button>
          {confirming ? (
            <span className="flex items-center gap-1 text-xs">
              <button
                className={`underline ${confirming === "remove" ? "text-[var(--color-negative)]" : "text-[var(--color-brand)]"}`}
                onClick={confirming === "remove" ? onRemove : onClose}
              >
                {confirming === "remove" ? "Törlés" : "Lezárás"}
              </button>
              <button className="text-[var(--color-muted)] underline" onClick={() => setConfirming(null)}>
                Mégse
              </button>
            </span>
          ) : (
            <>
              <button
                className="text-[var(--color-muted)] hover:text-[var(--color-positive)]"
                onClick={() => setConfirming("close")}
                title="Lezárás (visszapótolva vagy elengedted)"
                aria-label="Visszapótlás lezárása"
              >
                <CircleCheck className="h-4 w-4" />
              </button>
              <button
                className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                onClick={() => setConfirming("remove")}
                title="Törlés"
                aria-label="Visszapótlás törlése"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
        <div className="h-full bg-[var(--color-brand)]" style={{ width: `${Math.round(p.ratio * 100)}%` }} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Num label="Visszakerült" value={formatMoney(p.refilledHuf)} sub={`${Math.round(p.ratio * 100)}%`} />
        <Num label="Hátra" value={formatMoney(p.remainingHuf)} />
        <Num label="E hónapban" value={formatMoney(refillMonthHuf(p, budgetHuf))} />
      </div>

      <div className="mt-2 text-xs text-[var(--color-muted)]">
        → {targetName} · {paceText(g)}
        {p.status !== "done" && finish && ` · várhatóan ${finish}-ig kész`}
        {g.includeCost && " · a költséggel együtt"}
      </div>
      {p.sourceUnbuyable && (
        <div className="mt-1 text-xs text-[var(--color-muted)]">
          A forrás már nem vásárolható: {p.viaGlide ? "a célpálya az eszközcsoportján belül osztja el." : "válassz más célt."}
        </div>
      )}
      {p.status === "planned" && (
        <div className="mt-1 text-xs text-[var(--color-muted)]">
          A kivét napjától a havi terv először ezt pótolja vissza. A dátum utáni kuponok már most a kisebb
          névértékkel számolnak.
        </div>
      )}
      {p.status === "awaiting" && (
        <div className="mt-1 text-xs text-[var(--color-warning,#fbbf24)]">
          A kivét napja elmúlt, de az eladás még nincs a nyilvántartásban — importáld a kivonatot.
        </div>
      )}
      {p.status === "done" && (
        <div className="mt-1 text-xs text-[var(--color-positive)]">Visszakerült a teljes összeg — lezárhatod.</div>
      )}
    </div>
  );
}

function Num({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-surface-2)] px-2 py-1.5">
      <div className="text-[var(--color-muted)]">{label}</div>
      <div className="amt font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}
