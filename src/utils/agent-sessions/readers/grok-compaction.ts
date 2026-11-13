/**
 * Grok's `compactedSince`. Grok keeps only a compaction COUNT in `signals.json` beside the chat history, and it rewrites
 * that file every turn, so neither the count nor the file time places a compaction after a moment. A count of 0 does
 * prove that none happened; any other answer, an unreadable file included, is "maybe", which the shell guard reads as
 * "explain the rule in full again".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export function grokCompactedSince(transcriptPath: string): boolean {
    let signals: unknown;

    try {
        signals = SafeJSON.parse(readFileSync(join(dirname(transcriptPath), "signals.json"), "utf8"), { strict: true });
    } catch {
        // No file or a half-written one: the guard cannot tell, so it gives the long form.
        return true;
    }

    const count =
        typeof signals === "object" && signals !== null && "compactionCount" in signals
            ? signals.compactionCount
            : undefined;
    return count !== 0;
}
