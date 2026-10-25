import { readLinesBackwardSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import type { JsonValue } from "./source-scan";
import type { BackwardRead, NativeHistoryEntry, NativeSourceIssue, ReadBackwardOptions } from "./types";

/** How far back a `readBackward` reads by default: the newest 16 MB of a session. */
export const READ_BACKWARD_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The shared half of every provider's `readBackward`: one JSONL file read from its end, each row turned into entries
 * by the provider's own `rowEntries`, until an entry `until` accepts. The provider owns the format; this owns the walk.
 * A row that does not parse (a line still being written) is skipped and reported.
 */
export function readJsonlBackward(
    options: ReadBackwardOptions & {
        path: string;
        rowEntries: (row: JsonValue, line: number) => NativeHistoryEntry[];
    }
): BackwardRead {
    const limit = options.maxBytes ?? READ_BACKWARD_MAX_BYTES;
    const rows: NativeHistoryEntry[][] = [];
    const issues: NativeSourceIssue[] = [];
    let bytes = 0;
    let line = 0;

    for (const text of readLinesBackwardSync(options.path)) {
        line--;
        bytes += Buffer.byteLength(text) + 1;

        if (options.signal?.aborted || bytes > limit) {
            break;
        }

        if (!text.trim()) {
            continue;
        }

        let row: JsonValue;

        try {
            row = SafeJSON.parse(text, { strict: true }) as JsonValue;
        } catch {
            issues.push({ path: options.path, message: `Unreadable row at line ${line} from the end` });
            continue;
        }

        const entries = options.rowEntries(row, line);
        // A loop, not `findLastIndex`: the dashboards compile src/utils with a `lib` older than ES2023.
        let stop = -1;

        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];

            if (entry && options.until(entry)) {
                stop = index;
                break;
            }
        }

        if (stop >= 0) {
            rows.push(entries.slice(stop));
            return { entries: rows.reverse().flat(), found: true, issues };
        }

        rows.push(entries);
    }

    return { entries: rows.reverse().flat(), found: false, issues };
}
