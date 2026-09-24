// ETF / ETP issuers, recognised from a security's full name, for the small
// issuer mark next to it. The mark is drawn in the app's own style (tinted
// tile + monogram in the issuer's brand hue) — no external images.

export interface Issuer {
  name: string;
  /** Monogram shown on the tile (1–2 characters). */
  mark: string;
  /** Brand hue, lifted to read on the dark surfaces. */
  color: string;
}

const ISSUERS: { match: RegExp; issuer: Issuer }[] = [
  {
    match: /vanguard/i,
    issuer: { name: "Vanguard", mark: "V", color: "#f0525a" },
  },
  {
    match: /wisdomtree/i,
    issuer: { name: "WisdomTree", mark: "WT", color: "#4d9bff" },
  },
  {
    match: /ishares|blackrock/i,
    issuer: { name: "iShares", mark: "iS", color: "#d4d4d8" },
  },
  {
    match: /xtrackers|\bdws\b/i,
    issuer: { name: "Xtrackers", mark: "X", color: "#7b8cff" },
  },
  {
    match: /amundi|lyxor/i,
    issuer: { name: "Amundi", mark: "A", color: "#2dd4bf" },
  },
  {
    match: /\bspdr\b|state street/i,
    issuer: { name: "SPDR", mark: "S", color: "#fb923c" },
  },
  {
    match: /invesco/i,
    issuer: { name: "Invesco", mark: "IV", color: "#60a5fa" },
  },
];

/** The issuer named in a security's name, if it's one we know. */
export function issuerOf(name: string | undefined): Issuer | undefined {
  if (!name) return undefined;
  return ISSUERS.find((x) => x.match.test(name))?.issuer;
}
