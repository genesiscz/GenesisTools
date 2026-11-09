import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chosenPlan } from "@app/recorder/lib/proxy";
import { SafeJSON } from "@genesiscz/utils/json";
import { framesDurationUs } from "@genesiscz/utils/recording-editor/source";
import { RPC_ERRORS } from "@genesiscz/utils/screen-recorder/control";
import { LiveRecordingServer, RecorderClient } from "@genesiscz/utils/screen-recorder/live";
import * as mediaFacts from "@genesiscz/utils/video/media-facts";
import * as videoProbe from "@genesiscz/utils/video/probe";
import * as videoProcess from "@genesiscz/utils/video/process";
import { captureDiagnostics, validateBenchmark } from "../scripts/recorder-benchmark-policy";
import * as captureRunner from "./capture-runner";
import {
    audioTitlesArgv,
    audioTrackTitles,
    cursorTrackOffsets,
    movieLengthMs,
    type NativeRecorderOptions,
    nativeSegmentRecorder,
    segmentCaptureSpec,
    segmentJoiner,
} from "./recording-native";
import {
    concatCopyArgv,
    concatListLine,
    cursorTrackPath,
    FIRST_FRAME_MESSAGE,
    type FinishedSegment,
    joinCursorTracks,
    joinSegmentsArgv,
    letterboxPlacement,
    type MovieRates,
    PREPARING_MESSAGE,
    parseRecordingCommand,
    RecordingSession,
    type RecordingSessionEvent,
    type SegmentRecorder,
    type SegmentResult,
} from "./recording-session";
import { applyRecordingCommand, SessionRecorderControl } from "./recording-session-control";
import {
    defaultRecordingTarget,
    describeRecordingTarget,
    groupRecordingApps,
    parseRecordingWindows,
    parseRegionTarget,
    parseWindowIdList,
    type RecordingTarget,
} from "./recording-targets";

