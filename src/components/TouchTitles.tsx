import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=link],[role=menuitem]";
const EDGE = 12;
const GAP = 6;

interface Tip {
  el: Element;
  text: string;
  rect: DOMRect;
  personal: boolean;
}

const PERSONAL = ".amt,.priv";

function titleTarget(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest("[title]") : null;
  if (!el || !el.getAttribute("title")?.trim()) return null;
  return el.closest(INTERACTIVE) ? null : el;
}

export default function TouchTitles() {
  const [tip, setTip] = useState<Tip | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (pop.current?.contains(e.target as Node)) return;
      const el = titleTarget(e.target);
      setTip((cur) => {
        if (!el || cur?.el === el) return null;
        const text = el.getAttribute("title")!.trim();
        const personal = !!el.closest(PERSONAL) || !!el.querySelector(PERSONAL) || /\d/.test(text);
        return { el, text, rect: el.getBoundingClientRect(), personal };
      });
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch" || pop.current?.contains(e.target as Node)) return;
      setTip(null);
    };
    const close = () => setTip(null);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  useLayoutEffect(() => {
    const p = pop.current;
    if (!tip || !p) return setPos(null);
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const { rect } = tip;
    const below = rect.bottom + GAP;
    const top =
      below + p.offsetHeight > vh - EDGE && rect.top - GAP - p.offsetHeight >= EDGE
        ? rect.top - GAP - p.offsetHeight
        : below;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - p.offsetWidth / 2, EDGE), vw - p.offsetWidth - EDGE);
    setPos({ top, left: Math.max(EDGE, left) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={pop}
      role="tooltip"
      data-touch-title
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className={`${tip.personal ? "amt " : ""}fixed z-[100] w-max max-w-[min(20rem,calc(100vw-24px))] whitespace-pre-line rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-left text-xs leading-relaxed text-[var(--color-text)] shadow-xl`}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
