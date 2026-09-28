import { PiggyBank } from "lucide-react";
import { useLeftoverSettings } from "../../lib/store";
import { saveLeftoverSettings, type LeftoverSettings as Settings } from "../../lib/planPrefs";
import { Card } from "../ui";

/**
 * Month-end leftover: the bot's reminder on the month's last working day and
 * the pull-forward rule of the split (Teendők → Havi terv → "Maradt pénz a
 * hónapból?"). Synced, so the bot reads the same settings.
 */
export default function LeftoverSettings() {
  const s = useLeftoverSettings();
  const set = (patch: Partial<Settings>) => saveLeftoverSettings({ ...s, ...patch });
  const input =
    "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm tabular-nums";

  return (
    <Card className="mt-4 p-6">
      <div className="mb-2 flex items-center gap-2">
        <PiggyBank className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Hónap végi maradék</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Ha egy hónapban marad pénz, a Havi terv alatti mezőben (vagy a botnak
        küldött <code>/maradek 50000</code> paranccsal) javaslatot kapsz, mire
        menjen: a hónap még hiányzó célrészei, a közeli határidős célok
        következő havi része, végül a célpálya.
      </p>
      <div className="space-y-3 text-sm">
        <label className="flex flex-wrap items-center gap-2">
          <input type="checkbox" checked={s.notify} onChange={(e) => set({ notify: e.target.checked })} />
          Telegram-emlékeztető a hónap utolsó munkanapján
          <input
            type="time"
            value={s.time}
            disabled={!s.notify}
            onChange={(e) => {
              if (/^\d{2}:\d{2}$/.test(e.target.value)) set({ time: e.target.value });
            }}
            className={input}
          />
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            checked={s.pullForward}
            onChange={(e) => set({ pullForward: e.target.checked })}
          />
          A határidős célok következő havi részének előrehozása, ha a céldátum
          <input
            type="number"
            min={1}
            max={24}
            value={s.pullForwardMonths}
            disabled={!s.pullForward}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 24) set({ pullForwardMonths: v });
            }}
            className={`${input} w-16 text-right`}
          />
          hónapon belül van
        </label>
      </div>
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Az utolsó munkanap a magyar munkanap-naptár szerint (hétvége, ünnepnap,
        áthelyezett munkanap) — ugyanaz a nap, amelytől az app a vételeket már a
        következő hónaphoz számítja. Ha a hónapra már rögzítettél maradékot, a
        bot csak jelzi, nem kérdez újra.
      </p>
    </Card>
  );
}