// AppKit and the swift interpreter exist only on macOS.
it.skipIf(process.platform !== "darwin")(
    "the benchmark scene exceeds its one percent threshold on a 4K display",
    async () => {
        const proc = Bun.spawn(
            ["swift", "src/control/scripts/recorder-benchmark-scene.swift", "--geometry", "3840", "2160"],
            { stdout: "pipe", stderr: "pipe", env: process.env }
        );
        const [output, error, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect(error).toBe("");
        expect(code).toBe(0);
        const [width, height] = output.trim().split(" ").map(Number);
        expect((width! * height!) / (3840 * 2160)).toBeGreaterThan(0.01);
    },
    60_000
);

it("rejects benchmark durations beyond the backend cap and invalid plans", () => {
    for (const seconds of [0, -1, NaN, Infinity, 181]) {
        expect(() => validateBenchmark(1, seconds)).toThrow();
    }

    expect(() => validateBenchmark(0, 60)).toThrow();
    expect(() => validateBenchmark(1, 60, "unknown")).toThrow();
    expect(() => validateBenchmark(1, 180, "native")).not.toThrow();
});

it("reports fulfilled captures that terminated early as benchmark errors", () => {
    expect(captureDiagnostics({ startedAtMs: 0, frames: [], endedEarly: "stream-error" })).toEqual([
        "capture ended early: stream-error",
    ]);
});

const finder: RecordingTarget = { kind: "app", app: "4242", name: "Finder" };
const display: RecordingTarget = { kind: "display", screenIndex: 0, name: "Built-in" };
const editor: RecordingTarget = { kind: "window", windowIds: [77], app: "Editor", title: "notes.txt" };

interface FakeRun {
    target: RecordingTarget;
    /** The frame rates and threshold the session gave this run. */
    rates?: MovieRates;
    output: string;
    maxSeconds: number;
    signal: AbortSignal;
    /** Ends the run by itself, as the recorder's deadline or a failure would. */
    end: (result: SegmentResult, writeMovie?: boolean) => Promise<void>;
    /** The first frame arrives (runs arm at once unless the fake was made with `armLater`), when the recorder said. */
    arm: (start?: { firstFrameAt: number }) => void;
}

/**
 * A recorder that writes a small file per run and finishes it when the session aborts the run. A run aborted before
 * it armed writes no movie, as the real recorder cancelled while arming does.
 */
function fakeRecorder(
    options: {
        failFirst?: boolean;
        armLater?: boolean;
        prepares?: boolean;
        /** What each run reports when a stop or pause ends it (ax-tool's capturedFrames). */
        frames?: { frames: number };
        /** The length of each run's movie, as ax-tool reports it on a stop or pause. */
        movieMs?: number;
    } = {}
) {
    const runs: FakeRun[] = [];
    const recorder: SegmentRecorder = {
        record({ target, rates, output, maxSeconds, signal, onRecording, onPreparing }) {
            if (options.prepares) {
                onPreparing?.();
            }

            return new Promise<SegmentResult>((resolve) => {
                const index = runs.length;
                let armed = false;
                const end = async (result: SegmentResult, writeMovie = true) => {
                    if (writeMovie) {
                        await writeFile(output, `movie ${index} ${kindOf(target)}`);
                    }

                    resolve(result);
                };
                const arm = (start?: { firstFrameAt: number }) => {
                    armed = true;
                    onRecording(start);
                };
                runs.push({ target, rates, output, maxSeconds, signal, end, arm });
                if (options.failFirst && index === 0) {
                    void end({ ok: false, endedBy: "failure", error: "[screen-recording-denied] no grant" }, false);
                    return;
                }

                signal.addEventListener(
                    "abort",
                    () =>
                        void (armed
                            ? end({
                                  ok: true,
                                  endedBy: "stop",
                                  durationMs: 1000,
                                  ...options.frames,
                                  ...(options.movieMs === undefined ? {} : { movieMs: options.movieMs }),
                              })
                            : end({ ok: false, endedBy: "stop", error: "cancelled while arming" }, false)),
                    { once: true }
                );
                if (!options.armLater) {
                    arm();
                }
            });
        },
    };
    return { recorder, runs };
}

function kindOf(target: RecordingTarget): string {
    return target.kind;
}

describe("RecordingSession", () => {
    let root: string;
    let clock: number;
    let events: RecordingSessionEvent[];
    let joined: FinishedSegment[][];

    beforeEach(async () => {
        root = join(tmpdir(), `recording-session-${randomUUID()}`);
        await mkdir(root, { recursive: true });
        clock = 1_000_000;
        events = [];
        joined = [];
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    function session(
        recorder: SegmentRecorder,
        extra: {
            maxSeconds?: number;
            segmentSeconds?: number;
            slowStartMs?: number;
            join?: ConstructorParameters<typeof RecordingSession>[0]["join"];
            /** Measures the one-segment movie; by default it answers the fake recorder's 1000 ms. */
            measure?: ConstructorParameters<typeof RecordingSession>[0]["measure"];
            /** Sees every event after the test's own list does. */
            emit?: (event: RecordingSessionEvent) => void;
        } = {}
    ) {
        const { emit, ...rest } = extra;
        return new RecordingSession({
            target: finder,
            directory: join(root, "segments"),
            output: join(root, "out.mp4"),
            recorder,
            join: async ({ segments, output }) => {
                joined.push(segments);
                await writeFile(output, segments.map((segment) => segment.path).join("\n"));
                return { durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0) };
            },
            measure: async () => 1000,
            emit: (event) => {
                events.push(event);
                emit?.(event);
            },
            now: () => clock,
            tickMs: 0,
            slowStartMs: 0,
            ...rest,
        });
    }

    /** The state changes past `starting`, which every run passes through while it arms. */
    const states = () =>
        events.flatMap((event) =>
            event.event === "state" && event.state !== "starting"
                ? [`${event.state}:${event.reason}:${event.target.kind}`]
                : []
        );

    it("arming is not recording: no time counts until the first frame, and a pause then keeps nothing", async () => {
        const { recorder, runs } = fakeRecorder({ armLater: true });
        const recording = session(recorder);
        await recording.start();
        expect(events.at(-1)).toMatchObject({ event: "state", state: "starting", elapsedMs: 0 });
        clock += 2500;
        expect(recording.elapsedMs()).toBe(0);
        runs[0].arm();
        expect(events.at(-1)).toMatchObject({ event: "state", state: "recording", reason: "user" });
        clock += 1000;
        expect(recording.elapsedMs()).toBe(1000);
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        clock += 3000;
        await recording.command({ cmd: "pause" });
        expect(existsSync(runs[1].output)).toBe(false);
        expect(recording.elapsedMs()).toBe(1000);
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(joined).toHaveLength(0);
        expect(events.find((event) => event.event === "done")).toMatchObject({ segments: 1 });
    });

    it("as a RecorderControl over the socket: pause, a refused second pause, a display switch, stop as a join job", async () => {
        const { recorder, runs } = fakeRecorder();
        let control: SessionRecorderControl | undefined;
        const recording = new RecordingSession({
            target: finder,
            directory: join(root, "segments"),
            output: join(root, "out.mp4"),
            recorder,
            join: async ({ segments, output }) => {
                joined.push(segments);
                await writeFile(output, "joined");
                return { durationMs: 1000 };
            },
            measure: async () => 1000,
            emit: (event) => {
                events.push(event);
                control?.observe(event);
            },
            now: () => clock,
            tickMs: 0,
            slowStartMs: 0,
        });
        const progress: string[] = [];
        control = new SessionRecorderControl(recording, {
            target: finder,
            onProgress: (event) => progress.push(`${event.step} ${event.done}/${event.total}`),
            screens: async () => ({
                ok: true,
                screens: [
                    {
                        displayID: 7,
                        index: 0,
                        isPrimary: true,
                        name: "Built-in",
                        position: { x: 0, y: 0 },
                        resolution: { width: 1512, height: 982 },
                        scaleFactor: 2,
                    },
                ],
            }),
        });
        const dir = join(root, "live");
        const server = new LiveRecordingServer({
            id: "session-test",
            kind: control.kind,
            title: "Finder",
            control,
            dir,
        });
        await recording.start();
        const client = await RecorderClient.connect("session-test", { dir });

        expect(client.methods).toContain("target.switch");
        expect(await client.pause()).toEqual({ state: "paused" });
        await expect(client.pause()).rejects.toMatchObject({ code: RPC_ERRORS.alreadyPaused });
        expect(await client.resume()).toEqual({ state: "recording" });
        expect(await client.switchDisplay(7)).toMatchObject({ chosen: [7], applied: "restart" });
        await expect(client.switchDisplay(9)).rejects.toMatchObject({ code: RPC_ERRORS.unknownDisplay });
        expect(runs.at(-1)?.target).toMatchObject({ kind: "display", screenIndex: 0 });

        const stopped = await client.stop();
        client.close();
        server.close();

        expect(stopped).toMatchObject({ state: "stopped", outcome: "done", job: expect.stringMatching(/^join-/) });
        expect(progress).toContain("join 1/1");
        expect(joined).toHaveLength(1);
    });

    it("pause, resume, switch and stop join every segment in order, each with its own target", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder);
        await recording.start();
        clock += 4000;
        await recording.command({ cmd: "pause" });
        clock += 60_000;
        await recording.command({ cmd: "resume" });
        clock += 3000;
        await recording.command({ cmd: "switch", target: display });
        clock += 2000;
        await recording.command({ cmd: "stop" });

        expect(await recording.finished).toBe("done");
        expect(runs.map((run) => run.target.kind)).toEqual(["app", "app", "display"]);
        expect(states()).toEqual([
            "recording:user:app",
            "paused:user:app",
            "recording:user:app",
            "recording:user:display",
            "finishing:user:display",
        ]);
        expect(joined).toHaveLength(1);
        expect(joined[0].map((segment) => segment.index)).toEqual([1, 2, 3]);
        expect(joined[0].map((segment) => segment.target.kind)).toEqual(["app", "app", "display"]);
        const done = events.find((event) => event.event === "done");
        expect(done).toEqual({ event: "done", path: join(root, "out.mp4"), durationMs: 3000, segments: 3 });
        expect(existsSync(join(root, "segments"))).toBe(false);
        // The paused minute is not recording time.
        const finishing = events.findLast((event) => event.event === "state");
        expect(finishing?.event === "state" && finishing.elapsedMs).toBe(9000);
    });

    // 2026-11-08: markers sat about 1.35 s before what they marked. The session heard of the first frame only once the
    // recorder had written its PNG, and counted the movie from then; the movie starts at the frame itself.
    it("a mark is at its movie time: from the first frame the recorder reports, across a pause, and 0 before it", async () => {
        const { recorder, runs } = fakeRecorder({ armLater: true, movieMs: 2500 });
        let control: SessionRecorderControl | undefined;
        const recording = session(recorder, { emit: (event) => control?.observe(event) });
        control = new SessionRecorderControl(recording, { target: finder });
        await recording.start();

        clock = 1_000_300;
        const early = control.addMarker("before the first frame");
        clock = 1_001_500;
        const between = control.addMarker("after the frame, before the session heard of it");
        clock = 1_002_150;
        runs[0].arm({ firstFrameAt: 1_000_800 });
        expect(await early).toEqual({ atMs: 0, label: "before the first frame" });
        expect((await between).atMs).toBe(700);
        clock = 1_003_150;
        expect((await control.addMarker("bell")).atMs).toBe(2350);

        // After a pause the next piece starts where the first piece's movie ends (2.5 s), at its own first frame.
        clock = 1_003_300;
        await recording.command({ cmd: "pause" });
        clock = 1_060_000;
        await recording.command({ cmd: "resume" });
        clock = 1_060_400;
        runs[1].arm({ firstFrameAt: 1_060_100 });
        clock = 1_061_100;
        expect((await control.addMarker("after the pause")).atMs).toBe(3500);

        // A recorder that names no first frame starts the movie when the session hears of it, as before.
        clock = 1_062_000;
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        runs[2].arm();
        clock = 1_062_400;
        expect((await control.addMarker("no first frame named")).atMs).toBe(5400);
    });

    // 2026-11-09: the camera bubble lagged the voice by 0.5 to 2 s and more after each pause or rollover. The camera
    // runs on the wall clock, so it is cut to these spans after the recording (camera.ts alignCameraMovie).
    it("each kept segment is a span from its own first frame, after a resume and from 0 again after a restart", async () => {
        const { recorder, runs } = fakeRecorder({ armLater: true, movieMs: 2500 });
        const recording = session(recorder);
        await recording.start();
        clock = 1_001_400;
        runs[0].arm({ firstFrameAt: 1_000_800 });
        clock = 1_003_300;
        await recording.command({ cmd: "pause" });
        clock = 1_060_000;
        await recording.command({ cmd: "resume" });
        clock = 1_060_900;
        runs[1].arm({ firstFrameAt: 1_060_550 });
        clock = 1_063_000;
        await recording.command({ cmd: "pause" });
        expect(recording.movieSpans()).toEqual([
            { sourceStartMs: 0, firstFrameEpochMs: 1_000_800, lengthMs: 2500 },
            { sourceStartMs: 2500, firstFrameEpochMs: 1_060_550, lengthMs: 2500 },
        ]);

        await recording.command({ cmd: "restart" });
        clock = 1_070_700;
        runs[2].arm({ firstFrameAt: 1_070_200 });
        clock = 1_072_000;
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(recording.movieSpans()).toEqual([{ sourceStartMs: 0, firstFrameEpochMs: 1_070_200, lengthMs: 2500 }]);
    });

    it("one segment is moved into place without a join", async () => {
        const { recorder } = fakeRecorder();
        const recording = session(recorder);
        await recording.start();
        clock += 1500;
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(joined).toHaveLength(0);
        expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("movie 0 app");
    });

    it("restart drops every earlier segment and the clock", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder);
        await recording.start();
        clock += 5000;
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        clock += 5000;
        await recording.command({ cmd: "restart" });
        expect(existsSync(runs[0].output)).toBe(false);
        expect(existsSync(runs[1].output)).toBe(false);
        expect(recording.elapsedMs()).toBe(0);
        clock += 2000;
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        clock += 1000;
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(joined[0].map((segment) => segment.index)).toEqual([3, 4]);
    });

    it("a save that fails pauses the session, so a stop tries again and a discard still works", async () => {
        const { recorder, runs } = fakeRecorder();
        let attempts = 0;
        const recording = session(recorder, {
            join: async ({ segments, output }) => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("ffmpeg is missing");
                }

                await writeFile(output, segments.map((segment) => segment.path).join("\n"));
                return { durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0) };
            },
        });
        await recording.start();
        clock += 2000;
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        clock += 1000;
        await recording.command({ cmd: "stop" });

        expect(states().slice(-2)).toEqual(["finishing:user:app", "paused:recorder:app"]);
        expect(events.at(-1)).toEqual({
            event: "error",
            message: "The recording could not be saved: ffmpeg is missing",
            fatal: false,
        });
        expect(runs.every((run) => existsSync(run.output))).toBe(true);

        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(attempts).toBe(2);
        expect(existsSync(join(root, "out.mp4"))).toBe(true);
    });

    it("a join that fails after it began writing leaves no partial movie at the output", async () => {
        const { recorder } = fakeRecorder();
        const recording = session(recorder, {
            join: async ({ output }) => {
                await writeFile(output, "half a movie");
                throw new Error("ffmpeg died");
            },
        });
        await recording.start();
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        await recording.command({ cmd: "stop" });

        expect(existsSync(join(root, "out.mp4"))).toBe(false);
        await recording.command({ cmd: "discard" });
        expect(await recording.finished).toBe("discarded");
    });

    it("keeps its segment folder private, also when the folder already exists with wider permissions", async () => {
        for (const existing of [false, true]) {
            const directory = join(root, existing ? "existing" : "new");
            if (existing) {
                await mkdir(directory, { mode: 0o755 });
            }

            const { recorder } = fakeRecorder();
            const recording = new RecordingSession({
                target: finder,
                directory,
                output: join(root, "private.mp4"),
                recorder,
                join: async () => ({ durationMs: 0 }),
                measure: async () => 1000,
                emit: () => {},
                now: () => clock,
                tickMs: 0,
                slowStartMs: 0,
            });
            await recording.start();

            expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
            await recording.command({ cmd: "discard" });
            expect(await recording.finished).toBe("discarded");
        }
    });

    it("a failed join keeps a movie already at the output and leaves no temporary file", async () => {
        const { recorder } = fakeRecorder();
        await writeFile(join(root, "out.mp4"), "previous movie");
        const recording = session(recorder, {
            join: async ({ output }) => {
                await writeFile(output, "half a movie");
                throw new Error("ffmpeg died");
            },
        });
        await recording.start();
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        await recording.command({ cmd: "stop" });

        expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("previous movie");
        expect((await fs.readdir(root)).filter((name) => name.startsWith(".recording-"))).toEqual([]);
        await recording.command({ cmd: "discard" });
        expect(await recording.finished).toBe("discarded");
    });

    it("a session whose folder cannot be made ends as failed instead of waiting forever", async () => {
        const blocker = join(root, "blocker");
        await writeFile(blocker, "a file where the folder should go");
        const { recorder, runs } = fakeRecorder();
        const recording = new RecordingSession({
            target: finder,
            directory: join(blocker, "segments"),
            output: join(root, "out.mp4"),
            recorder,
            join: async () => ({ durationMs: 0 }),
            measure: async () => 1000,
            emit: (event) => events.push(event),
            tickMs: 0,
            slowStartMs: 0,
        });
        await recording.start();

        expect(await recording.finished).toBe("failed");
        expect(runs).toHaveLength(0);
        expect(events.some((event) => event.event === "error" && event.fatal === true)).toBe(true);
    });

    it("a single segment on another volume is copied next to the output and renamed there", async () => {
        const { recorder } = fakeRecorder();
        const recording = session(recorder);
        const originalRename = fs.rename;
        const moves: string[] = [];
        const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
            moves.push(String(source));
            if (String(source).includes("segments")) {
                throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
            }

            return originalRename(source, destination);
        });
        try {
            await recording.start();
            await recording.command({ cmd: "stop" });
            expect(events.at(-1)).toMatchObject({ event: "done", segments: 1 });
            expect(await recording.finished).toBe("done");
            expect(moves).toHaveLength(2);
            expect(moves[1]).toStartWith(join(root, ".recording-"));
            expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("movie 0 app");
            expect(existsSync(join(root, "segments"))).toBe(false);
        } finally {
            renameSpy.mockRestore();
        }
    });

    it("a folder that will not go after the save still ends the session as done", async () => {
        const { recorder } = fakeRecorder();
        const recording = session(recorder);
        const cleanup = spyOn(fs, "rm").mockRejectedValue(new Error("cleanup denied"));
        try {
            await recording.start();
            await recording.command({ cmd: "stop" });
            expect(events.at(-1)).toMatchObject({ event: "done" });
            expect(await recording.finished).toBe("done");
            expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("movie 0 app");
        } finally {
            cleanup.mockRestore();
        }
    });

    it("a failed cross-volume copy keeps the segment and the old output for a retry", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder);
        await writeFile(join(root, "out.mp4"), "previous movie");
        const move = spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
        const copy = spyOn(fs, "copyFile").mockImplementation(async (_source, destination) => {
            await writeFile(destination, "partial movie");
            throw new Error("disk full");
        });
        try {
            await recording.start();
            await recording.command({ cmd: "stop" });
            expect(events.findLast((event) => event.event === "state")).toMatchObject({ state: "paused" });
            expect(existsSync(runs[0].output)).toBe(true);
            expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("previous movie");
            expect((await fs.readdir(root)).filter((name) => name.startsWith(".recording-"))).toEqual([]);
        } finally {
            move.mockRestore();
            copy.mockRestore();
        }

        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("movie 0 app");
    });

    it("commands arriving together validate state in arrival order", async () => {
        const { recorder } = fakeRecorder();
        let control: SessionRecorderControl | undefined;
        const recording = new RecordingSession({
            target: finder,
            directory: join(root, "segments"),
            output: join(root, "out.mp4"),
            recorder,
            join: async () => ({ durationMs: 0 }),
            measure: async () => 1000,
            emit: (event) => control?.observe(event),
            now: () => clock,
            tickMs: 0,
            slowStartMs: 0,
        });
        control = new SessionRecorderControl(recording, { target: finder });

        try {
            await recording.start();
            await Promise.all([
                applyRecordingCommand(control, { cmd: "pause" }),
                applyRecordingCommand(control, { cmd: "resume" }),
            ]);
            expect((await control.status()).state).toBe("recording");
        } finally {
            await recording.command({ cmd: "discard" });
        }
    });

    it("control stop rejects a failed save and permits a retry", async () => {
        const { recorder } = fakeRecorder();
        let control: SessionRecorderControl | undefined;
        let attempts = 0;
        const recording = new RecordingSession({
            target: finder,
            directory: join(root, "segments"),
            output: join(root, "out.mp4"),
            recorder,
            join: async ({ output }) => {
                attempts += 1;

                if (attempts === 1) {
                    throw new Error("disk full");
                }

                await writeFile(output, "joined");
                return { durationMs: 1000 };
            },
            measure: async () => 1000,
            emit: (event) => control?.observe(event),
            now: () => clock,
            tickMs: 0,
            slowStartMs: 0,
        });
        control = new SessionRecorderControl(recording, { target: finder });

        try {
            await recording.start();
            await control.pause();
            await control.resume();
            await expect(
                Promise.race([
                    control.stop(),
                    Bun.sleep(300).then(() => {
                        throw new Error("stop hung");
                    }),
                ])
            ).rejects.toThrow("disk full");
            expect(await control.stop()).toMatchObject({ state: "stopped", outcome: "done" });
            expect(attempts).toBe(2);
        } finally {
            await recording.command({ cmd: "discard" });
        }
    });

    it("a discard after a failed save deletes every segment", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder, {
            join: async () => {
                throw new Error("disk full");
            },
        });
        await recording.start();
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        await recording.command({ cmd: "stop" });
        await recording.command({ cmd: "discard" });

        expect(await recording.finished).toBe("discarded");
        expect(runs.every((run) => !existsSync(run.output))).toBe(true);
        expect(existsSync(join(root, "segments"))).toBe(false);
    });

    it("discard deletes every segment and writes no movie", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder);
        await recording.start();
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "switch", target: editor });
        await recording.command({ cmd: "discard" });
        expect(await recording.finished).toBe("discarded");
        expect(events.at(-1)).toEqual({ event: "discarded" });
        expect(runs.every((run) => !existsSync(run.output))).toBe(true);
        expect(existsSync(join(root, "out.mp4"))).toBe(false);
        expect(existsSync(join(root, "segments"))).toBe(false);
    });

    it("a run that reaches its deadline is followed by the next, and the limit pauses the session", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder, { maxSeconds: 5, segmentSeconds: 3 });
        await recording.start();
        expect(runs[0].maxSeconds).toBe(3);
        clock += 3000;
        await runs[0].end({ ok: true, endedBy: "deadline", durationMs: 3000 });
        await Bun.sleep(0);
        await recording.command({ cmd: "resume" });
        expect(runs).toHaveLength(2);
        expect(runs[1].target).toEqual(finder);
        expect(runs[1].maxSeconds).toBe(2);
        clock += 2000;
        await runs[1].end({ ok: true, endedBy: "deadline", durationMs: 2000 });
        await Bun.sleep(0);
        await recording.command({ cmd: "resume" });
        expect(runs).toHaveLength(2);
        expect(states()).toEqual([
            "recording:user:app",
            "recording:recorder:app",
            "paused:limit:app",
            "paused:limit:app",
        ]);
        const refusal = events.findLast((event) => event.event === "error");
        expect(refusal).toMatchObject({ code: "limit", fatal: false });
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(joined[0].map((segment) => segment.durationMs)).toEqual([3000, 2000]);
    });

    it("the limit counts the movie each run made, and leaves out a refill shorter than a second", async () => {
        // The recorder's own deadline runs from its launch, so its movie is longer than the session's wall time.
        const longer = fakeRecorder();
        const recording = session(longer.recorder, { maxSeconds: 10 });
        await recording.start();
        clock += 9800;
        await longer.runs[0].end({ ok: true, endedBy: "deadline", durationMs: 10_059 });
        await Bun.sleep(0);
        expect(longer.runs).toHaveLength(1);
        expect(states()).toEqual(["recording:user:app", "paused:limit:app"]);

        events = [];
        const shorter = fakeRecorder();
        const second = session(shorter.recorder, { maxSeconds: 10 });
        await second.start();
        clock += 9300;
        await shorter.runs[0].end({ ok: true, endedBy: "deadline", durationMs: 9300 });
        await Bun.sleep(0);
        expect(shorter.runs).toHaveLength(1);
        expect(states()).toEqual(["recording:user:app", "paused:limit:app"]);
    });

    it("the done event says how many frames the movie holds and its average rate", async () => {
        // The defect: a 60 fps movie that got 42 fps said nothing of it (review 2026-11-06).
        const { recorder } = fakeRecorder({ frames: { frames: 50 } });
        const recording = session(recorder, { maxSeconds: 60 });
        await recording.start();
        clock += 1000;
        await recording.command({ cmd: "pause" });
        await recording.command({ cmd: "resume" });
        clock += 1000;
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        // Two runs of 1000 ms with 50 frames each: 100 frames over 2 s.
        expect(events.find((event) => event.event === "done")).toMatchObject({ frames: 100, averageFps: 50 });
    });

    describe("a saved movie's length is measured the same way for one segment and several", () => {
        // The defect: one segment kept ax-tool's wall time, which also counts the wait for the first frame and the
        // stop, while a join probed the file, so recording.json's durationMs and averageFps disagreed with the movie.
        it("a one-segment movie's durationMs is the saved movie's measured length, like a joined one's", async () => {
            const measured: string[] = [];
            const { recorder } = fakeRecorder({ frames: { frames: 30 }, movieMs: 990 });
            const recording = session(recorder, {
                measure: async (path) => {
                    measured.push(path);
                    return 970;
                },
            });
            await recording.start();
            await recording.command({ cmd: "stop" });
            expect(await recording.finished).toBe("done");
            expect(measured).toEqual([join(root, "out.mp4")]);
            // 30 frames over the measured 0.97 s, not over the 1 s of wall time the recorder reported.
            expect(events.find((event) => event.event === "done")).toMatchObject({
                durationMs: 970,
                frames: 30,
                averageFps: 30.9,
            });
        });

        it("a joined movie keeps the joiner's length and is not measured again", async () => {
            const measured: string[] = [];
            const { recorder } = fakeRecorder();
            const recording = session(recorder, {
                measure: async (path) => {
                    measured.push(path);
                    return 1;
                },
            });
            await recording.start();
            await recording.command({ cmd: "pause" });
            await recording.command({ cmd: "resume" });
            await recording.command({ cmd: "stop" });
            expect(await recording.finished).toBe("done");
            expect(joined).toHaveLength(1);
            expect(measured).toEqual([]);
            expect(events.find((event) => event.event === "done")).toMatchObject({ durationMs: 2000, segments: 2 });
        });

        it("a one-segment movie the probe cannot read still saves, with the recorder's movie length", async () => {
            const { recorder } = fakeRecorder({ movieMs: 990 });
            const recording = session(recorder, {
                measure: async () => {
                    throw new Error("not a movie ffprobe can read");
                },
            });
            await recording.start();
            await recording.command({ cmd: "stop" });
            expect(await recording.finished).toBe("done");
            expect(events.find((event) => event.event === "done")).toMatchObject({ durationMs: 990, segments: 1 });
        });
    });

    it("a first run that fails without a movie ends the session with the refusal code", async () => {
        const { recorder } = fakeRecorder({ failFirst: true });
        const recording = session(recorder);
        await recording.start();
        expect(await recording.finished).toBe("failed");
        expect(events.at(-1)).toMatchObject({ event: "error", fatal: true });
        expect(events.at(-1)?.event === "error" && events.at(-1)).toMatchObject({
            message: expect.stringContaining("[screen-recording-denied]"),
        });
        await recording.command({ cmd: "stop" });
        expect(events.filter((event) => event.event === "state" && event.state === "finishing")).toHaveLength(0);
    });

    it("a later run that fails pauses the session and keeps what was recorded", async () => {
        const { recorder, runs } = fakeRecorder();
        const recording = session(recorder);
        await recording.start();
        clock += 2000;
        await recording.command({ cmd: "switch", target: editor });
        await runs[1].end({ ok: false, endedBy: "failure", error: "window 77 is not visible" }, false);
        await Bun.sleep(0);
        await recording.command({ cmd: "pause" });
        expect(states().at(-1)).toBe("paused:recorder:window");
        expect(events.findLast((event) => event.event === "error")).toMatchObject({
            message: "window 77 is not visible",
            fatal: false,
        });
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("done");
        expect(await readFile(join(root, "out.mp4"), "utf8")).toBe("movie 0 app");
    });
    it("a stop before the first frame keeps no movie, even when the recorder left an empty file", async () => {
        const recorder: SegmentRecorder = {
            record: ({ output, signal }) =>
                new Promise<SegmentResult>((resolve) => {
                    signal.addEventListener(
                        "abort",
                        () => void writeFile(output, "").then(() => resolve({ ok: true, endedBy: "stop" })),
                        { once: true }
                    );
                }),
        };
        const recording = session(recorder);
        await recording.start();
        await recording.command({ cmd: "stop" });
        expect(await recording.finished).toBe("failed");
        expect(events.some((event) => event.event === "done")).toBe(false);
        expect(events.at(-1)).toMatchObject({ event: "error", fatal: true });
        expect(existsSync(join(root, "out.mp4"))).toBe(false);
    });

    it("says it still waits for the first frame when no compile explains a slow start", async () => {
        const { recorder } = fakeRecorder({ armLater: true });
        const recording = session(recorder, { slowStartMs: 20 });
        await recording.start();
        await Bun.sleep(60);
        expect(events.filter((event) => event.event === "preparing")).toEqual([
            { event: "preparing", message: FIRST_FRAME_MESSAGE },
        ]);
        await recording.command({ cmd: "discard" });

        const prepared = fakeRecorder({ armLater: true, prepares: true });
        events = [];
        const compiling = session(prepared.recorder, { slowStartMs: 20 });
        await compiling.start();
        await Bun.sleep(60);
        expect(events.filter((event) => event.event === "preparing").map((event) => event.message)).toEqual([
            PREPARING_MESSAGE,
        ]);
        await compiling.command({ cmd: "discard" });
    });

    it("says why a start is slow, and a discard while the recorder prepares ends the session at once", async () => {
        const { recorder } = fakeRecorder({ prepares: true, armLater: true });
        const recording = session(recorder);
        await recording.start();
        expect(events.filter((event) => event.event === "preparing")).toEqual([
            { event: "preparing", message: PREPARING_MESSAGE },
        ]);

        await recording.command({ cmd: "discard" });
        expect(await recording.finished).toBe("discarded");
        expect(existsSync(join(root, "out.mp4"))).toBe(false);
    });
});

