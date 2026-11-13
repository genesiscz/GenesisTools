/** Claude's `compactedSince`: a compaction is a system row of subtype `compact_boundary`. */
import { SafeJSON } from "@genesiscz/utils/json";
import { type CompactionDialect, type CompactionRow, compactedInTail } from "./session-compaction";

function parseClaudeRow(row: string): CompactionRow | undefined {
    let value: unknown;

    try {
        value = SafeJSON.parse(row, { strict: true });
    } catch {
        // A row cut by the window or by a concurrent append.
        return undefined;
    }

    if (typeof value !== "object" || value === null || !("timestamp" in value)) {
        return undefined;
    }

    const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;

    if (Number.isNaN(at)) {
        return undefined;
    }

    const compaction =
        "type" in value && value.type === "system" && "subtype" in value && value.subtype === "compact_boundary";
    return { at, compaction };
}

const CLAUDE_COMPACTION: CompactionDialect = { needle: "compact_boundary", parse: parseClaudeRow };

export function claudeCompactedSince(transcriptPath: string, sinceMs: number): boolean {
    return compactedInTail(transcriptPath, sinceMs, CLAUDE_COMPACTION);
}
