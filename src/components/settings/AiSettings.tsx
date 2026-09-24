import { useState } from "react";
import { CheckCircle2, Sparkles } from "lucide-react";
import { Card, Badge } from "../ui";
import {
  AI_MODELS,
  loadAiKey,
  saveAiKey,
  loadAiModel,
  saveAiModel,
  loadSpend,
  resetSpend,
} from "../../lib/ai";

const usdSpend = (n: number) =>
  n < 0.01 ? `${(n * 100).toFixed(2)} cent` : `$${n.toFixed(2)}`;

export default function AiSettings() {
  const [key, setKey] = useState(loadAiKey());
  const [model, setModel] = useState(loadAiModel());
  const [saved, setSaved] = useState(false);
  const [spend, setSpend] = useState(loadSpend);

  const connected = loadAiKey().length > 0;

  function save() {
    saveAiKey(key.trim());
    saveAiModel(model);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function onModelChange(id: string) {
    setModel(id);
    saveAiModel(id); // persist immediately so it applies even without re-saving the key
  }

  const activeModel = AI_MODELS.find((m) => m.id === model);

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">AI elemzés</h2>
        </div>
        {connected && <Badge tone="positive">beállítva</Badge>}
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Add meg a saját Claude API-kulcsodat az AI elemzéshez és a kérdezz
        funkcióhoz az Áttekintés oldalon. A kulcs{" "}
        <strong>csak ezen az eszközön</strong> tárolódik (mint a szinkron
        token), sosem kerül a felhőbe. Kulcsot a{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-brand)] hover:underline"
        >
          console.anthropic.com
        </a>{" "}
        oldalon készíthetsz. Hívásonként csak aggregált pillanatkép megy el
        (tranzakciók soha), így pár doll&aacute;r is sok lekérésre elég.
      </p>

      <input
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        type="password"
        placeholder="Claude API-kulcs (sk-ant-…)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />

      <div className="mt-3">
        <span className="mb-1.5 block text-xs text-[var(--color-muted)]">
          Modell
        </span>
        <div className="flex flex-col gap-2">
          {AI_MODELS.map((m) => (
            <label
              key={m.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${
                model === m.id
                  ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10"
                  : "border-[var(--color-border)] bg-[var(--color-surface-2)]/40 hover:border-[var(--color-brand)]/30"
              }`}
            >
              <input
                type="radio"
                name="ai-model"
                value={m.id}
                checked={model === m.id}
                onChange={() => onModelChange(m.id)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-[var(--color-muted)]">
                  {m.hint}
                </span>
                <span className="block text-[11px] text-[var(--color-muted)]/80 tabular-nums">
                  ${m.inPrice} / ${m.outPrice} per 1M token (be / ki)
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={save}>
          Mentés
        </button>
        {connected && (
          <button
            className="btn-ghost"
            onClick={() => {
              saveAiKey("");
              setKey("");
            }}
          >
            Kulcs törlése
          </button>
        )}
        {saved && (
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-positive)]">
            <CheckCircle2 className="h-4 w-4" />
            Mentve · {activeModel?.label}
          </span>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--color-border)] pt-3">
        <p className="text-xs text-[var(--color-muted)]">
          Becsült költség (a tokenhasználatból, ezen az eszközön számolva —{" "}
          <strong>nem</strong> a maradék kredit, azt az API nem adja vissza):
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            Ez a hónap:{" "}
            <strong className="tabular-nums">{usdSpend(spend.monthUsd)}</strong>
          </span>
          <span className="text-[var(--color-muted)]">
            Összesen:{" "}
            <span className="tabular-nums">{usdSpend(spend.allTimeUsd)}</span>
          </span>
          {spend.allTimeUsd > 0 && (
            <button
              className="text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
              onClick={() => {
                resetSpend();
                setSpend(loadSpend());
              }}
            >
              Nullázás
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
