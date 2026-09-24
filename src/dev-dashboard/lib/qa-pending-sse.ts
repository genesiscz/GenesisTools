import { todayPendingEventFile } from "@app/question/lib/pending/events";
import type { PendingEvent } from "@app/question/lib/pending/types";
import { createRollingJsonlStream, type RollingJsonlStream } from "@genesiscz/utils/fs/rolling-jsonl-stream";

export type PendingStream = RollingJsonlStream;

/**
 * Tail the pending-form lifecycle log for SSE, with midnight rollover.
 *
 * Same shape as the Q→A and handoff streams: a form created by a CLI process in another
 * terminal reaches the browser through the file, with no shared memory between them.
 * Pass `fileForNow` in tests to pin a path (rollover never fires when it is constant).
 */
export function createPendingStream(
    onEvent: (event: PendingEvent) => void,
    opts?: { fileForNow?: () => string }
): PendingStream {
    return createRollingJsonlStream<PendingEvent>({
        fileForNow: opts?.fileForNow ?? (() => todayPendingEventFile()),
        onLine: onEvent,
    });
}
