import InfoTip from "../InfoTip";
import { Send } from "lucide-react";
import { useNotifySettings } from "../../lib/store";
import {
  DEFAULT_NOTIFY,
  saveNotifySettings,
  type AiMode,
  type NotifyKind,
  type NotifySettings as Settings,
} from "../../lib/planPrefs";
import { Card } from "../ui";
import PctInput from "../PctInput";

const input =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm tabular-nums";

const GROUPS: { title: string; items: [NotifyKind, string][] }[] = [
  {
    title: "Teendők és figyelmeztetések",
    items: [
      ["alerts", "Új teendő (az app figyelmeztetései)"],
      ["deepGlide", "Tovább mélyült célpálya-eltérés"],
      ["bondNotices", "Kötvény-értesítések"],
      ["stale", "Elavult szinkron / árfolyamfájl"],
      ["stalePrices", "Elavult papír-árfolyam"],
      ["fundamentals", "Papír-adatok (P/E, szektorok) frissítési hibái"],
      ["priceAlerts", "Árriasztások (/riasztas)"],
    ],
  },
  {
    title: "Mozgások",
    items: [
      ["portfolioMove", "Nagy mozgás: a teljes portfólió"],
      ["positionMove", "Nagy mozgás: egy papír és az EUR/HUF"],
    ],
  },
  {
    title: "Vagyon és célok",
    items: [
      ["goalMilestones", "Célok mérföldkövei"],
      ["wealthPeak", "Vagyon-mérföldkő átlépése"],
      ["drawdown", "Visszaesés a csúcstól és felépülés"],
    ],
  },
  {
    title: "Jelentések",
    items: [
      ["weekly", "Heti jelentés"],
      ["monthly", "Havi zárás"],
      ["yearly", "Éves összefoglaló"],
      ["tax", "Adóemlékeztető (május)"],
      ["planReminder", "Havi terv emlékeztető"],
    ],
  },
];

const AI_LABEL: Record<AiMode, string> = {
  off: "Ki (nem fut)",
  silent: "Csak az appba",
  notify: "Telegramra is",
};

/**
 * Which Telegram messages the bot sends and when — one switch per type, the
 * thresholds that have no card of their own, the report times, the AI jobs and
 * the quiet hours. Synced: the bot reads the same settings from the cloud copy.
 */
