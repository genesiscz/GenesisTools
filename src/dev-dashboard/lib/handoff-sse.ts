import { existsSync, readFileSync } from "node:fs";
import { todayHandoffLogFile } from "@app/handoff/log-store";
import type { HandoffEvent } from "@app/handoff/types";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { parseJsonlChunk } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "dev-dashboard:handoff-sse" });

export interface HandoffStream {
    close(): void;
}

const ROLLOVER_CHECK_MS = 5_000;

/**
 * Tail the handoff event log for SSE. Handoffs are multi-day, so the tailer
 * MUST survive midnight (§7.2): a periodic check re-tails the new date's file
 * when the day rolls over — a tailer pinned to one date file dies silently at
 * 00:00 (qa-sse.ts has exactly that bug at routes/qa.ts:132; do not copy it).
 *
 * FileTailer attaches at EOF and never replays, so an event written to the new
 * day-file in the window before the rollover check would be missed. On switch
 * we therefore replay the new file from byte 0 (§8.10). Frames are idempotent
 * on the client (each just triggers a refetch), so any duplicate with the fresh
 * tailer's first reads is harmless — replay eliminates the miss at zero cost.
 */
export function createHandoffStream(onEvent: (e: HandoffEvent) => void): HandoffStream {
    let file = todayHandoffLogFile();
    let tailer = new FileTailer<HandoffEvent>(file, { onLine: (e) => onEvent(e) });
    tailer.start();

    const replayFromStart = (path: string): void => {
        if (!existsSync(path)) {
            return;
        }

        try {
            const { values } = parseJsonlChunk<HandoffEvent>(readFileSync(path));

            for (const event of values) {
                onEvent(event);
            }
        } catch (err) {
            log.warn({ err, path }, "handoff rollover replay failed (new day file unparseable)");
        }
    };

    const rollover = setInterval(() => {
        const current = todayHandoffLogFile();

        if (current !== file) {
            tailer.stop();
            file = current;
            tailer = new FileTailer<HandoffEvent>(file, { onLine: (e) => onEvent(e) });
            tailer.start();
            // Emit anything already written to the new day's file before the tailer attached.
            replayFromStart(file);
        }
    }, ROLLOVER_CHECK_MS);

    return {
        close: () => {
            clearInterval(rollover);
            tailer.stop();
        },
    };
}
