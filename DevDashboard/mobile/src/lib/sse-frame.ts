/**
 * Pure SSE frame parser — zero React Native / expo dependencies so it is unit-testable
 * under `bun test` without dragging the RN runtime. Given a single frame (the text
 * between two `\n\n` boundaries), return the concatenated `data:` payload, or `null` for
 * frames that carry no data (keep-alive comment frames like `:ping`, or event/id-only
 * frames).
 */
export function parseSseFrame(frame: string): string | null {
    const dataParts: string[] = [];

    for (const rawLine of frame.split("\n")) {
        // A CRLF-terminated source leaves a trailing `\r` that would survive into the payload.
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith("data:")) {
            // Per the SSE spec a single leading space after the colon is stripped.
            dataParts.push(line.slice(5).replace(/^ /, ""));
        }
    }

    if (dataParts.length === 0) {
        return null;
    }

    return dataParts.join("\n");
}
