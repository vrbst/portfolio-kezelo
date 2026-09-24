import { Landmark } from "lucide-react";
import { usePortfolio } from "../lib/store";
import { issuerOf } from "../lib/issuers";
import type { Instrument } from "../lib/model";

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

/**
 * Small issuer mark for a security, in the app's own icon style (the same
 * tinted rounded tile as the event/treasury icons): the ETF issuer's monogram
 * in its brand hue (issuer recognised from the full name — price file, live
 * quote, then the instrument), a treasury icon for government bonds, otherwise
 * the ticker's initials in the brand colour.
 */
export default function InstrumentLogo({
  instrument,
  size = 28,
}: {
  instrument?: Instrument;
  size?: number;
}) {
  const key = instrument?.key ?? "";
  const fileName = usePortfolio((s) => s.priceFile?.prices[key]?.name);
  const liveName = usePortfolio((s) => s.liveQuotes[key]?.name);

  const isBond = !!instrument && BOND_TYPES.has(instrument.type);
  const issuer = isBond
    ? undefined
    : issuerOf(fileName ?? liveName ?? instrument?.name);
  const color = issuer?.color ?? "var(--color-brand)";
  const text =
    issuer?.mark ??
    (instrument?.ticker ?? instrument?.name ?? "?")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase();

  return (
    <span
      className="font-display grid shrink-0 place-items-center rounded-lg font-bold tracking-tight"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (text.length > 1 ? 0.36 : 0.46)),
        color,
        background: `color-mix(in oklab, ${color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 28%, transparent)`,
      }}
      title={issuer?.name}
      aria-hidden="true"
    >
      {isBond ? (
        <Landmark style={{ width: size * 0.55, height: size * 0.55 }} />
      ) : (
        text
      )}
    </span>
  );
}
