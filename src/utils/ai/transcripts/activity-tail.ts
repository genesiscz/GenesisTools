import { statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { type ActivityState, classifyActivity, claudeRecordsToEvents, DEFAULT_STALL_TIMEOUT_MS } from "./activity";
import { readTail } from "./native-scan";
import { parseTranscriptLine } from "./parse-line";

/** How much of the end of a transcript is read. Enough for the last conversation record and what follows it. */
export const ACTIVITY_TAIL_BYTES = 64 * 1024;

export interface ReadClaudeActivityOptions {
    /** The current time in epoch ms. Default: now. */
    now?: number;
    /** Silence longer than this is a stall. Default: `DEFAULT_STALL_TIMEOUT_MS`. */
    stallTimeoutMs?: number;
}

export interface ClaudeActivity {
    state: ActivityState;
    /** Epoch ms of the newest sign of life: the last event, or the file's modification time. */
    lastActivityAt: number;
    /** `now` minus `lastActivityAt`. */
    silenceMs: number;
}

/**
 * The activity state of one Claude transcript, from the end of the file and its modification time: one
 * `stat`, one bounded read, no process spawn and no write. Returns null for a file that is empty or cannot
 * be read.
 *
 * A last conversation record longer than `ACTIVITY_TAIL_BYTES` leaves no whole record in the tail, so the
 * state then comes from the modification time alone: `RUNNING` or `STALLED`, never a question or a finish.
 */
export function readClaudeActivity(filePath: string, options: ReadClaudeActivityOptions = {}): ClaudeActivity | null {
    const now = options.now ?? Date.now();

    try {
        const stat = statSync(filePath);

        if (stat.size === 0) {
            return null;
        }

        const lastModified = stat.mtimeMs;
        const records = readTail(filePath, ACTIVITY_TAIL_BYTES)
            .split("\n")
            .map((line) => parseTranscriptLine(line))
            .filter((record): record is Record<string, unknown> => record !== null);
        const events = claudeRecordsToEvents(records);
        const state = classifyActivity({
            events,
            lastModified,
            now,
            stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
        });
        const lastActivityAt = Math.max(events.at(-1)?.ts ?? 0, lastModified);

        return { state, lastActivityAt, silenceMs: now - lastActivityAt };
    } catch (err) {
        logger.debug({ err, filePath }, "[transcripts] could not read the activity of a transcript");
        return null;
    }
}
