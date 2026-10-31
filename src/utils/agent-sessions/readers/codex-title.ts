/** Codex's session titles: the `session_index.jsonl` of a home. The Codex driver's `locate` part reads them. */
import { readFileSync } from "node:fs";
import { isRecord } from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Adds the titles of one `session_index.jsonl` to `found`. Codex appends a line per rename, in write order, so the
 * last line of an id is its current title.
 */
export function readCodexTitleIndex(indexPath: string, found: Map<string, TitledSession>): void {
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
        try {
            const record: unknown = line.trim() ? SafeJSON.parse(line, { strict: true }) : null;

            if (isRecord(record) && typeof record.id === "string" && typeof record.thread_name === "string") {
                found.delete(record.id);
                found.set(record.id, {
                    sessionId: record.id,
                    title: record.thread_name,
                    mtime: Date.parse(String(record.updated_at)) || 0,
                    locator: record.id,
                });
            }
        } catch (err) {
            logger.debug({ err, indexPath }, "[session-title] skipped an unreadable Codex index line");
        }
    }
}
