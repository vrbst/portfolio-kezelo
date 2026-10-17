// Típusos hibák: a hub hibakódjaihoz egy-egy osztály tartozik.
export class HubClientError extends Error {
    /** A hub hibakódja (bad_request, quota_exhausted, …), vagy "unreachable". */
    code;
    /** HTTP státusz; 0, ha a hub nem érhető el. */
    status;
    /** A hub által a hibához rendelt hívás sorszáma (a History-ban kereshető). */
    callId;
    /** A hub teljes hibatörzse. */
    body;
    constructor(code, status, message, extra = {}) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.status = status;
        if (extra.callId !== undefined)
            this.callId = extra.callId;
        if (extra.body !== undefined)
            this.body = extra.body;
    }
}
export class BadRequestError extends HubClientError {
    field;
    constructor(message, field, extra) {
        super("bad_request", 400, message, extra);
        if (field !== undefined)
            this.field = field;
    }
}
export class UnauthorizedError extends HubClientError {
    constructor(message, extra) {
        super("unauthorized", 401, message, extra);
    }
}
/** Profilon kívüli kérés: a `field` megnevezi a mezőt. */
export class ForbiddenError extends HubClientError {
    field;
    constructor(message, field, extra) {
        super("forbidden", 403, message, extra);
        if (field !== undefined)
            this.field = field;
    }
}
/** Kvótahiba vagy visszatartás: a reset előtt nem érdemes újrapróbálni. */
export class QuotaExhaustedError extends HubClientError {
    /** A visszatartás vége (a hub számítása; lehet becsült). */
    resetAt;
    constructor(message, resetAt, extra) {
        super("quota_exhausted", 429, message, extra);
        const t = resetAt ? new Date(resetAt) : null;
        this.resetAt = t && !Number.isNaN(t.getTime()) ? t : null;
    }
}
/** Rövid távú korlát: a hub már újrapróbált egyszer, ha belefért a határidőbe. */
export class RateLimitedError extends HubClientError {
    retryAfterS;
    constructor(message, retryAfterS, extra) {
        super("rate_limited", 429, message, extra);
        this.retryAfterS = typeof retryAfterS === "number" ? retryAfterS : null;
    }
}
export class DeadlineMissedError extends HubClientError {
    constructor(message, extra) {
        super("deadline_missed", 409, message, extra);
    }
}
export class TimeoutError extends HubClientError {
    /** A lejárt futás hossza ms-ben. */
    runMs;
    constructor(message, runMs, extra) {
        super("timeout", 504, message, extra);
        this.runMs = typeof runMs === "number" ? runMs : null;
    }
}
/** A claude CLI hibája (nem kvóta, nem rate limit, nem timeout). */
export class CliError extends HubClientError {
    exitCode;
    stderrTail;
    /** A CLI JSON-kimenete, ha volt. */
    cliJson;
    constructor(message, exitCode, stderrTail, cliJson, extra) {
        super("cli_error", 502, message, extra);
        this.exitCode = typeof exitCode === "number" ? exitCode : null;
        this.stderrTail = stderrTail ?? "";
        this.cliJson = cliJson && typeof cliJson === "object" ? cliJson : null;
    }
}
/** A hub leáll (503). Később újra lehet próbálni. */
export class UnavailableError extends HubClientError {
    constructor(message, extra) {
        super("unavailable", 503, message, extra);
    }
}
/** A hub nem érhető el (nem fut, rossz cím): a kapcsolat létre sem jött. Biztonságos újrapróbálni. */
export class HubUnreachableError extends HubClientError {
    constructor(message) {
        super("unreachable", 0, message);
    }
}
/**
 * A kapcsolat létrejött, de megszakadt (a hub újraindult, a válasz közben lezárult, vagy lejárt a biztonsági
 * felső korlát). A hívás lefuthatott: újrapróbálás előtt nézd meg a hub History-ját.
 */
export class ConnectionLostError extends HubClientError {
    constructor(message) {
        super("connection_lost", 0, message);
    }
}
/** A hub hibatörzséből (és státuszából) a megfelelő hibaosztály. */
export function errorFromResponse(status, body) {
    const e = (body && typeof body === "object" ? body.error : undefined) ?? {};
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : `A hub HTTP ${status} választ adott.`;
    const extra = { body, ...(typeof e.call_id === "number" ? { callId: e.call_id } : {}) };
    switch (code) {
        case "bad_request":
            return new BadRequestError(message, typeof e.field === "string" ? e.field : undefined, extra);
        case "unauthorized":
            return new UnauthorizedError(message, extra);
        case "forbidden":
            return new ForbiddenError(message, typeof e.field === "string" ? e.field : undefined, extra);
        case "quota_exhausted":
            return new QuotaExhaustedError(message, e.reset_at, extra);
        case "rate_limited":
            return new RateLimitedError(message, e.retry_after_s, extra);
        case "deadline_missed":
            return new DeadlineMissedError(message, extra);
        case "timeout":
            return new TimeoutError(message, e.run_ms, extra);
        case "cli_error":
            return new CliError(message, e.exit_code, e.stderr_tail, e.cli_json, extra);
        case "unavailable":
            return new UnavailableError(message, extra);
        default:
            return new HubClientError(code || "error", status, message, extra);
    }
}
