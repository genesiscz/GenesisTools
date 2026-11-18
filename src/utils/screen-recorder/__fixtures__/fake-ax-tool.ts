/**
 * A stand-in for `ax-tool` in tests: `--help` names the capture flags, `screens` lists two displays, and `capture
 * --control-stdin` keeps one frame, then takes switch, pause, resume and stop as JSON lines on stdin and answers with
 * events on stderr, as the real recorder does. The end of stdin or SIGINT stops it with the normal result on stdout.
 * `--fixture-late-png=<epoch ms>` writes the first PNG 800 ms after that capture time and reports the time as
 * `firstFrameEpochMs`, as ax-tool does; `--fixture-late-png-old=<epoch ms>` leaves it out, as an older ax-tool did.
 */
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";

const commandSchema = z.object({
    cmd: z.string(),
    displayId: z.number().optional(),
    deviceId: z.string().optional(),
    active: z.number().optional(),
    idle: z.number().optional(),
    percent: z.number().optional(),
    source: z.string().optional(),
});

const args = process.argv.slice(2);
const fixtureMode = args[0]?.startsWith("--fixture-") ? args.shift() : undefined;
const print = (value: unknown, stream: "stdout" | "stderr" = "stdout") =>
    process[stream].write(`${SafeJSON.stringify(value)}\n`);

if (args[0] === "--help") {
    if (fixtureMode?.startsWith("--fixture-help-once=")) {
        const marker = fixtureMode.slice("--fixture-help-once=".length);

        if (!existsSync(marker)) {
            writeFileSync(marker, "failed");
            process.exit(1);
        }
    }

    process.stdout.write(
        "capture: [--display-id ID] [--follow-focus] [--max-long-side PX] [--control-stdin] mute/unmute | set-mic | set-fps | set-threshold | set-max-long-side\n  [--audio system,mic] [--mic-device UID] [--audio-sidecar]\n  ax-tool audio-devices\n" +
            (fixtureMode === "--fixture-no-audio-session"
                ? ""
                : "  ax-tool audio-record --sources mic,system --segment-sec 60 [--without-screen] [--monitor] [--levels]\n")
    );
    process.exit(0);
}

if (args[0] === "audio-devices") {
    print({
        ok: true,
        inputs: [{ id: "built-in-mic", name: "Built-in Microphone", channels: 1, default: true, audioObjectId: 1 }],
        outputs: [{ id: "speakers", name: "Speakers", channels: 2, default: true, audioObjectId: 2 }],
    });
    process.exit(0);
}

if (args[0] === "screens") {
    print({
        ok: true,
        screens: [
            {
                displayID: 1,
                index: 0,
                isPrimary: true,
                name: "Built-in",
                position: { x: 0, y: 0 },
                resolution: { width: 1512, height: 982 },
                scaleFactor: 2,
            },
            {
                displayID: 4,
                index: 1,
                isPrimary: false,
                name: "External",
                position: { x: 0, y: 982 },
                resolution: { width: 2560, height: 1440 },
                scaleFactor: 1,
            },
        ],
    });
    process.exit(0);
}

const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const outDir = value("--out") ?? ".";

/** Decodable mono PCM under the native track name, for file-clock and recovery fixtures. */
function fixturePcm(durationMs: number, marker?: { firstSecond: number; source: string }): Buffer {
    const bytes = durationMs * 16 * 2;
    const sound = Buffer.alloc(44 + bytes);
    sound.write("RIFF", 0);
    sound.writeUInt32LE(sound.length - 8, 4);
    sound.write("WAVEfmt ", 8);
    sound.writeUInt32LE(16, 16);
    sound.writeUInt16LE(1, 20);
    sound.writeUInt16LE(1, 22);
    sound.writeUInt32LE(16_000, 24);
    sound.writeUInt32LE(32_000, 28);
    sound.writeUInt16LE(2, 32);
    sound.writeUInt16LE(16, 34);
    sound.write("data", 36);
    sound.writeUInt32LE(bytes, 40);
    if (marker) {
        for (let second = 0; second * 1000 < durationMs; second++) {
            const value = marker.firstSecond + second + 1;
            sound.writeInt16LE(marker.source === "mic" ? value : -value, 44 + second * 32_000);
        }
    }
    return sound;
}

