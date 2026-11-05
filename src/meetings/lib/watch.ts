import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type NotificationAction, sendNotification } from "@genesiscz/utils/macos/notifications";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { LiveRecording } from "@genesiscz/utils/meetings/sources";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import { readRecorderState } from "./recorder";
import { meetingSource } from "./sources";

const { log } = logger.scoped("meetings-watch");

/** How often the watcher looks at the source's live recording. One database query and one file stat. */
export const WATCH_INTERVAL_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;

/** The recording the watcher started, so it stops only its own. */
const autoSchema = z.object({ sourceMeetingId: z.string(), meetingId: z.string().optional(), startedAt: z.string() });
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
    run: (args: string[]) => Promise<{ success: boolean; exitCode: number | null; stderr: string }>;
    notify: (note: WatchNote) => Promise<void>;
}

function defaultDeps(store: MeetingStore): WatchDeps {
    return {
        settings: async () => (await new MeetingsConfigStore().read()).sources.wisprflow.autoRecord,
        liveRecording: async () => (await meetingSource("wisprflow")).liveRecording(),
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
        const recorder = deps.recorder();
        const auto = readAuto(store);

        if (recorder.running && auto?.meetingId && recorder.state?.meetingId === auto.meetingId) {
            const result = await deps.run(["meetings", "record", "stop"]);

            if (!result.success || deps.recorder().running) {
                return "failed";
            }

            unlinkSync(autoPath(store));
        }

        return "disabled";
    }

    const live = await deps.liveRecording();
    const recorder = deps.recorder();
    const auto = readAuto(store);
    log.debug({ live, running: recorder.running, auto }, "watch tick");

    if (recorder.running) {
        const own = auto && recorder.state?.meetingId === auto.meetingId;
        const ended = !live || live.sourceMeetingId !== auto?.sourceMeetingId;
        const silent = live ? now - Date.parse(live.liveChangedAt) > settings.stopAfterSilenceSec * 1000 : true;

        if (!own) {
            return "busy";
        }

        if (!ended && !silent) {
            return "recording";
        }

        const result = await deps.run(["meetings", "record", "stop"]);
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
            startedAt: new Date(now).toISOString(),
        })
    );

    if (settings.notify) {
        // Wispr names a meeting only after it ends, so a live one may have no title yet.
        const title = live.title.trim() || `Wispr Flow meeting since ${localTime(live.startedAt).slice(11)}`;
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
