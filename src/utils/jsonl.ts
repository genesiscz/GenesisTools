import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

export interface JsonlParseResult<T = unknown> {
    values: T[];
    read: number;
    done: boolean;
    remainder: Buffer<ArrayBuffer>;
}

const hasBunJsonl = typeof Bun !== "undefined" && typeof Bun.JSONL?.parseChunk === "function";
let warnedFallback = false;

function warnFallback(): void {
    if (warnedFallback) {
        return;
    }

    warnedFallback = true;
    out.error(
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
        const jsonl = Bun.JSONL;
        const values: T[] = [];
        let read = 0;

        // The native parser stops at a malformed line. A line with its newline is complete, so it is skipped, as the
        // fallback does; without that, a torn row kept every later append in the remainder and a tailer saw none.
        // Only an unterminated last line stays in the remainder, to be completed by the next append.
        for (;;) {
            const result = jsonl.parseChunk(combined.subarray(read));
            values.push(...(result.values as T[]));
            read += result.read;
            const newline = combined.indexOf(0x0a, read);

            if (result.done || read >= combined.length || newline === -1) {
                break;
            }

            read = newline + 1;
        }

        return {
            values,
            read,
            done: read >= combined.length,
            remainder: Buffer.from(combined.subarray(read)),
        };
    }

    warnFallback();
    return parseJsonlChunkFallback<T>(combined);
}

/**
 * Every well-formed row of an append-only JSONL log. A missing file has no rows. A torn or
 * corrupt line (a writer killed mid-append, a hand edit) is skipped and counted, so one bad
 * line cannot hide every other row. A missing file also carries `missing: true`; any other read error throws.
 */
export function readJsonlRows<T>(path: string): { rows: T[]; skipped: number; missing?: true } {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { rows: [], skipped: 0, missing: true };
        }

        throw error;
    }

    const rows: T[] = [];
    let skipped = 0;

    for (const line of text.split("\n")) {
        if (line.trim().length === 0) {
            continue;
        }

        try {
            rows.push(SafeJSON.parse(line, { strict: true }) as T);
        } catch {
            // Counted and reported by the caller, which knows what the log is.
            skipped += 1;
        }
    }

    return { rows, skipped };
}

/**
 * Parse an entire JSONL buffer (no streaming/remainder).
 */
export function parseJsonl<T = unknown>(data: Buffer | string): T[] {
    if (hasBunJsonl && Bun.JSONL) {
        const buf = typeof data === "string" ? Buffer.from(data) : data;
        return Bun.JSONL.parse(buf) as T[];
    }

    warnFallback();
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
