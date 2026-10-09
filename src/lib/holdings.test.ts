import { describe, expect, it } from "vitest";
import { bondPricePct } from "./holdings";

describe("bondPricePct", () => {
  it("a HUF bond: HUF value over face value", () => {
    expect(bondPricePct({ currency: "HUF", quantity: 1_000_000, marketValueHuf: 1_012_300 })).toBeCloseTo(101.23);
  });

  it("an EUR bond: measured in EUR, not in forint over euro face value", () => {
    expect(
      bondPricePct({ currency: "EUR", quantity: 10_000, marketValueHuf: 4_000_000, marketValueCcy: 10_050 }),
    ).toBeCloseTo(100.5);
    expect(bondPricePct({ currency: "EUR", quantity: 10_000, marketValueHuf: 4_000_000 })).toBeUndefined();
  });
});
