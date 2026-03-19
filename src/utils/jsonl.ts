import { SafeJSON } from "@app/utils/json";

export interface JsonlParseResult<T = unknown> {
    values: T[];
    read: number;
    done: boolean;
    remainder: Buffer;
}

/**
 * Parse a chunk of JSONL data, handling partial lines.
 * Returns parsed values and any unconsumed remainder (partial last line).
 */
export function parseJsonlChunk<T = unknown>(data: Buffer, existingRemainder?: Buffer): JsonlParseResult<T> {
    const combined = existingRemainder?.length ? Buffer.concat([existingRemainder, data]) : data;
    const text = combined.toString("utf-8");

    const values: T[] = [];
    let lastNewline = -1;

    const lines = text.split("\n");
    let bytesConsumed = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf-8") + (i < lines.length - 1 ? 1 : 0);

        if (i === lines.length - 1 && !text.endsWith("\n")) {
            break;
        }

        bytesConsumed += lineBytes;
        lastNewline = bytesConsumed;

        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        try {
            values.push(SafeJSON.parse(trimmed, { strict: true }) as T);
        } catch {
            // Skip invalid JSON lines
        }
    }

    const read = lastNewline === -1 ? 0 : lastNewline;

    return {
        values,
        read,
        done: read >= combined.length,
        remainder: combined.subarray(read),
    };
}

/**
 * Parse an entire JSONL buffer (no streaming/remainder).
 */
export function parseJsonl<T = unknown>(data: Buffer | string): T[] {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    const values: T[] = [];

    for (const line of text.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        try {
            values.push(SafeJSON.parse(trimmed, { strict: true }) as T);
        } catch {
            // Skip invalid JSON lines
        }
    }

    return values;
}
