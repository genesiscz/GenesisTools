import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { type NotificationAction, sendNotification } from "@genesiscz/utils/macos/notifications";
import { type MeetingsConfig, MeetingsConfigStore, type SourceSettings } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore, RecordingBlock } from "@genesiscz/utils/meetings/record";
import { type LiveRecording, MEETING_SOURCE_IDS, type MeetingSourceId } from "@genesiscz/utils/meetings/sources";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { assignSweep, hasOpenAssignSteps } from "./assign";
import { linkSource } from "./link";
import { readRecorderState } from "./recorder-shared";
import { pruneCapturesDaily } from "./retention";
import { meetingSource } from "./sources";
import {
    type AutoRecording,
    clearAuto,
    RETRY_AFTER_MS,
    readAuto,
    readPendingRefreshes,
    writeAuto,
    writePendingRefreshes,
} from "./watch-auto";

const { log } = logger.scoped("meetings-watch");

/** How often the watcher looks at the source's live recording. One database query and one file stat. */
export const WATCH_INTERVAL_MS = 15_000;
/** How long after the source ended a meeting the watcher keeps refreshing the record from it (title, end, people). */
export const REFRESH_FOR_MS = 10 * 60_000;
const TOOL_TIMEOUT_MS = 120_000;

export { RETRY_AFTER_MS };

type AutoRecordSettings = SourceSettings["autoRecord"];

/** The source the watcher follows: the first one in the registry with autoRecord on, else the first one. */
export function watchedSourceId(config: MeetingsConfig): MeetingSourceId {
    return MEETING_SOURCE_IDS.find((id) => config.sources[id].autoRecord.enabled) ?? MEETING_SOURCE_IDS[0];
}

/** What the watcher reads and does, so a test can replace each part. */
/** A notification the watcher posts. A click must do something: the body opens `open`, a button runs its command. */
export interface WatchNote {
    title: string;
    message: string;
    subtitle?: string;
    open?: string;
    actions?: NotificationAction[];
}

export interface WatchDeps {
    /** The source the watcher follows (`watchedSourceId`), with the label its notifications use. */
    source: () => Promise<{ id: MeetingSourceId; label: string }>;
    /** That source's `sources.<id>.autoRecord`. */
    settings: () => Promise<AutoRecordSettings>;
    liveRecording: () => Promise<LiveRecording | null>;
    recorder: () => ReturnType<typeof readRecorderState>;
    /** The `recording` block of a meeting record. */
    recording: (meetingId: string) => RecordingBlock | undefined;
    /** Links the source's meeting again, so its final title, end and people reach the record. */
    refresh: (meetingId: string, sourceRef: string) => Promise<MeetingRecord>;
    run: (args: string[]) => Promise<{ success: boolean; exitCode: number | null; stderr: string }>;
    notify: (note: WatchNote) => Promise<void>;
}

function defaultDeps(store: MeetingStore): WatchDeps {
    let watched: Promise<{ id: MeetingSourceId; settings: AutoRecordSettings }> | undefined;
    // One config read per look: every part of this look follows the same source.
    const current = () =>
        (watched ??= new MeetingsConfigStore().read().then((config) => {
            const id = watchedSourceId(config);
            return { id, settings: config.sources[id].autoRecord };
        }));

    return {
        source: async () => {
            const { id } = await current();
            return { id, label: (await meetingSource(id)).label };
        },
        settings: async () => (await current()).settings,
        liveRecording: async () => (await meetingSource((await current()).id)).liveRecording(),
        recorder: () => readRecorderState(store),
        recording: (meetingId) => store.read(meetingId)?.recording,
        refresh: async (meetingId, sourceRef) =>
            (
                await linkSource({
                    store,
                    config: new MeetingsConfigStore(),
                    sourceRef,
                    meetingRef: meetingId,
                    command: "watch refresh",
                    createdBy: "autostart",
                    quiet: true,
                    refresh: true,
                })
            ).record,
        run: (args) => execTool(args, { timeout: TOOL_TIMEOUT_MS }),
        notify: async (note) => {
            // The group names the source in the notification ledger (`tools notify history --source meetings`).
            await sendNotification({ ...note, group: "meetings" }).catch((err: unknown) =>
                log.warn({ err }, "notification failed")
            );
        },
    };
}

export type WatchResult = "disabled" | "idle" | "started" | "stopped" | "recording" | "busy" | "failed";

function isFresh(live: LiveRecording, withinSec: number, now: number): boolean {
    return now - Date.parse(live.liveChangedAt) <= withinSec * 1000;
}

/**
 * The meeting still runs, but its recorder ended: a stop the user asked for stays stopped, a failed capture starts
 * again every RETRY_AFTER_MS. The recorder itself posts the notice, once per failure episode.
 */
