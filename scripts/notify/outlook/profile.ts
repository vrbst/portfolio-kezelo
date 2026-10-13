import type { Fundamentals } from "../../../src/lib/fundamentals";
import type { AssetClass } from "../../../src/lib/outlook";
import type { Instrument } from "../../../src/lib/model";

export interface RuleProfile {
  assetClass: AssetClass;
  underlying?: string;
}

// Names (as brokers print them) of the coins Deribit lists options on, plus
// the usual product wording. First match wins.
const COINS: [RegExp, string][] = [
  [/bitcoin|\bbtc\b/i, "BTC"],
  [/ether(eum)?\b|\beth\b/i, "ETH"],
  [/solana|\bsol\b/i, "SOL"],
  [/\bxrp\b|ripple/i, "XRP"],
];
const GOLD = /\bgold\b|\barany\b|\bxau\b/i;
const BOND_FUND = /\bbonds?\b|treasur|govern?ment|aggregate|kötvény|\bcredit\b|money market/i;

/**
 * A first, rule-based guess of how an asset should be looked at. Returns null
 * when the rules cannot tell — the weekly AI run then decides.
 */
export function classifyForOutlook(
  inst: Pick<Instrument, "name" | "type">,
  f?: (Pick<Fundamentals, "quoteType"> & { names?: string[] }) | null,
): RuleProfile | null {
  if (inst.type === "gov_bond" || inst.type === "tbill" || inst.type === "cash") return null;
  // The imported name can be just the ticker ("WBIT"): Yahoo's long name says more.
  const names = [inst.name, ...(f?.names ?? [])].join(" | ");
  // Yahoo's quote type beats the imported one (a single stock is often filed as an ETF).
  const yahooFund = f?.quoteType === "ETF" || f?.quoteType === "MUTUALFUND";
  const isFund = f?.quoteType === "EQUITY" ? false : yahooFund || inst.type === "etf" || inst.type === "fund";
  if (isFund) {
    const coin = COINS.find(([re]) => re.test(names));
    if (coin) return { assetClass: "crypto", underlying: coin[1] };
    if (GOLD.test(names)) return { assetClass: "commodity", underlying: "XAU" };
    if (BOND_FUND.test(names)) return { assetClass: "bond_fund" };
    return { assetClass: "equity_fund" };
  }
  if (inst.type === "stock" || f?.quoteType === "EQUITY") return { assetClass: "equity" };
  return null;
}
