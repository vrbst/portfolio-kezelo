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
- **Célok** – cél-allokáció, középtávú célok és rendszeres (DCA)
  megtakarítási célok.
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

## Technológia

Vite · React 19 · TypeScript · Tailwind CSS v4 · Motion · Recharts · Dexie
(IndexedDB) · Zustand · SheetJS · vite-plugin-pwa.

## Indítás

```bash
npm install
npm run dev      # fejlesztői szerver (http://localhost:5173)
npm run lint     # ESLint (a deploy is lefuttatja)
npm run build    # produkciós build a dist/ mappába
```

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

Minden `main`-re pusholt commit után a `.github/workflows/deploy.yml` lintel,
buildel és GitHub Pages-re teszi az appot.

## Árfolyamok frissítése

```bash
npm run prices   # public/prices.json + history.json frissítése (Yahoo + frankfurter)
```

A `.github/workflows/prices.yml` ezt hétköznaponta automatikusan lefuttatja,
commitolja, és utána újradeployol. Új ISIN-t a `scripts/fetch-prices.mjs`
`INSTRUMENTS` listájához adj hozzá (az app élőben a listán kívüli papírokat is
árazza, a lista a napi mentett árat és az árfolyam-előzményt adja).
