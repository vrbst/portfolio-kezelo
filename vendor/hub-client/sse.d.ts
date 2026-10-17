export interface SseFrame {
    event: string;
    data: string;
}
export declare function parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame>;
