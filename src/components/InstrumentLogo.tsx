import { useState } from "react";
import { Landmark } from "lucide-react";
import { usePortfolio } from "../lib/store";
import { issuerLogoUrl, issuerOf } from "../lib/issuers";
import type { Instrument } from "../lib/model";

const BOND_TYPES = new Set(["gov_bond", "tbill"]);

/**
 * Small round logo for a security: the ETF issuer's brand icon (recognised from
 * the full name — price file, then the live quote, then the instrument), a
 * treasury icon for government bonds, otherwise a monogram. The icon is loaded
 * from the issuer's site; offline or on error the monogram stays.
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
  const [failed, setFailed] = useState(false);

  const box = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.38),
  };
  const base =
    "grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold";

  if (instrument && BOND_TYPES.has(instrument.type)) {
    return (
      <span
        className={`${base} bg-[var(--color-brand)]/15 text-[var(--color-brand)]`}
        style={box}
        aria-hidden="true"
      >
        <Landmark style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    );
  }

  const issuer = issuerOf(fileName ?? liveName ?? instrument?.name);
  const label = instrument?.ticker ?? instrument?.name ?? "?";
  const monogram = label
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase();

  if (issuer && !failed) {
    return (
      <span
        className={`${base} bg-white ring-1 ring-[var(--color-border)]`}
        style={box}
        title={issuer.name}
      >
        <img
          src={issuerLogoUrl(issuer)}
          alt={issuer.name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          style={{ width: size * 0.7, height: size * 0.7 }}
        />
      </span>
    );
  }

  return (
    <span
      className={`${base} text-white`}
      style={{ ...box, background: issuer?.color ?? "var(--color-brand)" }}
      title={issuer?.name}
      aria-hidden="true"
    >
      {monogram}
    </span>
  );
}
