import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import InfoTip from "../InfoTip";
import { AmountInput } from "../ui";
import {
  useAccountLimits,
  usePortfolio,
  usePortfolioSummary,
  useSavingsGoals,
  useToday,
  useValuedInstruments,
} from "../../lib/store";
import {
  refillImpact,
  withBondFigures,
  type RefillGoal,
  type RefillPace,
  type RefillSource,
  type RefillTarget,
} from "../../lib/refill";
import { formatDate, formatMoney } from "../../lib/format";

const INPUT =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm";
const WARN = "text-[var(--color-warning,#fbbf24)]";

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `rf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

const sourceValue = (s: RefillSource): string =>
  s.kind === "holding" ? `h|${s.accountId ?? ""}|${s.instrumentKey}` : `c|${s.accountId}`;

function parseSource(v: string): RefillSource | undefined {
  const [kind, accountId, key] = v.split("|");
  if (kind === "h" && key) return { kind: "holding", instrumentKey: key, ...(accountId ? { accountId } : {}) };
  if (kind === "c" && accountId) return { kind: "cash", accountId };
  return undefined;
}

/**
 * Add / edit a refill goal: when and from what the money is taken out, how
 * much (cash in hand), where it goes back and how fast. The live preview shows
 * what the withdrawal means on that day — for a bond the face to sell (face +
 * accrued − the early-redemption cost), the coupons lost and the dated goals
 * whose earmarked coupons shrink.
 */
export default function RefillEditorDialog({
  goal,
  goals,
  onSave,
  onClose,
}: {
  goal?: RefillGoal;
  /** Every refill goal (the others' planned sales are the "before" picture). */
  goals: RefillGoal[];
  onSave: (g: RefillGoal) => void;
  onClose: () => void;
}) {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const instruments = useValuedInstruments();
  const savingsGoals = useSavingsGoals();
  const accountLimits = useAccountLimits();
  const today = useToday();
  const imap = useMemo(() => new Map(instruments.map((i) => [i.key, i])), [instruments]);

  // Sources: every holding (per account) and every account with cash.
  const sources = useMemo(() => {
    const out: { value: string; label: string; availHuf: number }[] = [];
    for (const a of summary.accounts) {
      for (const h of a.holdings) {
        if (!(h.quantity > 0)) continue;
        out.push({
          value: sourceValue({ kind: "holding", instrumentKey: h.instrumentKey, accountId: a.account.id }),
          label: `${h.instrument?.name ?? h.instrumentKey} · ${a.account.name}`,
          availHuf: h.redeemableValueHuf ?? h.marketValueHuf ?? 0,
        });
      }
      if (a.cashValueHuf >= 1)
        out.push({
          value: sourceValue({ kind: "cash", accountId: a.account.id }),
          label: `Készpénz · ${a.account.name}`,
          availHuf: a.cashValueHuf,
        });
    }
    return out;
  }, [summary]);

  const buyable = useMemo(
    () => instruments.filter((i) => !i.notBuyable && i.type !== "cash").sort((a, b) => a.name.localeCompare(b.name)),
    [instruments],
  );

  const [name, setName] = useState(goal?.name ?? "");
  const [day, setDay] = useState(goal?.withdrawal.day ?? today);
  const [src, setSrc] = useState(goal ? sourceValue(goal.withdrawal.source) : (sources[0]?.value ?? ""));
  const [amount, setAmount] = useState(goal ? String(goal.withdrawal.amountHuf) : "");
  const [target, setTarget] = useState<RefillTarget["kind"]>(goal?.target.kind ?? "glide");
  const [targetKey, setTargetKey] = useState(
    goal?.target.kind === "instrument" ? goal.target.instrumentKey : (buyable[0]?.key ?? ""),
  );
  const [pace, setPace] = useState<RefillPace["kind"]>(goal?.pace.kind ?? "asap");
  const [months, setMonths] = useState(goal?.pace.kind === "months" ? String(goal.pace.months) : "12");
  const [monthly, setMonthly] = useState(goal?.pace.kind === "monthly" ? String(goal.pace.huf) : "");
  const [includeCost, setIncludeCost] = useState(!!goal?.includeCost);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const source = parseSource(src);
  const amountHuf = Number(amount) || 0;
  const withdrawal = useMemo(
    () => (source ? withBondFigures({ day, source, amountHuf }, imap) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [src, day, amountHuf, imap],
  );
  const avail = sources.find((s) => s.value === src)?.availHuf;

  const impact = useMemo(() => {
    if (!withdrawal || !(withdrawal.amountHuf > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
    return refillImpact({
      withdrawal,
      goalId: goal?.id,
      refills: goals,
      summary,
      accounts,
      transactions,
      instruments: imap,
      prices,
      fx,
      savingsGoals,
      accountLimits,
    });
  }, [withdrawal, day, goal?.id, goals, summary, accounts, transactions, imap, prices, fx, savingsGoals, accountLimits]);

  const validate = (): string => {
    if (!name.trim()) return "Adj nevet a kivétnek (mire veszed ki?).";
    if (!source) return "Válaszd ki, miből veszed ki.";
    if (!(amountHuf > 0)) return "Add meg, mennyit veszel ki.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Add meg a kivét napját.";
    if (target === "instrument" && !targetKey) return "Válaszd ki, mibe pótolod vissza.";
    if (pace === "months" && !(Number(months) >= 1)) return "Hány hónap alatt pótolod vissza?";
    if (pace === "monthly" && !(Number(monthly) > 0)) return "Add meg a havi összeget.";
    return "";
  };
  const shownError = tried ? validate() : "";

  function save() {
    setTried(true);
    if (validate() || !withdrawal) return;
    const t: RefillTarget =
      target === "instrument" ? { kind: "instrument", instrumentKey: targetKey } : { kind: target };
    const p: RefillPace =
      pace === "months"
        ? { kind: "months", months: Math.round(Number(months)) }
        : pace === "monthly"
          ? { kind: "monthly", huf: Number(monthly) }
          : { kind: "asap" };
    onSave({
      id: goal?.id ?? newId(),
      name: name.trim(),
      createdAt: goal?.createdAt ?? new Date().toISOString(),
      withdrawal,
      target: t,
      pace: p,
      ...(includeCost ? { includeCost: true } : {}),
      ...(goal?.closedAt ? { closedAt: goal.closedAt } : {}),
    });
    onClose();
  }

  const bond = impact?.bond;
  const over = avail != null && amountHuf > avail + 1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={goal ? "Visszapótlás szerkesztése" : "Új visszapótlás"}
        className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{goal ? "Visszapótlás szerkesztése" : "Új visszapótlás"}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Bezárás">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="-mx-1 flex-1 space-y-5 overflow-y-auto px-1">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">1. Mit, mikor és miből veszel ki?</h3>
            <label className="block text-xs text-[var(--color-muted)]">
              Mire veszed ki?
              <input
                type="text"
                placeholder="pl. Felújítás"
                className={`${INPUT} priv mt-1 w-full`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block text-xs text-[var(--color-muted)]">
              Miből?
              <select className={`${INPUT} priv mt-1 w-full`} value={src} onChange={(e) => setSrc(e.target.value)}>
                {sources.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-[var(--color-muted)]">
                Kézhez kapott összeg (Ft)
                <AmountInput
                  className={`${INPUT} amt mt-1 block w-40 text-right tabular-nums`}
                  value={amount}
                  onValueChange={setAmount}
                />
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                A kivét napja
                <input type="date" className={`${INPUT} mt-1 block`} value={day} onChange={(e) => setDay(e.target.value)} />
              </label>
            </div>
            {avail != null && (
              <div className={`text-xs ${over ? WARN : "text-[var(--color-muted)]"}`}>
                Elérhető most: <span className="amt">{formatMoney(avail)}</span>
                {over && " — ennél többet nem tudsz kivenni belőle."}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">2. Hova és milyen ütemben pótolod vissza?</h3>
            <fieldset className="space-y-1 text-sm">
              <legend className="mb-1 text-xs text-[var(--color-muted)]">Hova kerüljön vissza?</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={target === "glide"} onChange={() => setTarget("glide")} /> A célpálya szerint
                <InfoTip>
                  Mint bármely új pénz: oda, ahol a célpálya szerint most hiány van (a végső arány felé). Ha a
                  célpálya úgyis a részvény felé tart, ez a forrástól függetlenül ETF-et jelent.
                </InfoTip>
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={target === "source"} onChange={() => setTarget("source")} /> Oda, ahonnan kivettem
                <InfoTip>
                  Ugyanabba a papírba, ha még vehető; ha már nem (pl. lezárt FixMÁP-sorozat), a célpálya a forrás
                  eszközcsoportján belül (pl. állampapír) osztja el.
                </InfoTip>
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <input type="radio" checked={target === "instrument"} onChange={() => setTarget("instrument")} /> Konkrét papírba
                {target === "instrument" && (
                  <select className={INPUT} value={targetKey} onChange={(e) => setTargetKey(e.target.value)}>
                    {buyable.map((i) => (
                      <option key={i.key} value={i.key}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            </fieldset>
            <fieldset className="space-y-1 text-sm">
              <legend className="mb-1 text-xs text-[var(--color-muted)]">Milyen gyorsan?</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={pace === "asap"} onChange={() => setPace("asap")} /> Minél hamarabb
                <InfoTip>
                  A szokásos elosztás helyett: a havi tervben a határidős célok után jön, a teljes hátralévő
                  összeggel, és a hónap végi maradékot is előbb kapja, mint a DCA és a célpálya. Azok addig
                  hiányosan maradhatnak (a sorrend a Havi tervben átállítható).
                </InfoTip>
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <input type="radio" checked={pace === "months"} onChange={() => setPace("months")} />
                <span>Egyenletesen</span>
                {pace === "months" && (
                  <input
                    type="number"
                    min={1}
                    className={`${INPUT} w-20 text-right`}
                    value={months}
                    onChange={(e) => setMonths(e.target.value)}
                  />
                )}
                <span>hónap alatt</span>
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <input type="radio" checked={pace === "monthly"} onChange={() => setPace("monthly")} /> Havi fix összeggel
                {pace === "monthly" && (
                  <AmountInput className={`${INPUT} amt w-32 text-right tabular-nums`} value={monthly} onValueChange={setMonthly} />
                )}
              </label>
            </fieldset>
            {(withdrawal?.costHuf ?? 0) >= 1 && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={includeCost} onChange={(e) => setIncludeCost(e.target.checked)} />
                <span>
                  A visszaváltási költséget is pótold vissza (+<span className="amt">{formatMoney(withdrawal!.costHuf!)}</span>)
                </span>
              </label>
            )}
          </section>

          {impact && (
            <section className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
              <h3 className="text-sm font-semibold">Mit jelent ez {formatDate(day)}-n?</h3>
              {impact.blocked && (
                <div className={`flex items-start gap-1.5 ${WARN}`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Erről a számláról ekkor nem vehető ki pénz: {impact.blocked}.</span>
                </div>
              )}
              {impact.tbszTaxHuf != null && impact.tbszTaxHuf >= 1 && (
                <div className={`flex items-start gap-1.5 ${WARN}`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    A kivét megszünteti a TBSZ-t: a teljes hozamra adó jön, kb.{" "}
                    <span className="amt">{formatMoney(impact.tbszTaxHuf)}</span>.
                  </span>
                </div>
              )}
              {bond ? (
                <ul className="space-y-0.5">
                  <li>
                    Eladandó névérték: <b className="amt">{formatMoney(bond.faceHuf)}</b>
                    <span className="text-[var(--color-muted)]"> (elszámolás: {formatDate(bond.settlementDay)})</span>
                  </li>
                  <li className="text-[var(--color-muted)]">
                    + felhalmozott kamat <span className="amt">{formatMoney(bond.accruedHuf)}</span> (
                    {(bond.accruedPct * 100).toLocaleString("hu-HU", { maximumFractionDigits: 3 })}%) − visszaváltási költség{" "}
                    <span className="amt">{formatMoney(bond.saleCostHuf)}</span> = kézhez{" "}
                    <span className="amt">{formatMoney(bond.proceedsHuf)}</span>
                  </li>
                  <li className="text-[var(--color-muted)]">
                    Kupon előtt kevesebb, kupon után több névértéket kell eladni ugyanahhoz az összeghez.
                  </li>
                </ul>
              ) : (
                impact.saleCostHuf < 1 && <div className="text-[var(--color-muted)]">Nincs visszaváltási költség.</div>
              )}
              {impact.lostCouponsTotalHuf >= 1 && (
                <div>
                  Elmaradó kamat: <span className="amt">{formatMoney(impact.lostCoupons12Huf)}</span> az első évben,{" "}
                  <span className="amt">{formatMoney(impact.lostCouponsTotalHuf)}</span> a lejáratig.
                </div>
              )}
              {impact.goals.length > 0 && (
                <div>
                  <div className="font-medium">A célokhoz rendelt kuponok csökkennek:</div>
                  <ul className="mt-1 space-y-1">
                    {impact.goals.map((e) => (
                      <li key={e.goalId} className="text-xs">
                        <span className="priv font-medium">{e.name}</span>: kupon{" "}
                        <span className="amt">{formatMoney(e.couponsBeforeHuf)}</span> →{" "}
                        <span className="amt">{formatMoney(e.couponsAfterHuf)}</span>, hiány{" "}
                        <span className="amt">{formatMoney(e.gapBeforeHuf)}</span> →{" "}
                        <span className="amt">{formatMoney(e.gapAfterHuf)}</span>
                        {Math.abs(e.monthlyAfterHuf - e.monthlyBeforeHuf) >= 1 && (
                          <>
                            , havi <span className="amt">{formatMoney(e.monthlyBeforeHuf)}</span> →{" "}
                            <span className="amt">{formatMoney(e.monthlyAfterHuf)}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 text-xs text-[var(--color-muted)]">
                    A célok ezzel a kisebb kuponnal számolnak már a kivét előtt is; az eladás importja után a
                    nyilvántartás adja a pontos összeget.
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {shownError && <span className={`mr-auto text-xs ${WARN}`}>{shownError}</span>}
          <button className="btn-ghost" onClick={onClose}>
            Mégse
          </button>
          <button className="btn-primary" onClick={save}>
            Mentés
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
