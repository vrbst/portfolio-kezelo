import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { motion, animate, useReducedMotion } from "motion/react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { formatMoney, formatPercent } from "../lib/format";

/** Group an integer digit-string with non-breaking thousands spaces (hu-HU). */
function groupDigits(d: string): string {
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * A whole-number amount field (Ft) that stays thousands-grouped WHILE you type
 * (e.g. `155 000`), preserving the caret position across reformatting. It is
 * controlled: `value` is the raw digit-string the parent stores and
 * `onValueChange` reports the raw digits back (no separators), so existing parse
 * logic (`Number(v.replace(/\s/g, ""))`) keeps working unchanged. Uses a text
 * input with a numeric keypad since a native number input can't show grouping.
 */
export function AmountInput({
  value,
  onValueChange,
  className = "",
  ...rest
}: {
  value: string | number;
  onValueChange: (raw: string) => void;
  className?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "inputMode"
>) {
  const ref = useRef<HTMLInputElement>(null);
  // Desired caret position after a reformat; set on change, applied post-render.
  const caret = useRef<number | null>(null);

  const raw = String(value ?? "").replace(/\D/g, "");
  const display = raw ? groupDigits(raw) : "";

  useLayoutEffect(() => {
    if (caret.current != null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const pos = el.selectionStart ?? el.value.length;
    // How many digits sit left of the caret — the anchor we keep stable.
    const digitsLeft = el.value.slice(0, pos).replace(/\D/g, "").length;
    let digits = el.value.replace(/\D/g, "");
    // Drop leading zeros ("007" → "7") but keep a lone "0".
    digits = digits.replace(/^0+(?=\d)/, "");
    const formatted = digits ? groupDigits(digits) : "";
    // Re-find the caret: walk the formatted string past `digitsLeft` digits.
    let seen = 0;
    let i = 0;
    while (i < formatted.length && seen < digitsLeft) {
      if (formatted[i] >= "0" && formatted[i] <= "9") seen++;
      i++;
    }
    caret.current = i;
    onValueChange(digits);
  };

  return (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      value={display}
      onChange={handleChange}
      className={className}
      {...rest}
    />
  );
}

/**
 * A number that counts up to `value` — from 0 on first mount, from the previous
 * value on change — formatted via `format`. Honours prefers-reduced-motion (it
 * then just snaps to the value). Does NOT add `.amt` itself, so the caller
 * controls privacy blur.
 */
export function AnimatedAmount({
  value,
  format,
  className = "",
  duration = 0.8,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  duration?: number;
}) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);
  const prev = useRef(reduce ? value : 0);

  useEffect(() => {
    if (
      reduce ||
      duration === 0 ||
      prev.current === value ||
      !Number.isFinite(value)
    ) {
      setDisplay(value);
      prev.current = value;
      return;
    }
    const controls = animate(prev.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v),
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, reduce, duration]);

  return <span className={className}>{format(display)}</span>;
}

/**
 * Tiny inline trend line (no axes, no ticks) from a numeric series, scaled to
 * fill its box. The stroke keeps a constant width regardless of box size.
 * Renders nothing under 2 points.
 */
export function Sparkline({
  data,
  className = "",
  stroke = "var(--color-brand)",
  fill = true,
}: {
  data: number[];
  className?: string;
  stroke?: string;
  fill?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  if (data.length < 2) return null;
  const w = 100;
  const h = 28;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const px = (i: number) => (i / (data.length - 1)) * w;
  const py = (v: number) => h - 1.5 - ((v - min) / range) * (h - 3);
  const line = data
    .map(
      (v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(v).toFixed(2)}`,
    )
    .join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#spark-${id})`} />}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A single shimmering placeholder block (use with sizing utility classes). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/**
 * A one-shot confetti burst for a small "goal reached" flourish. Place inside a
 * `relative` element; the bits fly out from its centre and fade. Renders nothing
 * under prefers-reduced-motion.
 */
const CELEBRATE_COLORS = [
  "var(--color-positive)",
  "var(--color-brand)",
  "var(--color-accent)",
  "var(--color-warning)",
];
export function Celebrate({ className = "" }: { className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return null;
  const bits = Array.from({ length: 10 });
  return (
    <span
      className={`pointer-events-none absolute inset-0 ${className}`}
      aria-hidden="true"
    >
      {bits.map((_, i) => {
        const angle = (i / bits.length) * 2 * Math.PI;
        const dist = 22 + (i % 3) * 9;
        return (
          <span
            key={i}
            className="celebrate-bit"
            style={
              {
                background: CELEBRATE_COLORS[i % CELEBRATE_COLORS.length],
                "--dx": `${Math.cos(angle) * dist}px`,
                "--dy": `${Math.sin(angle) * dist}px`,
                animationDelay: `${(i % 5) * 25}ms`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

/**
 * Wrap a Ft/EUR amount or quantity so it blurs in privacy mode. Percentages are
 * never wrapped, so they always stay readable. inline-block keeps the CSS blur
 * filter rendering reliably for inline text.
 */
export function Amt({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={`amt inline-block ${className}`}>{children}</span>;
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-[var(--color-muted)]">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Card({
  children,
  className = "",
  hover = false,
  id,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  id?: string;
}) {
  const reduce = useReducedMotion();
  // Glide in the first time the card scrolls into view.
  return (
    <motion.div
      id={id}
      className={`card ${hover ? "card-hover" : ""} ${className}`}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Odometer-style number: every digit is a 0–9 column that slides to its value,
 * so a changing amount visibly "rolls" digit by digit. Non-digits (spaces,
 * currency, sign) stay static. Digits are keyed from the right so they keep
 * their identity when the length changes. `instant` (or reduced motion) skips
 * the slide.
 */
export function RollingNumber({
  value,
  format,
  instant = false,
  gradient = false,
}: {
  value: number;
  format: (n: number) => string;
  instant?: boolean;
  /**
   * Brand-gradient text. background-clip:text on the root can't reach the
   * transformed digit columns, so every glyph carries the gradient itself,
   * sized to the whole number and shifted by the glyph's offset (measured after
   * layout) — it reads as one continuous gradient.
   */
  gradient?: boolean;
}) {
  const reduce = useReducedMotion();
  // First paint parks every column at 0, the next frame rolls them into place.
  const [mounted, setMounted] = useState(reduce);
  useEffect(() => {
    if (mounted) return;
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [mounted]);
  const text = format(value);
  const chars = text.split("");
  const rootRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!gradient || !root) return;
    root.style.setProperty("--gw", `${root.offsetWidth}px`);
    for (const el of Array.from(root.children) as HTMLElement[])
      el.style.setProperty("--gx", `${el.offsetLeft}px`);
  }, [gradient, text]);
  const glyph = gradient ? "rolling-gradient" : "";
  const slide =
    reduce || instant
      ? "none"
      : "transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)";
  return (
    <span ref={rootRef} className="relative inline-flex" aria-label={text}>
      {chars.map((ch, i) => {
        const key = chars.length - i;
        if (!/\d/.test(ch))
          return (
            <span
              key={`s${key}`}
              className={`whitespace-pre ${glyph}`}
              aria-hidden="true"
            >
              {ch}
            </span>
          );
        const d = mounted ? Number(ch) : 0;
        return (
          <span
            key={`d${key}`}
            aria-hidden="true"
            className="relative inline-block h-[1.15em] overflow-hidden leading-[1.15em]"
          >
            <span
              className="flex flex-col"
              style={{
                transform: `translateY(-${d * 1.15}em)`,
                transition: slide,
              }}
            >
              {DIGITS.map((n) => (
                <span key={n} className={`h-[1.15em] ${glyph}`}>
                  {n}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Coloured delta value with arrow. */
export function Delta({
  value,
  pct,
  className = "",
}: {
  value?: number;
  pct?: number;
  className?: string;
}) {
  const positive = (value ?? pct ?? 0) >= 0;
  const color = positive
    ? "text-[var(--color-positive)]"
    : "text-[var(--color-negative)]";
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-1 ${color} ${className}`}>
      <Icon className="h-4 w-4" />
      {value != null && (
        <span className="amt">{formatMoney(value, "HUF", { sign: true })}</span>
      )}
      {pct != null && (
        <span className={value != null ? "opacity-80" : ""}>
          {value != null ? "(" : ""}
          {formatPercent(pct)}
          {value != null ? ")" : ""}
        </span>
      )}
    </span>
  );
}

export function StatCard({
  label,
  value,
  numericValue,
  format,
  sub,
  delta,
  deltaPct,
  deltaNote,
  icon,
  index = 0,
  accent = false,
  hero = false,
  aurora = false,
  flashOnChange = false,
  scrubbing = false,
  sparkline,
  sparkStroke = "var(--color-brand)",
}: {
  label: string;
  /** Static value; ignored when numericValue + format are given (count-up). */
  value?: ReactNode;
  /** When set (with `format`), the value counts up on mount / change. */
  numericValue?: number;
  format?: (n: number) => string;
  /** Muted secondary line under the value (e.g. an EUR equivalent). */
  sub?: ReactNode;
  delta?: number;
  deltaPct?: number;
  /** Muted qualifier after the delta (e.g. "ma"). */
  deltaNote?: string;
  icon?: ReactNode;
  index?: number;
  accent?: boolean;
  /** Larger, gradient-tinted number + stronger glow for the primary metric. */
  hero?: boolean;
  /** Slow animated gradient wash behind the card (reduced-motion: static). */
  aurora?: boolean;
  /** Briefly glows the number green/red when numericValue changes. */
  flashOnChange?: boolean;
  /**
   * The value is being scrubbed from a chart: follow it instantly (no count-up,
   * no flash). On release it glides back to the live value.
   */
  scrubbing?: boolean;
  /** Tiny trend line drawn at the bottom of the card. */
  sparkline?: number[];
  sparkStroke?: string;
}) {
  const reduce = useReducedMotion();
  // Ticker-style flash: when a fresh value arrives (e.g. after a price refresh)
  // the number briefly glows up/down. Skipped on first mount and reduced-motion.
  const [flash, setFlash] = useState<null | "up" | "down">(null);
  const prevNum = useRef(numericValue);
  useEffect(() => {
    // Scrubbed values are not price moves: leave prevNum at the live value so
    // the release (back to it) doesn't flash either.
    if (scrubbing) return;
    if (!flashOnChange || reduce || numericValue == null) {
      prevNum.current = numericValue;
      return;
    }
    if (prevNum.current != null && numericValue !== prevNum.current) {
      setFlash(numericValue > prevNum.current ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 900);
      prevNum.current = numericValue;
      return () => clearTimeout(t);
    }
    prevNum.current = numericValue;
  }, [numericValue, flashOnChange, reduce, scrubbing]);

  const numberCls = hero
    ? "font-display mt-2 text-3xl font-bold tracking-tight"
    : "font-display mt-2 text-2xl font-semibold tracking-tight";
  const flashCls = flash === "up" ? "flash-up" : flash === "down" ? "flash-down" : "";
  const showValue =
    numericValue != null && format ? (
      <RollingNumber
        value={numericValue}
        format={format}
        instant={scrubbing}
        gradient={hero}
      />
    ) : (
      value
    );
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: index * 0.06,
        duration: 0.4,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={`card card-hover relative overflow-hidden p-5 ${
        accent || hero ? "ring-1 ring-[var(--color-brand)]/30" : ""
      }`}
    >
      {aurora && (
        <div
          className={`pointer-events-none absolute inset-0 opacity-70 ${
            reduce ? "" : "aurora"
          }`}
          aria-hidden="true"
        />
      )}
      {(accent || hero) && (
        <div
          className={`pointer-events-none absolute -right-8 -top-10 rounded-full bg-[var(--color-brand)]/20 blur-2xl ${
            hero ? "h-40 w-40 bg-[var(--color-brand)]/25" : "h-32 w-32"
          }`}
        />
      )}
      <div className="relative flex items-center justify-between">
        <span className="text-sm text-[var(--color-muted)]">{label}</span>
        {icon && <span className="text-[var(--color-muted)]">{icon}</span>}
      </div>
      <div className={`amt relative ${numberCls} ${flashCls}`}>{showValue}</div>
      {sub != null && (
        <div className="amt relative mt-0.5 text-sm tabular-nums text-[var(--color-muted)]">
          {sub}
        </div>
      )}
      {(delta != null || deltaPct != null) && (
        <div className="relative mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
          <Delta value={delta} pct={deltaPct} />
          {deltaNote && (
            <span className="text-xs text-[var(--color-muted)]">
              {deltaNote}
            </span>
          )}
        </div>
      )}
      {sparkline && sparkline.length >= 2 && (
        <div className="relative mt-3 h-8 w-full">
          <Sparkline
            data={sparkline}
            stroke={sparkStroke}
            className="h-full w-full"
          />
        </div>
      )}
    </motion.div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-[var(--color-muted)]">
        {description}
      </p>
      {action}
    </Card>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "positive" | "warning";
}) {
  const tones: Record<string, string> = {
    neutral:
      "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]",
    brand:
      "border-[var(--color-brand)]/40 bg-[var(--color-brand)]/15 text-[var(--color-text)]",
    positive:
      "border-[var(--color-positive)]/40 bg-[var(--color-positive)]/10 text-[var(--color-positive)]",
    warning:
      "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-warning)]",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
