import { todayHandoffLogFile } from "@app/handoff/log-store";
import type { HandoffEvent } from "@app/handoff/types";
import { createRollingJsonlStream } from "./rolling-jsonl-stream";

export interface HandoffStream {
    close(): void;
}

/** Tail the handoff event log for SSE — midnight-safe via createRollingJsonlStream. */
export function createHandoffStream(onEvent: (e: HandoffEvent) => void): HandoffStream {
    return createRollingJsonlStream<HandoffEvent>({
        fileForNow: () => todayHandoffLogFile(),
        onLine: onEvent,
    });
}