describe("nativeSegmentRecorder", () => {
    let root: string;

    beforeEach(async () => {
        root = join(tmpdir(), `recording-native-${randomUUID()}`);
        await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
        mock.restore();
        await rm(root, { recursive: true, force: true });
    });

    /** One recorder run that a stop ends; `failed` is what the recorder reported when it exited. */
    async function stoppedRun(failed: boolean) {
        const output = join(root, "segment.mp4");
        spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(async ({ signal, onRecording }) => {
            await writeFile(output, "movie");
            onRecording?.({ sessionDir: join(root, "session") });
            if (!signal.aborted) {
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            }

            const sessionDir = join(root, "session");
            await mkdir(sessionDir, { recursive: true });
            return {
                ...({} as Awaited<ReturnType<typeof captureRunner.runCapturePlanWithSignal>>),
                captureFailed: failed,
                sessionDir,
                warnings: failed ? ["video writer did not finish within 10s"] : [],
                capture: { error: failed ? "video writer ended without completing" : undefined },
            };
        });
        const probe = spyOn(videoProbe, "probeVideo").mockImplementation(async () => {
            throw new Error("no finished container");
        });
        const controller = new AbortController();
        const run = nativeSegmentRecorder().record({
            target: display,
            output,
            maxSeconds: 3,
            signal: controller.signal,
            onRecording: () => controller.abort(),
        });
        return { result: await run, output, probes: probe.mock.calls.length };
    }

    it("a run records with the session's rates, and passes no idle rate when it equals the active one", async () => {
        const plans: Array<{ activeFps?: number; idleFps?: number; threshold?: number }> = [];
        spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(async ({ plan }) => {
            plans.push({
                activeFps: plan.capture.activeFps,
                idleFps: plan.capture.idleFps,
                threshold: plan.capture.threshold,
            });
            return {
                ...({} as Awaited<ReturnType<typeof captureRunner.runCapturePlanWithSignal>>),
                captureFailed: true,
                warnings: [],
                capture: null,
            };
        });
        const recorder = nativeSegmentRecorder({ fps: 60, idleFps: 2, threshold: 0.5 });
        const run = (rates: MovieRates) =>
            recorder.record({
                target: display,
                rates,
                output: join(root, "segment.mp4"),
                maxSeconds: 3,
                signal: new AbortController().signal,
                onRecording: () => undefined,
            });

        await run({ activeFps: 30, idleFps: 1, threshold: 2 });
        await run({ activeFps: 30, idleFps: 30, threshold: 2 });

        expect(plans).toEqual([
            { activeFps: 30, idleFps: 1, threshold: 2 },
            { activeFps: 30, idleFps: undefined, threshold: 2 },
        ]);
    });

    it("a run tells the session when ax-tool captured its first frame, and how long its movie is", async () => {
        const sessionDir = join(root, "session");
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "movie-start.json"), '{"firstFrameEpochMs": 1700000000123.4}\n');
        spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(async ({ onRecording }) => {
            onRecording?.({ sessionDir });
            return {
                ...({} as Awaited<ReturnType<typeof captureRunner.runCapturePlanWithSignal>>),
                captureFailed: false,
                sessionDir,
                warnings: [],
                capture: { data: { stats: { durationMs: 2600, capturedFrames: 75, movieMs: 2480 } } },
            };
        });
        const starts: unknown[] = [];
        const record = (onRecording: (start?: { firstFrameAt: number }) => void) =>
            nativeSegmentRecorder().record({
                target: display,
                output: join(root, "segment.mp4"),
                maxSeconds: 3,
                signal: new AbortController().signal,
                onRecording,
            });

        const result = await record((start) => starts.push(start));
        expect(starts).toEqual([{ firstFrameAt: 1_700_000_000_123.4 }]);
        expect(result).toMatchObject({ durationMs: 2600, movieMs: 2480, frames: 75 });

        // A recorder that wrote no first-frame time (an older ax-tool) leaves the session to its own clock.
        await mkdir(sessionDir, { recursive: true });
        await record((start) => starts.push(start));
        expect(starts).toEqual([{ firstFrameAt: 1_700_000_000_123.4 }, undefined]);
    });

    it("a stop on a recorder that failed probes its movie and drops an unfinished one", async () => {
        const { result, output, probes } = await stoppedRun(true);
        expect(probes).toBe(1);
        expect(result.ok).toBe(false);
        expect(result.endedBy).toBe("stop");
        expect(result.error).toBe("video writer ended without completing");
        expect(existsSync(output)).toBe(false);
    });

    it("a clean stop keeps its movie without a probe", async () => {
        const { result, output, probes } = await stoppedRun(false);
        expect(probes).toBe(0);
        expect(result).toEqual({ ok: true, endedBy: "stop", durationMs: undefined });
        expect(existsSync(output)).toBe(true);
    });
});

