import InfoTip from "../InfoTip";
import { useMemo } from "react";
import { Activity } from "lucide-react";
import { usePortfolio, usePortfolioSummary, useMoveAlertSettings } from "../../lib/store";
import { saveMoveAlertSettings, type MoveAlertSettings as Settings } from "../../lib/planPrefs";
import { consolidatedHoldings } from "../../lib/holdings";
import {
  DEFAULT_MOVE_PCT,
  FX_MOVE_KEY,
  alertDaysPerMonth,
  dailyAbsMoves,
  typicalMovePct,
} from "../../lib/moveAlerts";
import { formatNumber } from "../../lib/format";
import type { InstrumentType } from "../../lib/model";
import { Card } from "../ui";
import PctInput from "../PctInput";

const QUOTED: InstrumentType[] = ["etf", "stock", "fund"];

const pct = (v: number) => `${formatNumber(v, v < 10 ? 1 : 0)}%`;

export default function MoveAlertSettings() {
  const s = useMoveAlertSettings();
  const summary = usePortfolioSummary();
  const instruments = usePortfolio((st) => st.instruments);
  const history = usePortfolio((st) => st.historyFile);
  const accounts = usePortfolio((st) => st.accounts);
  const save = (next: Settings) => saveMoveAlertSettings(next);
  const setKey = (key: string, v: number | undefined) => {
    const byKey = { ...s.byKey };
    if (v === undefined) delete byKey[key];
    else byKey[key] = v;
    save({ ...s, byKey });
  };
  const setTop = (field: "portfolioPct" | "positionPct", v: number | undefined) => {
    const next = { ...s };
    if (v === undefined) delete next[field];
    else next[field] = v;
    save(next);
  };

  const rows = useMemo(() => {
    const held = consolidatedHoldings(summary)
      .filter((h) => h.quantity > 0 && h.instrument && QUOTED.includes(h.instrument.type))
      .map((h) => ({ key: h.instrumentKey, name: h.instrument?.name ?? h.instrumentKey, held: true }));
    const seen = new Set(held.map((r) => r.key));
    const stale = Object.keys(s.byKey)
      .filter((k) => k !== FX_MOVE_KEY && !seen.has(k))
      .map((k) => ({ key: k, name: instruments.find((i) => i.key === k)?.name ?? k, held: false }));
    return [...held, { key: FX_MOVE_KEY, name: "EUR/HUF", held: true }, ...stale].map((r) => ({
      ...r,
      moves: dailyAbsMoves(r.key === FX_MOVE_KEY ? history?.fx.EUR : history?.prices[r.key]),
    }));
  }, [summary, instruments, history, s.byKey]);

  if (accounts.length === 0) return null;
  const positionDefault = s.positionPct ?? DEFAULT_MOVE_PCT;

  return (
    <Card className="mt-4 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Activity className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Nagy mozgás riasztás (Telegram)</h2>
        <InfoTip>
          A bot akkor jelez, ha a portfólió, egy tartott papír vagy az EUR/HUF
          aznapi mozgása eléri a küszöböt, és újra, ha a küszöb többszörösét
          (2×, 3×…) is átlépi. Az üres mező az alapértéket használja. A lista a
          most tartott, tőzsdei árfolyamú papírokból áll, így új papír
          vételekor magától bővül. A „riasztás havonta” az elmúlt kb. egy év
          napi záróárai alapján becsli, hány napon szólt volna a megadott
          küszöbbel. Szinkronizálódik, a bot is ezt használja. Ahol itt üres a
          mező, a bot gépén a .notify/.env-ben megadott küszöb érvényes, ha van
          ilyen — azt az app nem látja.
        </InfoTip>
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <label className="flex items-center gap-2">
          Teljes portfólió
          <PctInput
            key={String(s.portfolioPct)}
            label="Teljes portfólió küszöbe"
            value={s.portfolioPct}
            placeholder={DEFAULT_MOVE_PCT}
            onCommit={(v) => setTop("portfolioPct", v)}
          />
        </label>
        <label className="flex items-center gap-2">
          Alapérték egy papírra
          <PctInput
            key={String(s.positionPct)}
            label="Alapérték egy papírra"
            value={s.positionPct}
            placeholder={DEFAULT_MOVE_PCT}
            onCommit={(v) => setTop("positionPct", v)}
          />
        </label>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm" data-privacy="public">
          <thead>
            <tr className="text-left text-xs text-[var(--color-muted)]">
              <th className="py-1 pr-3 font-normal">Papír</th>
              <th className="py-1 pr-3 font-normal">Küszöb</th>
              <th className="py-1 pr-3 text-right font-normal">Jellemző napi mozgás</th>
              <th className="py-1 text-right font-normal">Riasztás havonta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const effective = s.byKey[r.key] ?? positionDefault;
              const typical = typicalMovePct(r.moves);
              const perMonth = alertDaysPerMonth(r.moves, effective);
              return (
                <tr key={r.key} className="border-t border-[var(--color-border)]/50">
                  <td className="py-1.5 pr-3">
                    {r.name}
                    {!r.held && (
                      <span className="ml-1 text-xs text-[var(--color-muted)]">(már nincs a portfólióban)</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <PctInput
                      key={`${r.key}:${s.byKey[r.key]}`}
                      label={`${r.name} küszöbe`}
                      value={s.byKey[r.key]}
                      placeholder={positionDefault}
                      onCommit={(v) => setKey(r.key, v)}
                    />
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {typical == null ? "—" : pct(typical)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {perMonth == null ? "—" : `~${formatNumber(perMonth, perMonth < 10 ? 1 : 0)} nap`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
