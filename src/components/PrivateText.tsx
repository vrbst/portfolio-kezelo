import { Fragment, useMemo } from "react";
import { usePortfolio, useSavingsGoals } from "../lib/store";

/** Alert ids that belong to a savings goal (their text names its instruments). */
const SAVINGS_ALERT = /^savings-(goal|ok):/;

/**
 * Renders `text` with the personal parts marked `.priv` (blurred in privacy
 * mode): every savings-goal name, and — for a savings-goal alert (`alertId`) —
 * the goal's assigned instrument names too, since those reveal which holding
 * backs which goal. Works on stored texts as well (alert history), since it
 * matches the current goals rather than relying on markup in the string.
 */
export default function PrivateText({
  text,
  alertId,
}: {
  text: string;
  alertId?: string;
}) {
  const goals = useSavingsGoals();
  const instruments = usePortfolio((s) => s.instruments);
  const pattern = useMemo(() => {
    const terms = new Set<string>();
    for (const g of goals) {
      if (g.name.trim()) terms.add(g.name.trim());
      if (alertId && SAVINGS_ALERT.test(alertId)) {
        for (const k of g.instrumentKeys) {
          const name = instruments.find((i) => i.key === k)?.name;
          if (name) terms.add(name);
        }
      }
    }
    if (terms.size === 0) return null;
    // Longest first, so a name that contains another is matched whole.
    const alts = [...terms]
      .sort((a, b) => b.length - a.length)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(${alts.join("|")})`, "g");
  }, [goals, instruments, alertId]);

  if (!pattern) return <>{text}</>;
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="priv">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