describe("joining segments with their audio and cursor tracks", () => {
    it("copies same-shape segments with every stream and quotes paths for the concat list", () => {
        const argv = concatCopyArgv({ list: "/s/list.txt", output: "/o.mp4" });
        expect(argv.slice(argv.indexOf("-f"), argv.indexOf("-f") + 6)).toEqual([
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "/s/list.txt",
        ]);
        expect(argv).toContain("copy");
        expect(argv[argv.indexOf("-map") + 1]).toBe("0");
        expect(concatListLine("/a/it's.mp4")).toBe("file '/a/it'\\''s.mp4'");
    });

    it("keeps the audio when it re-encodes segments of different sizes", () => {
        const argv = joinSegmentsArgv({
            inputs: [
                { path: "/a.mp4", width: 1280, height: 720 },
                { path: "/b.mp4", width: 1920, height: 1080 },
            ],
            width: 1280,
            height: 720,
            output: "/o.mp4",
            audio: true,
        });
        const graph = argv[argv.indexOf("-filter_complex") + 1];
        expect(graph).toContain("[0:a:0]aresample=async=1:first_pts=0[a0_0]");
        expect(graph).toEndWith("[v0][a0_0][v1][a1_0]concat=n=2:v=1:a=1[out][aout0]");
        expect(argv).toContain("[aout0]");
        expect(argv[argv.indexOf("-c:a") + 1]).toBe("aac");
    });

    it("names each audio track as its source, in the order --audio gave them", () => {
        // The defect: both tracks read "Core Media Audio", so a player showed Track 1 and Track 2 (review 2026-11-06).
        const titles = audioTrackTitles(["mic", "system"]);
        expect(titles).toEqual(["Microphone", "System audio"]);
        const copied = concatCopyArgv({ list: "/s/list.txt", output: "/o.mp4", audioTitles: titles });
        expect(copied.slice(copied.indexOf("-metadata:s:a:0"), copied.indexOf("-metadata:s:a:0") + 4)).toEqual([
            "-metadata:s:a:0",
            "title=Microphone",
            "-metadata:s:a:0",
            "handler_name=Microphone",
        ]);
        expect(copied).toContain("title=System audio");
        expect(copied.at(-1)).toBe("/o.mp4");
        const joined = joinSegmentsArgv({
            inputs: [
                { path: "/a.mp4", width: 1280, height: 720 },
                { path: "/b.mp4", width: 1920, height: 1080 },
            ],
            width: 1280,
            height: 720,
            output: "/o.mp4",
            audioTracks: 2,
            audioTitles: titles,
        });
        expect(joined[joined.indexOf("-metadata:s:a:1") + 1]).toBe("title=System audio");
        expect(
            concatCopyArgv({ list: "/s/list.txt", output: "/o.mp4" }).some((arg) => arg.startsWith("-metadata"))
        ).toBe(false);
        // A movie of one segment is moved, not joined: its tracks get their titles by one stream copy.
        const single = audioTitlesArgv({ input: "/m/screen.mp4", output: "/m/screen.mp4.titled.mp4", titles });
        expect(single.slice(single.indexOf("-i"), single.indexOf("-i") + 6)).toEqual([
            "-i",
            "/m/screen.mp4",
            "-map",
            "0",
            "-c",
            "copy",
        ]);
        expect(single).toContain("title=Microphone");
        expect(single.at(-1)).toBe("/m/screen.mp4.titled.mp4");
    });

    it("moves each segment's cursor samples by the length of the segments before it", () => {
        const joined = joinCursorTracks([
            { text: '{"t":0.0,"x":0.1,"y":0.2}\n{"t":500.5,"x":0.3,"y":0.4,"click":"left"}\n', offsetMs: 0 },
            { text: 'not json\n{"t":10.0,"x":0.5,"y":0.6}\n', offsetMs: 2000 },
        ]);
        expect(joined.trim().split("\n")).toEqual([
            '{"t":0.0,"x":0.1,"y":0.2}',
            '{"t":500.5,"x":0.3,"y":0.4,"click":"left"}',
            '{"t":2010.0,"x":0.5,"y":0.6}',
        ]);
        expect(joinCursorTracks([])).toBe("");
    });
});

