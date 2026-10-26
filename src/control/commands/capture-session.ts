import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { ancestorPids } from "../lib/decision/frontmost";
import { ffmpegSegmentJoiner, nativeSegmentRecorder } from "../lib/recording-native";
import {
    parseRecordingCommand,
    RECORDING_SESSION_MAX_SECONDS,
    RecordingSession,
    type RecordingSessionEvent,
    recordingsDir,
} from "../lib/recording-session";
import {
    defaultRecordingTarget,
    describeRecordingTarget,
    listRecordingTargets,
    recordingTargetSchema,
} from "../lib/recording-targets";

const { log } = logger.scoped("control-capture-session");

interface SessionFlags {
    json?: boolean;
    stopOnStdin?: boolean;
    target?: string;
    excludeWindowIds?: string;
    fps?: string;
    /** Commander's `--no-indicator`: true unless the flag is given. */
    indicator?: boolean;
    maxSeconds?: string;
    output?: string;
}

function parseIds(raw: string | undefined): number[] | undefined {
    if (!raw) {
        return undefined;
    }

    const ids = raw.split(",").map(Number);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error("--exclude-window-ids takes positive CG window ids separated by commas");
    }

    return ids;
}

function boundedNumber(raw: string | undefined, name: string, min: number, max: number): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}`);
    }

    return value;
}

function stamp(date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function humanLine(event: RecordingSessionEvent): string {
    switch (event.event) {
        case "state":
            return `${event.state} (${event.reason}) · ${describeRecordingTarget(event.target)} · ${Math.round(event.elapsedMs / 1000)} s`;
        case "elapsed":
            return `${Math.round(event.elapsedMs / 1000)} s`;
        case "segment":
            return `segment ${event.index}: ${Math.round(event.durationMs / 1000)} s`;
        case "done":
            return `saved ${event.path} (${Math.round(event.durationMs / 1000)} s, ${event.segments} segments)`;
        case "discarded":
            return "discarded";
        case "preparing":
            return event.message;
        case "error":
            return `error: ${event.message}`;
    }
}

/**
 * Reads one command per stdin line and calls `onEnd` at EOF. The returned function stops reading, so a finished
 * session does not keep the process alive while its host still holds the pipe open.
 */
function readCommands({ onLine, onEnd }: { onLine: (line: string) => void; onEnd: () => void }): () => void {
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    let cancelled = false;
    void (async () => {
        let pending = "";
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) {
                    break;
                }

                pending += decoder.decode(next.value, { stream: true });
                let newline = pending.indexOf("\n");
                while (newline >= 0) {
                    const line = pending.slice(0, newline).trim();
                    pending = pending.slice(newline + 1);
                    if (line) {
                        onLine(line);
                    }

                    newline = pending.indexOf("\n");
                }
            }
        } catch (error) {
            log.debug({ error }, "recording command input ended with an error");
        }

        if (!cancelled) {
            onEnd();
        }
    })();
    return () => {
        cancelled = true;
        void reader.cancel().catch((error: unknown) => log.debug({ error }, "recording command input cancel"));
    };
}

export function registerCaptureSessionCommands(capture: Command): void {
    capture
        .command("session")
        .description(
            "A recording you control while it runs: JSONL commands on stdin (pause, resume, switch, restart, stop, discard), JSONL events on stdout"
        )
        .option("--json", "Events as JSON lines on stdout")
        .option("--stop-on-stdin", "Read commands from stdin; its end stops and keeps the recording")
        .option(
            "--target <json>",
            'What to record: {"kind":"window","windowIds":[n]}, {"kind":"app","app":"Finder"} or {"kind":"display","screenIndex":0}; default the front window'
        )
        .option("--exclude-window-ids <ids>", "CG window ids the movie never shows (the host's own controls)")
        .option("--fps <n>", "Frame rate while something moves, 0.5–120", "60")
        .option("--no-indicator", "Hide the red border around what is recorded (never in the movie either way)")
        .option("--max-seconds <n>", `Longest recording, 1–${RECORDING_SESSION_MAX_SECONDS} s`)
        .option("--output <path>", "Where the joined movie goes (default ~/.genesis-tools/control/recordings/)")
        .action(async (flags: SessionFlags) => {
            // A host that dies closes the pipe: the next write fails with EPIPE, which would end this process with
            // the segments on disk and no movie. Stop instead, and keep what was recorded.
            let hostGone = false;
            let session: RecordingSession | undefined;
            process.stdout.on("error", (error) => {
                if (hostGone) {
                    return;
                }

                hostGone = true;
                log.warn({ error }, "stdout closed; the host is gone, so the recording stops and is kept");
                void session?.command({ cmd: "stop" });
            });
            const emit = (event: RecordingSessionEvent) => {
                log.info({ event }, "recording event");
                if (hostGone) {
                    return;
                }

                if (flags.json) {
                    out.print(`${SafeJSON.stringify(event)}\n`);
                } else {
                    out.printlnErr(humanLine(event));
                }
            };

            try {
                const target = flags.target
                    ? recordingTargetSchema.parse(SafeJSON.parse(flags.target, { strict: true }))
                    : defaultRecordingTarget(await listRecordingTargets(), new Set([...ancestorPids(), process.pid]));
                if (!target) {
                    throw new Error("Nothing on screen to record.");
                }

                // The default output and every session folder live here, so the folder is owner only.
                await mkdir(recordingsDir(), { recursive: true, mode: 0o700 });
                await chmod(recordingsDir(), 0o700);
                session = new RecordingSession({
                    target,
                    directory: recordingsDir(`session-${randomUUID()}`),
                    // The suffix keeps two sessions that start in the same second from saving over each other.
                    output: flags.output ?? recordingsDir(`recording-${stamp()}-${randomUUID().slice(0, 8)}.mp4`),
                    recorder: nativeSegmentRecorder({
                        excludeWindowIds: parseIds(flags.excludeWindowIds),
                        fps: boundedNumber(flags.fps, "--fps", 0.5, 120),
                        indicator: flags.indicator,
                    }),
                    join: ffmpegSegmentJoiner,
                    emit,
                    maxSeconds: boundedNumber(flags.maxSeconds, "--max-seconds", 1, RECORDING_SESSION_MAX_SECONDS),
                });
                log.info({ target, stopOnStdin: flags.stopOnStdin === true }, "recording session starting");
            } catch (error) {
                emit({ event: "error", message: error instanceof Error ? error.message : String(error), fatal: true });
                process.exitCode = 1;
                return;
            }

            const active = session;
            const outcome = await withInterrupt(
                async (signal) => {
                    // Ctrl-C or SIGTERM keeps what was recorded: a host that quits never loses the movie.
                    signal.addEventListener("abort", () => void active.command({ cmd: "stop" }), { once: true });
                    await active.start();
                    const stopReading = flags.stopOnStdin
                        ? readCommands({
                              onLine: (line) => {
                                  const command = parseRecordingCommand(line);
                                  if ("error" in command) {
                                      emit({ event: "error", message: command.error, fatal: false });
                                      return;
                                  }

                                  void active.command(command);
                              },
                              onEnd: () => void active.command({ cmd: "stop" }),
                          })
                        : undefined;
                    const result = await active.finished;
                    stopReading?.();
                    return result;
                },
                { handleTermination: true }
            );
            log.info({ outcome }, "recording session ended");
            if (outcome === "failed") {
                process.exitCode = 1;
            }
        });

    capture
        .command("targets")
        .description("What a recording session can record: on-screen windows, their apps, and the displays")
        .option("--json", "JSON on stdout")
        .action(async (flags: { json?: boolean }) => {
            const targets = await listRecordingTargets();
            if (flags.json) {
                out.print(`${SafeJSON.stringify(targets)}\n`);
                return;
            }

            renderCliHeader(
                "Recording targets",
                `${targets.windows.length} windows · ${targets.displays.length} displays`
            );
            const table = createBoxTable(["KIND", "ID", "APP", "TITLE / NAME", "SIZE"]);
            for (const window of targets.windows) {
                table.push([
                    "window",
                    String(window.id),
                    window.app,
                    window.title || "—",
                    `${Math.round(window.bounds.width)}x${Math.round(window.bounds.height)}`,
                ]);
            }

            for (const display of targets.displays) {
                table.push([
                    "display",
                    String(display.index),
                    "",
                    display.name + (display.isPrimary ? " (main)" : ""),
                    `${display.width}x${display.height}`,
                ]);
            }

            out.println(table.toString());
        });
}
