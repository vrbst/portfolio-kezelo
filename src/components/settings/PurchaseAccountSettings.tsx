import { useMemo, useState } from "react";
import { Plus, Trash2, Wallet } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useAccountContext,
  useGlideVersions,
  usePurchaseAccounts,
} from "../../lib/store";
import { savePurchaseAccounts } from "../../lib/planPrefs";
import { latestConfig, isCashKey } from "../../lib/glidePath";
import {
  accountLabel,
  purchaseVenue,
  type PendingAccount,
  type PurchaseAccounts,
  type PurchaseEntry,
} from "../../lib/accountRules";
import { providerLabel } from "../../lib/incomeFlow";
import type { AccountKind } from "../../lib/model";
import { todayLocal } from "../../lib/day";
import { Card } from "../ui";

const INPUT =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm";
const LABEL = "text-xs text-[var(--color-muted)]";

const KIND_LABEL: Record<AccountKind, string> = {
  tbsz: "TBSZ",
  regular: "Befektetési",
  treasury: "Államkincstár",
  cash: "Pénzszámla",
};

const SOURCE_TEXT = {
  setting: "beállítás szerint",
  largest: "ahol a legnagyobb része van",
  last: "az utolsó vétel számlája",
  none: "",
} as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Vételi számlák": per instrument, which account new buys go to — dated, so
 * e.g. from 2027-01-01 the buys can move to a new account (even one not in the
 * ledger yet: it binds on the first import). Without a setting the account
 * holding most of it is used. Synced.
 */