async function retryFailed(options: {
    store: MeetingStore;
    deps: WatchDeps;
    auto: AutoRecording & { meetingId: string };
    now: number;
}): Promise<WatchResult> {
    const { store, deps, auto, now } = options;
    const recording = deps.recording(auto.meetingId);

    if (recording?.stopReason !== "failed" && recording?.stopReason !== "error") {
        return "idle";
    }

    const stoppedAt = recording.stoppedAt ? Date.parse(recording.stoppedAt) : 0;
    const lastTry = Math.max(stoppedAt, auto.retriedAt ? Date.parse(auto.retriedAt) : 0);

    if (now - lastTry < RETRY_AFTER_MS) {
        return "idle";
    }

    const result = await deps.run(["meetings", "record", "start", "--meeting", auto.meetingId, "--yes"]);
    log.info({ meeting: auto.meetingId, exitCode: result.exitCode }, "failed recording started again");
    writeAuto(store, { ...auto, retriedAt: new Date(now).toISOString() });
    return result.success ? "started" : "failed";
}

/**
 * The source ended the meeting the watcher recorded: link it again so its final title, end and people reach the
 * record. The source may name the meeting a little later, so this repeats on each look until the record has an end,
 * or for REFRESH_FOR_MS.
 */
async function refreshEnded(options: {
    store: MeetingStore;
    deps: WatchDeps;
    sourceId: MeetingSourceId;
    auto: AutoRecording;
    now: number;
}): Promise<boolean> {
    const { store, deps, auto, now } = options;

    if (!auto.refreshUntil || !auto.meetingId) {
        return true;
    }

    const record = await deps
        .refresh(auto.meetingId, `${options.sourceId}:${auto.sourceMeetingId}`)
        .catch((err: unknown) => {
            log.warn({ err, meeting: auto.meetingId }, "refresh from the source failed");
            return undefined;
        });
    log.info({ meeting: auto.meetingId, title: record?.title, end: record?.end }, "meeting refreshed from its source");

    if (record?.end || now >= Date.parse(auto.refreshUntil)) {
        const active = readAuto(store);

        // A pending refresh that finished leaves the active recording alone.
        if (active?.sourceMeetingId === auto.sourceMeetingId && active.meetingId === auto.meetingId) {
            clearAuto(store);
        }

        return true;
    }

    return false;
}

/**
 * One look: the watched source records and nothing else is recording, so start (and post a notification); the recording the
 * watcher started has ended or gone silent, so stop it. A recording a person started is never stopped here.
 */

