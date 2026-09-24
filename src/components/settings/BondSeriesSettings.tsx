import { useState } from "react";
import { Landmark } from "lucide-react";
import { usePortfolio } from "../../lib/store";
import { Card, Badge, AmountInput } from "../ui";
import { instrumentTypeLabel } from "../../lib/labels";
import type { BondTerms, Instrument } from "../../lib/model";

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

const INTERVALS = [
  { months: 12, label: "éves" },
  { months: 6, label: "féléves" },
  { months: 3, label: "negyedéves" },
  { months: 1, label: "havi" },
];

const inputCls =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm";

export default function BondSeriesSettings() {
  const instruments = usePortfolio((s) => s.instruments);
  const updateInstrument = usePortfolio((s) => s.updateInstrument);

  const bonds = instruments.filter((i) => BOND_TYPES.has(i.type));
  if (bonds.length === 0) return null;

  const setBond = (inst: Instrument, patch: Partial<BondTerms>) =>
    updateInstrument(inst.key, { bond: { ...inst.bond, ...patch } });

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex items-center gap-2">
        <Landmark className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Állampapír sorozatok</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        A pontos értékeléshez add meg a sorozat adatait: kibocsátás, éves kamat,
        kamatperiódus és az első kamatfizetés dátuma — ebből számoljuk a
        felhalmozott kamatot a kupon-ütemterv szerint. A portfólió a névérték +
        felhalmozott kamat összeggel számol (lejáratig tartva ennyit ér), a
        lejárat előtti eladási költség (alapból a névérték 1%-a) csak a „most"
        visszaváltható összegnél jelenik meg a számla- és eszköz-nézetben.
        Hétvégén a következő hétfői nappal számolunk (mint a MobilKincstár). Az
        első (tört) kamat összegét kézzel is megadhatod (a MÁK-érték), mert a
        tört periódus nem számolható forintra pontosan. A diszkont
        kincstárjegyek automatikusan a vételár → névérték akkrécióval
        értékelődnek.
      </p>

      <div className="space-y-3">
        {bonds.map((inst) => {
          const isTbill = inst.type === "tbill";
          const b = inst.bond ?? {};
          const missing = !isTbill && b.couponRate == null;
          return (
            <div
              key={inst.key}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{inst.name}</span>
                <Badge tone="neutral">{instrumentTypeLabel[inst.type]}</Badge>
                {missing && <Badge tone="warning">hiányzó adat</Badge>}
                {!isTbill && !missing && <Badge tone="positive">megadva</Badge>}
                <span className="text-xs text-[var(--color-muted)]">
                  lejárat: {(b.maturity ?? inst.maturity)?.slice(0, 10) ?? "—"}
                </span>
              </div>

              {isTbill ? (
                <p className="text-xs text-[var(--color-muted)]">
                  Diszkont kincstárjegy — automatikus akkréció a lejáratig (
                  {inst.maturity?.slice(0, 10) ?? "ismeretlen lejárat"}).
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Lejárat">
                    <input
                      type="date"
                      className={inputCls}
                      value={(b.maturity ?? inst.maturity)?.slice(0, 10) ?? ""}
                      onChange={(e) =>
                        setBond(inst, { maturity: e.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="Kibocsátás">
                    <input
                      type="date"
                      className={inputCls}
                      value={b.issueDate?.slice(0, 10) ?? ""}
                      onChange={(e) =>
                        setBond(inst, {
                          issueDate: e.target.value || undefined,
                        })
                      }
                    />
                  </Field>
                  <Field label="Éves kamat %">
                    {/* key: uncontrolled input — remount when the stored value
                        changes (e.g. cloud pull), else it shows stale text */}
                    <input
                      key={`cr:${b.couponRate ?? ""}`}
                      type="number"
                      step="any"
                      className={`${inputCls} w-24 text-right`}
                      defaultValue={
                        b.couponRate != null
                          ? +(b.couponRate * 100).toFixed(4)
                          : ""
                      }
                      placeholder="pl. 7.04"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setBond(inst, {
                          couponRate: v === "" ? undefined : Number(v) / 100,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Kamatperiódus">
                    <select
                      className={inputCls}
                      value={b.couponIntervalMonths ?? 12}
                      onChange={(e) =>
                        setBond(inst, {
                          couponIntervalMonths: Number(e.target.value),
                        })
                      }
                    >
                      {INTERVALS.map((iv) => (
                        <option key={iv.months} value={iv.months}>
                          {iv.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Első kamatfizetés">
                    <input
                      type="date"
                      className={inputCls}
                      value={b.firstCouponDate?.slice(0, 10) ?? ""}
                      onChange={(e) =>
                        setBond(inst, {
                          firstCouponDate: e.target.value || undefined,
                        })
                      }
                    />
                  </Field>
                  <Field label="Eladási költség %">
                    <input
                      key={`sc:${b.saleCostPct ?? ""}`}
                      type="number"
                      step="any"
                      className={`${inputCls} w-24 text-right`}
                      defaultValue={
                        b.saleCostPct != null
                          ? +(b.saleCostPct * 100).toFixed(4)
                          : ""
                      }
                      placeholder="1"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setBond(inst, {
                          saleCostPct: v === "" ? undefined : Number(v) / 100,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Első kamat (Ft)">
                    {/* key: remount (reseed the draft) when the stored value
                        changes externally, e.g. a cloud pull. */}
                    <FirstCouponInput
                      key={`fc:${b.firstCouponHuf ?? ""}`}
                      valueHuf={b.firstCouponHuf}
                      onCommit={(v) => setBond(inst, { firstCouponHuf: v })}
                      className={`${inputCls} w-32 text-right`}
                    />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The bond "first coupon (Ft)" amount — grouped while typing. Controlled draft
 * seeded from the stored value (rounded to whole Ft), committed on blur. The
 * parent remounts it via `key` when the stored value changes externally.
 */
function FirstCouponInput({
  valueHuf,
  onCommit,
  className,
}: {
  valueHuf?: number;
  onCommit: (v: number | undefined) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(
    valueHuf != null ? String(Math.round(valueHuf)) : "",
  );
  return (
    <AmountInput
      value={draft}
      onValueChange={setDraft}
      placeholder="becsült"
      className={className}
      onBlur={() => onCommit(draft === "" ? undefined : Number(draft))}
    />
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
