// The key help (? in the app): what every key does, and the keys of the open tab.

export interface HelpSection {
  title: string;
  rows: [keys: string, what: string][];
}

/** Tab indexes (0-based) that have keys of their own. */
export const TAB_POSITIONS = 1;
export const TAB_CHARTS = 4;

const GENERAL: HelpSection = {
  title: "Mindenhol",
  rows: [
    ["Tab / Shift+Tab", "következő / előző fül"],
    ["← / →", "előző / következő fül"],
    ["1–9", "ugrás az 1–9. fülre (a 10–12. fül csak Tab-bal vagy nyilakkal)"],
    ["p", "összegek és célnevek elrejtése / mutatása"],
    ["r", "újratöltés (adatok és hírek)"],
    ["?", "ez a súgó (Esc vagy ? zárja)"],
    ["q", "kilépés"],
  ],
};

const POSITIONS: HelpSection = {
  title: "Pozíciók fül",
  rows: [["↑ / ↓", "a lista görgetése"]],
};

const CHARTS: HelpSection = {
  title: "Grafikon fül",
  rows: [
    ["c / C", "következő / előző grafikon"],
    ["t", "időszak váltása (előrejelzésnél: horizont)"],
    ["m", "allokáció: eszköztípus / deviza / számla"],
    ["↑ / ↓", "árfolyam-grafikon: előző / következő papír"],
  ],
};

/** The open tab's own keys first, then the general ones. */
export function helpSections(tab: number): HelpSection[] {
  const own = tab === TAB_POSITIONS ? [POSITIONS] : tab === TAB_CHARTS ? [CHARTS] : [];
  return [...own, GENERAL];
}
