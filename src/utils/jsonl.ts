import { SafeJSON } from "@app/utils/json";

export interface JsonlParseResult<T = unknown> {
    values: T[];
    read: number;
    done: boolean;
    remainder: Buffer<ArrayBuffer>;
}

const hasBunJsonl = typeof Bun !== "undefined" && typeof Bun.JSONL?.parseChunk === "function";

if (!hasBunJsonl) {
    console.error(
        "[jsonl] Bun.JSONL not available — using slower JS fallback.\n" +
            "        Run `bun upgrade` to get native C++ JSONL parsing (requires Bun ≥1.3.6).\n"
    );
}

/**
 * Parse a chunk of JSONL data, handling partial lines.
 * Uses native Bun.JSONL.parseChunk() when available (C++, ~10x faster),
 * falls back to manual line splitting + JSON.parse otherwise.
 */
export function parseJsonlChunk<T = unknown>(data: Buffer, existingRemainder?: Buffer): JsonlParseResult<T> {
    const combined = existingRemainder?.length ? Buffer.concat([existingRemainder, data]) : data;

    if (hasBunJsonl && Bun.JSONL) {
        const result = Bun.JSONL.parseChunk(combined);
        return {
            values: result.values as T[],
            read: result.read,
            done: result.done,
            remainder: Buffer.from(combined.subarray(result.read)),
        };
    }

    return parseJsonlChunkFallback<T>(combined);
}

/**
 * Parse an entire JSONL buffer (no streaming/remainder).
 */
export function parseJsonl<T = unknown>(data: Buffer | string): T[] {
    if (hasBunJsonl && Bun.JSONL) {
        const buf = typeof data === "string" ? Buffer.from(data) : data;
        return Bun.JSONL.parse(buf) as T[];
    }

    return parseJsonlFallback<T>(data);
}

// ---------------------------------------------------------------------------
// Fallback implementations (no Bun.JSONL)
// ---------------------------------------------------------------------------

function parseJsonlChunkFallback<T>(combined: Buffer): JsonlParseResult<T> {
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
            // skip malformed lines
        }
    }

    const read = lastNewline === -1 ? 0 : lastNewline;

    return {
        values,
        read,
        done: read >= combined.length,
        remainder: Buffer.from(combined.subarray(read)),
    };
}

function parseJsonlFallback<T>(data: Buffer | string): T[] {
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
            // skip malformed lines
        }
    }

    return values;
}
