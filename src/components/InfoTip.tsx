import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

/** Gap to the screen edge and to the "i" (px). */
const EDGE = 12;
const GAP = 6;
/** Hover intent: open after a short rest, close after leaving both parts. */
const OPEN_MS = 80;
const CLOSE_MS = 150;

/**
 * A small "i" that keeps an explanation out of the layout: it opens on hover
 * (mouse), on tap (touch: tap again or outside to close) and on keyboard
 * focus; Esc closes it. The text is rendered in a portal (cards that clip
 * their overflow can't cut it), placed below the "i" — above when there's no
 * room — and kept inside the screen. Amounts inside still go in <Amt>: the
 * privacy blur is page-wide, so it covers the portal too.
 */
export default function InfoTip({
  children,
  label = "Magyarázat",
  className = "",
  size = 14,
}: {
  children: ReactNode;
  /** Accessible name of the "i" button. */
  label?: string;
  className?: string;
  size?: number;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = hover || pinned || focused;

  const later = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const below = b.bottom + GAP;
    const top = below + h > vh - EDGE && b.top - GAP - h >= EDGE ? b.top - GAP - h : below;
    const left = Math.min(Math.max(b.left + b.width / 2 - w / 2, EDGE), vw - w - EDGE);
    setPos({ top, left: Math.max(EDGE, left) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // A tap / click elsewhere or Esc closes a pinned one.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || pop.current?.contains(t)) return;
      setPinned(false);
      setHover(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPinned(false);
      setHover(false);
      setFocused(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const enter = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") later(() => setHover(true), OPEN_MS);
  };
  const leave = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") later(() => setHover(false), CLOSE_MS);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onClick={(e) => {
          // Inside a <label> or a link row: don't toggle the field / navigate.
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))}
        onBlur={() => setFocused(false)}
        className={`info-tip relative inline-grid shrink-0 cursor-help place-items-center rounded-full align-middle text-[var(--color-muted)] transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:text-[var(--color-brand)] focus-visible:text-[var(--color-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50 ${
          open ? "text-[var(--color-brand)]" : ""
        } ${className}`}
      >
        <Info size={size} strokeWidth={2.25} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="tooltip"
            onPointerEnter={enter}
            onPointerLeave={leave}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className="fixed z-[100] w-max max-w-[min(20rem,calc(100vw-24px))] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-[var(--color-text)] shadow-xl"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
