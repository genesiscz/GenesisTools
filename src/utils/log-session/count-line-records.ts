import { existsSync } from "node:fs";

/**
 * Fast count of `{"type":"line",…}` records in a JSONL session file without
 * parsing JSON.
 *
 * Sized to be cheap enough to call on every dashboard list refresh (every
 * ~5s polled). The dashboard sidebar previously triggered a full
 * `readJsonlFile` + JSON.parse-per-record per session per refresh, which on
 * long-running sessions (hundreds of MB jsonl) caused multi-second blocks.
 *
 * The scan looks for the literal substring `"type":"line"` which is the
 * shape the JsonlWriter emits — it appears exactly once per line record
 * (the meta and exit records use `"type":"meta"` / `"type":"exit"`).
 */
export async function countJsonlLineRecords(path: string): Promise<number> {
    if (!existsSync(path)) {
        return 0;
    }

    try {
        const text = await Bun.file(path).text();
        return countOccurrences(text, '"type":"line"');
    } catch {
        return 0;
    }
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) {
        return 0;
    }

    let count = 0;
    let idx = 0;

    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count += 1;
        idx += needle.length;
    }

    return count;
}
