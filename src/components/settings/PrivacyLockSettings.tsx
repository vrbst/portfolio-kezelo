import InfoTip from "../InfoTip";
import { useEffect, useState } from "react";
import { Fingerprint, Lock } from "lucide-react";
import { Card } from "../ui";
import UnlockDialog from "../UnlockDialog";
import {
  biometricSupported,
  hasBiometric,
  hasLock,
  registerBiometric,
  removeBiometric,
  removeLock,
  setLockPassword,
} from "../../lib/privacyLock";

type Pending = "remove" | "change" | "addBio" | "removeBio";

const inputCls =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm";

/**
 * Lock for the "Elrejt" (privacy) button: hiding stays one tap, showing the
 * amounts again needs the password or the device biometric. Device-local.
 */
export default function PrivacyLockSettings() {
  const [locked, setLocked] = useState(hasLock);
  const [bio, setBio] = useState(hasBiometric);
  const [bioOk, setBioOk] = useState(false);
  const [editing, setEditing] = useState(!hasLock());
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    void biometricSupported().then(setBioOk);
  }, []);

  const refresh = () => {
    setLocked(hasLock());
    setBio(hasBiometric());
  };

  const savePassword = async () => {
    if (pw.length < 4) return setMsg({ ok: false, text: "Legalább 4 karakter legyen." });
    if (pw !== pw2) return setMsg({ ok: false, text: "A két jelszó nem egyezik." });
    await setLockPassword(pw);
    setPw("");
    setPw2("");
    setEditing(false);
    refresh();
    setMsg({ ok: true, text: "Jelszó elmentve." });
  };

  const addBiometric = async () => {
    try {
      await registerBiometric();
      refresh();
      setMsg({ ok: true, text: "Ujjlenyomatos feloldás bekapcsolva." });
    } catch (e) {
      setMsg({
        ok: false,
        text: `Nem sikerült: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  // Every change to an existing lock needs the current password / biometric.
  const runPending = (p: Pending) => {
    setPending(null);
    setMsg(null);
    if (p === "remove") {
      removeLock();
      setEditing(true);
      refresh();
      setMsg({ ok: true, text: "A zár kikapcsolva." });
    } else if (p === "change") {
      setEditing(true);
    } else if (p === "addBio") {
      void addBiometric();
    } else {
      removeBiometric();
      refresh();
    }
  };

  return (
    <Card className="mt-4 p-6">
      <div className="mb-4 flex items-center gap-2">
        <Lock className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Elrejtés zárolása</h2>
        <InfoTip>
          Az összegek elrejtése mindig egy koppintás, a visszaállításhoz viszont
          jelszó vagy ujjlenyomat / arcfelismerés kell. Csak ezen az eszközön
          érvényes, nem szinkronizálódik. Ez a kíváncsi szemek ellen véd, nem
          titkosítja az adatokat.
        </InfoTip>
      </div>

      {locked && !editing && (
        <div className="space-y-3">
          <p className="text-sm">
            Zár: <span className="font-medium text-[var(--color-positive)]">bekapcsolva</span>
            {bio && " · ujjlenyomattal is feloldható"}
          </p>
          <div className="flex flex-wrap gap-2">
            {bioOk && !bio && (
              <button className="btn-ghost" onClick={() => setPending("addBio")}>
                <Fingerprint className="h-4 w-4" /> Ujjlenyomat bekapcsolása
              </button>
            )}
            {bio && (
              <button className="btn-ghost" onClick={() => setPending("removeBio")}>
                <Fingerprint className="h-4 w-4" /> Ujjlenyomat kikapcsolása
              </button>
            )}
            <button className="btn-ghost" onClick={() => setPending("change")}>
              Jelszó módosítása
            </button>
            <button className="btn-ghost" onClick={() => setPending("remove")}>
              Zár kikapcsolása
            </button>
          </div>
          {!bioOk && (
            <p className="text-xs text-[var(--color-muted)]">
              Ezen az eszközön/böngészőben nem érhető el ujjlenyomatos feloldás.
            </p>
          )}
        </div>
      )}

      {editing && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            className={inputCls}
            type="password"
            autoComplete="new-password"
            placeholder={locked ? "Új jelszó" : "Jelszó"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <input
            className={inputCls}
            type="password"
            autoComplete="new-password"
            placeholder="Jelszó újra"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={savePassword} disabled={!pw}>
              Mentés
            </button>
            {locked && (
              <button className="btn-ghost" onClick={() => setEditing(false)}>
                Mégse
              </button>
            )}
          </div>
        </div>
      )}

      {msg && (
        <p
          className={`mt-3 text-xs ${msg.ok ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}
        >
          {msg.text}
        </p>
      )}

      {pending && (
        <UnlockDialog
          title="Azonosítás"
          onClose={() => setPending(null)}
          onSuccess={() => runPending(pending)}
        />
      )}
    </Card>
  );
}
