export declare const DEFAULT_URL = "http://127.0.0.1:7420";
export interface HubConnection {
    /** A hub címe. Alapból a MY_CLAUDE_HUB_URL környezeti változó, vagy http://127.0.0.1:7420. */
    baseUrl?: string;
    /** Az app kulcsa (`npm run hub -- keygen <app>`). Alapból a MY_CLAUDE_HUB_KEY környezeti változó. */
    apiKey?: string;
    /**
     * A kérés biztonsági felső korlátja ms-ben (tesztekhez). Alapból: a határidőig hátralévő idő + `timeout_s` + 2 perc,
     * határidő nélkül `timeout_s` + 15 perc. Lejáratkor `ConnectionLostError`.
     */
    capMs?: number;
}
/** A felső korlát számításához, ha a hívás nem ad `timeout_s`-t (a hubon a profilok legnagyobb engedett ideje). */
export declare const DEFAULT_TIMEOUT_S = 1800;
export type Priority = "interactive" | "normal" | "background";
/** A POST /ask mezői (a hub API nevei), plusz a kliens saját opciói. */
export interface AskOptions {
    prompt: string;
    model?: string;
    json_schema?: Record<string, unknown>;
    /** `[]` = semmilyen tool. Ha elmarad, a hub a profil listáját használja. */
    tools?: string[];
    allowed_tools?: string[];
    disallowed_tools?: string[];
    permission_mode?: string;
    chrome?: boolean;
    system_prompt?: string;
    append_system_prompt?: string;
    max_turns?: number;
    cwd?: string;
    env?: Record<string, string>;
    /** A futási időre vonatkozik (a sorban töltött időre nem). */
    timeout_s?: number;
    priority?: Priority;
    /** Ha addig nem indulhat el a hívás, DeadlineMissedError. */
    deadline?: string | Date;
    retry_on_timeout?: boolean;
    run_id?: string;
    /** A kérés megszakítása: a hub a várakozó kérést kiveszi a sorból, a futót hagyja lefutni. */
    signal?: AbortSignal;
    /** Egyedi kapcsolat ehhez a híváshoz. */
    hub?: HubConnection;
}
/** A claude CLI JSON-ja, kiegészítve a hub mezőivel. */
export interface AskResult {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    /** A válasz szövege (sima szöveg). */
    result?: string;
    /** A `json_schema` szerinti, már értelmezett válasz. */
    structured_output?: unknown;
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    session_id?: string;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, unknown>;
    /** A hub hívás-azonosítója (History). */
    call_id: number;
    queued_ms: number;
    run_ms: number;
    /** A claude stderr-je; sosem keveredik a `result`-ba. */
    stderr: string;
    [key: string]: unknown;
}
export type StreamEvent = {
    type: "message";
    data: Record<string, unknown>;
} | {
    type: "done";
    data: AskResult;
};
/** Egy kérés a hubnak; a claude JSON-ját adja vissza a hub mezőivel. Hibánál típusos kivételt dob. */
export declare function ask(options: AskOptions, conn?: HubConnection): Promise<AskResult>;
/**
 * Stream mód: a claude `stream-json` eseményei érkeznek `message` eseményként, a végén `done` az összesítővel.
 * Hiba esetén típusos kivételt dob (a stream közbeni hibát is).
 */
export declare function askStream(options: AskOptions, conn?: HubConnection): AsyncGenerator<StreamEvent>;
/** Egy rögzített kapcsolattal dolgozó kliens. */
export declare function createHubClient(conn?: HubConnection): {
    ask: (options: AskOptions) => Promise<AskResult>;
    askStream: (options: AskOptions) => AsyncGenerator<StreamEvent, any, any>;
};
/** A portfolio `claudeCodeEngine` által várt alak: a claude CLI JSON-objektuma (a hub mezői nélkül). */
export interface ClaudeCodeResult {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    session_id?: string;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, unknown>;
}
/**
 * A választ a portfolio `parseClaudeCodeOutput`-ja által várt alakban adja: pontosan az, amit a
 * `claude -p --output-format json` stdout-ja tartalmazna (a hub kiegészítő mezői nélkül).
 * `parseClaudeCodeOutput(JSON.stringify(asClaudeCodeResult(res)))` ugyanazt adja, mint a közvetlen CLI-hívás.
 */
export declare function asClaudeCodeResult(res: AskResult): ClaudeCodeResult;
/** A sima szöveges válasz (a used-car-checker `stdout`-ja helyett). Üres szöveg, ha nincs `result`. */
export declare function resultText(res: Pick<AskResult, "result">): string;
