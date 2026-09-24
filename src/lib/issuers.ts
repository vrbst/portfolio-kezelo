// ETF / ETP issuers, recognised from a security's full name, for the small
// brand logo next to it. The logo itself is the issuer site's icon, fetched at
// runtime (see InstrumentLogo) — nothing is bundled.

export interface Issuer {
  name: string;
  /** Site whose icon is shown as the logo. */
  domain: string;
  /** Brand-ish colour for the monogram fallback (offline / icon missing). */
  color: string;
}

const ISSUERS: { match: RegExp; issuer: Issuer }[] = [
  {
    match: /vanguard/i,
    issuer: { name: "Vanguard", domain: "vanguard.com", color: "#96151d" },
  },
  {
    match: /wisdomtree/i,
    issuer: { name: "WisdomTree", domain: "wisdomtree.eu", color: "#0a5eb0" },
  },
  {
    match: /ishares|blackrock/i,
    issuer: { name: "iShares", domain: "ishares.com", color: "#111111" },
  },
  {
    match: /xtrackers|\bdws\b/i,
    issuer: { name: "Xtrackers", domain: "xtrackers.com", color: "#0018a8" },
  },
  {
    match: /amundi|lyxor/i,
    issuer: { name: "Amundi", domain: "amundietf.com", color: "#00a3a1" },
  },
  {
    match: /\bspdr\b|state street/i,
    issuer: { name: "SPDR", domain: "ssga.com", color: "#0d2c6c" },
  },
  {
    match: /invesco/i,
    issuer: { name: "Invesco", domain: "invesco.com", color: "#0a2a5e" },
  },
];

/** The issuer named in a security's name, if it's one we know. */
export function issuerOf(name: string | undefined): Issuer | undefined {
  if (!name) return undefined;
  return ISSUERS.find((x) => x.match.test(name))?.issuer;
}

/** Icon URL for an issuer's site (Google's favicon service, 64px). */
export function issuerLogoUrl(issuer: Issuer): string {
  return `https://www.google.com/s2/favicons?domain=${issuer.domain}&sz=64`;
}
