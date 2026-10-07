// Test helper: the bot's full Context for the invented portfolio of
// src/test/fixture.ts at a given LOCAL wall-clock time, with Date frozen there.
// The caller restores the timers (vi.useRealTimers) after the test.

import { vi } from "vitest";
import type { PortfolioSnapshot } from "../../src/lib/sync";
import { applyRemotePrefs } from "../../src/lib/prefs";
import {
  fixtureHistory,
  fixturePriceFile,
  fixtureQuotes,
  fixtureSnapshot,
} from "../../src/test/fixture";
import { buildContext, type Context } from "./data";
import { installLocalStorage } from "./env";
import type { BondRatesFile } from "../../src/lib/bondRates";

export function contextAt(
  localWallClock: [number, number, number, number, number?],
  tweak?: (s: PortfolioSnapshot) => void,
  bondRates?: BondRatesFile,
): Context {
  const [y, m, d, h, mi = 0] = localWallClock;
  const at = new Date(y, m - 1, d, h, mi);
  vi.useFakeTimers({ toFake: ["Date"], now: at });
  const snapshot = fixtureSnapshot();
  tweak?.(snapshot);
  installLocalStorage();
  applyRemotePrefs(snapshot.prefs);
  const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // The price file is from the previous trading evening, like in real use.
  const history = fixtureHistory(day);
  const before = (s: [string, number][]) => s.filter(([dd]) => dd < day);
  history.prices = Object.fromEntries(Object.entries(history.prices).map(([k, s]) => [k, before(s)]));
  history.fx = Object.fromEntries(Object.entries(history.fx).map(([k, s]) => [k, before(s)]));
  const priceFile = fixturePriceFile(history);
  return buildContext({
    snapshot,
    priceFile,
    history,
    bondRates,
    ...fixtureQuotes(priceFile),
    at,
    idleCashHuf: 100_000,
    reserveGraceDays: 45,
  });
}
