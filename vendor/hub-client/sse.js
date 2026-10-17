// Minimális SSE-értelmező (event + data mezők).
export async function* parseSse(body) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const value of body) {
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
            const frame = frameOf(block);
            if (frame)
                yield frame;
        }
    }
    const last = frameOf(buf);
    if (last)
        yield last;
}
function frameOf(block) {
    let event = "message";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":"))
            continue;
        const c = line.indexOf(":");
        const field = c === -1 ? line : line.slice(0, c);
        const value = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "event")
            event = value;
        else if (field === "data")
            data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
}