describe("a joined cursor track on the joined movie's clock", () => {
    let root: string;

    beforeEach(async () => {
        root = join(tmpdir(), `cursor-join-${randomUUID()}`);
        await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
        mock.restore();
        await rm(root, { recursive: true, force: true });
    });

    it("measures a saved movie by its probed length in whole milliseconds, as the joiner measures a join", async () => {
        const probe = spyOn(videoProbe, "probeVideo").mockImplementation(async () => ({
            ...({} as Awaited<ReturnType<typeof videoProbe.probeVideo>>),
            durationUs: 2_530_400,
        }));
        expect(await movieLengthMs(join(root, "out.mp4"))).toBe(2530);
        expect(probe).toHaveBeenCalledWith({ input: join(root, "out.mp4") });
    });

    it("starts each segment's cursor rows where the lengths of the segments before it end", () => {
        expect(cursorTrackOffsets([2530, 2513, 2530])).toEqual([0, 2530, 5043]);
        expect(cursorTrackOffsets([])).toEqual([]);
    });

    it("moves a segment's cursor rows by the probed lengths of the segments before it, not by their wall time", async () => {
        // A live run: ax-tool's wall durationMs was 2543 and 2545 ms, but concat stacked the files by their own
        // lengths, 2530 and 2513 ms, so segment 2's frames start at 2530 ms of the joined movie.
        const lengthsSec: Record<string, number | null> = { "a.mp4": 2.53, "b.mp4": 2.513 };
        spyOn(mediaFacts, "readMediaFacts").mockImplementation(async ({ input }) => ({
            path: input,
            bytes: 1,
            durationSec: lengthsSec[input.split("/").at(-1) ?? ""] ?? null,
            streams: [{ type: "video", codec: "h264", attachedPicture: false, width: 160, height: 100 }],
        }));
        spyOn(videoProcess, "runVideoCommand").mockImplementation(async () => "");
        spyOn(videoProbe, "probeVideo").mockImplementation(async () => ({
            ...({} as Awaited<ReturnType<typeof videoProbe.probeVideo>>),
            durationUs: 5_043_000,
        }));
        const segments: FinishedSegment[] = [
            { index: 0, path: join(root, "a.mp4"), durationMs: 2543, movieMs: 2543, target: display },
            { index: 1, path: join(root, "b.mp4"), durationMs: 2545, movieMs: 2561, target: display },
        ];
        await writeFile(cursorTrackPath(segments[0].path), '{"t":0.0,"x":0.1,"y":0.2}\n');
        await writeFile(cursorTrackPath(segments[1].path), '{"t":100.0,"x":0.5,"y":0.6,"click":"left"}\n');
        const output = join(root, "joined.mp4");

        await segmentJoiner()({ segments, output });

        expect((await readFile(cursorTrackPath(output), "utf8")).trim().split("\n")).toEqual([
            '{"t":0.0,"x":0.1,"y":0.2}',
            '{"t":2630.0,"x":0.5,"y":0.6,"click":"left"}',
        ]);
    });
});

