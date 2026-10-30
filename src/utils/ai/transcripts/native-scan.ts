import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isZstdPath, readZstdFramesSync, zstdContentBytes } from "@genesiscz/utils/compress/zstd";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseTranscriptLine } from "./parse-line";
import type { TranscriptProvider } from "./types";

// The provider's own session file, for what `tools ai sessions tail` turns leave out: per-call
// usage with cache writes and the model (Claude turns carry no usage at all), exact tool timing
// (the tool_result line's timestamp), and each call's full input for the stuck detector's
// "same call again" test. Mirrors the hub's Swift `SessionNativeLog` scan, which reads the same
// fields for the rows it draws.

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `claude-opus-5-5` → `opus`: the family word the session list and the transcript use. */
export function shortModel(model: string): string {
    for (const family of ["fable", "opus", "sonnet", "haiku"]) {
        if (model.includes(family)) {
            return family;
        }
    }

    return model.startsWith("claude-") ? model.slice(7) : model;
}

/** Calls `visit` for each line of `text`, without splitting the whole file into an array first. */
export function eachLine(text: string, visit: (line: string) => void): void {
    let start = 0;

    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;

        if (end > start) {
            visit(text.slice(start, end));
        }

        start = end + 1;
    }
}

/**
 * Tool call id → its full input as one string, for the calls in `text` (a session file or its
 * tail). The transcript's `inputPreview` is only the key argument (an Edit's path), so five
 * different edits of one file would read as one call repeated five times.
 */
export function toolInputKeys(text: string, provider: TranscriptProvider): Map<string, string> {
    const keys = new Map<string, string>();

    eachLine(text, (line) => {
        if (provider === "claude") {
            if (!line.includes('"tool_use"')) {
                return;
            }

            const record = parseTranscriptLine(line);
            const message = record && isRecord(record.message) ? record.message : null;
            const content = message && Array.isArray(message.content) ? message.content.filter(isRecord) : [];

            for (const block of content) {
                if (block.type === "tool_use" && typeof block.id === "string") {
                    keys.set(block.id, SafeJSON.stringify(block.input ?? null, { strict: true }) ?? "");
                }
            }

            return;
        }

        if (provider === "codex") {
            if (!line.includes('"call_id"')) {
                return;
            }

            const record = parseTranscriptLine(line);
            const payload = record && isRecord(record.payload) ? record.payload : null;

            if (
                payload &&
                (payload.type === "function_call" || payload.type === "custom_tool_call") &&
                typeof payload.call_id === "string"
            ) {
                const input = payload.arguments ?? payload.input ?? null;
                keys.set(
                    payload.call_id,
                    typeof input === "string" ? input : (SafeJSON.stringify(input, { strict: true }) ?? "")
                );
            }
        }
    });

    return keys;
}

/** The model a Codex rollout ran with: the last `turn_context` line's `model`. */
export function codexModelOf(text: string): string | null {
    let model: string | null = null;

    eachLine(text, (line) => {
        if (!line.includes('"turn_context"')) {
            return;
        }

        const record = parseTranscriptLine(line);
        const payload = record && isRecord(record.payload) ? record.payload : null;

        if (payload && typeof payload.model === "string" && payload.model) {
            model = payload.model;
        }
    });

    return model;
}

/** The last `bytes` of a file as text, starting at a line boundary. Throws when the file cannot be read. */
export function readTail(path: string, bytes: number): string {
    return readTailAt(path, bytes).text;
}

/** The last bytes of a file's content, cut anywhere: `start` is where `buffer` begins, `size` the content's length. */
export interface TailWindow {
    buffer: Buffer;
    start: number;
    size: number;
}

/**
 * The last `bytes` of a `.zst` file's decompressed content, frames read from the end until they cover the window.
 * A Codex rollout is one frame, so it decompresses whole; a seekable file costs its last frames. Offsets count
 * decompressed bytes: the file never grows, so they are stable.
 */
function zstdTailWindow(path: string, bytes: number): TailWindow {
    const known = zstdContentBytes(path);
    const frames: Buffer[] = [];
    let kept = 0;
    let seen = 0;

    for (const frame of readZstdFramesSync(path, { fromEnd: true })) {
        seen += frame.length;

        if (kept < bytes) {
            frames.push(Buffer.from(frame.buffer, frame.byteOffset, frame.length));
            kept += frame.length;
        }

        if (kept >= bytes && known !== undefined) {
            break;
        }
    }

    // When the frame headers do not give the content size, every frame was decompressed to count it.
    const size = known ?? seen;
    const content = Buffer.concat(frames.reverse());
    const buffer = content.subarray(Math.max(0, content.length - bytes));
    return { buffer, start: size - buffer.length, size };
}

/**
 * The last `bytes` of a file, or of a `.zst` file's decompressed content (Codex 0.164 compresses its old rollouts),
 * with no line handling. Throws when the file cannot be read.
 */
export function readTailWindow(path: string, bytes: number): TailWindow {
    if (isZstdPath(path)) {
        return zstdTailWindow(path, bytes);
    }

    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buffer = Buffer.alloc(size - start);
        let read = 0;

        while (read < buffer.length) {
            const got = readSync(fd, buffer, read, buffer.length - read, start + read);

            if (got === 0) {
                break;
            }

            read += got;
        }

        return { buffer: buffer.subarray(0, read), start, size };
    } finally {
        closeSync(fd);
    }
}

/**
 * The first `bytes` of a file, or of a `.zst` file's decompressed content, cut anywhere: for a field near the start of
 * a first line too long to read whole (a Codex `session_meta` carries ~20 KB of instructions). Throws when the file
 * cannot be read.
 */
export function readHead(path: string, bytes: number): Buffer {
    if (isZstdPath(path)) {
        const frames: Buffer[] = [];
        let kept = 0;

        for (const frame of readZstdFramesSync(path)) {
            frames.push(Buffer.from(frame.buffer, frame.byteOffset, frame.length));
            kept += frame.length;

            if (kept >= bytes) {
                break;
            }
        }

        return Buffer.concat(frames).subarray(0, bytes);
    }

    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(bytes);
        const read = readSync(fd, buffer, 0, bytes, 0);
        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

/**
 * `readTail`, plus the byte offset where the returned text begins (a whole line's start). For a `.zst` the offsets
 * count decompressed bytes. `raw` is the tail's bytes, for callers that count byte offsets: re-encoding `text`
 * changes the length of a line that holds invalid UTF-8.
 */
export function readTailAt(path: string, bytes: number): { text: string; start: number; raw: Buffer } {
    const { buffer, start, size } = readTailWindow(path, bytes);

    if (start === 0) {
        return { text: buffer.toString("utf8"), start: 0, raw: buffer };
    }

    // The window almost certainly starts mid-line: drop that fragment, counted in bytes.
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) {
        return { text: "", start: size, raw: Buffer.alloc(0) };
    }

    const raw = buffer.subarray(firstNewline + 1);
    return { text: raw.toString("utf8"), start: start + firstNewline + 1, raw };
}
