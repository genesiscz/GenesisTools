import { SafeJSON } from "@genesiscz/utils/json";
import { MAX_REPLY_BYTES, MAX_REQUEST_BYTES } from "./messages";

/**
 * Chromium native messaging framing: a 32-bit length in native byte order (little-endian on every
 * Mac and PC this runs on), then that many bytes of UTF-8 JSON.
 */
export function encodeFrame(message: unknown): Uint8Array {
    let body = new TextEncoder().encode(SafeJSON.stringify(message, { strict: true }));

    if (body.byteLength > MAX_REPLY_BYTES) {
        const refusal = { ok: false, code: "too-large", error: `reply is ${body.byteLength} bytes; the cap is 1 MiB` };
        body = new TextEncoder().encode(SafeJSON.stringify(refusal, { strict: true }));
    }

    const frame = new Uint8Array(4 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, body.byteLength, true);
    frame.set(body, 4);
    return frame;
}

export class FrameError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FrameError";
    }
}

/**
 * Collects stdin chunks and yields each complete message; a chunk may hold several or part of one.
 * The unread bytes are `buffer[start, end)`. The buffer at least doubles when it grows and is
 * compacted only when a chunk does not fit after `end`, so a 4 MiB request sent in small chunks
 * copies each byte a bounded number of times instead of once per chunk.
 */
export class FrameReader {
    private buffer = new Uint8Array(0);
    private start = 0;
    private end = 0;

    push(chunk: Uint8Array): unknown[] {
        this.append(chunk);
        const messages: unknown[] = [];

        while (this.end - this.start >= 4) {
            const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.start, 4).getUint32(0, true);

            if (length > MAX_REQUEST_BYTES) {
                throw new FrameError(`request of ${length} bytes is over the ${MAX_REQUEST_BYTES} byte cap`);
            }

            if (this.end - this.start < 4 + length) {
                break;
            }

            const body = new TextDecoder().decode(this.buffer.subarray(this.start + 4, this.start + 4 + length));
            messages.push(SafeJSON.parse(body, { strict: true }));
            this.start += 4 + length;
        }

        if (this.start === this.end) {
            this.start = 0;
            this.end = 0;
        }

        return messages;
    }

    private append(chunk: Uint8Array): void {
        if (this.end + chunk.byteLength > this.buffer.byteLength) {
            const unread = this.end - this.start;
            const needed = unread + chunk.byteLength;

            if (needed > this.buffer.byteLength) {
                const grown = new Uint8Array(Math.max(needed, this.buffer.byteLength * 2, 64 * 1024));
                grown.set(this.buffer.subarray(this.start, this.end), 0);
                this.buffer = grown;
            } else {
                this.buffer.copyWithin(0, this.start, this.end);
            }

            this.start = 0;
            this.end = unread;
        }

        this.buffer.set(chunk, this.end);
        this.end += chunk.byteLength;
    }
}
