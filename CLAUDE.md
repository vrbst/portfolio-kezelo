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

## Az AI-oldal „Új elemzés” gombja (helyi híd)
- A gomb nem az Anthropic API-t hívja, hanem az előfizetést, a my-claude-hubon át. A hub a böngészős `Origin`-t elutasítja (403), ezért közvetítő kell:
  `npm run ai-bridge` (`scripts/notify/analysis/bridge.ts`) egy **csak `127.0.0.1:47811`-en** hallgató szerver, ami az éjszakai elemzés jobját
  (`analysisNow` a `tg-app.ts`-ben, `interactive` prioritással) futtatja, és az eredményt a szinkron-repóba is feltölti. Telegram-üzenet nincs.
- „Csak ezen a gépen”: a gomb csak akkor látszik, ha az app eléri a hidat (`src/lib/aiBridge.ts`, `/health` próba). Más eszközről a híd nem érhető el.
- Védelem: `Host` és `Origin` ellenőrzés (az app címe `APP_URL`-ből + a vite 5173/4173 portjai), a `POST` egyedi fejlécet kér (mindig preflight),
  egyszerre egy elemzés (409 `busy`).
- Automatikus indítás: `npm run ai-bridge:install` (Windows ütemezett feladat `portfolio-ai-bridge`, bejelentkezéskor indul, hiba után újraindul, napló: `logs/ai-bridge.log`;
  `-- -Status` / `-- -Remove`). A végleges mappából telepítsd, ne worktree-ből. Ez folyamatos szerver, nem job, ezért nem a schedulerben van.
- A chat és az árfolyam-kilátás továbbra is a saját API-kulccsal megy (böngészős kivétel, lásd a közös CONVENTIONS).
- Chrome a nyilvános oldalról (GitHub Pages) a loopbackre először engedélyt kérhet („helyi hálózat elérése”): egyszer engedélyezni kell.

## Telegram-beszélgetés a portfólióról (szabad szöveg)
- Minden nem-parancs üzenet (`tg-hub.app.json` `freeText: true`) kérdés az AI-nak, a my-claude-hubon át (Opus, WebSearch/WebFetch; modell: `CHAT_MODEL`).
  Kivétel: a `/maradek` utáni várt összeg (`expectText`). `/uj` új beszélgetést kezd.
- A válasz percekig tart, a kezelő 60 s-os, ezért a kezelő csak eltárolja a kérdést (`.notify/chat.json`, külön fájl, nem a `state.json`: a tick felülírná),
  elindítja a `chat` jobot (`runJob`) és nyugtáz; a job küldi a választ. Kódja: `scripts/notify/chat/` (`store`, `prompt`, `job`).
- A hubnak nincs session-je: minden körben a teljes pillanatkép (`analysisContext`) + az utolsó ≤20 üzenet megy a promptba. 60 perc csend után új beszélgetés.
- A `chat` jobnak az ütemező miatt kell `every`; a 10 perces futás csak pótlás (nincs függő kérdés → üres). A függő kérdés 25 percig él.
- Hibánál a felhasználó a hub `error.code`-ja szerinti üzenetet kapja (kvóta → mikor nullázódik), a függő kérdés mindig törlődik.
- Éles használathoz: `tg-hub restart` és `scheduler restart` (a leírók változtak).
