export interface ErrorExtra {
    callId?: number;
    body?: unknown;
}
export declare class HubClientError extends Error {
    /** A hub hibakódja (bad_request, quota_exhausted, …), vagy "unreachable". */
    readonly code: string;
    /** HTTP státusz; 0, ha a hub nem érhető el. */
    readonly status: number;
    /** A hub által a hibához rendelt hívás sorszáma (a History-ban kereshető). */
    readonly callId?: number;
    /** A hub teljes hibatörzse. */
    readonly body?: unknown;
    constructor(code: string, status: number, message: string, extra?: ErrorExtra);
}
export declare class BadRequestError extends HubClientError {
    readonly field?: string;
    constructor(message: string, field: string | undefined, extra?: ErrorExtra);
}
export declare class UnauthorizedError extends HubClientError {
    constructor(message: string, extra?: ErrorExtra);
}
/** Profilon kívüli kérés: a `field` megnevezi a mezőt. */
export declare class ForbiddenError extends HubClientError {
    readonly field?: string;
    constructor(message: string, field: string | undefined, extra?: ErrorExtra);
}
/** Kvótahiba vagy visszatartás: a reset előtt nem érdemes újrapróbálni. */
export declare class QuotaExhaustedError extends HubClientError {
    /** A visszatartás vége (a hub számítása; lehet becsült). */
    readonly resetAt: Date | null;
    constructor(message: string, resetAt: string | null | undefined, extra?: ErrorExtra);
}
/** Rövid távú korlát: a hub már újrapróbált egyszer, ha belefért a határidőbe. */
export declare class RateLimitedError extends HubClientError {
    readonly retryAfterS: number | null;
    constructor(message: string, retryAfterS: number | null | undefined, extra?: ErrorExtra);
}
export declare class DeadlineMissedError extends HubClientError {
    constructor(message: string, extra?: ErrorExtra);
}
export declare class TimeoutError extends HubClientError {
    /** A lejárt futás hossza ms-ben. */
    readonly runMs: number | null;
    constructor(message: string, runMs: number | null | undefined, extra?: ErrorExtra);
}
/** A claude CLI hibája (nem kvóta, nem rate limit, nem timeout). */
export declare class CliError extends HubClientError {
    readonly exitCode: number | null;
    readonly stderrTail: string;
    /** A CLI JSON-kimenete, ha volt. */
    readonly cliJson: Record<string, unknown> | null;
    constructor(message: string, exitCode: number | null | undefined, stderrTail: string | undefined, cliJson: unknown, extra?: ErrorExtra);
}
/** A hub leáll (503). Később újra lehet próbálni. */
export declare class UnavailableError extends HubClientError {
    constructor(message: string, extra?: ErrorExtra);
}
/** A hub nem érhető el (nem fut, rossz cím): a kapcsolat létre sem jött. Biztonságos újrapróbálni. */
export declare class HubUnreachableError extends HubClientError {
    constructor(message: string);
}
/**
 * A kapcsolat létrejött, de megszakadt (a hub újraindult, a válasz közben lezárult, vagy lejárt a biztonsági
 * felső korlát). A hívás lefuthatott: újrapróbálás előtt nézd meg a hub History-ját.
 */
export declare class ConnectionLostError extends HubClientError {
    constructor(message: string);
}
/** A hub hibatörzséből (és státuszából) a megfelelő hibaosztály. */
export declare function errorFromResponse(status: number, body: unknown): HubClientError;
