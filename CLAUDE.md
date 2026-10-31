# Portfólió-kezelő – szabályok a munkához

## Mielőtt késznek mondasz egy változást
- `npm run lint && npm test && npx tsc -b` legyen zöld. UI-változásnál:
  `npm run test:e2e` is (előtte build; sandboxban `PW_CHROMIUM_PATH`-szal).
- A deploy (`.github/workflows/deploy.yml`) ugyanezt futtatja a
  `checks.yml`-en át — piros teszttel nincs deploy.

## Hibajavítás
- Minden hibajavításhoz tartozzon teszt, ami a javítás ELŐTT elbukik
  (ellenőrizd: vedd vissza a javítást, és nézd meg, hogy piros).
- Ha a hiba egy egész hibacsaládot jelent (pl. dátum, kerekítés, dupla
  számolás), fontold meg a szabályteszt (`scripts/notify/invariants.test.ts`,
  `src/lib/properties.test.ts`) bővítését is, ne csak az egy esetet.

## Dátumok (a leggyakoribb hibaforrás)
- A tárolt tranzakció-dátum egy HELYI időpont ISO-alakja; a kincstári tételek
  helyi éjfélként (Budapesten UTC-ben az előző nap!).
- Soha: `toISOString().slice(0, 10)`, `t.date.slice(0, 10)` — az ESLint tiltja.
  Helyette `src/lib/day.ts`: `txDay`, `toLocalDay`, `todayLocal`, `addDaysIso`,
  `utcDay` (csak ha az érték eleve UTC).
- A tesztek alapból Europe/Budapest időzónában futnak; a CI UTC-ben és
  New Yorkban is. Tesztadatot helyi időből építs (`new Date(y, m-1, d)`).

## Számok változása
- A `scripts/notify/pipeline.test.ts` a teljes számítási lánc eredményét
  rögzíti (`__snapshots__/*.txt`). Ha egy szám szándékosan változik: nézd át a
  diffet, `npm run test:update`, és a commit üzenetében írd le, mi és miért
  változott. Nem szándékos diff = hiba.

## Adatvédelmi mód
- Minden személyes Ft/EUR összeg `.amt` (vagy `<Amt>`), minden célnév `.priv`
  (vagy `<PrivateText>`); generált mondatban `<PrivateText text=… amounts />`.
- Nyilvános adat (piaci árfolyam, fix minta) `data-privacy="public"`.
- Az e2e teszt minden oldalon ellenőrzi, hogy semmi személyes nem olvasható.

## Tesztadat
- Csak a kitalált portfólió (`src/test/fixture.ts`) — valódi adatot (CSV,
  XLS, szinkron-mentés) soha ne tegyél a repóba.

## Az asszisztens-nézet (HTML-popup az asszisztens hubjában)
- A nézetet a `scripts/notify/assistantView.ts` állítja elő (`portfolioViewHtml(ctx, appUrl)`: ugyanaz a `Context`, mint a Telegram-riportoké),
  a `tg-app.ts` `assistant_view` parancsa adja `{ view: { html, title } }` alakban. A leíró az `asszisztens.app.json` (`reads`, `view`, `actions`);
  a parancs szándékosan nincs a `tg-hub.app.json`-ban, Telegramon nem érhető el.
- **A szerződés** (mi engedélyezett, stílusváltozók, `data-act` / `data-open` / `data-refresh`): `..\asszisztens\docs\app-view.md`. Röviden: csak HTML +
  CSS + inline SVG; nincs `<script>`, eseménykezelő, külső kép / betűtípus / URL, `<iframe>`, `<form>`. A védelmet az asszisztens CSP-je kényszeríti ki,
  de a nézet maga is tartsa be (a teszt ellenőrzi). Grafikon = szerveroldalon rajzolt SVG.
- Minden szöveg, ami adatból jön (papírnevek, célnevek, címek), `esc()`-en át kerül a HTML-be.
- A gombok a leíró `actions` listájából valók: a `data-act` értéke egy létező művelet azonosítója (a külső hatásúhoz az asszisztens megerősítést kér).
  Új művelethez előbb az `asszisztens.app.json`, aztán a parancs a kezelőben, és a teszt (`assistantView.test.ts`) összeveti a kettőt.
- A nézet gyorsítótárazott (`freshFor`, `refreshOn: ["tick"]`): az első megnyitás egy teljes kontextus-betöltés (~4–5 mp).
- Változtatás után: `npm run lint && npm test && npx tsc -b`; a nézetet az asszisztens popupjában (P) kell megnézni, a UI-szervert nem kell újraindítani
  (a nézetet kérésenként kapja), csak ha a leíró (`asszisztens.app.json`) változott.