if (args[0] === "audio-record" && args.includes("--monitor")) {
    print({ event: "state", state: "recording", sources: ["mic", "system"] }, "stderr");
    print(
        { event: "levels", atMs: Date.now(), mic: 0.25, system: null, input: "Test input", output: "Test output" },
        "stderr"
    );
    process.stdin.once("data", () => process.exit(0));
    process.stdin.once("end", () => process.exit(0));
    await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
    process.exit(0);
}
if (args[0] === "audio-record") {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "argv.json"), SafeJSON.stringify(args));
    const requested = (value("--sources") ?? "mic,system").split(",");
    const sources = requested.filter((source) => fixtureMode !== "--fixture-no-mic-grant" || source !== "mic");
    if (sources.length !== requested.length) {
        print(
            { event: "warning", message: "the microphone is not granted; the recording keeps the system sound only" },
            "stderr"
        );
    }
    const initiallyMuted = (value("--muted") ?? "").split(",");
    const muted: Record<string, boolean> = {
        mic: initiallyMuted.includes("mic"),
        system: initiallyMuted.includes("system"),
    };
    const timeline = fixtureMode?.match(/^--fixture-meeting-timeline=(\d+)$/);
    const start = timeline ? Number(timeline[1]) : Date.parse("2026-11-03T12:00:00.000Z");
    let sequence = 0;
    let position = 0;
    let paused = args.includes("--paused");
    const spans: Record<string, Array<[number, number]>> = { mic: [], system: [] };
    const openSegment = (file: string, source: string, zeroAt: string) => {
        print({ event: "segment-started", file, source, zeroAt });
    };
    const emitSegment = (durationMs: number) => {
        sequence += 1;
        for (const source of sources) {
            const file = `audio-${String(sequence).padStart(6, "0")}-${source}.m4a`;
            writeFileSync(
                join(outDir, file),
                timeline ? fixturePcm(durationMs, { firstSecond: (sequence - 1) * 30, source }) : "invented sound"
            );
            const at = new Date(start + (sequence - 1) * (timeline ? 30_000 : 60_000)).toISOString();
            openSegment(file, source, at);
            print({
                file,
                source,
                at,
                zeroAt: at,
                durationMs,
                mutedSpans: spans[source],
                kept: "normal",
                ...(fixtureMode === "--fixture-audio-loss" ? { lostSpans: [[100, 1750]] } : {}),
            });
            spans[source] = [];
        }
    };
    const state = () => print({ event: "state", state: paused ? "paused" : "recording", sources, muted }, "stderr");
    const restartCase =
        fixtureMode === "--fixture-audio-session-dies-once" || fixtureMode === "--fixture-audio-session-restart-fails";
    const restartMarker = join(outDir, "..", "audio-session-started");
    const restarted = restartCase && existsSync(restartMarker);
    if (restartCase) {
        writeFileSync(restartMarker, "started");
    }
    if (
        fixtureMode === "--fixture-audio-session-dies-at-start" ||
        (fixtureMode === "--fixture-audio-session-restart-fails" && restarted)
    ) {
        // As the real tool did on 2026-11-17: an error on the first captured buffer, before it was ready.
        print({ event: "error", message: "could not split system audio at the segment boundary" }, "stderr");
        await new Promise<void>((resolve) => {
            process.stdin.once("data", () => resolve());
            process.stdin.once("end", () => resolve());
        });
        process.exit(1);
    }

    state();
    if (fixtureMode === "--fixture-audio-exit-open-pipes") {
        // A descendant can keep the pipes open after the process exits. Its lifetime is bounded, not polled.
        Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 1500)"], {
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
        });
        setTimeout(() => process.exit(1), 150);
    }
    if (fixtureMode === "--fixture-audio-session-dies-later" || (restartCase && !restarted)) {
        const failWriter = () => {
            print({ event: "error", message: "the system writer stopped accepting samples" }, "stderr");
            // Let the supervisor read the error and close this session before exiting.
            process.stdin.prependOnceListener("data", () => process.exit(1));
            process.stdin.once("end", () => process.exit(1));
        };
        const gate = value("--fixture-fail-when");
        if (gate) {
            const { waitForPath } = await import("@genesiscz/utils/fs/watcher");
            if (!(await waitForPath(gate, { timeoutMs: 10_000 }))) {
                throw new Error(`missing fixture failure trigger: ${gate}`);
            }
            failWriter();
        } else {
            setTimeout(failWriter, 150);
        }
    }

    if (fixtureMode === "--fixture-audio-loss") {
        emitSegment(60_000);
    }
    if (fixtureMode === "--fixture-audio-three") {
        for (let segment = 0; segment < 3; segment++) {
            emitSegment(60_000);
        }
    }
    if (timeline) {
        const { waitForPath } = await import("@genesiscz/utils/fs/watcher");
        for (let piece = 1; piece <= 3; piece++) {
            if (!(await waitForPath(join(outDir, "..", `frame-${piece}`), { timeoutMs: 5000 }))) {
                throw new Error(`frame piece ${piece} did not start`);
            }
            emitSegment(30_000);
        }
    }
    if (fixtureMode === "--fixture-audio-crash") {
        // A decodable 1.25 s file under the native name: recovery must ignore its unrelated file times.
        const file = "audio-000001-system.m4a";
        writeFileSync(join(outDir, file), fixturePcm(1250));
        openSegment(file, "system", new Date(start + 700).toISOString());
        process.exit(1);
    }
    let input = "";
    let stopping = false;
    const stop = () => {
        if (stopping) {
            return;
        }
        stopping = true;
        if ((!paused && sequence === 0) || position > 0) {
            emitSegment(Math.max(position, 1));
        }
        process.exit(0);
    };
    process.stdin.on("data", (chunk) => {
        input += chunk.toString();
        const lines = input.split("\n");
        input = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
            const command = commandSchema.parse(SafeJSON.parse(line, { strict: true }));
            appendFileSync(join(outDir, "commands.jsonl"), `${SafeJSON.stringify(command)}\n`);
            if (
                !paused &&
                !(
                    (timeline || fixtureMode === "--fixture-audio-three" || fixtureMode === "--fixture-audio-loss") &&
                    command.cmd === "stop" &&
                    position === 0
                )
            ) {
                for (const source of sources) {
                    if (muted[source]) {
                        spans[source].push([position, position + 15_000]);
                    }
                }
                position += 15_000;
            }
            if (command.cmd === "stop") {
                stop();
            } else if (command.cmd === "mute" || command.cmd === "unmute") {
                muted[command.source ?? "mic"] = command.cmd === "mute";
                state();
            } else if (command.cmd === "set-mic") {
                print(
                    command.deviceId === "built-in-mic"
                        ? { event: "settings", micDevice: command.deviceId }
                        : { event: "error", code: "device-missing", message: `no input device ${command.deviceId}` },
                    "stderr"
                );
            } else if (command.cmd === "pause" || command.cmd === "resume") {
                paused = command.cmd === "pause";
                state();
            }
        }
    });
    process.stdin.on("end", stop);
    process.on("SIGINT", stop);
    await new Promise(() => undefined);
}
let displayId = Number(value("--display-id"));
const frames: Array<Record<string, unknown>> = [];
let finished = false;
const latePng = fixtureMode?.match(/^--fixture-late-png(-old)?=(\d+)$/);
const capturedAt = latePng ? Number(latePng[2]) : undefined;
mkdirSync(outDir, { recursive: true });

