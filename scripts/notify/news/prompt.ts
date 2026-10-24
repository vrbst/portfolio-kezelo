// The research brief for the daily news digest. The model gets what the
// portfolio is exposed to — instruments and their weights in percent, never
// an amount — and the titles already reported, so it doesn't repeat them.

import { consolidatedHoldings, currentRate } from "../../../src/lib/portfolio";
import { txDay } from "../../../src/lib/day";
import {
  EVENT_KINDS,
  NEWS_EDITION_LABEL,
  type NewsEdition,
  type NewsIndexEntry,
} from "../../../src/lib/newsSchema";
import type { Context } from "../data";
import { profileSection } from "../profile";

const TYPE_LABEL: Record<string, string> = {
  etf: "ETF",
  stock: "részvény",
  fund: "befektetési alap",
  gov_bond: "magyar állampapír",
  tbill: "diszkont kincstárjegy (DKJ)",
  cash: "pénzpiaci",
};

const pctOf = (part: number, total: number) =>
  total > 0 ? `${((part / total) * 100).toFixed(1).replace(".", ",")}%` : "?";

/**
 * The portfolio as the model may see it: one line per instrument (weight,
 * type, currency, coupon kind for bonds), the cash, the account kinds.
 */
export function portfolioExposure(ctx: Context): string[] {
  const s = ctx.summary;
  const total = s.totalValueHuf;
  const lines = consolidatedHoldings(s)
    .filter((h) => h.quantity > 1e-9 && h.marketValueHuf > 0)
    .sort((a, b) => b.marketValueHuf - a.marketValueHuf)
    .map((h) => {
      const i = h.instrument;
      const what = [
        TYPE_LABEL[i?.type ?? ""] ?? i?.type ?? "",
        h.currency,
        i?.ticker ? `ticker: ${i.ticker}` : "",
        i?.isin ? `ISIN: ${i.isin}` : "",
        currentRate(i?.bond) != null ? `kamat: ${(currentRate(i?.bond)! * 100).toFixed(2)}%` : "",
        i?.maturity ? `lejárat: ${txDay(i.maturity)}` : "",
      ].filter(Boolean);
      return `- ${i?.name ?? h.instrumentKey} (${what.join(", ")}): ${pctOf(h.marketValueHuf, total)}`;
    });
  if (s.cashValueHuf > 0) lines.push(`- Készpénz: ${pctOf(s.cashValueHuf, total)}`);
  const kinds = new Set(s.accounts.map((a) => a.account.kind));
  const accounts = [
    kinds.has("tbsz") ? "TBSZ (magyar tartós befektetési számla)" : "",
    kinds.has("treasury") ? "Magyar Államkincstár értékpapírszámla" : "",
    kinds.has("regular") ? "normál brókerszámla" : "",
  ].filter(Boolean);
  if (accounts.length) lines.push(`- Számlák: ${accounts.join(", ")}`);
  return lines;
}

const WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

export interface PromptInput {
  /** Local day of the digest, YYYY-MM-DD. */
  day: string;
  weekday: number;
  edition: NewsEdition;
  exposure: string[];
  /** Recent digests (newest first), to continue from and not repeat. */
  previous: NewsIndexEntry[];
  /** The user's investment preferences (from the assistant), if any. */
  profile?: string;
}

