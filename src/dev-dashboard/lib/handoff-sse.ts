import { todayHandoffLogFile } from "@app/handoff/log-store";
import type { HandoffEvent } from "@app/handoff/types";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";

export interface HandoffStream {
    close(): void;
}

const ROLLOVER_CHECK_MS = 30_000;

/**
 * Tail the handoff event log for SSE. Handoffs are multi-day, so the tailer
 * MUST survive midnight (§7.2): a periodic check re-tails the new date's file
 * when the day rolls over — a tailer pinned to one date file dies silently at
 * 00:00 (qa-sse.ts has exactly that bug; do not copy it).
 */
export function createHandoffStream(onEvent: (e: HandoffEvent) => void): HandoffStream {
    let file = todayHandoffLogFile();
    let tailer = new FileTailer<HandoffEvent>(file, { onLine: (e) => onEvent(e) });
    tailer.start();

    const rollover = setInterval(() => {
        const current = todayHandoffLogFile();

        if (current !== file) {
            tailer.stop();
            file = current;
            tailer = new FileTailer<HandoffEvent>(file, { onLine: (e) => onEvent(e) });
            tailer.start();
        }
    }, ROLLOVER_CHECK_MS);

    return {
        close: () => {
            clearInterval(rollover);
            tailer.stop();
        },
    };
}
