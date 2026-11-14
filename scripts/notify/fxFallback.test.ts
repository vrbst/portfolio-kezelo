import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRemotePrefs } from "../../src/lib/prefs";
import { fixtureHistory, fixturePriceFile, fixtureQuotes, fixtureSnapshot } from "../../src/test/fixture";
import { buildContext } from "./data";
import { installLocalStorage } from "./env";
import { tickMessages } from "./tg-app";
import type { State } from "./state";

afterEach(() => vi.useRealTimers());

const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };

/** A context where no FX source (price file, live quote) is available. */
function ctxWithoutFx(opts: { history: boolean; conversions: boolean }) {
  const at = new Date(2026, 9, 20, 10);
  vi.useFakeTimers({ toFake: ["Date"], now: at });
  const snapshot = fixtureSnapshot();
  if (!opts.conversions)
    snapshot.transactions = snapshot.transactions.filter((t) => t.type !== "conversion");
  installLocalStorage();
  applyRemotePrefs(snapshot.prefs);
  const full = fixtureHistory("2026-10-20");
  const priceFile = fixturePriceFile(full);
  const quotes = fixtureQuotes(priceFile);
  const history = opts.history ? full : { ...full, fx: {} };
  return {
    full: buildContext({
      snapshot, priceFile, history, ...quotes, at, idleCashHuf: 100_000, reserveGraceDays: 45,
    }),
    degraded: buildContext({
      snapshot,
      priceFile: { ...priceFile, fx: {} },
      history,
      priceQuotes: quotes.priceQuotes,
      fxQuotes: {},
      at,
      idleCashHuf: 100_000,
      reserveGraceDays: 45,
    }),
  };
}

describe("a bot árfolyam-tartaléka", () => {
  it("a váltásokból tartalékot képez, a vagyon nem esik össze", () => {
    const { full, degraded } = ctxWithoutFx({ history: false, conversions: true });
    expect(degraded.summary.missingFxCcys).toEqual([]);
    expect(degraded.summary.totalValueHuf).toBeGreaterThan(full.summary.totalValueHuf * 0.9);
  });

  it("a history.json utolsó árfolyamát használja, ha a váltásokból nincs", () => {
    const { full, degraded } = ctxWithoutFx({ history: true, conversions: false });
    expect(degraded.summary.missingFxCcys).toEqual([]);
    expect(degraded.summary.totalValueHuf).toBeGreaterThan(full.summary.totalValueHuf * 0.9);
  });

  it("ha semmi nincs, csak a hiányzó árfolyam riasztás megy ki", () => {
    const { degraded } = ctxWithoutFx({ history: false, conversions: false });
    expect(degraded.summary.missingFxCcys).toContain("EUR");
    const st: State = { sentAlerts: {}, warned: {} };
    const msgs = tickMessages(degraded, st, env);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.html).toContain("Hiányzó árfolyam");
    expect(Object.keys(st.sentAlerts).every((id) => id.startsWith("missing-fx:"))).toBe(true);
  });
});