export default function NotifySettings() {
  const s = useNotifySettings();
  const set = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    for (const k of ["wealthStepHuf", "drawdownStepPct"] as const)
      if (next[k] === undefined) delete next[k];
    saveNotifySettings(next);
  };
  const toggle = (kind: NotifyKind, on: boolean) => {
    const off = { ...s.off };
    if (on) delete off[kind];
    else off[kind] = true;
    set({ off });
  };
  const setAi = (patch: Partial<Settings["ai"]>) => set({ ai: { ...s.ai, ...patch } });
  const aiSelect = (label: string, key: "newsMorning" | "newsEvening" | "analysis") => (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-48">{label}</span>
      <select
        value={s.ai[key]}
        onChange={(e) => setAi({ [key]: e.target.value as AiMode })}
        className={input}
        aria-label={label}
      >
        {(Object.keys(AI_LABEL) as AiMode[]).map((m) => (
          <option key={m} value={m}>
            {AI_LABEL[m]}
          </option>
        ))}
      </select>
    </label>
  );
  const hour = (label: string, value: number, field: "weeklyHour" | "monthlyHour") => (
    <label className="flex items-center gap-2">
      {label}
      <input
        type="number"
        min={0}
        max={23}
        value={value}
        onChange={(e) => {
          const v = Math.round(Number(e.target.value));
          if (e.target.value !== "" && v >= 0 && v <= 23) set({ [field]: v });
        }}
        className={`${input} w-16 text-right`}
        aria-label={label}
      />
      óra
    </label>
  );

  return (
    <Card className="mt-4 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Send className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Telegram-értesítések</h2>
        <InfoTip>
          Mely üzeneteket küldje a bot, és mikor. A kikapcsolt típus nem küld
          üzenetet, de a háttérben az állapota követi az eseményeket: ha később
          visszakapcsolod, nem zúdul rád a közben felgyűlt múlt. Szinkronizálódik,
          a bot is ezt használja (legfeljebb pár percet késik). Amit te kérsz a
          boton (parancs, <code>/hirkereses</code>), az mindig megjön. A nagy
          mozgás küszöbei és a hónap végi maradék külön kártyán állnak.
        </InfoTip>
      </div>

      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="space-y-1.5 text-sm">
            <legend className="mb-1 text-xs text-[var(--color-muted)]">{g.title}</legend>
            {g.items.map(([kind, label]) => (
              <label key={kind} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!s.off[kind]}
                  onChange={(e) => toggle(kind, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        ))}
      </div>

      <div className="mt-5 grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        <label className="flex items-center gap-2">
          Vagyon-mérföldkő lépcsője
          <input
            type="number"
            min={1}
            step={100000}
            value={s.wealthStepHuf ?? ""}
            placeholder="1000000"
            onChange={(e) => {
              const v = Number(e.target.value);
              set({ wealthStepHuf: e.target.value !== "" && v > 0 ? v : undefined });
            }}
            className={`${input} amt w-32 text-right`}
            aria-label="Vagyon-mérföldkő lépcsője (Ft)"
          />
          Ft
        </label>
        <label className="flex items-center gap-2">
          Visszaesés-jelzés lépcsője
          <PctInput
            key={String(s.drawdownStepPct)}
            label="Visszaesés-jelzés lépcsője"
            value={s.drawdownStepPct}
            placeholder={5}
            onCommit={(v) => set({ drawdownStepPct: v })}
          />
        </label>
        {hour("Heti jelentés péntek", s.weeklyHour, "weeklyHour")}
        {hour("Havi és éves jelentés az 1-jén", s.monthlyHour, "monthlyHour")}
        <label className="flex items-center gap-2">
          Havi terv emlékeztető
          <input
            type="number"
            min={1}
            max={28}
            value={s.planReminderDay}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (e.target.value !== "" && v >= 1 && v <= 28) set({ planReminderDay: v });
            }}
            className={`${input} w-16 text-right`}
            aria-label="Havi terv emlékeztető napja"
          />
          . naptól
        </label>
      </div>

      <div className="mt-5 space-y-2 text-sm">
        <div className="text-xs text-[var(--color-muted)]">AI-feladatok</div>
        {aiSelect("Reggeli piaci előzetes", "newsMorning")}
        {aiSelect("Esti piaci napzárta", "newsEvening")}
        {aiSelect("Éjszakai AI-elemzés", "analysis")}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.ai.why === "notify"}
            onChange={(e) => setAi({ why: e.target.checked ? "notify" : "off" })}
          />
          „Miért mozdult?” hírkeresés nagy mozgás után
        </label>
        <p className="text-xs text-[var(--color-muted)]">
          A „Ki” állásban a feladat el sem indul, így az előfizetés keretét sem
          fogyasztja és az appban sem lesz friss eredmény.
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.quietHours != null}
            onChange={(e) => set({ quietHours: e.target.checked ? DEFAULT_NOTIFY.quietHours : null })}
          />
          Csendes órák (a sürgős üzenetet és a kérésedre adott választ nem tartja vissza)
        </label>
        {s.quietHours && (
          <>
            {(["from", "to"] as const).map((k) => (
              <input
                key={k}
                type="time"
                value={s.quietHours![k]}
                onChange={(e) => {
                  if (/^\d{2}:\d{2}$/.test(e.target.value))
                    set({ quietHours: { ...s.quietHours!, [k]: e.target.value } });
                }}
                className={input}
                aria-label={k === "from" ? "Csendes órák kezdete" : "Csendes órák vége"}
              />
            ))}
          </>
        )}
      </div>
    </Card>
  );
}
