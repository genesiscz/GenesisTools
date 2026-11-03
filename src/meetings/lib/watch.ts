import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { type NotificationAction, sendNotification } from "@genesiscz/utils/macos/notifications";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore, RecordingBlock } from "@genesiscz/utils/meetings/record";
import type { LiveRecording } from "@genesiscz/utils/meetings/sources";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { linkSource } from "./link";
import { readRecorderState } from "./recorder";
import { meetingSource } from "./sources";
import { type AutoRecording, clearAuto, RETRY_AFTER_MS, readAuto, writeAuto } from "./watch-auto";

const { log } = logger.scoped("meetings-watch");

/** How often the watcher looks at the source's live recording. One database query and one file stat. */
export const WATCH_INTERVAL_MS = 15_000;
/** How long after the source ended a meeting the watcher keeps refreshing the record from it (title, end, people). */
export const REFRESH_FOR_MS = 10 * 60_000;
const TOOL_TIMEOUT_MS = 120_000;

export { RETRY_AFTER_MS };

type AutoRecordSettings = Awaited<ReturnType<MeetingsConfigStore["read"]>>["sources"]["wisprflow"]["autoRecord"];

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
    return {
        settings: async () => (await new MeetingsConfigStore().read()).sources.wisprflow.autoRecord,
        liveRecording: async () => (await meetingSource("wisprflow")).liveRecording(),
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
    auto: AutoRecording;
    now: number;
}): Promise<void> {
    const { store, deps, auto, now } = options;

    if (!auto.refreshUntil || !auto.meetingId) {
        return;
    }

    const record = await deps.refresh(auto.meetingId, `wisprflow:${auto.sourceMeetingId}`).catch((err: unknown) => {
        log.warn({ err, meeting: auto.meetingId }, "refresh from the source failed");
        return undefined;
    });
    log.info({ meeting: auto.meetingId, title: record?.title, end: record?.end }, "meeting refreshed from its source");

    if (record?.end || now >= Date.parse(auto.refreshUntil)) {
        clearAuto(store);
    }
}

/**
 * One look: Wispr Flow records and nothing else is recording, so start (and post a notification); the recording the
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
        return "disabled";
    }

    const live = await deps.liveRecording();
    const recorder = deps.recorder();
    let auto = readAuto(store);
    log.debug({ live, running: recorder.running, auto }, "watch tick");

    if (!recorder.running && auto?.refreshUntil) {
        await refreshEnded({ store, deps, auto, now });
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
        if (!result.success) {
            return "failed";
        }

        if (ended && auto.meetingId) {
            const pending = { ...auto, refreshUntil: new Date(now + REFRESH_FOR_MS).toISOString() };
            writeAuto(store, pending);
            await refreshEnded({ store, deps, auto: pending, now });
        } else {
            clearAuto(store);
        }

        return "stopped";
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
        `wisprflow:${live.sourceMeetingId}`,
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

    const meetingId = deps.recorder().state?.meetingId;
    writeAuto(store, {
        sourceMeetingId: live.sourceMeetingId,
        ...(meetingId ? { meetingId } : {}),
        startedAt: new Date(now).toISOString(),
    });

    if (settings.notify) {
        // Wispr names a meeting only after it ends, so a live one may have no title yet.
        const title = live.title.trim() || `Wispr Flow meeting since ${localTime(live.startedAt).slice(11)}`;
        await deps.notify({
            title: "Recording the screen",
            subtitle: title,
            message: `Click to open its folder. ${toolCommand("meetings", "record", "stop")} ends it.`,
            ...(meetingId ? { open: store.folder(meetingId) } : {}),
            actions: [
                {
                    id: "stop",
                    title: "Stop recording",
                    execute: toolCommand("meetings", "record", "stop"),
                    destructive: true,
                },
            ],
        });
    }

    return "started";
}

/** The watcher loop: one look every 15 s until a signal. */
export async function watchLoop(store: MeetingStore): Promise<void> {
    let stopped = false;
    const stop = () => {
        stopped = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    log.info("meetings watcher started");

    while (!stopped) {
        const result = await watchOnce(store).catch((err: unknown) => {
            log.warn({ err }, "watch tick failed");
            return "failed" as const;
        });

        if (result === "disabled") {
            log.info("autoRecord is off; the watcher ends");
            break;
        }

        await Bun.sleep(WATCH_INTERVAL_MS);
    }
}
