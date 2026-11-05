import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type NotificationAction, sendNotification } from "@genesiscz/utils/macos/notifications";
import { type MeetingsConfig, MeetingsConfigStore, type SourceSettings } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { type LiveRecording, MEETING_SOURCE_IDS, type MeetingSourceId } from "@genesiscz/utils/meetings/sources";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import { readRecorderState } from "./recorder";
import { pruneCapturesDaily } from "./retention";
import { meetingSource } from "./sources";

const { log } = logger.scoped("meetings-watch");

/** How often the watcher looks at the source's live recording. One database query and one file stat. */
export const WATCH_INTERVAL_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;

/** The recording the watcher started, so it stops only its own. */
const autoSchema = z.object({
    sourceMeetingId: z.string(),
    meetingId: z.string().optional(),
    startedAt: z.string(),
    recorderStartedAt: z.string().optional(),
});
type AutoRecording = z.infer<typeof autoSchema>;

function autoPath(store: MeetingStore): string {
    return join(store.root, "watch-auto.json");
}

function readAuto(store: MeetingStore): AutoRecording | undefined {
    const path = autoPath(store);

    if (!existsSync(path)) {
        return undefined;
    }

    const parsed = autoSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
}

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

        if (
            recorder.running &&
            auto?.meetingId &&
            auto.recorderStartedAt !== undefined &&
            recorder.state?.meetingId === auto.meetingId &&
            recorder.state?.startedAt === auto.recorderStartedAt
        ) {
            const result = await deps.run([
                "meetings",
                "record",
                "stop",
                "--meeting",
                auto.meetingId,
                "--started-at",
                auto.recorderStartedAt,
            ]);

            if (!result.success || deps.recorder().running) {
                return "failed";
            }

            unlinkSync(autoPath(store));
        }

        return "disabled";
    }

    const source = await deps.source();

    const live = await deps.liveRecording();
    const recorder = deps.recorder();
    const auto = readAuto(store);
    log.debug({ live, running: recorder.running, auto }, "watch tick");

    if (recorder.running) {
        const own =
            auto &&
            auto.recorderStartedAt !== undefined &&
            recorder.state?.meetingId === auto.meetingId &&
            recorder.state?.startedAt === auto.recorderStartedAt;
        const ended = !live || live.sourceMeetingId !== auto?.sourceMeetingId;
        const silent = live ? now - Date.parse(live.liveChangedAt) > settings.stopAfterSilenceSec * 1000 : true;

        if (!own) {
            return "busy";
        }

        if (!ended && !silent) {
            return "recording";
        }

        const result = await deps.run([
            "meetings",
            "record",
            "stop",
            "--meeting",
            auto.meetingId!,
            "--started-at",
            auto.recorderStartedAt!,
        ]);
        log.info({ meeting: auto.meetingId, exitCode: result.exitCode, ended, silent }, "auto recording stopped");
        if (result.success && !deps.recorder().running) {
            unlinkSync(autoPath(store));
            return "stopped";
        }

        return "failed";
    }

    if (!live || !isFresh(live, settings.liveWithinSec, now) || auto?.sourceMeetingId === live.sourceMeetingId) {
        return "idle";
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
        atomicWriteFileSync(
            autoPath(store),
            SafeJSON.stringify({ sourceMeetingId: live.sourceMeetingId, startedAt: new Date(now).toISOString() })
        );
        return "failed";
    }

    const startedRecorder = deps.recorder().state;
    const meetingId = startedRecorder?.meetingId;
    atomicWriteFileSync(
        autoPath(store),
        SafeJSON.stringify({
            sourceMeetingId: live.sourceMeetingId,
            ...(meetingId ? { meetingId } : {}),
            ...(startedRecorder ? { recorderStartedAt: startedRecorder.startedAt } : {}),
            startedAt: new Date(now).toISOString(),
        })
    );

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
        const recorder = readRecorderState(store);
        const skip = recorder.running ? recorder.state?.meetingId : undefined;
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

/** The watcher loop: one look every 15 s until a signal, and the capture retention pass once a day. */
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

        if (result === "disabled") {
            log.info("autoRecord is off; the watcher ends");
            break;
        }

        await Bun.sleep(WATCH_INTERVAL_MS);
    }
}
