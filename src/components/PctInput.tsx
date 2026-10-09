import { useState } from "react";
import { formatNumber } from "../lib/format";

const INPUT =
  "w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums";

function parsePct(s: string): number | null | undefined {
  const t = s.trim().replace(",", ".");
  if (t === "") return undefined;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : null;
}

export default function PctInput({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: number | undefined;
  placeholder: number;
  label: string;
  onCommit: (v: number | undefined) => void;
}) {
  const shown = value === undefined ? "" : String(value).replace(".", ",");
  const [draft, setDraft] = useState(shown);
  const commit = () => {
    const v = parsePct(draft);
    if (v === null) setDraft(shown);
    else if (v !== value) onCommit(v);
  };
  return (
    <span className="flex items-center gap-1">
      <input
        inputMode="decimal"
        aria-label={label}
        value={draft}
        placeholder={formatNumber(placeholder, placeholder % 1 ? 1 : 0)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={INPUT}
      />
      <span className="text-sm text-[var(--color-muted)]">%</span>
    </span>
  );
}
