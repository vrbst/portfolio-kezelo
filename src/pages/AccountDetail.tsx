import { Fragment, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Pencil,
  Check,
  X,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { usePortfolio, usePortfolioSummary, useValuedInstruments } from "../lib/store";
import {
  accountReturn,
  isInternalTransfer,
  isEmptyAccount,
  accountValueSpark,
} from "../lib/portfolio";
import {
  PageHeader,
  Card,
  StatCard,
  Badge,
  EmptyState,
} from "../components/ui";
import TbszTimeline from "../components/TbszTimeline";
import AccountLimitsCard from "../components/AccountLimitsCard";
import TbszExitValue from "../components/TbszExitValue";
import BondSwitchCard from "../components/BondSwitchCard";
import HoldingsTable from "../components/holdings/HoldingsTable";
import {
  formatMoney,
  formatNumber,
  formatDate,
  eurEquivalent,
} from "../lib/format";
import {
  accountKindLabel,
  txTypeLabel,
} from "../lib/labels";
import { groupTransactions } from "../lib/txGroups";
import type { AccountKind, Transaction } from "../lib/model";

export default function AccountDetail() {
  const { id } = useParams();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const summary = usePortfolioSummary();
  const updateAccount = usePortfolio((s) => s.updateAccount);
  const removeAccount = usePortfolio((s) => s.removeAccount);
  const navigate = useNavigate();
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);
  const fx = usePortfolio((s) => s.fx);
  const prices = usePortfolio((s) => s.prices);
  const historyFile = usePortfolio((s) => s.historyFile);

  const instruments = useValuedInstruments();
  const account = accounts.find((a) => a.id === id);
  const accSummary = summary.accounts.find((a) => a.account.id === id);

  // This account's value trend → the hero card sparkline.
  const accSpark = useMemo(() => {
    if (!account) return [];
    const instMap = new Map(instruments.map((i) => [i.key, i]));
    return accountValueSpark(
      account,
      transactions,
      instMap,
      prices,
      fx,
      historyFile,
    );
  }, [account, transactions, instruments, prices, fx, historyFile]);

  const accTxs = useMemo(
    () =>
      transactions
        .filter((t) => t.accountId === id)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [transactions, id],
  );

  // Transactions list with the funding conversion legs folded under their
  // buy/sell head; txOpen holds the expanded head ids.
  const txRows = useMemo(() => groupTransactions(accTxs), [accTxs]);
  const [txOpen, setTxOpen] = useState<Set<string>>(new Set());
  const toggleTx = (id: string) =>
    setTxOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? "regular");
  const [year, setYear] = useState<string>(
    account?.tbszYear ? String(account.tbszYear) : "",
  );

  if (!account || !accSummary) {
    return (
      <EmptyState
        title="Számla nem található"
        description="Lehet, hogy törölted az adatokat."
        action={
          <Link to="/accounts" className="btn-primary mt-2">
            Vissza a számlákhoz
          </Link>
        }
      />
    );
  }

  const accountTxCount = transactions.filter(
    (t) => t.accountId === account.id,
  ).length;
  const isTreasury = account.provider === "allamkincstar";
  const isCashHub = account.kind === "cash";
  const empty = isEmptyAccount(accSummary);
  const ret = accountReturn(accSummary);
  // Treasury: bonds' quantity = face value (névérték), so summing gives the
  // total nominal you get back at the maturities.
  const totalFaceHuf = accSummary.holdings.reduce((s, h) => s + h.quantity, 0);
  // EUR equivalent only makes sense for the (EUR-invested) Lightyear accounts,
  // not the HUF-denominated treasury bonds.
  const eur = (huf: number, opts?: { sign?: boolean }) =>
    isTreasury ? undefined : eurEquivalent(huf, eurHuf, opts);

  async function saveEdit() {
    await updateAccount(account!.id, {
      kind,
      tbszYear: kind === "tbsz" && year ? Number(year) : undefined,
    });
    setEditing(false);
  }

  // Cancel must reseed the draft from the account — otherwise a reopened
  // editor shows (and a Mentés silently saves) the discarded values.
  function cancelEdit() {
    setKind(account!.kind);
    setYear(account!.tbszYear ? String(account!.tbszYear) : "");
    setConfirmingDelete(false);
    setEditing(false);
  }

  async function deleteAccount() {
    await removeAccount(account!.id);
    navigate("/accounts");
  }

  return (
    <div>
      <Link
        to="/accounts"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
      >
        <ArrowLeft className="h-4 w-4" /> Számlák
      </Link>

      <PageHeader
        title={account.name}
        subtitle={account.externalRef}
        action={
          editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as AccountKind)}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                <option value="regular">Befektetési</option>
                <option value="tbsz">TBSZ</option>
                <option value="treasury">Államkincstár</option>
                <option value="cash">Pénzszámla</option>
              </select>
              {kind === "tbsz" && (
                <input
                  type="number"
                  placeholder="Év (pl. 2025)"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                />
              )}
              <button className="btn-primary" onClick={saveEdit}>
                <Check className="h-4 w-4" /> Mentés
              </button>
              <button className="btn-ghost" onClick={cancelEdit}>
                <X className="h-4 w-4" />
              </button>
              {confirmingDelete ? (
                <>
                  <span className="text-sm text-[var(--color-negative)]">
                    A számla és mind a {accountTxCount} tranzakciója törlődik
                    (minden szinkronizált eszközön). Újraimportálással
                    visszahozható.
                  </span>
                  <button
                    className="btn bg-[var(--color-negative)] text-white hover:brightness-110"
                    onClick={deleteAccount}
                  >
                    Igen, törlöm
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Mégse
                  </button>
                </>
              ) : (
                <button
                  className="btn-ghost border-[var(--color-negative)]/40 text-[var(--color-negative)]"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="h-4 w-4" /> Számla törlése
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge tone="brand">{accountKindLabel(account)}</Badge>
              <button className="btn-ghost" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" /> Szerkesztés
              </button>
            </div>
          )
        }
      />

      <div
        className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
          isTreasury ? "lg:grid-cols-5" : "lg:grid-cols-4"
        }`}
      >
        <StatCard
          label="Teljes érték"
          numericValue={accSummary.totalValueHuf}
          format={(n) => formatMoney(n)}
          sub={eur(accSummary.totalValueHuf)}
          index={0}
          hero
          sparkline={accSpark.length >= 2 ? accSpark : undefined}
          sparkStroke={
            (ret ?? 0) >= 0
              ? "var(--color-positive)"
              : "var(--color-negative)"
          }
        />
        {isCashHub ? (
          <>
            <StatCard
              label="Külső befizetés"
              value={formatMoney(accSummary.netDepositedHuf)}
              sub={eur(accSummary.netDepositedHuf)}
              index={1}
            />
            <StatCard
              label="Befektetésekbe utalva"
              value={formatMoney(accSummary.transfersOutHuf)}
              sub={eur(accSummary.transfersOutHuf)}
              index={2}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              sub={eur(accSummary.cashValueHuf)}
              index={3}
            />
          </>
        ) : isTreasury ? (
          // A bond's mark oscillates with the coupon cycle (the accrued
          // interest resets on every payment date), so we don't show a "Hozam"
          // here. The meaningful figures: total face value, coupons received,
          // and the capital invested.
          <>
            <StatCard
              label="Összes névérték"
              value={formatMoney(totalFaceHuf)}
              index={1}
            />
            <StatCard
              label="Kapott kamat"
              value={formatMoney(accSummary.interestHuf)}
              index={2}
            />
            <StatCard
              label="Befektetett tőke"
              value={formatMoney(accSummary.capitalBasisHuf)}
              index={3}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              index={4}
            />
          </>
        ) : (
          <>
            <StatCard
              label="Hozam"
              value={
                empty
                  ? "üres"
                  : formatMoney(
                      accSummary.totalValueHuf - accSummary.capitalBasisHuf,
                      "HUF",
                      { sign: true },
                    )
              }
              sub={
                empty
                  ? "a tőkét kiutaltad"
                  : eur(accSummary.totalValueHuf - accSummary.capitalBasisHuf, {
                      sign: true,
                    })
              }
              deltaPct={empty ? undefined : ret}
              index={1}
            />
            <StatCard
              label="Készpénz"
              value={formatMoney(accSummary.cashValueHuf)}
              // Show the actual EUR balance when the account holds EUR cash
              // (a TBSZ usually just has EUR leftovers); else the HUF→EUR
              // equivalent.
              sub={
                accSummary.cash["EUR"] != null &&
                Math.abs(accSummary.cash["EUR"]) > 0.005
                  ? formatMoney(accSummary.cash["EUR"], "EUR")
                  : eur(accSummary.cashValueHuf)
              }
              index={2}
            />
            <StatCard
              label="Befektetett tőke"
              value={formatMoney(accSummary.capitalBasisHuf)}
              sub={eur(accSummary.capitalBasisHuf)}
              index={3}
            />
          </>
        )}
      </div>

      {account.kind === "tbsz" && account.tbszYear && (
        <div className="mt-6 space-y-6">
          <TbszTimeline year={account.tbszYear} />
          <TbszExitValue
            year={account.tbszYear}
            grossValueHuf={accSummary.totalValueHuf}
            gainHuf={accSummary.totalValueHuf - accSummary.capitalBasisHuf}
          />
        </div>
      )}

      <AccountLimitsCard account={account} />

      {isTreasury && <BondSwitchCard holdings={accSummary.holdings} />}

      <div className="mt-6">
        <HoldingsTable
          accountId={account.id}
          variant="full"
          title={isTreasury ? "Értékpapírok" : "Pozíciók"}
          showTotals={isTreasury}
        />
      </div>

      {/* Cash by currency — a treasury és a TBSZ számlán a készpénz már fent
          van a kártyán (TBSZ-en az EUR-egyenleggel), így csak a pénzszámla-hub
          és a sima befektetési számlák mutatják a bontást. */}
      {!isTreasury &&
        account.kind !== "tbsz" &&
        Object.keys(accSummary.cash).length > 0 && (
          <div className="mt-6">
            <h2 className="mb-3 text-lg font-semibold">Készpénz egyenleg</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(accSummary.cash).map(([ccy, amt]) => (
                <Card key={ccy} className="px-5 py-4">
                  <div className="text-xs text-[var(--color-muted)]">{ccy}</div>
                  <div className="amt text-lg font-semibold tabular-nums">
                    {formatMoney(amt, ccy)}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

      {/* Transactions */}
      <div className="mt-6">
        <h2 className="mb-3 text-lg font-semibold">
          Tranzakciók ({accTxs.length})
        </h2>
        <Card className="overflow-hidden">
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted)]">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-4 py-3 font-medium">Dátum</th>
                  <th className="px-4 py-3 font-medium">Típus</th>
                  <th className="px-4 py-3 font-medium">Eszköz</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Mennyiség
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Összeg</th>
                </tr>
              </thead>
              <tbody>
                {txRows.map((row) => {
                  const t = row.tx;
                  const inst = accSummary.holdings.find(
                    (h) => h.instrumentKey === t.instrumentKey,
                  )?.instrument;
                  const open = txOpen.has(t.id);
                  return (
                    <Fragment key={t.id}>
                      <tr
                        className={`border-b border-[var(--color-border)]/40 last:border-0 ${
                          row.details
                            ? "cursor-pointer hover:bg-[var(--color-surface-2)]/40"
                            : ""
                        }`}
                        onClick={row.details ? () => toggleTx(t.id) : undefined}
                        title={
                          row.details
                            ? open
                              ? "Átváltás-lábak elrejtése"
                              : "Átváltás-lábak megjelenítése"
                            : undefined
                        }
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {row.details && (
                              <ChevronDown
                                className={`h-3.5 w-3.5 shrink-0 text-[var(--color-muted)] transition-transform ${
                                  open ? "" : "-rotate-90"
                                }`}
                              />
                            )}
                            {formatDate(t.date)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5">
                            <Badge tone="neutral">
                              {isInternalTransfer(t)
                                ? t.type === "deposit"
                                  ? "Transzfer be"
                                  : "Transzfer ki"
                                : txTypeLabel[t.type]}
                            </Badge>
                            {row.details && !open && (
                              <span className="text-[10px] text-[var(--color-muted)]">
                                +{row.details.length}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-[var(--color-muted)]">
                          {inst?.name ?? t.instrumentKey ?? "—"}
                        </td>
                        <td className="amt px-4 py-2.5 text-right tabular-nums">
                          {t.quantity != null
                            ? isTreasury
                              ? formatMoney(t.quantity, "HUF") // névérték Ft-ban, tizedes nélkül
                              : formatNumber(t.quantity, 4)
                            : "—"}
                        </td>
                        <td className="amt px-4 py-2.5 text-right tabular-nums">
                          {t.grossAmount != null
                            ? formatMoney(t.grossAmount, t.currency)
                            : "—"}
                        </td>
                      </tr>
                      {open &&
                        row.details?.map((d: Transaction) => (
                          <tr
                            key={d.id}
                            className="border-b border-[var(--color-border)]/40 bg-[var(--color-surface-2)]/30 text-[var(--color-muted)] last:border-0"
                          >
                            <td className="whitespace-nowrap py-2 pl-10 pr-4 text-xs">
                              {formatDate(d.date)}
                            </td>
                            <td className="px-4 py-2 text-xs">
                              {txTypeLabel[d.type]} ({d.currency})
                            </td>
                            <td className="px-4 py-2 text-xs">—</td>
                            <td className="px-4 py-2 text-right text-xs">—</td>
                            <td className="amt px-4 py-2 text-right text-xs tabular-nums">
                              {d.grossAmount != null
                                ? formatMoney(d.grossAmount, d.currency)
                                : "—"}
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

