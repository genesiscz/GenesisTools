/**
 * Codex's `compactedSince`: a compaction is a `compacted` rollout item, or a `context_compacted` event of an older
 * rollout (the same two shapes `codex-analysis.ts` counts).
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { type CompactionDialect, type CompactionRow, compactedInTail } from "./session-compaction";

function parseCodexRow(row: string): CompactionRow | undefined {
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

    const type = "type" in value ? value.type : undefined;
    const payload = "payload" in value && typeof value.payload === "object" ? value.payload : null;
    const event = payload !== null && "type" in payload ? payload.type : undefined;
    return { at, compaction: type === "compacted" || (type === "event_msg" && event === "context_compacted") };
}

const CODEX_COMPACTION: CompactionDialect = { needle: "compacted", parse: parseCodexRow };

export function codexCompactedSince(transcriptPath: string, sinceMs: number): boolean {
    return compactedInTail(transcriptPath, sinceMs, CODEX_COMPACTION);
}
