export interface Open {
    status: number;
    /** A választörzs darabjai. A közben megszakadt kapcsolat `ConnectionLostError`, a megszakítás `AbortError`. */
    chunks: AsyncGenerator<Uint8Array>;
    /** A kapcsolat lezárása (a darabok végigolvasása nélkül is). */
    close(): void;
}
/** A tárgy kérés felső korlátja: a határidőig hátralévő idő + futási idő + 2 perc; határidő nélkül futási idő + 15 perc. */
export declare function requestCapMs(timeoutS: number, deadline: Date | undefined, now?: number): number;
/** POST JSON a hubnak; a válaszfejléc megérkezésekor teljesül. */
export declare function openPost(url: string, apiKey: string, payload: string, capMs: number, signal?: AbortSignal): Promise<Open>;
/** A teljes választörzs szövegként. */
export declare function readText(o: Open): Promise<string>;
