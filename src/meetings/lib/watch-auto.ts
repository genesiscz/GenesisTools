import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";

/** How long after a recorder stopped on its own (its capture failed) the watcher starts it again, while the meeting runs. */
export const RETRY_AFTER_MS = 120_000;

/** The recording the watcher started, so it stops only its own. */
const autoSchema = z.object({
    sourceMeetingId: z.string(),
    /** The source the meeting came from, so a pending refresh outlives a later source switch. */
    sourceId: z.enum(MEETING_SOURCE_IDS).optional(),
    meetingId: z.string().optional(),
    startedAt: z.string(),
    /** When the watcher last started the recorder again after it stopped on its own. */
    retriedAt: z.string().optional(),
    /** The source ended the meeting: refresh the record from it (title, end, people) until then. */
    refreshUntil: z.string().optional(),
});
export type AutoRecording = z.infer<typeof autoSchema>;

function autoPath(store: MeetingStore): string {
    return join(store.root, "watch-auto.json");
}

export function readAuto(store: MeetingStore): AutoRecording | undefined {
    const path = autoPath(store);

    if (!existsSync(path)) {
        return undefined;
    }

    const parsed = autoSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
}

function pendingPath(store: MeetingStore): string {
    return join(store.root, "watch-refresh.json");
}

/**
 * Writes the active recording. An ended meeting still refreshing from its source moves to the pending list first,
 * so the next meeting's recording does not drop its refresh.
 */
export function writeAuto(store: MeetingStore, auto: AutoRecording): void {
    const previous = readAuto(store);

    if (previous?.refreshUntil && previous.sourceMeetingId !== auto.sourceMeetingId) {
        const pending = readPendingRefreshes(store);
        const known = pending.some(
            (one) => one.sourceMeetingId === previous.sourceMeetingId && one.meetingId === previous.meetingId
        );

        if (!known) {
            writePendingRefreshes(store, [...pending, previous]);
        }
    }

    atomicWriteFileSync(autoPath(store), SafeJSON.stringify(auto));
}

/** Ended meetings that still refresh from their source after another recording took the active slot. */
export function readPendingRefreshes(store: MeetingStore): AutoRecording[] {
    const path = pendingPath(store);

    if (!existsSync(path)) {
        return [];
    }

    const parsed = z.array(autoSchema).safeParse(SafeJSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : [];
}

export function writePendingRefreshes(store: MeetingStore, pending: AutoRecording[]): void {
    atomicWriteFileSync(pendingPath(store), SafeJSON.stringify(pending));
}

export function clearAuto(store: MeetingStore): void {
    const path = autoPath(store);

    if (existsSync(path)) {
        unlinkSync(path);
    }
}
