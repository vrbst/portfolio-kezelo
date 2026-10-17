import { BadRequestError, ConnectionLostError, errorFromResponse, HubClientError, UnauthorizedError } from "./errors.js";
import { parseSse } from "./sse.js";
import { openPost, readText, requestCapMs } from "./transport.js";
export const DEFAULT_URL = "http://127.0.0.1:7420";
/** A felső korlát számításához, ha a hívás nem ad `timeout_s`-t (a hubon a profilok legnagyobb engedett ideje). */
export const DEFAULT_TIMEOUT_S = 1800;
function env(name) {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
}
function resolve(...conns) {
    const pick = (k) => conns.map((c) => c?.[k]).find((v) => v !== undefined);
    const baseUrl = (pick("baseUrl") ?? env("MY_CLAUDE_HUB_URL") ?? DEFAULT_URL).replace(/\/+$/, "");
    const apiKey = pick("apiKey") ?? env("MY_CLAUDE_HUB_KEY") ?? "";
    const capMs = pick("capMs");
    if (!apiKey)
        throw new UnauthorizedError("Nincs app-kulcs: add meg az apiKey opciót vagy a MY_CLAUDE_HUB_KEY környezeti változót.");
    return { baseUrl, apiKey, ...(capMs !== undefined ? { capMs } : {}) };
}
function bodyOf(o) {
    if (!o || typeof o.prompt !== "string")
        throw new BadRequestError("A prompt kötelező szöveg.", "prompt");
    const { signal: _s, hub: _h, deadline, ...rest } = o;
    const payload = { ...rest };
    if (deadline !== undefined)
        payload.deadline = deadline instanceof Date ? deadline.toISOString() : deadline;
    return JSON.stringify(payload);
}
async function post(path, o, conn) {
    const r = resolve(o.hub, conn); // a hívásonkénti kapcsolat (mezőnként) felülbírálja a kliensét
    const deadline = o.deadline === undefined ? undefined : new Date(o.deadline);
    const cap = r.capMs ?? requestCapMs(o.timeout_s ?? DEFAULT_TIMEOUT_S, deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined);
    return openPost(`${r.baseUrl}${path}`, r.apiKey, bodyOf(o), cap, o.signal);
}
async function failure(res) {
    let body;
    try {
        body = JSON.parse(await readText(res));
    }
    catch (e) {
        if (e instanceof ConnectionLostError)
            return e;
        /* nem JSON */
    }
    return errorFromResponse(res.status, body);
}
/** Egy kérés a hubnak; a claude JSON-ját adja vissza a hub mezőivel. Hibánál típusos kivételt dob. */
export async function ask(options, conn) {
    const res = await post("/ask", options, conn);
    if (res.status < 200 || res.status >= 300)
        throw await failure(res);
    const text = await readText(res);
    try {
        return JSON.parse(text);
    }
    catch {
        throw new HubClientError("bad_response", res.status, `A hub válasza nem JSON: ${text.slice(0, 200)}`);
    }
}
/**
 * Stream mód: a claude `stream-json` eseményei érkeznek `message` eseményként, a végén `done` az összesítővel.
 * Hiba esetén típusos kivételt dob (a stream közbeni hibát is).
 */
export async function* askStream(options, conn) {
    const res = await post("/ask/stream", options, conn);
    if (res.status < 200 || res.status >= 300)
        throw await failure(res);
    let finished = false;
    try {
        for await (const frame of parseSse(res.chunks)) {
            const data = JSON.parse(frame.data);
            if (frame.event === "message")
                yield { type: "message", data: data };
            else if (frame.event === "done") {
                finished = true;
                yield { type: "done", data: data };
            }
            else if (frame.event === "error")
                throw errorFromResponse(res.status, data);
        }
    }
    finally {
        res.close();
    }
    if (!finished)
        throw new ConnectionLostError("A hub lezárta a kapcsolatot a válasz vége előtt.");
}
/** Egy rögzített kapcsolattal dolgozó kliens. */
export function createHubClient(conn = {}) {
    return {
        ask: (options) => ask(options, conn),
        askStream: (options) => askStream(options, conn),
    };
}
/**
 * A választ a portfolio `parseClaudeCodeOutput`-ja által várt alakban adja: pontosan az, amit a
 * `claude -p --output-format json` stdout-ja tartalmazna (a hub kiegészítő mezői nélkül).
 * `parseClaudeCodeOutput(JSON.stringify(asClaudeCodeResult(res)))` ugyanazt adja, mint a közvetlen CLI-hívás.
 */
export function asClaudeCodeResult(res) {
    const { call_id: _c, queued_ms: _q, run_ms: _r, stderr: _s, ...cli } = res;
    return cli;
}
/** A sima szöveges válasz (a used-car-checker `stdout`-ja helyett). Üres szöveg, ha nincs `result`. */
export function resultText(res) {
    return typeof res.result === "string" ? res.result : "";
}
