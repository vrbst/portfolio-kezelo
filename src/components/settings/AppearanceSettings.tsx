import { Palette, Check } from "lucide-react";
import { useSkin, type Skin } from "../../lib/skin";
import { Card } from "../ui";

/**
 * Skin picker: the default look or the terminal one. Device-local (not
 * synced) — see lib/skin.ts.
 */
export default function AppearanceSettings() {
  const skin = useSkin((s) => s.skin);
  const crt = useSkin((s) => s.crt);
  const setSkin = useSkin((s) => s.setSkin);
  const setCrt = useSkin((s) => s.setCrt);

  return (
    <Card className="mt-4 p-6">
      <div className="mb-2 flex items-center gap-2">
        <Palette className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Megjelenés</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Az app kinézete. Csak ezen az eszközön érvényes, nem szinkronizálódik.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <SkinOption
          value="classic"
          current={skin}
          onPick={setSkin}
          label="Klasszikus"
          hint="Üveghatású kártyák, színátmenetek"
        >
          {/* Fixed colours: the preview shows the skin, not the current one. */}
          <div
            className="flex h-full flex-col justify-center gap-1 rounded-lg px-3"
            style={{
              background:
                "radial-gradient(10rem 6rem at 10% 0%, rgb(99 102 241 / 0.35), transparent 70%), #0a0e1a",
              fontFamily: '"Inter Variable", sans-serif',
            }}
          >
            <span className="text-[10px]" style={{ color: "#8a93b2" }}>
              Teljes érték
            </span>
            <span
              className="text-lg font-semibold"
              style={{
                fontFamily: '"Space Grotesk Variable", sans-serif',
                background: "linear-gradient(90deg, #6366f1, #8b5cf6, #22d3ee)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              12 345 678 Ft
            </span>
          </div>
        </SkinOption>

        <SkinOption
          value="terminal"
          current={skin}
          onPick={setSkin}
          label="Terminál"
          hint="Zöld foszfor, monospace, szögletes dobozok"
        >
          <div
            className="flex h-full flex-col justify-center gap-1 px-3"
            style={{
              background: "#050805",
              border: "1px solid #1c4a28",
              fontFamily: '"JetBrains Mono Variable", monospace',
            }}
          >
            <span className="text-[10px]" style={{ color: "#4fa865" }}>
              portfolio@local:~$
            </span>
            <span
              className="text-lg font-semibold"
              style={{
                color: "#33ff66",
                textShadow: "0 0 8px rgb(51 255 102 / 0.45)",
              }}
            >
              12 345 678 Ft
              <span className="term-cursor" aria-hidden />
            </span>
          </div>
        </SkinOption>
      </div>

      {skin === "terminal" && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={crt}
            onChange={(e) => setCrt(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          <span>CRT hatás (pásztázó sorok, sötétedő szélek)</span>
        </label>
      )}
    </Card>
  );
}

function SkinOption({
  value,
  current,
  onPick,
  label,
  hint,
  children,
}: {
  value: Skin;
  current: Skin;
  onPick: (s: Skin) => void;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      aria-pressed={active}
      className={`flex flex-col gap-2 rounded-xl border p-2 text-left transition ${
        active
          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10"
          : "border-[var(--color-border)] hover:border-[var(--color-brand)]/40"
      }`}
    >
      <div className="h-20 overflow-hidden">{children}</div>
      <div className="flex items-start gap-2 px-1 pb-1">
        <span
          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
            active
              ? "border-[var(--color-brand)] bg-[var(--color-brand)]"
              : "border-[var(--color-border)]"
          }`}
        >
          {active && <Check className="h-3 w-3 text-[var(--color-bg)]" />}
        </span>
        <span>
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs text-[var(--color-muted)]">
            {hint}
          </span>
        </span>
      </div>
    </button>
  );
}
