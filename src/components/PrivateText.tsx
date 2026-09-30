import { Fragment, useMemo, type ReactNode } from "react";
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
/** An amount inside a sentence: "65 103 Ft", "≈ 1,5 M Ft", "12,50 EUR", "0,9413 db". */
const AMOUNT = /(≈\s?)?[+−-]?\d[\d\s\u00a0\u202f.,]*\s?(?:M\s)?(?:Ft|EUR|€|db)(?![a-zá-ű])/g;

/** `text` with its amounts marked `.amt` (blurred in privacy mode). */
function withAmounts(text: string, keyPrefix: string) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(AMOUNT)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={`${keyPrefix}-${m.index}`} className="amt inline-block">
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function PrivateText({
  text,
  alertId,
  amounts = false,
}: {
  text: string;
  alertId?: string;
  /** Also blur the amounts in the text (a plain generated sentence). */
  amounts?: boolean;
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

  const plain = (part: string, key: string) =>
    amounts ? <Fragment key={key}>{withAmounts(part, key)}</Fragment> : <Fragment key={key}>{part}</Fragment>;
  if (!pattern) return plain(text, "t");
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="priv">
            {part}
          </span>
        ) : (
          plain(part, String(i))
        ),
      )}
    </>
  );
}
