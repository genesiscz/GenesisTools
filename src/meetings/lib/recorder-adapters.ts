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
 * Claims the store's one recorder. A claim whose owner is dead, a reused pid of another program and an unreadable
 * (empty or corrupt) file are taken over, as the daemon and chrome-devtools do; a live recorder's claim and this
 * process's own are left as they are, and the start fails, so one process never runs two meeting recordings.
 */
export async function claimRecorderPid(path: string): Promise<{ release: () => void }> {
    const claim = await claimPidFile(path, {
        reclaimable: (state) => state.status === "dead" || state.status === "foreign" || state.status === "none",
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
    private statusWrites: Promise<void> = Promise.resolve();

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
    async start(options: {
        startedAt: string;
        backend: string;
        displayPolicy: RecordingBlock["displayPolicy"];
        displaySpans?: RecordingBlock["displaySpans"];
    }) {
        await this.store.update(
            this.meetingId,
            { command: "record start", change: `display ${options.displayPolicy} (${options.backend})` },
            (current) => {
                current.recording = {
                    ...current.recording,
                    // A restart keeps the first run's start: the record's totals and movie time 0 count from it.
                    startedAt: current.recording?.startedAt ?? options.startedAt,
                    backend: options.backend,
                    displayPolicy: options.displayPolicy,
                    framesDir: "frames",
                    ocr: "ocr.jsonl",
                    status: "recording",
                    spans: this.spans,
                    ...(options.displaySpans ? { displaySpans: options.displaySpans } : {}),
                };
                delete current.recording.stoppedAt;
                delete current.recording.stopReason;
            }
        );
    }

    /** Adds a marker of `marker.add` to the record at its wall time, beside the markers of earlier starts. */
    async addMarker(marker: { at: string; label: string }): Promise<void> {
        await this.update(`marker "${marker.label}"`, (recording) => {
            recording.markers = [...(recording.markers ?? []), { at: marker.at, label: marker.label }];
        });
    }

    /** Finalization waits for status/history writes before publishing the stopped record. */
    async settleStatuses(): Promise<void> {
        await this.statusWrites;
    }

    /** Writes the pause (or the resume) in the background; a failed write is logged, the recording goes on. */
    markStatus(status: "paused" | "recording"): void {
        const change = status === "paused" ? "paused" : "resumed";
        const spans = this.spans.map((span) => ({ ...span }));
        this.statusWrites = this.statusWrites
            .then(() =>
                this.update(change, (recording) => {
                    recording.status = status;
                    recording.spans = spans;
                })
            )
            .then(() => undefined)
            .catch((err: unknown) =>
                log.warn({ err }, `${status === "paused" ? "pause" : "resume"} not written to the record`)
            );
    }
}
