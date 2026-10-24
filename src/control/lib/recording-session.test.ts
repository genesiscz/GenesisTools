import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type FinishedSegment,
    joinSegmentsArgv,
    PREPARING_MESSAGE,
    parseRecordingCommand,
    RecordingSession,
    type RecordingSessionEvent,
    type SegmentRecorder,
    type SegmentResult,
} from "./recording-session";
import {
    defaultRecordingTarget,
    groupRecordingApps,
    parseRecordingWindows,
    type RecordingTarget,
} from "./recording-targets";

const finder: RecordingTarget = { kind: "app", app: "4242", name: "Finder" };
const display: RecordingTarget = { kind: "display", screenIndex: 0, name: "Built-in" };
const editor: RecordingTarget = { kind: "window", windowIds: [77], app: "Editor", title: "notes.txt" };

interface FakeRun {
    target: RecordingTarget;
    output: string;
    maxSeconds: number;
    signal: AbortSignal;
    /** Ends the run by itself, as the recorder's deadline or a failure would. */
    end: (result: SegmentResult, writeMovie?: boolean) => Promise<void>;
    /** The first frame arrives (runs arm at once unless the fake was made with `armLater`). */
    arm: () => void;
}

/**
 * A recorder that writes a small file per run and finishes it when the session aborts the run. A run aborted before
 * it armed writes no movie, as the real recorder cancelled while arming does.
 */
function fakeRecorder(options: { failFirst?: boolean; armLater?: boolean; prepares?: boolean } = {}) {
    const runs: FakeRun[] = [];
    const recorder: SegmentRecorder = {
        record({ target, output, maxSeconds, signal, onRecording, onPreparing }) {
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
                const arm = () => {
                    armed = true;
                    onRecording();
                };
                runs.push({ target, output, maxSeconds, signal, end, arm });
                if (options.failFirst && index === 0) {
                    void end({ ok: false, endedBy: "failure", error: "[screen-recording-denied] no grant" }, false);
                    return;
                }

                signal.addEventListener(
                    "abort",
                    () =>
                        void (armed
                            ? end({ ok: true, endedBy: "stop", durationMs: 1000 })
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

    function session(recorder: SegmentRecorder, extra: { maxSeconds?: number; segmentSeconds?: number } = {}) {
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
            emit: (event) => events.push(event),
            now: () => clock,
            tickMs: 0,
            ...extra,
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

describe("joinSegmentsArgv", () => {
    it("scales and pads every input to the first segment's even size and concatenates them", () => {
        const argv = joinSegmentsArgv({ inputs: ["/a.mp4", "/b.mp4"], width: 1281, height: 721, output: "/o.mp4" });
        expect(argv.slice(0, 6)).toEqual(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]);
        expect(argv).toContain("-nostdin");
        expect(argv.filter((value) => value === "-i")).toHaveLength(2);
        const graph = argv[argv.indexOf("-filter_complex") + 1];
        expect(graph).toBe(
            "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=AVTB[v0];" +
                "[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=AVTB[v1];" +
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
