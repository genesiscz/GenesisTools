import { ensureBinaryAsync } from "@app/control/lib/runner";
import {
    framesDoneLine,
    framesStartOf,
    recordFrames,
    refuseOtherKindFlags,
    wantsFrames,
} from "@app/recorder/lib/frames-recording";
import { ensureRecorderPart, openEditor } from "@app/recorder/lib/library";
import {
    checkTargetOnScreen,
    countdownSecondsOf,
    defaultStartTarget,
    otherRecordingsWarning,
    parseStartFlags,
    type StartFlags,
    withStartOptions,
} from "@app/recorder/lib/start-options";
import { announcedCountdown, recordVideo, videoDoneLine } from "@app/recorder/lib/video-recording";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { FRAME_NAMINGS, OCR_SINK_KINDS } from "@genesiscz/utils/screen-recorder/frame-output";
import { listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { FRAME_FLUSHES } from "@genesiscz/utils/screen-recorder/start";
import type { Command } from "commander";

const { log } = logger.scoped("recorder");

/** The enumerated flags of a frames recording; a bare one asks in a terminal and lists its values elsewhere. */
const FRAMES_ENUM_FLAGS = [
    { key: "naming", flag: "--naming", values: FRAME_NAMINGS },
    { key: "flush", flag: "--flush", values: FRAME_FLUSHES },
    { key: "ocrSink", flag: "--ocr-sink", values: OCR_SINK_KINDS },
] as const;

/** False when a bare or unknown enumerated flag was answered with its values, or the question was cancelled. */
async function settleFramesEnumFlags(flags: StartFlags): Promise<boolean> {
    for (const { key, flag, values } of FRAMES_ENUM_FLAGS) {
        const given = flags[key];

        if (given === undefined || values.some((one) => one === given)) {
            continue;
        }

        if (given === true && isInteractive()) {
            const picked = await p.select({
                message: `${flag}`,
                options: values.map((one) => ({ value: one, label: one })),
                cancel: "back",
            });

            if (p.isCancel(picked)) {
                return false;
            }

            flags[key] = String(picked);
            continue;
        }

        out.printlnErr(
            suggestEnumFlag("tools recorder", flag, values, {
                given: typeof given === "string" ? given : undefined,
            })
        );
        process.exitCode = 1;
        return false;
    }

    return true;
}

/** `start --json`: the countdown's length before it runs, so nothing on stdout for those seconds is explained. */
function printCountdownEvent(seconds: number): void {
    out.print(`${SafeJSON.stringify({ event: "countdown", seconds })}\n`);
}

/** `tools recorder start --frames`: the REPL's `recorder.start()` from the command line. */
async function startFrames(flags: StartFlags): Promise<void> {
    if (!(await settleFramesEnumFlags(flags))) {
        return;
    }

    const start = framesStartOf(flags);
    const result = await recordFrames({
        start,
        countdownSeconds: countdownSecondsOf(flags.countdown),
        ...(flags.json ? { countdown: announcedCountdown(printCountdownEvent) } : {}),
        onStart: (recording) => {
            if (flags.json) {
                out.print(`${SafeJSON.stringify({ event: "started", id: recording.id, folder: recording.folder })}\n`);
            } else {
                out.printlnErr(`recording frames into ${recording.folder}`);
            }
        },
    });

    if (flags.json) {
        out.print(`${SafeJSON.stringify({ event: "result", ...result })}\n`);
    } else {
        out.println(framesDoneLine(result));

        for (const note of result.notes ?? []) {
            out.printlnErr(`note: ${note}`);
        }
    }

    if (result.outcome === "failed") {
        process.exitCode = 1;
    }
}

export function register(program: Command): void {
    withStartOptions(
        program
            .command("start")
            .description(
                "Record a movie into the recordings library (screen.mp4 with audio tracks, cursor.jsonl, recording.json), or with --frames the frames of the displays (JPEG or the recorder's files, OCR into ocr.jsonl or beside each frame), as recorder.start() in the REPL does. Runs until the stop command, the menu bar item, the floating controls, Ctrl-C or --max-seconds; pausing leaves the paused time out"
            )
    ).action(async (flags: StartFlags) => {
        try {
            if (wantsFrames(flags)) {
                await startFrames(flags);
                return;
            }

            refuseOtherKindFlags(flags);
            const request = parseStartFlags(flags);
            // A fresh checkout compiles the native recorder first (up to a minute): say so before the silence.
            await ensureBinaryAsync({
                onBuild: () => {
                    const message =
                        "building the native recorder (ax-tool) once; the first start in a checkout waits for it";
                    if (flags.json) {
                        out.print(`${SafeJSON.stringify({ event: "preparing", message })}\n`);
                    } else {
                        out.printlnErr(message);
                    }
                },
            });
            if (request.target) {
                await checkTargetOnScreen(request.target);
            }

            const alongside = otherRecordingsWarning(listLiveRecordings());

            if (alongside) {
                if (flags.json) {
                    out.print(
                        `${SafeJSON.stringify({ event: "warning", code: "another-recording", message: alongside })}\n`
                    );
                } else {
                    out.printlnErr(`note: ${alongside}`);
                }
            }

            const target = request.target ?? (await defaultStartTarget());

            const result = await recordVideo({
                ...request,
                target,
                ...(flags.json ? { countdown: announcedCountdown(printCountdownEvent) } : {}),
                onStarted: (recording) => {
                    if (flags.json) {
                        out.print(`${SafeJSON.stringify({ event: "started", ...recording })}\n`);
                    } else {
                        out.printlnErr(`recording into ${recording.folder} (live id ${recording.liveId})`);
                    }
                },
                emit: (event) => {
                    if (flags.json) {
                        out.print(`${SafeJSON.stringify(event)}\n`);
                    } else if (event.event === "state") {
                        out.printlnErr(`${event.state} (${event.reason}) · ${Math.round(event.elapsedMs / 1000)} s`);
                    } else if (event.event === "error") {
                        out.printlnErr(`error: ${event.message}`);
                    }
                },
            });

            if (flags.json) {
                out.print(`${SafeJSON.stringify({ event: "result", ...result })}\n`);
            } else {
                out.println(videoDoneLine(result));
            }

            if (result.outcome === "failed" || result.cameraMissing) {
                process.exitCode = 1;
            }

            if (flags.open && result.movie) {
                await ensureRecorderPart((line) => out.printlnErr(line));
                openEditor(result.folder);
            }
        } catch (error) {
            log.debug({ error }, "recorder start failed");
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });
}
