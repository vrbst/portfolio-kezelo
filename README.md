# Portfólió-kezelő

Webes portfólió-kezelő alkalmazás magyar befektetőknek. Importálja a
**Lightyear** (CSV) és a **Magyar Államkincstár** (XLS) kivonatait, és egy
letisztult, modern felületen mutatja a teljes portfóliót: TBSZ-számlák (több
évjárat) és államkincstári állampapír-számla.

Élesben: <https://vrbst.github.io/portfolio-kezelo/> (telepíthető PWA).

> Az adatok alapból helyben, a böngésző IndexedDB tárolójában maradnak. Külső
> szolgáltatás csak akkor kap adatot, ha bekapcsolod:
> - **Szinkron** – a portfólió egy JSON-fájlként a *saját, privát* GitHub
>   repódba kerül (a token csak az adott eszközön tárolódik).
> - **AI elemzés** – a saját Claude API-kulcsoddal csak aggregált pillanatkép
>   megy az Anthropic API-nak, tranzakció soha.
>
> Az árfolyamok lekérése (Yahoo, frankfurter.app) személyes adatot nem küld.

## Funkciók

- **Importálás** – Lightyear befektetési/pénzszámla CSV és Államkincstár XLS,
  drag & drop, duplikátum-szűréssel. Az újraimportálás a már meglévő papírok
  hiányzó adatait pótolja, a kézi beállításokat nem írja felül.
- **Áttekintés** – teljes érték, napi változás (a be-/kifizetések nélkül),
  hozam, befektetett tőke, kamat, eszközallokáció, értékgrafikon.
- **Számlák** – pozíciók, készpénz devizánként, teljes tranzakció-történet,
  TBSZ-évjárat és -idővonal, kilépési érték; a számla törölhető (a törlés
  szinkronizálódik, újraimportálással visszahozható).
- **Hozam** – XIRR, TWR és egyszerű hozam (egy évnél rövidebb adatsorra a
  teljes időszak hozama a fő szám), összevetés a VWCE világindexszel forintban,
  realizált eredmény és kamat évenként, TER-költség.
- **Naptár** – befektetési mozgások és várható kifizetések (kupon, lejárat,
  TBSZ-mérföldkövek) az egész évre.
- **Előrejelzés** – a meglévő vagyon, a kötvényhozamok és a havi megtakarítás
  alapján vetített pálya pesszimista/reális/optimista sávval, betervezett
  kiadásokkal.
- **Célok** – célpálya (saját eszközcsoportok, amelyek célsúlya egy pálya
  mentén mozog, sávval; verziózott beállítások, idősoros grafikon), Teendők
  panel (hová menjen a bejövő pénz, sávkorrekció költséggel és minimális
  tranzakciómérettel, „mi lenne, ha” szimuláció — az app semmit nem hajt
  végre, a javaslat teendőként rögzíthető), középtávú célok (hozzárendelt
  eszközökkel, konkrét jövőbeni kuponokkal és a havi félretétel kezdő
  dátumával) és rendszeres (DCA) megtakarítási célok. Hónap végi maradék: a
  Havi terv alatt beírt (vagy a botnak `/maradek 50000`-ként küldött)
  megmaradt pénz előbb a hónap hiányzó célrészeire, majd a közeli határidős
  célok teljes hátralévő összegére, végül a célpályára megy; a hónap utolsó
  munkanapján (magyar munkanap-naptár) a bot rákérdez.
- **„Ha most eladnék mindent”** – a Telegram-bot `/eladas` parancsa megmondja,
  mennyi pénzed lenne, ha ma mindent eladnál: a TBSZ-eken a hozam adójával (a
  számla aktuális szakaszának kulcsával), az állampapíroknál a lejárat előtti
  visszaváltási díjjal (alapból 1%) csökkentve, számlánkénti bontásban.
- **Árfolyamok a botban** – a Telegram-bot `/arfolyam` parancsa elsőként az
  EUR/HUF-ot (és a tartott papírok többi devizáját) mutatja, utána minden
  tartott részvényt és ETF-et: aktuális ár saját devizában és napi változás.
  Ahol nincs élő ár, az
  árfolyamfájl záróára jelenik meg, jelölve.
- **Figyelmeztetések** – parlagon heverő készpénz, TBSZ-határidők, elmaradt
  célok, kupon-import emlékeztetők, saját teendők.
- **AI elemzés** – egykattintásos értékelés és szabad kérdés-válasz
  (Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5 / Haiku 4.5), becsült havi
  költséggel.
- **Élő árfolyamok** – ETF-ek Yahoo-ról (Cloudflare Worker proxyn át),
  EUR/HUF a frankfurter.app-ról; ideiglenes kézi ár és szimbólum-felülírás.
- **Szinkron és mentés** – eszközök közti szinkron privát GitHub-repón át,
  teljes helyi mentés JSON-fájlba.
