# Portfólió-kezelő

Webes portfólió-kezelő alkalmazás magyar befektetőknek. Importálja a
**Lightyear** (CSV) és a **Magyar Államkincstár** (XLS) kivonatait, és egy
letisztult, modern felületen mutatja a teljes portfóliót: TBSZ-számlák (több
évjárat) és államkincstári állampapír-számla.

> Minden adat helyben, a böngésző IndexedDB tárolójában marad. Semmi nem kerül
> külső szerverre.

## Funkciók

- **Importálás** – Lightyear befektetési/pénzszámla CSV és Államkincstár XLS,
  drag & drop, duplikátum-szűréssel.
- **Áttekintő dashboard** – teljes érték, hozam, befektetett tőke, kamat,
  eszközallokáció (számlánként).
- **Számla nézetek** – pozíciók, készpénz devizánként, teljes tranzakció-
  történet; a számla TBSZ-évjárattal felcímkézhető.
- **Modern megjelenés** – sötét téma, finom színátmenetek és animációk
  (Framer Motion / Recharts).

## Technológia

Vite · React 19 · TypeScript · Tailwind CSS v4 · Motion · Recharts · Dexie
(IndexedDB) · Zustand · SheetJS.

## Indítás

```bash
npm install
npm run dev      # fejlesztői szerver (http://localhost:5173)
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

## Állapot

- [x] Projekt-váz, téma, navigáció
- [x] Lightyear + Államkincstár parserek (valós adaton ellenőrizve)
- [x] Adatmodell + IndexedDB tárolás
- [x] Dashboard + számla nézetek
- [x] Élő árfolyamok (ETF Yahoo + EUR/HUF frankfurter) + kézi felülírás
- [ ] GitHub Pages deploy + privát repós szinkron több eszközre

## Árfolyamok frissítése

```bash
npm run prices   # public/prices.json frissítése (Yahoo + frankfurter)
```

A `.github/workflows/prices.yml` ezt hétköznaponta automatikusan lefuttatja és
commitolja, miután a repó felkerült a GitHubra. Új ISIN-t a
`scripts/fetch-prices.mjs` `INSTRUMENTS` listájához adj hozzá.
