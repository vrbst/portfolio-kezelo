import { Coins } from "lucide-react";
import { tbszStatus, tbszExitScenarios } from "../lib/tbsz";
import { formatMoney } from "../lib/format";
import { Card, Badge } from "./ui";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * "Mi lenne, ha most eladnám?" — net (after-tax) value of a TBSZ now and at the
 * next milestones, on the current gain. TBSZ-only (lives on the account tab).
 */
export default function TbszExitValue({
  year,
  grossValueHuf,
  gainHuf,
  now,
}: {
  year: number;
  grossValueHuf: number;
  gainHuf: number;
  now?: Date;
}) {
  const status = tbszStatus(year, now);
  const scenarios = tbszExitScenarios(status, grossValueHuf, gainHuf);
  const taxableGain = Math.max(0, gainHuf);

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Coins className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Mi lenne, ha most eladnám?</h2>
      </div>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Nettó, adózott érték a jelenlegi árakon. A TBSZ-en csak a{" "}
        <span className="font-medium">hozam</span> adózik — a befizetett tőke
        nem.
      </p>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <span className="text-[var(--color-muted)]">Bruttó érték: </span>
          <span className="amt font-semibold tabular-nums">
            {formatMoney(grossValueHuf)}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-muted)]">Adóköteles hozam: </span>
          <span className="amt font-semibold tabular-nums">
            {formatMoney(taxableGain)}
          </span>
        </div>
      </div>

      {taxableGain <= 0 ? (
        <p className="mt-3 rounded-lg bg-[var(--color-surface-2)]/50 p-3 text-sm text-[var(--color-muted)]">
          Jelenleg nincs adóköteles hozam ezen a számlán, így eladáskor a teljes
          bruttó érték a tiéd — nincs levonandó adó.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {scenarios.map((s) => (
            <li
              key={s.key}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 ${
                s.key === "now"
                  ? "border-[var(--color-border)] bg-[var(--color-surface-2)]/40"
                  : "border-[var(--color-positive)]/30 bg-[var(--color-positive)]/5"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  {s.label}
                  <Badge tone={s.taxRate === 0 ? "positive" : "neutral"}>
                    {s.taxRate === 0 ? "adómentes" : `${pct(s.taxRate)} adó`}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-[var(--color-muted)] tabular-nums">
                  adó: −{formatMoney(s.taxHuf)}
                  {s.savedVsNowHuf > 0 && (
                    <span className="text-[var(--color-positive)]">
                      {" "}
                      · megtakarítás: +{formatMoney(s.savedVsNowHuf)}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="amt text-lg font-semibold tabular-nums">
                  {formatMoney(s.netHuf)}
                </div>
                <div className="amt text-xs tabular-nums text-[var(--color-positive)]">
                  profit: +{formatMoney(gainHuf - s.taxHuf)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-[var(--color-muted)]">
        A jövőbeli értékek a <span className="font-medium">mostani</span>{" "}
        hozamra vetített becslések — a tényleges összeg a piaci mozgással
        változik. A kötvények lejárat előtti eladásánál a visszaváltási költség
        külön levonódhat.
      </p>
    </Card>
  );
}
