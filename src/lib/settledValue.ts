import { useEffect, useState } from "react";
import { usePortfolio } from "./store";

/**
 * A price round (refreshPrices) writes its result piece by piece — snapshot
 * file, live FX, securities in bursts, off-hours cross-check — and every write
 * recomputes the portfolio total. The in-between totals are not real (new FX
 * on old prices, half the securities fresh), so the headline numbers hold the
 * last settled value for the whole round and move once, at its end.
 */

/** A stalled security must not pin the number forever. */
export const MAX_HOLD_MS = 8000;

export interface SettleState<T> {
  /** What the headline shows. */
  shown: T;
  /** The previous value is being held while a round runs. */
  holding: boolean;
  /** The hold hit its time limit in this round: follow live values until it ends. */
  released: boolean;
}

/**
 * `timedOut`: the round has been holding for MAX_HOLD_MS (a timer in the hook
 * tells, so this function stays free of clocks).
 */
export function settle<T>(
  prev: SettleState<T> | null,
  current: T,
  loading: boolean,
  timedOut: boolean,
): SettleState<T> {
  if (!prev || !loading) return { shown: current, holding: false, released: false };
  if (prev.released || timedOut) return { shown: current, holding: false, released: true };
  return { shown: prev.shown, holding: true, released: false };
}

/**
 * `current` as the headline should show it: unchanged during a price round,
 * the new value once the round ends. `stale` is true while the shown value is
 * the previous one (a fresh one is on its way) — but not during the very first
 * round after start-up, where the "previous" value is only the committed
 * snapshot.
 */
export function useSettledValue<T>(current: T): { value: T; stale: boolean } {
  const loading = usePortfolio((s) => s.pricesLoading);
  const everSettled = usePortfolio((s) => s.pricesSettled);
  const [st, setSt] = useState<SettleState<T> | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const next = settle(st, current, loading, timedOut);
  if (
    !st ||
    st.shown !== next.shown ||
    st.holding !== next.holding ||
    st.released !== next.released
  )
    setSt(next); // adjusting state while rendering: React re-renders at once
  if (!loading && timedOut) setTimedOut(false); // the round is over: rearm

  const holding = next.holding;
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setTimedOut(true), MAX_HOLD_MS);
    return () => clearTimeout(t);
  }, [holding]);

  return { value: next.shown, stale: holding && everSettled };
}
