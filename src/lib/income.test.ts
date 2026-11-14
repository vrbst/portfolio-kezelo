import { describe, expect, it } from "vitest";
import type { Account, Instrument, Transaction } from "./model";
import { computePortfolio } from "./portfolio";
import { computeIncomeByYear } from "./income";

// Invented sample data. The yearly view and the summary must agree.

const ACC: Account = { id: "a", name: "Számla", provider: "lightyear", kind: "regular", currency: "HUF" };
const BOND: Instrument = { key: "B", name: "Kötvény", type: "gov_bond", currency: "HUF", faceValue: 1 };
const instruments = new Map([[BOND.key, BOND]]);
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10).toISOString();
let n = 0;
const tx = (t: Omit<Transaction, "id">): Transaction => ({ id: `t${++n}`, ...t });

const sumOf = (rows: ReturnType<typeof computeIncomeByYear>, k: "realizedPlHuf" | "feesHuf") =>
  rows.reduce((s, r) => s + r[k], 0);

describe("az éves jövedelem egyezik az összesítővel", () => {
  const now = new Date(2026, 5, 30, 12);

  it("darabszám nélküli eladás (lejárat) lezárja a pozíciót", () => {
    const txs = [
      tx({ accountId: "a", date: at(2025, 1, 5), type: "buy", instrumentKey: "B", quantity: 100, pricePerUnit: 1, currency: "HUF", grossAmount: 100, netAmount: -100 }),
      // lejárat darabszám nélkül: a teljes pozíció megy ki
      tx({ accountId: "a", date: at(2025, 6, 5), type: "redemption", instrumentKey: "B", currency: "HUF", grossAmount: 110, netAmount: 110 }),
      // új vétel ugyanarra: a régi darabszám nem maradhat a pozícióban
      tx({ accountId: "a", date: at(2025, 7, 5), type: "buy", instrumentKey: "B", quantity: 50, pricePerUnit: 1, currency: "HUF", grossAmount: 50, netAmount: -50 }),
      tx({ accountId: "a", date: at(2025, 8, 5), type: "sell", instrumentKey: "B", quantity: 50, pricePerUnit: 1.2, currency: "HUF", grossAmount: 60, netAmount: 60 }),
    ];
    const s = computePortfolio([ACC], txs, instruments, new Map(), {}, now);
    expect(sumOf(computeIncomeByYear([ACC], txs, instruments, {}), "realizedPlHuf")).toBeCloseTo(s.realizedPlHuf, 6);
    expect(s.realizedPlHuf).toBeCloseTo(20, 6);
  });

  it("a belső átvezetés díját mindkét nézet ugyanúgy kezeli", () => {
    const txs = [
      tx({ accountId: "a", date: at(2025, 2, 5), type: "deposit", currency: "HUF", grossAmount: 1000, netAmount: 1000, fee: 5, reference: "IT-1" }),
      tx({ accountId: "a", date: at(2025, 3, 5), type: "buy", instrumentKey: "B", quantity: 10, pricePerUnit: 1, currency: "HUF", grossAmount: 10, fee: 2, netAmount: -10 }),
    ];
    const s = computePortfolio([ACC], txs, instruments, new Map(), {}, now);
    expect(sumOf(computeIncomeByYear([ACC], txs, instruments, {}), "feesHuf")).toBeCloseTo(s.accounts.reduce((x, a) => x + a.feesHuf, 0), 6);
  });
});
