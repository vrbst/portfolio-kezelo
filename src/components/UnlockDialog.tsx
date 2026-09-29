import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fingerprint, Lock, X } from "lucide-react";
import { hasBiometric, verifyBiometric, verifyPassword } from "../lib/privacyLock";

/**
 * Asks for the privacy-lock password or the device biometric. Biometric (when
 * registered) is offered straight away; the password always works as fallback.
 */
export default function UnlockDialog({
  title = "Összegek megjelenítése",
  onSuccess,
  onClose,
}: {
  title?: string;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bio = hasBiometric();
  const inputRef = useRef<HTMLInputElement>(null);
  const autoTried = useRef(false);

  const tryBiometric = async () => {
    setError(null);
    setBusy(true);
    try {
      if (await verifyBiometric()) onSuccess();
      else setError("Az azonosítás nem sikerült.");
    } catch {
      setError("Az ujjlenyomatos azonosítás megszakadt — használd a jelszót.");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (bio && !autoTried.current) {
      autoTried.current = true;
      void tryBiometric();
    } else {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    const ok = await verifyPassword(password);
    setBusy(false);
    if (ok) onSuccess();
    else {
      setError("Hibás jelszó.");
      setPassword("");
      inputRef.current?.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Lock className="h-5 w-5 text-[var(--color-brand)]" /> {title}
          </h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Bezárás">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            ref={inputRef}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            type="password"
            autoComplete="current-password"
            placeholder="Jelszó"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-xs text-[var(--color-negative)]">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={busy || !password}>
              Feloldás
            </button>
            {bio && (
              <button
                type="button"
                className="btn-ghost"
                onClick={tryBiometric}
                disabled={busy}
              >
                <Fingerprint className="h-4 w-4" /> Ujjlenyomat
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