- **Adatvédelmi mód** – egy kattintással elmossa az összegeket.
- **Skinek** – a Beállítások → Megjelenés alatt választható kinézetek a
  klasszikus mellett: **Terminál** (zöld foszfor, monospace, szögletes dobozok,
  kikapcsolható CRT hatás), **Újság** (világos, lazacszínű papír, tinta, serif
  címek és számok) és **Win95** (szürke domború ablakok kékeszöld asztalon,
  sötétkék címsorok, pixeles számok); eszközönként tárolódik.

## Technológia

Vite · React 19 · TypeScript · Tailwind CSS v4 · Motion · Recharts · Dexie
(IndexedDB) · Zustand · SheetJS · vite-plugin-pwa.

## Indítás

```bash
npm install
npm run dev      # fejlesztői szerver (http://localhost:5173)
npm run lint     # ESLint (a deploy is lefuttatja)
npm test         # unit, szabály- és láncteszt (Vitest; a deploy is lefuttatja)
npm run test:e2e # böngészős teszt a megépített appon (Playwright)
npm run build    # produkciós build a dist/ mappába
```

## Tesztek

Minden pull requesten és minden deploy előtt lefut
(`.github/workflows/checks.yml`); ha bármelyik piros, nincs deploy.

| Réteg | Hol | Mit fog meg |
| --- | --- | --- |
| Egységtesztek | `src/lib/*.test.ts` | egy-egy számítás kézzel ellenőrzött értékekkel |
| Időzóna | a tesztek Budapest, UTC és New York időzónában is futnak | nappal elcsúszó lejárat, befizetés, kupon (UTC-nap a helyi nap helyett) |
| Láncteszt (pillanatfelvétel) | `scripts/notify/pipeline.test.ts` | bármely szám vagy botszöveg változása a teljes láncon (portfólió → célok → havi terv → maradék → riasztások → előrejelzés) |
| Szabálytesztek | `scripts/notify/invariants.test.ts`, `src/lib/properties.test.ts` | véletlen napokon és összegekkel: pénz nem vész el és nem keletkezik, cél nem kap a hiányánál többet, a tétel = „Hová utald?”, nincs morzsa-vétel, nincs dupla riasztás, a szinkron nem töröl |
| Böngésző | `e2e/app.spec.ts` | oldalhiba, telefonon kilógó elem, adatvédelmi módban olvasható összeg vagy célnév |

A tesztek egy **kitalált** portfólión futnak (`src/test/fixture.ts`) — valódi
adat soha nem kerül a repóba.

Ha egy szám **szándékosan** változik, a láncteszt diffet mutat a
`scripts/notify/__snapshots__/*.txt` fájlokban: nézd át, majd
`npm run test:update`, és commitold a frissített fájlokat a változással együtt.

Dátumkezelés: a `toISOString().slice(0, 10)` és a `tranzakció.date.slice(0, 10)`
mintát az ESLint tiltja (Budapesten a helyi éjfél UTC-ben az előző nap) —
a `src/lib/day.ts` segédfüggvényeit használd.

## Importálható fájlok

| Forrás | Formátum | Tartalom |
| --- | --- | --- |
| Lightyear – befektetési | `AccountStatement-LY-*.csv` | vétel/eladás, átváltás, ETF-ek |
| Lightyear – pénzszámla | `AccountStatement-LY-*.csv` | be-/kifizetések |
| Magyar Államkincstár | `transaction*.xls` | állampapír vétel/eladás, kamat, pénzmozgás |

## Megjegyzés az államkincstári készpénzről

A kincstári export a kötvény-tranzakciók (Vétel/Eladás) **cash-oldalát** külön,
„Pénzszámla be-/kifizetés" tételként is felsorolja — ezek belső tükör-tételek.
A valós készpénz-egyenleg az alábbi, ellenőrzött képletből áll össze (a minta-
adatra pontosan 0):

```
Utalás érkeztetés + Bankkártyás fizetés − Utalás indítás
  − Vétel + Eladás + kamat  =  készpénz
```

Ezért a „Pénzszámla be-/kifizetés" tételek `internal` jelölést kapnak, és nem
számítanak bele a készpénzbe / hozamba (de a tranzakció-listában láthatók).

## Deploy

Minden `main`-re pusholt commit után a `.github/workflows/deploy.yml` lefuttatja
az összes ellenőrzést (lint, tesztek három időzónában, build, böngészős teszt),
és csak ha mind zöld, GitHub Pages-re teszi az appot.

## Árfolyamok frissítése

```bash
npm run prices   # public/prices.json + history.json frissítése (Yahoo + frankfurter)
```

A `.github/workflows/prices.yml` ezt hétköznaponta automatikusan lefuttatja,
commitolja, és utána újradeployol. Új ISIN-t a `scripts/fetch-prices.mjs`
`INSTRUMENTS` listájához adj hozzá (az app élőben a listán kívüli papírokat is
árazza, a lista a napi mentett árat és az árfolyam-előzményt adja).
