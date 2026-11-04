import { existsSync, renameSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type {
    MeetingRecord,
    MeetingStore,
    RecordingBlock,
    RecordingSpan,
    RecordingStopReason,
} from "@genesiscz/utils/meetings/record";
import { claimPidFile, clearPidFile } from "@genesiscz/utils/process/pidfile";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

/**
 * What the meetings recorder keeps that the shared capture session does not know about: the one recorder of a store
 * (its pid file), its state file, and the meeting record's recording block (spans, start, pause and resume). The
 * session (`@genesiscz/utils/screen-recorder/session`) captures; these say who runs it and what the meeting saw.
 */

const { log } = logger.scoped("meetings-recorder");

/**
 * Claims the store's one recorder. Only a claim whose owner is dead (or a reused pid of another program) is taken
 * over; a live recorder's claim, this process's own and an unreadable file are left as they are, and the start fails.
 */
export async function claimRecorderPid(path: string): Promise<{ release: () => void }> {
    const claim = await claimPidFile(path, {
        reclaimable: (state) => state.status === "dead" || state.status === "foreign",
    });

    if (claim.status !== "claimed") {
        const owner = claim.status === "held" && "pid" in claim.state ? ` (pid ${claim.state.pid})` : "";
        throw new Error(`another recorder holds ${path}${owner}`);
    }

    return { release: () => clearPidFile(path) };
}

/** The running recorder's state (`recorder.json`), which becomes `recorder-last.json` when it ends. */
export class RecorderStateFile<T> {
    constructor(private readonly paths: { state: string; last: string }) {}

    save(state: T): void {
        atomicWriteFileSync(this.paths.state, SafeJSON.stringify(state, null, 2));
    }

    retire(): void {
        if (existsSync(this.paths.state)) {
            renameSync(this.paths.state, this.paths.last);
        }
    }
}

/** The meeting record's recording block as the recorder keeps it: the spans, and the start, pause and resume. */
export class RecordingRecord {
    readonly spans: RecordingSpan[];

    constructor(
        private readonly store: MeetingStore,
        private readonly meetingId: string,
        spans: readonly RecordingSpan[]
    ) {
        this.spans = [...spans];
    }

    update(change: string, mutate: (recording: RecordingBlock) => void): Promise<MeetingRecord> {
        return this.store.update(this.meetingId, { command: "record", change }, (current) => {
            const recording: RecordingBlock = { ...current.recording };
            mutate(recording);
            current.recording = recording;
        });
    }

    openSpan(): void {
        this.spans.push({ from: new Date().toISOString() });
    }

    /** `at`: when it was asked for; the running piece converts its frames after that. */
    closeSpan(stopReason: RecordingStopReason, at = new Date().toISOString()): void {
        const open = this.spans.at(-1);

        if (open && !open.to) {
            open.to = at;
            open.stopReason = stopReason;
        }
    }

    /** The `record start` entry: the block starts over (status recording, no stop yet) with the spans so far. */
    async start(options: { startedAt: string; backend: string; displayPolicy: RecordingBlock["displayPolicy"] }) {
        await this.store.update(
            this.meetingId,
            { command: "record start", change: `display ${options.displayPolicy} (${options.backend})` },
            (current) => {
                current.recording = {
                    ...current.recording,
                    startedAt: options.startedAt,
                    backend: options.backend,
                    displayPolicy: options.displayPolicy,
                    framesDir: "frames",
                    ocr: "ocr.jsonl",
                    status: "recording",
                    spans: this.spans,
                };
                delete current.recording.stoppedAt;
                delete current.recording.stopReason;
            }
        );
    }

    /** Writes the pause (or the resume) in the background; a failed write is logged, the recording goes on. */
    markStatus(status: "paused" | "recording"): void {
        const change = status === "paused" ? "paused" : "resumed";
        void this.update(change, (recording) => {
            recording.status = status;
            recording.spans = this.spans;
        }).catch((err: unknown) =>
            log.warn({ err }, `${status === "paused" ? "pause" : "resume"} not written to the record`)
        );
    }
}