export default function PurchaseAccountSettings() {
  const accounts = usePortfolio((s) => s.accounts);
  const instruments = usePortfolio((s) => s.instruments);
  const goals = usePortfolio((s) => s.goals);
  const summary = usePortfolioSummary();
  const glide = latestConfig(useGlideVersions());
  const saved = usePurchaseAccounts();
  const ctx = useAccountContext();
  const [draft, setDraft] = useState<PurchaseAccounts | null>(null);
  const cur = draft ?? saved;
  const providers = [...new Set(accounts.map((a) => a.provider))].sort();

  // Held, glide-path and DCA-goal instruments, plus any already configured.
  const keys = useMemo(() => {
    const set = new Set<string>(Object.keys(saved));
    for (const a of summary.accounts)
      for (const h of a.holdings) if (h.quantity > 0) set.add(h.instrumentKey);
    for (const k of Object.keys(glide?.instruments ?? {})) if (!isCashKey(k)) set.add(k);
    for (const g of goals) if (g.instrumentKey) set.add(g.instrumentKey);
    const name = (k: string) => instruments.find((i) => i.key === k)?.name ?? k;
    return [...set].sort((a, b) => name(a).localeCompare(name(b), "hu"));
  }, [saved, summary, glide, goals, instruments]);

  if (accounts.length === 0) return null;
  const nameOf = (k: string) => instruments.find((i) => i.key === k)?.name ?? k;

  const setRows = (key: string, rows: PurchaseEntry[]) => {
    const next = { ...cur };
    if (rows.length) next[key] = rows;
    else delete next[key];
    setDraft(next);
  };
  const errors = Object.entries(cur).flatMap(([k, rows]) => {
    const days = rows.map((r) => r.from);
    const out: string[] = [];
    if (days.some((d) => !DAY_RE.test(d))) out.push(`${nameOf(k)}: minden sorhoz kell dátum.`);
    if (new Set(days).size !== days.length) out.push(`${nameOf(k)}: két sor ugyanattól a naptól.`);
    return out;
  });
  const save = () => {
    const sorted: PurchaseAccounts = {};
    for (const [k, rows] of Object.entries(cur))
      if (rows.length) sorted[k] = [...rows].sort((a, b) => a.from.localeCompare(b.from));
    savePurchaseAccounts(sorted);
    setDraft(null);
  };

  return (
    <Card className="mt-4 p-6">
      <div className="mb-2 flex items-center gap-2">
        <Wallet className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Vételi számlák</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Melyik számlára menjenek egy instrumentum új vételei — dátumtól, így pl.
        2027-01-01-től másik számla is megadható (akár egy még meg sem nyitott,
        amely az első import után automatikusan hozzá kötődik). Beállítás nélkül
        az a számla, amelyen a legnagyobb része van. A havi terv és a sávszabály
        ezt használja; ha a számla nem fogad befizetést, nem javasol oda vételt.
      </p>
      <div className="space-y-4">
        {keys.map((key) => {
          const rows = cur[key] ?? [];
          const v = purchaseVenue(ctx, key);
          return (
            <div key={key} className="rounded-xl border border-[var(--color-border)] p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{nameOf(key)}</span>
                <span className={LABEL}>
                  Ma: {v.label}
                  {v.source !== "none" && ` (${SOURCE_TEXT[v.source]})`}
                  {v.depositBlocked && (
                    <span className="text-[var(--color-warning)]"> — nem fogad befizetést</span>
                  )}
                  {v.pending && <span className="text-[var(--color-warning)]"> — még nincs a nyilvántartásban</span>}
                </span>
              </div>
              {rows.map((r, i) => {
                const isPending = "pending" in r.target;
                const pending: PendingAccount | undefined =
                  "pending" in r.target ? r.target.pending : undefined;
                const update = (patch: Partial<PurchaseEntry>) =>
                  setRows(key, rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <div key={i} className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={LABEL}>ettől:</span>
                    <input
                      type="date"
                      className={INPUT}
                      value={r.from}
                      onChange={(e) => update({ from: e.target.value })}
                    />
                    <select
                      className={INPUT}
                      value={isPending ? "pending" : `acc:${"accountId" in r.target ? r.target.accountId : ""}`}
                      onChange={(e) => {
                        const val = e.target.value;
                        // A new account: by default at the broker of the row's account.
                        const cur = "accountId" in r.target
                          ? accounts.find((a) => a.id === (r.target as { accountId: string }).accountId)
                          : undefined;
                        if (val === "pending")
                          update({
                            target: {
                              pending: {
                                provider: cur?.provider ?? v.provider ?? providers[0] ?? "lightyear",
                                kind: "tbsz",
                                tbszYear: Number(r.from.slice(0, 4)) || new Date().getFullYear(),
                              },
                            },
                          });
                        else update({ target: { accountId: val.slice(4) } });
                      }}
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={`acc:${a.id}`}>
                          {accountLabel(a)}
                        </option>
                      ))}
                      <option value="pending">Új, még nem létező számla…</option>
                    </select>
                    {pending && (
                      <>
                        <select
                          className={INPUT}
                          value={pending.provider}
                          onChange={(e) => update({ target: { pending: { ...pending, provider: e.target.value } } })}
                        >
                          {providers.map((p) => (
                            <option key={p} value={p}>
                              {providerLabel(p)}
                            </option>
                          ))}
                        </select>
                        <select
                          className={INPUT}
                          value={pending.kind}
                          onChange={(e) =>
                            update({
                              target: {
                                pending: {
                                  ...pending,
                                  kind: e.target.value as AccountKind,
                                  tbszYear: e.target.value === "tbsz" ? pending.tbszYear : undefined,
                                },
                              },
                            })
                          }
                        >
                          {(["tbsz", "regular", "treasury"] as const).map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABEL[k]}
                            </option>
                          ))}
                        </select>
                        {pending.kind === "tbsz" && (
                          <input
                            type="number"
                            className={`${INPUT} w-24`}
                            value={pending.tbszYear ?? ""}
                            placeholder="év"
                            onChange={(e) =>
                              update({
                                target: { pending: { ...pending, tbszYear: Number(e.target.value) || undefined } },
                              })
                            }
                          />
                        )}
                      </>
                    )}
                    <button
                      className="rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                      onClick={() => setRows(key, rows.filter((_, j) => j !== i))}
                      title="Sor törlése"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
              <button
                className="btn-ghost mt-2 text-xs"
                onClick={() =>
                  setRows(key, [
                    ...rows,
                    {
                      from: todayLocal(),
                      target: { accountId: v.account?.id ?? accounts[0].id },
                    },
                  ])
                }
              >
                <Plus className="h-3.5 w-3.5" /> Vételi számla dátumtól
              </button>
            </div>
          );
        })}
      </div>
      {errors.length > 0 && (
        <ul className="mt-3 text-xs text-[var(--color-negative)]">
          {errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <button className="btn-primary text-sm" disabled={!draft || errors.length > 0} onClick={save}>
          Mentés
        </button>
        {draft && (
          <button className="btn-ghost text-sm" onClick={() => setDraft(null)}>
            Mégse
          </button>
        )}
      </div>
    </Card>
  );
}
