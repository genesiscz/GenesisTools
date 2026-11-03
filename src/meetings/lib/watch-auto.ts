import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";

/** How long after a recorder stopped on its own (its capture failed) the watcher starts it again, while the meeting runs. */
export const RETRY_AFTER_MS = 120_000;

/** The recording the watcher started, so it stops only its own. */
const autoSchema = z.object({
    sourceMeetingId: z.string(),
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

export function writeAuto(store: MeetingStore, auto: AutoRecording): void {
    atomicWriteFileSync(autoPath(store), SafeJSON.stringify(auto));
}

export function clearAuto(store: MeetingStore): void {
    const path = autoPath(store);

    if (existsSync(path)) {
        unlinkSync(path);
    }
}