function cursorRows(text: string): Array<Record<string, unknown>> {
    return text
        .trim()
        .split("\n")
        .map((line): Record<string, unknown> => SafeJSON.parse(line, { strict: true }));
}

describe("segments of another shape: the picture and the cursor rows share one placement", () => {
    let root: string;

    beforeEach(async () => {
        root = join(tmpdir(), `cursor-letterbox-${randomUUID()}`);
        await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
        mock.restore();
        await rm(root, { recursive: true, force: true });
    });

    it("places a 16:9 segment inside a 16:10 frame as ffmpeg's letterbox does, with even offsets", () => {
        expect(letterboxPlacement({ width: 1920, height: 1080, into: { w: 2880, h: 1800 } })).toEqual({
            x: 0,
            y: 90,
            w: 2880,
            h: 1620,
            into: { w: 2880, h: 1800 },
        });
        // The live join of 1920x1080 into 1440x900 put the picture's first row at 44 (yuv420p rounds 45 down).
        expect(letterboxPlacement({ width: 1920, height: 1080, into: { w: 1440, h: 900 } })).toMatchObject({
            x: 0,
            y: 44,
            w: 1440,
            h: 810,
        });
        expect(letterboxPlacement({ width: 1440, height: 900, into: { w: 1440, h: 900 } })).toMatchObject({
            x: 0,
            y: 0,
            w: 1440,
            h: 900,
        });
    });

    it("writes the same placement into the join filter", () => {
        const argv = joinSegmentsArgv({
            inputs: [
                { path: "/a.mp4", width: 2880, height: 1800 },
                { path: "/b.mp4", width: 1920, height: 1080 },
            ],
            width: 2880,
            height: 1800,
            output: "/o.mp4",
        });
        const graph = argv[argv.indexOf("-filter_complex") + 1];
        expect(graph).toContain("[0:v]scale=2880:1800,pad=2880:1800:0:0:color=black,");
        expect(graph).toContain("[1:v]scale=2880:1620,pad=2880:1800:0:90:color=black,");
    });

    it("moves a letterboxed segment's cursor rows into its picture and scales its point width", () => {
        const joined = joinCursorTracks([
            { text: '{"t":0.0,"x":0.50000,"y":0.50000,"pw":1920.0}\n', offsetMs: 0 },
            {
                text: '{"t":0.0,"x":0.00000,"y":0.00000,"pw":1440.0,"shape":"abc"}\n{"t":10.0,"x":1.00000,"y":0.50000,"click":"left"}\n',
                offsetMs: 2000,
                placement: { x: 160, y: 0, w: 1600, h: 1080, into: { w: 1920, h: 1080 } },
            },
        ]);
        const [first, corner, click] = cursorRows(joined);
        expect(first).toEqual({ t: 0, x: 0.5, y: 0.5, pw: 1920 });
        expect(corner.t).toBe(2000);
        expect(corner.x).toBeCloseTo(160 / 1920, 4);
        expect(corner.y).toBe(0);
        // 1600 joined pixels show 1440 points: videoWidth / pw must be 1600 / 1440.
        expect(corner.pw).toBeCloseTo((1440 * 1920) / 1600, 1);
        expect(corner.shape).toBe("abc");
        expect(click.x).toBeCloseTo(1760 / 1920, 4);
        expect(click.y).toBeCloseTo(0.5, 4);
        expect(click.click).toBe("left");
    });

    it("joins segments of different shapes with their rows inside the padded picture", async () => {
        const sizes: Record<string, [number, number]> = { "a.mp4": [1440, 900], "b.mp4": [1920, 1080] };
        const nameOf = (input: string) => input.split("/").at(-1) ?? "";
        spyOn(mediaFacts, "readMediaFacts").mockImplementation(async ({ input }) => ({
            path: input,
            bytes: 1,
            durationSec: 1,
            streams: [
                {
                    type: "video",
                    codec: "h264",
                    attachedPicture: false,
                    width: sizes[nameOf(input)]?.[0],
                    height: sizes[nameOf(input)]?.[1],
                },
            ],
        }));
        const commands: string[][] = [];
        spyOn(videoProcess, "runVideoCommand").mockImplementation(async ({ command }) => {
            commands.push(command);
            return "";
        });
        spyOn(videoProbe, "probeVideo").mockImplementation(async ({ input }) => {
            const [width, height] = sizes[nameOf(input)] ?? [1440, 900];
            return {
                ...({} as Awaited<ReturnType<typeof videoProbe.probeVideo>>),
                width,
                height,
                displayWidth: width,
                displayHeight: height,
                durationUs: 2_000_000,
            };
        });
        const segments: FinishedSegment[] = [
            { index: 0, path: join(root, "a.mp4"), durationMs: 1000, target: display },
            { index: 1, path: join(root, "b.mp4"), durationMs: 1000, target: display },
        ];
        await writeFile(cursorTrackPath(segments[0].path), '{"t":0.0,"x":0.50000,"y":0.50000,"pw":1440.0}\n');
        await writeFile(
            cursorTrackPath(segments[1].path),
            '{"t":0.0,"x":0.01000,"y":0.01000,"pw":1920.0}\n{"t":100.0,"x":0.01000,"y":1.00000,"click":"left"}\n'
        );
        const output = join(root, "joined.mp4");

        await segmentJoiner()({ segments, output });

        const graph = commands[0][commands[0].indexOf("-filter_complex") + 1];
        expect(graph).toContain("[1:v]scale=1440:810,pad=1440:900:0:44:color=black,");
        const [first, top, bottom] = cursorRows(await readFile(cursorTrackPath(output), "utf8"));
        expect(first).toEqual({ t: 0, x: 0.5, y: 0.5, pw: 1440 });
        expect(top.t).toBe(1000);
        expect(top.x).toBeCloseTo(0.01, 4);
        expect(top.y).toBeCloseTo((44 + 0.01 * 810) / 900, 4);
        expect(top.pw).toBeCloseTo((1920 * 1440) / 1440, 1);
        expect(bottom.y).toBeCloseTo((44 + 810) / 900, 4);
    });
});