const keep = (sample: { reason: string; timestampMs?: number; changePercent?: number }) => {
    const file = `keep-${String(frames.length + 1).padStart(4, "0")}.png`;
    const path = join(outDir, file);
    writeFileSync(path, "png");
    const frame = {
        index: frames.length,
        file,
        path,
        timestampMs: sample.timestampMs ?? frames.length * 100,
        changePercent: sample.changePercent ?? 5,
        reason: sample.reason,
        displayId,
    };
    frames.push(frame);
    print({ event: "frame", ...frame }, "stderr");
    return path;
};

const finish = (cancelled: boolean) => {
    if (finished) {
        return;
    }

    finished = true;
    if (fixtureMode === "--fixture-corrupt-output") {
        process.stdout.write('{"data":');
        process.exit(1);
    }

    // As ax-tool does when the mic sidecar fails: the track has no file, only its warnings.
    const tracks =
        fixtureMode === "--fixture-failed-audio"
            ? [
                  {
                      source: "mic",
                      durationMs: 0,
                      mutedSpans: [],
                      warnings: ["the mic sidecar could not start: disk full"],
                  },
              ]
            : (value("--audio")?.split(",") ?? []).map((source) => {
                  const path = join(outDir, `audio-${source}.m4a`);
                  writeFileSync(path, "invented piece sound");
                  return {
                      source,
                      path,
                      durationMs: 1000,
                      mutedSpans: [],
                      ...(fixtureMode === "--fixture-audio-loss" ? { lostSpans: [[100, 750]] } : {}),
                  };
              });
    print({
        ok: true,
        success: true,
        data: {
            frames,
            cancelled,
            stats: { keptFrames: frames.length },
            ...(tracks ? { tracks } : {}),
            ...(capturedAt !== undefined && !latePng?.[1] ? { firstFrameEpochMs: capturedAt } : {}),
        },
    });
    process.exit(0);
};

