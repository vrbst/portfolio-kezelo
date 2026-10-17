// HTTP-átvitel: sima node:http(s), nem fetch. A hosszú válasz (12+ perc) esetén a Node beépített fetch-e
// (undici `headersTimeout`) 300 s után megszakítja a kapcsolatot, ha addig nem jön válaszfejléc; ez hamis
// „a hub nem érhető el” hibát adna. Itt csak a valódi kapcsolódási hiba `unreachable`; a már létrejött,
// majd megszakadt kapcsolat `connection_lost`.
import http from "node:http";
import https from "node:https";
import { ConnectionLostError, HubUnreachableError } from "./errors.js";
/** A tárgy kérés felső korlátja: a határidőig hátralévő idő + futási idő + 2 perc; határidő nélkül futási idő + 15 perc. */
export function requestCapMs(timeoutS, deadline, now = Date.now()) {
    const run = timeoutS * 1000;
    return deadline ? Math.max(0, deadline.getTime() - now) + run + 2 * 60_000 : run + 15 * 60_000;
}
function abortError(signal) {
    const e = new Error(typeof signal?.reason === "string" ? signal.reason : "A kérés megszakítva.");
    e.name = "AbortError";
    return e;
}
/** POST JSON a hubnak; a válaszfejléc megérkezésekor teljesül. */
export function openPost(url, apiKey, payload, capMs, signal) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(url);
        }
        catch {
            return reject(new HubUnreachableError(`Érvénytelen hub-cím: ${url}`));
        }
        if (signal?.aborted)
            return reject(abortError(signal));
        let connected = false;
        let gotHeaders = false;
        let capped = false;
        let aborted = false;
        let timer;
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            aborted = true;
            req.destroy();
        };
        const capMsg = () => `A hub ${Math.round(capMs / 1000)} s alatt sem fejezte be a választ (biztonsági korlát).`;
        const lib = u.protocol === "https:" ? https : http;
        const req = lib.request(u, {
            method: "POST",
            agent: false, // minden híváshoz friss kapcsolat: nincs elavult keep-alive, ami összezavarná a hibafajtát
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${apiKey}` },
        }, (res) => {
            gotHeaders = true;
            async function* chunks() {
                try {
                    for await (const c of res)
                        yield c;
                    if (!res.complete)
                        throw new ConnectionLostError("A hub lezárta a kapcsolatot a válasz vége előtt.");
                }
                catch (e) {
                    if (e instanceof ConnectionLostError)
                        throw e;
                    if (aborted)
                        throw abortError(signal);
                    throw new ConnectionLostError(capped ? capMsg() : `A hub kapcsolata megszakadt a válasz közben: ${e.message}`);
                }
                finally {
                    cleanup();
                }
            }
            resolve({
                status: res.statusCode ?? 0,
                chunks: chunks(),
                close: () => {
                    res.destroy();
                    cleanup();
                },
            });
        });
        timer = setTimeout(() => {
            capped = true;
            req.destroy();
        }, capMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("socket", (s) => {
            if (!s.connecting)
                connected = true;
            else
                s.once("connect", () => (connected = true));
        });
        req.on("error", (e) => {
            if (gotHeaders)
                return; // a válasz közbeni hibát a chunks() jelzi
            cleanup();
            if (aborted)
                return reject(abortError(signal));
            if (capped)
                return reject(new ConnectionLostError(capMsg()));
            if (connected)
                return reject(new ConnectionLostError(`A hub kapcsolata megszakadt: ${e.message}`));
            reject(new HubUnreachableError(`A hub nem érhető el (${u.origin}): ${e.code ?? e.message}`));
        });
        req.end(payload);
    });
}
/** A teljes választörzs szövegként. */
export async function readText(o) {
    const parts = [];
    try {
        for await (const c of o.chunks)
            parts.push(Buffer.from(c));
    }
    finally {
        o.close();
    }
    return Buffer.concat(parts).toString("utf8");
}