export async function watchOnce(
    store: MeetingStore,
    options: { deps?: Partial<WatchDeps>; now?: number } = {}
): Promise<WatchResult> {
    const deps: WatchDeps = { ...defaultDeps(store), ...options.deps };
    const now = options.now ?? Date.now();
    const settings = await deps.settings();

    if (!settings.enabled) {
        const recorder = deps.recorder();
        const auto = readAuto(store);

        // Turning autostart off ends the recording it started; a manual recording is left alone.
        if (recorder.running && auto?.meetingId && recorder.state?.meetingId === auto.meetingId) {
            const result = await deps.run(["meetings", "record", "stop"]);

            if (!result.success || deps.recorder().running) {
                return "failed";
            }

            clearAuto(store);
        }

        return "disabled";
    }

    const source = await deps.source();
    const pendingRefreshes = readPendingRefreshes(store);
    const remaining: AutoRecording[] = [];

    for (const pending of pendingRefreshes) {
        const done = await refreshEnded({ store, deps, sourceId: pending.sourceId ?? source.id, auto: pending, now });

        if (!done) {
            remaining.push(pending);
        }
    }

    if (remaining.length !== pendingRefreshes.length) {
        writePendingRefreshes(store, remaining);
    }

    const live = await deps.liveRecording();
    const recorder = deps.recorder();
    let auto = readAuto(store);
    log.debug({ live, running: recorder.running, auto }, "watch tick");

    if (!recorder.running && auto?.refreshUntil) {
        await refreshEnded({ store, deps, sourceId: source.id, auto, now });
        auto = readAuto(store);
    }

    if (recorder.running) {
        if (!auto || recorder.state?.meetingId !== auto.meetingId) {
            return "busy";
        }

        const ended = !live || live.sourceMeetingId !== auto.sourceMeetingId;
        const silent = live ? now - Date.parse(live.liveChangedAt) > settings.stopAfterSilenceSec * 1000 : true;

        if (!ended && !silent) {
            return "recording";
        }

        const result = await deps.run(["meetings", "record", "stop"]);
        log.info({ meeting: auto.meetingId, exitCode: result.exitCode, ended, silent }, "auto recording stopped");

        // Not stopped yet: the next look tries again, and still knows the recording is its own.
        if (!result.success || deps.recorder().running) {
            return "failed";
        }

        if (ended && auto.meetingId) {
            const pending = {
                ...auto,
                sourceId: source.id,
                refreshUntil: new Date(now + REFRESH_FOR_MS).toISOString(),
            };
            writeAuto(store, pending);
            await refreshEnded({ store, deps, sourceId: source.id, auto: pending, now });
        } else {
            clearAuto(store);
        }

        return "stopped";
    }

    if (auto?.meetingId && !auto.refreshUntil && live?.sourceMeetingId !== auto.sourceMeetingId) {
        const pending = { ...auto, sourceId: source.id, refreshUntil: new Date(now + REFRESH_FOR_MS).toISOString() };
        writeAuto(store, pending);
        await refreshEnded({ store, deps, sourceId: source.id, auto: pending, now });
    }

    if (!live || !isFresh(live, settings.liveWithinSec, now)) {
        return "idle";
    }

    if (auto?.sourceMeetingId === live.sourceMeetingId) {
        return auto.meetingId
            ? await retryFailed({ store, deps, auto: { ...auto, meetingId: auto.meetingId }, now })
            : "idle";
    }

    const result = await deps.run([
        "meetings",
        "record",
        "start",
        "--source",
        `${source.id}:${live.sourceMeetingId}`,
        "--yes",
    ]);
    log.info({ live, exitCode: result.exitCode, stderr: result.stderr.slice(-400) }, "auto recording start");

    if (!result.success) {
        if (settings.notify) {
            await deps.notify({
                title: "Meeting not recorded",
                message: result.stderr.split("\n").at(-1) || "The screen recording did not start.",
            });
        }

        // Remember the meeting, so a missing grant does not retry and notify every 15 s.
        writeAuto(store, { sourceMeetingId: live.sourceMeetingId, startedAt: new Date(now).toISOString() });
        return "failed";
    }

    const startedRecorder = deps.recorder().state;
    const meetingId = startedRecorder?.meetingId;
    writeAuto(store, {
        sourceMeetingId: live.sourceMeetingId,
        ...(meetingId ? { meetingId } : {}),
        startedAt: new Date(now).toISOString(),
    });

    if (settings.notify) {
        // A source may name a meeting only after it ends (Wispr does), so a live one may have no title yet.
        const title = live.title.trim() || `${source.label} meeting since ${localTime(live.startedAt).slice(11)}`;
        await deps.notify({
            title: "Recording the screen",
            subtitle: title,
            message: `Click to open its folder. ${toolCommand("meetings", "record", "stop")} ends it.`,
            ...(meetingId ? { open: store.folder(meetingId) } : {}),
            actions:
                meetingId && startedRecorder
                    ? [
                          {
                              id: "stop",
                              title: "Stop recording",
                              execute: toolCommand(
                                  "meetings",
                                  "record",
                                  "stop",
                                  "--meeting",
                                  meetingId,
                                  "--started-at",
                                  startedRecorder.startedAt
                              ),
                              destructive: true,
                          },
                      ]
                    : [],
        });
    }

    return "started";
}

/** Once a day: the frames and OCR of meetings past `capture.retentionDays` go to the trash. Never fails a look. */
async function pruneOldCaptures(store: MeetingStore): Promise<void> {
    try {
        const config = await new MeetingsConfigStore().read();
        const skip = readRecorderState(store).state?.meetingId;
        const result = pruneCapturesDaily(store, { days: config.global.capture.retentionDays, skip });

        if (result && result.plans.length > 0) {
            log.info(
                { meetings: result.plans.length, batch: result.batch, days: config.global.capture.retentionDays },
                "frames and OCR past capture.retentionDays moved to the trash"
            );
        }
    } catch (err) {
        log.warn({ err }, "capture retention pass failed");
    }
}

/**
 * The watcher loop: one look every 15 s until a signal, then the "ask each time" sweep (a question for each ended
 * meeting without a project, and the answers applied), and the capture retention pass once a day. With autoRecord
 * off it still runs while a project question or a folder step waits, since only the sweep reads those back.
 */
export async function watchLoop(store: MeetingStore): Promise<void> {
    let stopped = false;
    const stop = () => {
        stopped = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    log.info("meetings watcher started");

    while (!stopped) {
        await pruneOldCaptures(store);
        const result = await watchOnce(store).catch((err: unknown) => {
            log.warn({ err }, "watch tick failed");
            return "failed" as const;
        });
        // After the look, so a meeting the look just refreshed from its source is asked about at once.
        await assignSweep(store).catch((err: unknown) => log.warn({ err }, "assign sweep failed"));

        if (result === "disabled" && !hasOpenAssignSteps(store)) {
            log.info("autoRecord is off and no project question waits; the watcher ends");
            break;
        }

        await Bun.sleep(WATCH_INTERVAL_MS);
    }
}