export function buildNewsPrompt(p: PromptInput): string {
  const last = p.previous[0];
  const since = last
    ? `az előző összefoglaló (${last.day}, ${NEWS_EDITION_LABEL[last.edition].toLowerCase()}) óta — hétvége vagy kimaradt futás után az egész időszakot`
    : "az elmúlt 24 órában (hétfőn a hétvégén is)";
  const morning = p.edition === "morning";
  const situation = morning
    ? "reggel van, a Xetra 9:00-kor nyit"
    : "a Xetra kereskedés lezárult";
  const task = morning
    ? `Reggeli előzetest írsz: keress a weben és foglald össze, mi történt ${since}, főleg az éjszaka (amerikai zárás és utána, ázsiai piacok, éjszakai geopolitikai és gazdaságpolitikai hírek), és mire számíthatunk ma (mai adatközlések, kamatdöntések, aukciók, határidők) — mindazt, ami a lenti portfólió értékét vagy a befektetési döntéseket befolyásolhatja.`
    : `Napzártát írsz: keress a weben és foglald össze, mi történt ${since} (főleg a mai kereskedési napon: mi mozgatta a forintot, a kamatokat és a piacokat), ami a lenti portfólió értékét vagy a befektetési döntéseket befolyásolhatja.`;
  const already = p.previous
    .slice(0, 4)
    .flatMap((d) => d.titles.map((t) => `- [${d.day} ${NEWS_EDITION_LABEL[d.edition].toLowerCase()}] ${t}`));

  return `Te egy magyar magánbefektető piaci hírszerkesztője vagy. Ma ${p.day}, ${WEEKDAYS[p.weekday]}; ${situation}.

${task}

A portfólió (súlyok a teljes vagyonból):
${p.exposure.join("\n")}${profileSection(p.profile)}

Témák, amiket mindig nézz meg:
- Forint: EUR/HUF és USD/HUF mozgása és oka.
- Kamatok: MNB (alapkamat, kommunikáció), EKB, Fed; magyar és eurós hozamgörbe.
- Magyar állampapírok: ÁKK aukciók, lakossági állampapírok (FixMÁP, PMÁP, MÁP Plusz, DKJ) kamatváltozásai, új sorozatok, KSH inflációs adat (a PMÁP kamatát befolyásolja).
- Globális részvénypiac (a világindex-ETF szempontjából): nagy indexek, szektorok, vállalati hírek, ha piacot mozgattak.
- Bitcoin / kripto, ha a portfólióban van.
- Geopolitika és gazdaságpolitika: háborúk, vámok, szankciók, választások, magyar költségvetés és hitelminősítések, EU-források.
- Makroadatok: infláció, GDP, munkaerőpiac, beszerzési menedzserindexek (USA, eurózóna, Magyarország).

Szabályok:
- Csak megbízható forrás (pl. Reuters, Bloomberg, FT, CNBC, MNB, ÁKK, KSH, Portfolio.hu, telex.hu, hvg.hu, index.hu). Minden hírhez adj legalább egy valódi forrás-URL-t, amit ténylegesen megnyitottál vagy a keresés visszaadott.
- Ne találj ki számot, árfolyamot vagy idézetet: ha bizonytalan, hagyd ki.
- Ne ismételd az alábbi, már közölt híreket, hacsak nincs érdemi fejlemény (akkor az új fejleményt írd meg):
${already.length ? already.join("\n") : "- (nincs korábbi)"}
- 4–10 hír, a legfontosabb elöl. importance: 3 = érdemben mozgatja a portfóliót vagy döntést igényelhet, 2 = érdemes tudni, 1 = háttér.
- impact: a portfólió érintett elemeire várható hatás ("up" = értéknövelő, "down" = értékcsökkentő, "mixed", "neutral"). A gyengülő forint a devizás eszközök forintértékét növeli.
- affects: a portfólió érintett elemei rövid névvel (pl. "VWCE", "WBIT", "EUR/HUF", "FixMÁP", "DKJ", "PMÁP").
- title: legfeljebb ~80 karakter; summary: 1–3 mondat, és mondja ki, miért számít ennek a portfóliónak.
- headline: egyetlen mondat, a nap lényege.
- upcoming: ${morning ? "a mai nap és " : ""}a következő ~7 nap fontos eseményei (kamatdöntés, inflációs adat, aukció, választás, piacmozgató gyorsjelentés), dátummal és hogy miért számít. Minden eseményhez mind a tizenegy mezőt add meg:
  - time: a bejelentés ideje "HH:MM" alakban, BUDAPESTI idő szerint — hivatalos naptárból (KSH, MNB, Fed, BLS, Eurostat, EKB, ÁKK, Országgyűlés), vagy ha csak megbízható sajtóhír közli, abból; különben null. Ne becsülj. (Az USA-beli időpontokat váltsd át budapesti időre.)
  - timeApprox: true, ha a time nem hivatalos naptárból, csak sajtóhírből való; különben false.
  - session: csak gyorsjelentésnél, ha nincs pontos time: "pre", ha a cég az amerikai tőzsdenyitás előtt jelent, "post", ha zárás után (a cég bejelentése vagy megbízható naptár szerint, akkor is, ha a források a percben eltérnek); különben null.
  - followUp: true csak akkor, ha az esemény ütemezett, az ideje ismert (pontos time, vagy gyorsjelentésnél a session), az eredménye számszerű vagy döntés, és a lenti portfóliót érdemben mozgathatja (pl. inflációs adat, kamatdöntés, foglalkoztatási adat, GDP, ÁKK-aukció eredménye, a magyar költségvetés vagy hiánycél bemutatása, hitelminősítés, a világindexet vagy a piaci hangulatot mozgató nagy cég gyorsjelentése); egyébként false. Naponta legfeljebb 3 ilyen legyen.
  - kind: a fajtája a listából: ${EVENT_KINDS.join(", ")}; gyorsjelentésnél EARNINGS; ha egyik sem illik, OTHER; ha nincs követés, null.
  - query: OTHER fajtánál, ha followUp true: 2–4 szavas magyar keresőkifejezés, amellyel a Google Hírekben az eredményről szóló cikkek megtalálhatók (pl. "2027-es költségvetés", "Moody's Magyarország"); különben null.
  - Gyorsjelentésből cégenként külön tétel legyen, és az event a cég nevével kezdődjön (pl. "Tesla gyorsjelentés", "Meta gyorsjelentés").
  - pressTime: kamatdöntésnél a sajtótájékoztató kezdete "HH:MM" budapesti idő szerint, ha hivatalosan ismert; különben null.
  - expected: a várakozás/konszenzus rövid szöveggel (pl. "3,0% é/é"), ha megbízható forrásból ismert; különben null.
- Minden szöveg magyarul.

A válasz kizárólag a megadott JSON-séma szerinti objektum legyen.`;
}
