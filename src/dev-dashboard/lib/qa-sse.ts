import { logFilePathFor } from "@app/question/lib/log-store";
import type { QaEntry } from "@app/question/lib/types";
import { createRollingJsonlStream, type RollingJsonlStream } from "./rolling-jsonl-stream";

export function todayLogFile(): string {
    return logFilePathFor({ ts: Date.now() });
}

export type QaStream = RollingJsonlStream;

/**
 * Tail today's QA JSONL with midnight rollover. Pass `fileForNow` in tests to
 * pin a fixed path (rollover never fires when the path is constant).
 */
export function createQaStream(onEntry: (e: QaEntry) => void, opts?: { fileForNow?: () => string }): QaStream {
    return createRollingJsonlStream<QaEntry>({
        fileForNow: opts?.fileForNow ?? todayLogFile,
        onLine: onEntry,
    });
}
