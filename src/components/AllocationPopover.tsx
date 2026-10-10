import { useEffect, useState, type RefObject } from "react";
import type { DetailSlice } from "../lib/allocationDetail";
import { formatMoney, formatPercent } from "../lib/format";
import { Amt } from "./ui";

const MAX_ROWS = 8;
const WIDTH = 256;
const pct = (v: number) => formatPercent(v).replace("+", "");

let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined")
  window.addEventListener(
    "pointermove",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true },
  );

/** What a donut slice is made of: header plus its largest contributors. */
export function SliceDetail({ slice, base }: { slice: DetailSlice; base: number }) {
  const shown = slice.items.slice(0, MAX_ROWS);
  const rest = slice.items.length - shown.length;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-medium">{slice.name}</span>
        <span className="shrink-0 text-xs font-medium text-[var(--color-brand)]">
          {base > 0 ? pct(slice.value / base) : ""}
        </span>
      </div>
      <div className="mb-2 text-xs text-[var(--color-muted)]">
        <Amt>{formatMoney(slice.value)}</Amt>
      </div>
      <ul className="space-y-1 text-xs">
        {shown.map((c) => (
          <li key={c.key} className="flex items-baseline gap-2">
            {/* Asset / account names are not personal; only the amounts are. */}
            <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">{c.label}</span>
            <Amt className="tabular-nums">{formatMoney(c.valueHuf)}</Amt>
            <span className="w-10 shrink-0 text-right tabular-nums text-[var(--color-muted)]">
              {slice.value > 0 ? pct(c.valueHuf / slice.value) : ""}
            </span>
          </li>
        ))}
      </ul>
      {rest > 0 && <div className="mt-1.5 text-xs text-[var(--color-muted)]">+{rest} további</div>}
    </div>
  );
}

/**
 * Floating popover that follows the pointer inside `containerRef` (which must
 * be `position: relative`). Tracks the pointer itself, so moving the mouse
 * re-renders only this component, not the dashboard.
 */
export default function AllocationPopover({
  slice,
  base,
  containerRef,
}: {
  slice: DetailSlice;
  base: number;
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [pos, setPos] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const place = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      setPos({ x: cx - r.left, y: cy - r.top, w: r.width, h: r.height });
    };
    const move = (e: PointerEvent) => place(e.clientX, e.clientY);
    // The popover mounts on hover, after the pointer already moved in: start
    // from where it last was instead of waiting for the next movement.
    if (lastPointer) place(lastPointer.x, lastPointer.y);
    el.addEventListener("pointermove", move);
    return () => el.removeEventListener("pointermove", move);
  }, [containerRef]);
  if (!pos) return null;

  const left = Math.max(8, Math.min(pos.x + 14, pos.w - WIDTH - 8));
  const below = pos.y < pos.h / 2;
  return (
    <div
      role="tooltip"
      data-testid="slice-detail"
      className="pointer-events-none absolute z-30 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg"
      style={{
        width: WIDTH,
        left,
        ...(below ? { top: pos.y + 14 } : { bottom: pos.h - pos.y + 14 }),
      }}
    >
      <SliceDetail slice={slice} base={base} />
    </div>
  );
}