process.on("SIGINT", () => finish(true));
if (fixtureMode === "--fixture-screen-changes") {
    // Percentage of a fixed image painted so far, compared with the last kept image.
    let lastKept = 0;
    keep({ reason: "first", timestampMs: 0, changePercent: 100 });
    for (const [index, painted] of [1, 4, 4, 10].entries()) {
        const changePercent = Math.abs(painted - lastKept);
        if (changePercent > 0 && changePercent >= Number(value("--threshold"))) {
            keep({ reason: "change", timestampMs: (index + 1) * 500, changePercent });
            lastKept = painted;
        }
    }
} else {
    const firstPng = keep({ reason: "first" });
    if (capturedAt !== undefined) {
        const landed = new Date(capturedAt + 800);
        utimesSync(firstPng, landed, landed);
    }
}

print({ event: "state", state: "recording", displayId }, "stderr");

let pending = "";
process.stdin.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines.filter(Boolean)) {
        const command = commandSchema.parse(SafeJSON.parse(line, { strict: true }));

        if (command.cmd === "switch") {
            if (command.displayId !== 1 && command.displayId !== 4) {
                print(
                    {
                        event: "error",
                        code: "display-missing",
                        message: `display ${command.displayId} is not connected`,
                    },
                    "stderr"
                );
                continue;
            }

            print({ event: "display-switch", from: displayId, to: command.displayId }, "stderr");
            displayId = command.displayId;
            keep({ reason: "display-switch" });
        } else if (command.cmd === "pause" || command.cmd === "resume") {
            print({ event: "state", state: command.cmd === "pause" ? "paused" : "recording" }, "stderr");
        } else if (command.cmd === "mute" || command.cmd === "unmute") {
            // As ax-tool does: a mute answers with the state and what is muted, not with the settings.
            print(
                { event: "state", state: "recording", muted: { [command.source ?? "mic"]: command.cmd === "mute" } },
                "stderr"
            );
        } else if (["set-fps", "set-threshold", "set-max-long-side"].includes(command.cmd)) {
            print({ event: "settings", cmd: command.cmd, activeFps: command.active, idleFps: command.idle }, "stderr");
        } else if (command.cmd === "set-mic") {
            print(
                command.deviceId === "built-in-mic"
                    ? { event: "settings", micDevice: command.deviceId }
                    : { event: "error", code: "device-missing", message: `no input device ${command.deviceId}` },
                "stderr"
            );
        } else if (command.cmd === "stop") {
            finish(false);
        }
    }
});
process.stdin.on("end", () => finish(false));
