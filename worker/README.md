# Árfolyam-proxy Worker

A böngészős portfolio (GitHub Pages) élő árfolyamait ez a Cloudflare Worker továbbítja,
mert a Yahoo és a többi adatforrás böngészőből, CORS miatt közvetlenül nem érhető el.
A címe be van égetve a [`src/lib/prices.ts`](../src/lib/prices.ts)-be
(`https://cold-truth-4d27.vrbst405.workers.dev/`), használata: `?url=<kódolt cél-URL>`.

## Mit csinál

- Csak az `ALLOWED_HOSTS` listán lévő hosztokat proxyzza (különben `403`), így mások nem
  használhatják tetszőleges címekre. A lista a kódban van (`index.js`).
- Minden válaszhoz `Access-Control-Allow-Origin: *`-ot ad, `OPTIONS` kérésre `204`-gyel felel.
- Nincs benne tárolás, titok vagy időzítés (nincs binding, nincs cron).

A lista tágabb, mint amit a portfolio ma használ: a portfolio csak a Yahoo-t
(`query1.finance.yahoo.com`) és a frankfurtert (`api.frankfurter.app`) kéri rajta át. Az
Anthropic- és RSS-hosztok régi használatból maradtak; az Anthropic-ág akkor számítana, ha
az app a kulcsot valaha újra a proxyn át küldené (`?apikey=` vagy `x-api-key`).
Ha ez megtörténne, a Worker naplózása (`redact_query_string: false`) a lekérdezési
paramétert is eltárolná. Ma ilyen hívás nincs.

## Állapot

Ez a mappa az **élő Worker mentése** (letöltve 2026-10-17-én a Cloudflare-fiókból), a
dashboardról kézzel feltöltött kód forrása. A repó **nem** deploy-ol automatikusan.

Módosítás után:

```
cd worker
npx wrangler@4.147.0 deploy --dry-run   # ellenőrzés
npx wrangler@4.147.0 deploy             # éles feltöltés (bejelentkezés kell: wrangler login)
```

A `wrangler.jsonc` az élő beállításokat tükrözi (név, `compatibility_date`, naplózás). Deploy
előtt érdemes a dashboardon összevetni, nehogy egy ott átírt beállítást felülírjon.
