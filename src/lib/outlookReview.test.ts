// Regressions from the code review of the outlook feature (PR #20).

import { describe, expect, it } from "vitest";
import { isStaleConsensus, validateConsensus, validateOutlookFile } from "./outlook";

const NOW = new Date(2026, 9, 14, 12);
const consensus = (asOf: string) => ({
  source: "issuer",
  url: "https://example.com/c.pdf",
  asOf,
  currency: "HUF",
  target: { min: 29_000, avg: 45_888, max: 58_667, count: 17 },
});

describe("consensus age", () => {
  it("a consensus older than a year is dropped, like a view; one just inside stays", () => {
    expect(validateConsensus(consensus("2025-10-13"), NOW)).toBeNull();
    expect(validateConsensus(consensus("2025-10-15"), NOW)).not.toBeNull();
  });

  it("a stored file loses its stale consensus when read", () => {
    const f = validateOutlookFile(
      {
        v: 1,
        updatedAt: "2026-10-13T00:00:00Z",
        items: { OTP: { consensus: [consensus("2024-01-01")] }, B: { consensus: [consensus("2026-08-03")] } },
      },
      NOW,
    );
    expect(f?.items.OTP).toBeUndefined();
    expect(f?.items.B.consensus).toHaveLength(1);
  });

  it("an issuer consensus is shown as old after about three months", () => {
    const fresh = validateConsensus(consensus("2026-08-03"), NOW)!;
    const old = validateConsensus(consensus("2026-04-01"), NOW)!;
    expect(isStaleConsensus(fresh, NOW)).toBe(false);
    expect(isStaleConsensus(old, NOW)).toBe(true);
  });

  it("a Yahoo consensus (refreshed daily) that stopped refreshing becomes old too", () => {
    const y = validateConsensus({ ...consensus("2026-06-01"), source: "yahoo", url: undefined }, NOW)!;
    expect(isStaleConsensus(y, NOW)).toBe(true);
  });
});
