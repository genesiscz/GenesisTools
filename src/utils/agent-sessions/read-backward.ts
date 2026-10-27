import { readLinesBackwardSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { JsonValue } from "./source-scan";
import type { BackwardRead, NativeHistoryEntry, NativeSourceIssue, ReadBackwardOptions, TurnBoundary } from "./types";
import { isWrapperUserText } from "./user-text";

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
        rowEntries: (row: JsonValue, line: number, position: number) => NativeHistoryEntry[];
    }
): BackwardRead {
    const limit = options.maxBytes ?? READ_BACKWARD_MAX_BYTES;
    const rows: NativeHistoryEntry[][] = [];
    const issues: NativeSourceIssue[] = [];
    let line = 0;
    let position = 0;
    let endOffset: number | undefined;
    let lastAssistantOffset: number | undefined;
    const issue = (message: string) => {
        issues.push({ path: options.path, message });
        logger.warn({ path: options.path, maxBytes: limit, position, line }, message);
    };
    const walk = readLinesBackwardSync(options.path, {
        maxBytes: limit,
        signal: options.signal,
        ...(options.fromOffset !== undefined ? { fromOffset: options.fromOffset } : {}),
        onSource: (end) => {
            endOffset = end;
        },
        onLine: (offset) => {
            position = offset;
        },
    });

    try {
        for (;;) {
            const next = walk.next();

            if (next.done) {
                if (next.value.reason !== "eof" && next.value.reason !== "offset") {
                    position = next.value.position;
                    issue(`Backward read stopped: ${next.value.reason}; read ${next.value.bytesRead} bytes`);
                }

                break;
            }

            const text = next.value;
            line--;

            if (!text.trim()) {
                continue;
            }

            let row: JsonValue;

            try {
                row = SafeJSON.parse(text, { strict: true }) as JsonValue;
            } catch {
                // The newest row cut short is one still being written: a later read starts at it, not after it.
                if (line === -1 && !text.endsWith("}")) {
                    endOffset = position;
                }

                issue(`Unreadable row at line ${line} from the end; skipped`);
                continue;
            }

            const entries = options.rowEntries(row, line, position);

            if (lastAssistantOffset === undefined && entries.some((entry) => entry.role === "assistant")) {
                lastAssistantOffset = position;
            }
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
                rows.push(options.includeBoundaryMessage ? entries : entries.slice(stop));
                return {
                    entries: rows.reverse().flat(),
                    found: true,
                    issues,
                    ...ended(endOffset, lastAssistantOffset),
                };
            }

            rows.push(entries);
        }
    } finally {
        walk.return({ reason: "eof", position, bytesRead: 0 });
    }

    return { entries: rows.reverse().flat(), found: false, issues, ...ended(endOffset, lastAssistantOffset) };
}

function ended(
    endOffset: number | undefined,
    lastAssistantOffset: number | undefined
): { endOffset?: number; lastAssistantOffset?: number } {
    return {
        ...(endOffset === undefined ? {} : { endOffset }),
        ...(lastAssistantOffset === undefined ? {} : { lastAssistantOffset }),
    };
}

/** A stable prompt boundary even for a timestamp-free transcript: the prompt's absolute byte offset. */
export function readJsonlTurnBoundary(
    options: Omit<ReadBackwardOptions, "until"> & {
        path: string;
        rowEntries: (row: JsonValue, line: number) => NativeHistoryEntry[];
    }
): TurnBoundary | null {
    let boundary: TurnBoundary | null = null;
    readJsonlBackward({
        ...options,
        rowEntries: (row, line, position) => {
            const entries = options.rowEntries(row, line);
            const prompt = entries.find(
                (entry) => entry.role === "user" && entry.text.trim() && !isWrapperUserText(entry.text)
            );

            if (prompt) {
                const at = prompt.timestamp ? Date.parse(prompt.timestamp) : Number.NaN;
                boundary = {
                    key: Number.isFinite(at) ? at : -(position + 1),
                    ...(Number.isFinite(at) ? { timestamp: prompt.timestamp } : {}),
                };
            }

            return prompt ? [prompt] : [];
        },
        until: () => true,
    });
    return boundary;
}
