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
- **Állampapír-kamatok a botban** – a bot az ÁKK adataiból (`public/bond-rates.json`)
  egy tartott állampapír vagy DKJ lejárata előtt 30 és 7 nappal szól, és
  felsorolja a most kapható lakossági állampapírokat és a legutóbbi DKJ-aukció
  hozamát; MÁP Plusz, PMÁP, BMÁP és hasonló sorozatoknál jelzi az új
  kamatperiódust (régi → új kamat). A hiányzó sorozat-adatokat (kamat,
  kamatfizetés gyakorisága, ismert kamatfizetési nap, lejárat) a bot az
  ÁKK-adatokból pótolja; a kézzel beírtakat soha nem írja felül.
- **Nem csak fix kamatú, negyedéves papírok** – a kamatfizetés gyakorisága
  sorozatonként éves, féléves, negyedéves vagy havi lehet; a változó kamatú
  papíroknál (PMÁP, BMÁP, MÁP Plusz, KTV) az app és a bot az ÁKK aktuális
  kamatperiódusának kamatával értékel, minden kupon a saját periódusa kamatával
  számolódik, a még meg nem hirdetett jövőbeli periódusokra az utolsó ismert
  kamattal. A tőkésítő papír (pl. Babakötvény) évente a tőkéhez adja a kamatot,
  közben nem fizet, és a lejáratkor egy összegben jön. Tört első periódusnál az
  ÁKK-ból ismert kifizetési nap lesz az ütemezés kiindulópontja.
- **Állampapír-csere javaslat** – a kincstári számla oldalán az app a tartott
  állampapírok kamatát összeveti a most kapható lakossági papírokkal
  (`public/bond-rates.json`): csere-jelöltet akkor mutat, ha az új papír legalább
  0,25 százalékponttal többet hoz, és a lejárat előtti visszaváltási díj a
  mostani papír lejáratáig megtérül (megtérülési idő, becsült többlet). Az
  AI elemzés ugyanezt az összevetést kapja meg, a chat pedig a
  `compare_gov_bonds` eszközzel kérdezheti le.
  A bot ugyanezt jelzi: új csere-jelöltnél egyszer szól (90 nap után, ha még
  mindig érvényes, újra), a változó kamatú papír új kamatperiódusáról szóló
  üzenetbe beleírja a csere-jelöltet, a lejárati üzenetbe pedig a most elérhető
  legmagasabb hozamot. Változó kamatú papírnál az ÁKK aktuális kamatperiódusának
  kamatával számol, nem a kézzel beírt kamattal.
- **Árfolyamok a botban** – a Telegram-bot `/arfolyam` parancsa elsőként az
  EUR/HUF-ot (és a tartott papírok többi devizáját) mutatja, utána minden
  tartott részvényt és ETF-et: aktuális ár saját devizában és napi változás.
  Ahol nincs élő ár, az
  árfolyamfájl záróára jelenik meg, jelölve.
- **Nagy mozgás és „Miért mozdult?” a botban** – ha a portfólió, egy tartott
  papír vagy az EUR/HUF aznap legalább 1%-ot mozdul (`NOTIFY_BIG_MOVE_PCT`,
  `NOTIFY_POSITION_MOVE_PCT` a `.notify/.env`-ben), a riasztás azonnal megy;
  utána egy rövid AI-hírkeresés (`news-why` job, alapból `sonnet`,
  `NEWS_WHY_MODEL`) külön üzenetben megírja, mi mozgatta, forrásokkal. Egy
  tényezőt naponta egyszer magyaráz, az egyszerre mozdulókat egy keresésben,
  és naponta legfeljebb 3 keresés fut. Csak Telegramon jelenik meg, az app
  Hírek oldalán nem. Papíronként saját küszöb adható
  (`NOTIFY_MOVE_PCT_OVERRIDES="WBIT:4,XYZ:2"`, tickerre, ISIN-re vagy névre;
  alapból `WBIT:4`), és egy mögöttes eszközt követő papírnál megadható, mire
  keressen a „Miért?” (`NOTIFY_WHY_SUBJECT="WBIT=Bitcoin (BTC)"`, több
  pontosvesszővel elválasztva; alapból ez). A hibás bejegyzéseket kihagyja.
- **Tervek és mutatók a botban** – `/terv`: az e havi Havi terv (mit vegyél,
  melyik számlán); `/palya`: célpálya-súlyok a sávokkal, végcél, sávon kívül
  a javasolt lépések; `/hozam`: XIRR, TWR, VWCE-összevetés, időszakos és
  számlánkénti eredmény; `/tbsz`: TBSZ-szakaszok, határidők, nettó érték most
  és a következő mérföldkövek után.
- **Értesítések a botban** – a célok 25/50/75/100%-os mérföldkövei; minden
  újabb kerek összeg (alapból 1 M Ft, `NOTIFY_WEALTH_STEP_HUF`) átlépése; a
  csúcstól mért visszaesés 5%-onként (`NOTIFY_DRAWDOWN_STEP_PCT`, a
  befizetésektől függetlenül, az összes eredményből) és a visszatérés a
  csúcsra; a hónap 10-étől a Havi terv még hiányzó tételei; saját ár- és
  árfolyamriasztás (`/riasztas VWCE 100 alatt`, `/riasztas EUR 400 felett`,
  `/riasztas torol 1`; teljesülés után törlődik); január 1-jén éves zárás;
  május 20-ig szja-emlékeztető a TBSZ-en kívüli számlák előző évi
  jövedelméről; és ha egy tartott papírnak 7+ napja nincs új ára.
- **AI-felhasználás a botban** – minden AI-futás (reggeli és esti hírek,
  `/hirkereses`, „Miért mozdult?”, az újrapróbálásokkal együtt) egy sort ír a
  `.notify/ai-usage.jsonl`-be: modell, tokenek (be, ki, cache), webes
  keresések, lépések, futási idő, „API-áron” számolt $, siker vagy hiba. A
  napló 180 napot (legfeljebb 5000 sort) tart meg, és az írása soha nem
  buktat el egy jobot. A `/koltseg` az elmúlt 7 és 30 nap összesítését küldi
  feladatonként és modellenként, a heti összefoglaló pedig egy sort
  („🤖 AI: 12 futás, ~$4,80 API-áron (előző hét: $3,90)”). A $ csak
  tájékoztató: a futások az előfizetés keretéből mennek.
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
npm run prices       # public/prices.json + history.json frissítése (Yahoo + frankfurter)
npm run bond-rates   # public/bond-rates.json: lakossági állampapír-kamatok, kamatperiódusok, DKJ-aukciók (ÁKK)
```

Az ÁKK-adatok az akk.hu statisztikai oldalainak nem hivatalos JSON-API-jából
jönnek; ha a lekérdezés vagy a mezők megváltoznak, a script a korábbi adatokat
megtartja és hibával áll le, a bot pedig 7 nap után szól, hogy a fájl elavult.

A `.github/workflows/prices.yml` ezt hétköznaponta automatikusan lefuttatja,
commitolja, és utána újradeployol. Új ISIN-t a `scripts/fetch-prices.mjs`
`INSTRUMENTS` listájához adj hozzá (az app élőben a listán kívüli papírokat is
árazza, a lista a napi mentett árat és az árfolyam-előzményt adja).