describe("joinSegmentsArgv", () => {
    it("scales and pads every input to the first segment's even size and concatenates them", () => {
        const argv = joinSegmentsArgv({
            inputs: [
                { path: "/a.mp4", width: 1281, height: 721 },
                { path: "/b.mp4", width: 1440, height: 900 },
            ],
            width: 1281,
            height: 721,
            output: "/o.mp4",
        });
        expect(argv.slice(0, 6)).toEqual(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]);
        expect(argv).toContain("-nostdin");
        expect(argv.filter((value) => value === "-i")).toHaveLength(2);
        const graph = argv[argv.indexOf("-filter_complex") + 1];
        expect(graph).toBe(
            "[0:v]scale=1280:720,pad=1280:720:0:0:color=black,setsar=1,format=yuv420p,settb=AVTB[v0];" +
                "[1:v]scale=1152:720,pad=1280:720:64:0:color=black,setsar=1,format=yuv420p,settb=AVTB[v1];" +
                "[v0][v1]concat=n=2:v=1:a=0[out]"
        );
        expect(argv.slice(-9)).toEqual([
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "vfr",
            "-movflags",
            "+faststart",
            "/o.mp4",
        ]);
    });
});

describe("recording commands and targets", () => {
    it("reads one command per line and names a line it cannot use", () => {
        expect(parseRecordingCommand('{"cmd":"pause"}')).toEqual({ cmd: "pause" });
        expect(parseRecordingCommand('{"cmd":"switch","target":{"kind":"display","screenIndex":1}}')).toEqual({
            cmd: "switch",
            target: { kind: "display", screenIndex: 1 },
        });
        expect(parseRecordingCommand("pause")).toMatchObject({ error: expect.stringContaining("Not a JSON") });
        expect(parseRecordingCommand('{"cmd":"switch","target":{"kind":"window","windowIds":[]}}')).toMatchObject({
            error: expect.stringContaining("Unknown command"),
        });
    });

    it("lists windows without system chrome or slivers, groups apps and picks the frontmost app's window", () => {
        const raw = {
            ok: true,
            frontmostPid: 20,
            windows: [
                { pid: 1, app: "Dock", windowId: 5, bounds: { x: 0, y: 0, width: 1000, height: 80 } },
                { pid: 9, app: "Terminal", windowId: 6, title: "zsh", bounds: { x: 0, y: 0, width: 800, height: 500 } },
                {
                    pid: 20,
                    app: "Editor",
                    windowId: 7,
                    title: "a.txt",
                    bounds: { x: 10, y: 10, width: 600, height: 400 },
                },
                { pid: 20, app: "Editor", windowId: 8, bounds: { x: 0, y: 0, width: 30, height: 30 } },
                {
                    pid: 20,
                    app: "Editor",
                    windowId: 9,
                    title: "b.txt",
                    bounds: { x: 50, y: 50, width: 600, height: 400 },
                },
                { pid: 30, app: "Viewer", title: "missing id", bounds: { x: 0, y: 0, width: 600, height: 400 } },
            ],
        };
        const windows = parseRecordingWindows(raw);
        expect(windows.map((window) => window.id)).toEqual([6, 7, 9]);
        expect(groupRecordingApps(windows)).toEqual([
            { pid: 9, name: "Terminal", windowCount: 1 },
            { pid: 20, name: "Editor", windowCount: 2 },
        ]);
        const targets = { windows, apps: groupRecordingApps(windows), displays: [], frontmostPid: 9 };
        // The frontmost app is this command's own terminal, so the pick falls through to the next app.
        expect(defaultRecordingTarget(targets, new Set([9]))).toEqual({
            kind: "window",
            windowIds: [7],
            app: "Editor",
            title: "a.txt",
            pid: 20,
        });
    });
});

