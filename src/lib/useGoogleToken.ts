import { useEffect, useReducer } from "react";
import {
  EXPIRY_MARGIN_MS,
  TOKEN_EVENT,
  googleTokenExpiresAt,
  hasValidGoogleToken,
} from "./googleAuth";

/** setTimeout's longest delay; longer ones fire at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * Is the stored Google token still usable? Re-evaluates by itself at the
 * moment it lapses and whenever the token / sign-in changes — a plain
 * render-time check would stay stale on a page that just sits open.
 */
export function useGoogleTokenValid(): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const valid = hasValidGoogleToken();
  useEffect(() => {
    window.addEventListener(TOKEN_EVENT, bump as () => void);
    return () => window.removeEventListener(TOKEN_EVENT, bump as () => void);
  }, []);
  useEffect(() => {
    const at = googleTokenExpiresAt();
    if (at == null) return;
    const wait = at - EXPIRY_MARGIN_MS - Date.now();
    if (wait <= 0) return;
    const id = setTimeout(bump as () => void, Math.min(wait, MAX_DELAY_MS) + 50);
    return () => clearTimeout(id);
  }, [valid]);
  return valid;
}
