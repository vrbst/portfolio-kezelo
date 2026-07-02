import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { formatMoney, formatPercent } from "../lib/format";

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
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div className={`card ${hover ? "card-hover" : ""} ${className}`}>
      {children}
    </div>
  );
}

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
  sub,
  delta,
  deltaPct,
  icon,
  index = 0,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  /** Muted secondary line under the value (e.g. an EUR equivalent). */
  sub?: ReactNode;
  delta?: number;
  deltaPct?: number;
  icon?: ReactNode;
  index?: number;
  accent?: boolean;
}) {
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
        accent ? "ring-1 ring-[var(--color-brand)]/30" : ""
      }`}
    >
      {accent && (
        <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-[var(--color-brand)]/20 blur-2xl" />
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--color-muted)]">{label}</span>
        {icon && <span className="text-[var(--color-muted)]">{icon}</span>}
      </div>
      <div className="amt mt-2 text-2xl font-semibold tracking-tight">
        {value}
      </div>
      {sub != null && (
        <div className="amt mt-0.5 text-sm tabular-nums text-[var(--color-muted)]">
          {sub}
        </div>
      )}
      {(delta != null || deltaPct != null) && (
        <div className="mt-1.5 text-sm">
          <Delta value={delta} pct={deltaPct} />
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
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