describe("segmentCaptureSpec", () => {
    it("records an area of the screen in region mode, in global points", () => {
        const spec = segmentCaptureSpec({
            target: { kind: "region", x: 100, y: 50, width: 640, height: 360 },
            output: "/tmp/segment.mp4",
            maxSeconds: 60,
            options: { fps: 30, cursorTrack: true },
        });
        expect(spec.mode).toBe("region");
        expect(spec.region).toBe("100,50,640,360");
        expect(spec.activeFps).toBe(30);
        expect(spec.cursorTrack).toBe("/tmp/segment.mp4.cursor.jsonl");
        expect(describeRecordingTarget({ kind: "region", x: 100, y: 50, width: 640, height: 360 })).toBe(
            "area 640×360 at 100,50"
        );
    });

    it("passes the idle rate, the change threshold and the windows to leave out", () => {
        const spec = segmentCaptureSpec({
            target: { kind: "display", screenIndex: 0 },
            output: "/tmp/segment.mp4",
            maxSeconds: 60,
            options: { fps: 30, idleFps: 2, threshold: 3, excludeWindowIds: [41, 42] },
        });
        expect(spec.idleFps).toBe(2);
        expect(spec.threshold).toBe(3);
        expect(spec.excludeWindowIds).toEqual([41, 42]);
    });

    it("keeps the motion threshold the recorder used before when none is given", () => {
        const spec = segmentCaptureSpec({
            target: { kind: "window", windowIds: [7] },
            output: "/tmp/segment.mp4",
            maxSeconds: 60,
            options: {},
        });
        expect(spec.threshold).toBe(0.5);
        expect(spec.idleFps).toBeUndefined();
    });

    it("refuses audio and the cursor track for a window or an app before the capture starts", () => {
        const targets: RecordingTarget[] = [
            { kind: "window", windowIds: [7] },
            { kind: "app", app: "Notes" },
        ];
        const asks: NativeRecorderOptions[] = [{ audio: ["mic"] }, { cursorTrack: true }];

        for (const target of targets) {
            for (const options of asks) {
                expect(() =>
                    segmentCaptureSpec({ target, output: "/tmp/segment.mp4", maxSeconds: 60, options })
                ).toThrow("those need a display or an area target");
            }
        }

        const region = segmentCaptureSpec({
            target: { kind: "region", x: 0, y: 0, width: 100, height: 100 },
            output: "/tmp/segment.mp4",
            maxSeconds: 60,
            options: { audio: ["mic"], cursorTrack: true },
        });
        expect(region.audio).toEqual(["mic"]);
    });
});

describe("start flags for a target", () => {
    it("reads an area as x,y,width,height and refuses a malformed one", () => {
        expect(parseRegionTarget("10, 20,300,200")).toEqual({ kind: "region", x: 10, y: 20, width: 300, height: 200 });
        expect(() => parseRegionTarget("10,20,0,200")).toThrow("--region takes x,y,width,height");
        expect(() => parseRegionTarget("10,20,300")).toThrow("--region takes x,y,width,height");
    });

    it("reads window ids and refuses anything that is not one", () => {
        expect(parseWindowIdList(undefined, "--exclude-window-ids")).toBeUndefined();
        expect(parseWindowIdList("41,42", "--exclude-window-ids")).toEqual([41, 42]);
        expect(() => parseWindowIdList("41,x", "--exclude-window-ids")).toThrow(
            "--exclude-window-ids takes CG window ids"
        );
    });
});

describe("a movie recording's live settings", () => {
    let root: string;

    beforeEach(async () => {
        root = join(tmpdir(), `movie-settings-${randomUUID()}`);
        await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    /** A movie session started at 60 fps, 1 fps while still and a 0.5 % threshold, served over its live socket. */
    async function movie(rates = { activeFps: 60, idleFps: 1, threshold: 0.5 }) {
        const { recorder, runs } = fakeRecorder();
        let control: SessionRecorderControl | undefined;
        const recording = new RecordingSession({
            target: display,
            directory: join(root, "segments"),
            output: join(root, "out.mp4"),
            recorder,
            rates,
            join: async ({ output }) => {
                await writeFile(output, "joined");
                return { durationMs: 1000 };
            },
            measure: async () => 1000,
            emit: (event) => control?.observe(event),
            tickMs: 0,
            slowStartMs: 0,
        });
        control = new SessionRecorderControl(recording, { target: display, audio: { sources: ["mic"] } });
        const dir = join(root, "live");
        const server = new LiveRecordingServer({
            id: "movie-settings",
            kind: control.kind,
            title: "Movie",
            control,
            dir,
        });
        await recording.start();
        const client = await RecorderClient.connect("movie-settings", { dir });
        const close = async () => {
            client.close();
            server.close();
            await recording.command({ cmd: "discard" });
        };
        return { client, runs, close };
    }

    it("reads the movie's rates and threshold, and names the keys a movie keeps as they are", async () => {
        const { client, close } = await movie();

        try {
            expect(client.methods).toContain("settings.set");
            const answer = await client.getSettings();
            expect(answer.settings).toEqual({
                activeFps: 60,
                idleFps: 1,
                threshold: 0.5,
                maxLongSide: 16_384,
                heartbeatSec: 0,
                ocr: {
                    enabled: false,
                    languages: ["en-US"],
                    minChars: 0,
                    threshold: 0,
                    skipTextless: false,
                    region: "frame",
                    read: "frame",
                },
            });
            expect(answer.audio).toEqual({ sources: ["mic"], muted: { mic: false, system: false } });
            expect(Object.keys(answer.fixed ?? {}).sort()).toEqual(["heartbeatSec", "maxLongSide", "ocr"]);
        } finally {
            await close();
        }
    });

    it("a change while it records ends the running segment and starts the next one with the new rates", async () => {
        const { client, runs, close } = await movie();

        try {
            const answer = await client.setSettings({ activeFps: 30, threshold: 2 });
            expect(answer.applied).toBe("restart");
            expect(answer.settings).toMatchObject({ activeFps: 30, idleFps: 1, threshold: 2 });
            expect(runs).toHaveLength(2);
            expect(runs[0].signal.aborted).toBe(true);
            expect(runs[0].rates).toEqual({ activeFps: 60, idleFps: 1, threshold: 0.5 });
            expect(runs[1].rates).toEqual({ activeFps: 30, idleFps: 1, threshold: 2 });
        } finally {
            await close();
        }
    });

    it("a single-rate movie stays single-rate when only its active rate changes", async () => {
        const { client, runs, close } = await movie({ activeFps: 60, idleFps: 60, threshold: 0.5 });

        try {
            const answer = await client.setSettings({ activeFps: 120 });
            expect(answer.applied).toBe("restart");
            expect(runs[1].rates).toEqual({ activeFps: 120, idleFps: 120, threshold: 0.5 });
        } finally {
            await close();
        }
    });

    it("refuses the keys a movie keeps, naming each, and changes nothing", async () => {
        const { client, runs, close } = await movie();

        try {
            const refused = client.setSettings({ activeFps: 30, maxLongSide: 1280, ocr: { enabled: true } });
            await expect(refused).rejects.toMatchObject({ code: RPC_ERRORS.unsupported });
            await expect(refused).rejects.toThrow("maxLongSide, ocr");
            expect(runs).toHaveLength(1);
            expect((await client.getSettings()).settings.activeFps).toBe(60);
        } finally {
            await close();
        }
    });
});

it("segment re-encoding maps every audio source", () => {
    const argv = joinSegmentsArgv({
        inputs: [
            { path: "/a.mp4", width: 1280, height: 720 },
            { path: "/b.mp4", width: 1920, height: 1080 },
        ],
        width: 1280,
        height: 720,
        output: "/out.mp4",
        audioTracks: 2,
    });
    const graph = argv[argv.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:a:0]");
    expect(graph).toContain("[1:a:1]");
    expect(graph).toContain("concat=n=2:v=1:a=2[out][aout0][aout1]");
    expect(argv).toContain("[aout0]");
    expect(argv).toContain("[aout1]");
});

it("a proxy retains its final still until stop and validates supplied plan windows", () => {
    expect(
        framesDurationUs({ lastUs: 1_000_000, startedAt: "2026-11-05T10:00:00Z", endedAt: "2026-11-05T10:03:00Z" })
    ).toBe(180_000_000);
    expect(framesDurationUs({ lastUs: 1_000_000 })).toBe(2_000_000);
    for (const windowSec of [0, -1, Number.NaN, 0.0000001]) {
        expect(() => chosenPlan([], { plan: { policy: "most-change", windowSec, ranges: [] } })).toThrow("window");
    }
});
