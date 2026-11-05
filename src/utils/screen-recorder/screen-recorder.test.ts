import { describe, expect, spyOn, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { pixelBox } from "@genesiscz/utils/macos/ocr-boxes";
import * as bounded from "@genesiscz/utils/process/bounded-command";
import * as rm from "@genesiscz/utils/rm";
import { z } from "zod";
import {
    type DisplayEntry,
    OCR_READ_DEFAULTS,
    RECORDER_DISPATCH,
    RecorderControl,
    type RecorderMethod,
    type RecorderState,
    type RecorderStatus,
    type StopAnswer,
} from "./control";
import { DisplayBook } from "./display-book";
import { outputScaleFor, parseDisplayList } from "./displays";
import { FrameOutput, type OcrRow, ocrSinkFor, SidecarOcrSink, sipsJpegWithin } from "./frame-output";
import { readRecordingManifest, renameRecording } from "./library";
import {
    callTimeoutFor,
    type LiveNotification,
    LiveRecordingServer,
    listLiveRecordings,
    liveSocketPath,
    RecorderClient,
    RPC_ERRORS,
    RpcError,
    readLiveRecording,
} from "./live";
import { audioArgv, captureErrorKind, flagsInHelp, NativeFrameRecorder, NativeLiveCapture, nativeArgv } from "./native";
import { blockInFrame, changedAreas, mergeAreaRead, planRead } from "./ocr-region";
import { peekabooCaptureError } from "./peekaboo";
import type { SessionCapture } from "./session";
import { startRecording } from "./start";
import {
    type CapturedFrame,
    CaptureError,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderSupport,
    type LiveCapture,
    type MotionBox,
} from "./types";

test("an unreadable live entry does not break the inventory", () => {
    const dir = mkdtempSync(join(tmpdir(), "unreadable-live-"));
    symlinkSync(join(dir, "gone"), join(dir, "ended.json"));
    expect(listLiveRecordings(dir)).toEqual([]);
});

const axScreens = {
    ok: true,
    screens: [
        {
            displayID: 1,
            index: 0,
            isPrimary: true,
            name: "Built-in",
            position: { x: 0, y: 0 },
            resolution: { width: 2056, height: 1329 },
            scaleFactor: 2,
        },
        {
            displayID: 4,
            index: 1,
            isPrimary: false,
            name: "External",
            position: { x: -410, y: 1329 },
            resolution: { width: 2560, height: 1440 },
            scaleFactor: 1,
        },
    ],
};

const request = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
    target: { kind: "display", displayId: 4 },
    durationSec: 30,
    activeFps: 1,
    idleFps: 0.1,
    thresholdPercent: 2,
    outDir: "/tmp/piece",
    ...over,
});

describe("displays", () => {
    test("ax-tool's list and peekaboo's envelope give the same displays by id", () => {
        const native = parseDisplayList(axScreens);
        const peekaboo = parseDisplayList({ success: true, data: { screens: axScreens.screens } });

        expect(native).toEqual(peekaboo);
        expect(native.map((display) => [display.id, display.index, display.main])).toEqual([
            [1, 0, true],
            [4, 1, false],
        ]);
    });

    test("the output scale keeps the long side within the cap and never above the display's own", () => {
        const [builtIn, external] = parseDisplayList(axScreens);

        expect(outputScaleFor(builtIn!, 2880)).toBeCloseTo(2880 / 2056);
        expect(outputScaleFor(external!, 2880)).toBe(1);
    });

    test("the recorded displays name the display a capture records now, after its frames moved to another", () => {
        const book = new DisplayBook({
            names: [
                [1, "left"],
                [4, "right"],
            ],
        });
        const capture: SessionCapture = {
            target: { target: { kind: "display", displayId: 1 }, displayId: 1, label: "display 1" },
            startDisplayId: 1,
            controller: new AbortController(),
            streamed: 0,
            audio: false,
            outDir: join(tmpdir(), "d1-0"),
            done: Promise.resolve(),
        };
        const running = new Map([[1, capture]]);
        book.open(capture, 1);
        expect(book.sync(running)).toBe(true);
        expect(book.recorded).toEqual([{ id: 1, name: "left" }]);
        book.open(capture, 4);
        expect(book.sync(running)).toBe(true);
        expect(book.recorded).toEqual([{ id: 4, name: "right" }]);
        expect(book.sync(running)).toBe(false);
    });
});

describe("native capture argv", () => {
    const displays = parseDisplayList(axScreens);

    test("without the new flags, a display id becomes its current index and the cap an output scale", () => {
        const argv = nativeArgv({ request: request({ maxLongSidePx: 1280 }), flags: new Set(), displays });

        expect(argv.slice(argv.indexOf("--screen-index"), argv.indexOf("--screen-index") + 2)).toEqual([
            "--screen-index",
            "1",
        ]);
        expect(argv).toContain("--output-scale");
        expect(argv[argv.indexOf("--output-scale") + 1]).toBe(String(Number((1280 / 2560).toFixed(4))));
        expect(argv).not.toContain("--display-id");
        expect(argv).toContain("--no-indicator");
    });

    test("with them, the id and the cap go through as they are", () => {
        const flags = flagsInHelp("  --display-id <id>\n  --max-long-side <px>\n  --heartbeat-sec <s>");
        const argv = nativeArgv({ request: request({ maxLongSidePx: 1280, heartbeatSec: 60 }), flags, displays });

        expect(argv).toEqual(expect.arrayContaining(["--display-id", "4", "--max-long-side", "1280"]));
        expect(argv).toEqual(expect.arrayContaining(["--heartbeat-sec", "60"]));
        expect(argv).not.toContain("--screen-index");
        expect(argv).not.toContain("--output-scale");
    });

    test("a display that is gone is display-missing; follow-focus needs the flag", () => {
        const gone = () =>
            nativeArgv({ request: request({ target: { kind: "display", displayId: 9 } }), flags: new Set(), displays });
        const focus = () =>
            nativeArgv({ request: request({ target: { kind: "follow-focus" } }), flags: new Set(), displays });

        expect(gone).toThrow(CaptureError);
        expect(captureKindOf(gone)).toBe("display-missing");
        expect(captureKindOf(focus)).toBe("unavailable");
    });

    test("the help text names a flag only as a whole word", () => {
        expect([...flagsInHelp("--max-mb-total <n>  --quiet-ms <ms>")]).toEqual(["--quiet-ms"]);
    });

    test("error codes win over the message; old messages still map", () => {
        expect(captureErrorKind("display-missing", "x")).toBe("display-missing");
        expect(captureErrorKind(undefined, "--screen-index outside the current display list")).toBe("display-missing");
        expect(captureErrorKind(undefined, "ScreenCaptureKit refused to enumerate content: denied")).toBe(
            "no-permission"
        );
        expect(captureErrorKind("invalid-argument", "display missing")).toBe("failed");
    });
});

function captureKindOf(run: () => unknown): string | undefined {
    try {
        run();
    } catch (error) {
        return error instanceof CaptureError ? error.kind : "other";
    }

    return undefined;
}

describe("native capture over --control-stdin (a fake ax-tool)", () => {
    const fake = join(moduleDir(import.meta), "__fixtures__", "fake-ax-tool.ts");
    const recorder = new NativeFrameRecorder({ axTool: async () => [process.execPath, fake], launch: (argv) => argv });

    test("a failed help probe is retried on the next availability check", async () => {
        const marker = join(mkdtempSync(join(tmpdir(), "help-retry-")), "once");
        const retrying = new NativeFrameRecorder({
            axTool: async () => [process.execPath, fake, `--fixture-help-once=${marker}`],
            launch: (argv) => argv,
        });
        await retrying.available();
        expect(retrying.supports.liveControl).toBe(false);
        await retrying.available();
        expect(retrying.supports.liveControl).toBe(true);
    });

    test("truncated native output still returns frames already written", async () => {
        const broken = new NativeFrameRecorder({
            axTool: async () => [process.execPath, fake, "--fixture-corrupt-output"],
            launch: (argv) => argv,
        });
        const outDir = mkdtempSync(join(tmpdir(), "salvage-capture-"));
        const result = await broken.capture(request({ outDir, durationSec: 1 }));
        expect(result.frames).toHaveLength(1);
        expect(existsSync(result.frames[0].path)).toBe(true);
    });

    test("replacing a pending display switch clears its deadline and completes the replacement", async () => {
        const clear = spyOn(globalThis, "clearTimeout");
        try {
            const channel = new NativeLiveCapture(() => undefined, 1, {});
            const replaced = channel.switchDisplay(4).catch((error: unknown) => error);
            const replacement = channel.switchDisplay(9);
            expect(clear).toHaveBeenCalledTimes(1);
            channel.receive(SafeJSON.stringify({ event: "display-switch", from: 1, to: 9 }));
            await replacement;
            expect(await replaced).toMatchObject({ kind: "failed" });
        } finally {
            clear.mockRestore();
        }
    });

    test("frames arrive as they land, a switch moves the running capture, and an abort keeps its frames", async () => {
        expect(await recorder.available()).toEqual({ ok: true });
        expect(recorder.supports.liveControl).toBe(true);

        const outDir = mkdtempSync(join(tmpdir(), "fake-capture-"));
        const streamed: Array<number | undefined> = [];
        const firstFrame = Promise.withResolvers<void>();
        const liveReady = Promise.withResolvers<void>();
        let channel: LiveCapture | undefined;
        const controller = new AbortController();
        const capture = recorder.capture(
            {
                ...request({ outDir, durationSec: 30 }),
                hooks: {
                    onFrame: (frame) => {
                        streamed.push(frame.displayId);
                        firstFrame.resolve();
                    },
                    onLive: (live) => {
                        channel = live;
                        liveReady.resolve();
                    },
                },
            },
            controller.signal
        );
        await withTimeout(
            Promise.all([firstFrame.promise, liveReady.promise]),
            5_000,
            new Error("capture readiness timed out")
        );

        await channel?.switchDisplay(1);
        await channel?.setRates?.(2, 0.5);
        await channel?.setThreshold?.(3);
        await channel?.mute?.("mic", true);
        await channel?.setMic?.("built-in-mic");
        await expect(channel?.setMic?.("nope")).rejects.toMatchObject({ kind: "failed" });
        await expect(channel?.switchDisplay(9)).rejects.toMatchObject({ kind: "display-missing" });
        channel?.pause();
        channel?.resume();
        controller.abort();
        const result = await capture;

        expect(streamed).toEqual([4, 1]);
        expect(result.frames.map((frame) => [frame.displayId, frame.reason])).toEqual([
            [4, "first"],
            [1, "display-switch"],
        ]);
        expect(result.endedEarly).toBe("stopped");
        expect(channel?.setMaxLongSide).toBeDefined();
    });

    test("the input devices come from ax-tool audio-devices, and sound needs the sidecar flags", async () => {
        expect(await recorder.audioDevices()).toEqual({
            inputs: [{ id: "built-in-mic", name: "Built-in Microphone", channels: 1, default: true }],
            outputs: [{ id: "speakers", name: "Speakers", channels: 2, default: true }],
        });
        expect(recorder.supports.audio).toBe(true);
        expect(
            audioArgv(
                request({ audio: { sources: ["mic"], micDeviceId: "built-in-mic" } }),
                flagsInHelp("--audio --mic-device --audio-sidecar")
            )
        ).toEqual(["--audio", "mic", "--mic-device", "built-in-mic", "--audio-sidecar"]);
        expect(() => audioArgv(request({ audio: { sources: ["mic"] } }), new Set())).toThrow(CaptureError);
        expect([...flagsInHelp("mute/unmute | set-mic")]).toEqual(["mute", "set-mic"]);
    });
});

describe("a failed peekaboo capture", () => {
    test("malformed output preserves the diagnostic fallback", () => {
        expect(peekabooCaptureError(1, '{"broken":', "capture crashed").message).toContain("capture crashed");
        expect(peekabooCaptureError(1, "not json", "permission denied").kind).toBe("no-permission");
    });

    const stderr = "[Visualizer][INFO] Visualizer client forcing mac-app context via PEEKABOO_VISUALIZER_FORCE_APP";

    test("names peekaboo's own error from its JSON, not its log line", () => {
        const stdout = SafeJSON.stringify({
            success: false,
            error: { code: "INVALID_INPUT", message: "Invalid input: Screen index 1 not found" },
            data: null,
        });
        const err = peekabooCaptureError(1, stdout, stderr);

        expect(err.message).toBe("peekaboo exited 1: Invalid input: Screen index 1 not found");
        expect(err.kind).toBe("display-missing");
    });

    test("another error is no missing display, and output without JSON names the real error line, never the log", () => {
        const denied = SafeJSON.stringify({ success: false, error: { message: "Screen Recording permission denied" } });

        expect(peekabooCaptureError(1, denied, stderr).kind).toBe("no-permission");
        expect(peekabooCaptureError(1, "", `${stderr}\nError: No space left on device`).message).toBe(
            "peekaboo exited 1: Error: No space left on device"
        );
        expect(peekabooCaptureError(1, "", stderr).message).toBe(
            "peekaboo exited 1: peekaboo printed no reason (only its log lines; the day log has its whole output)"
        );
    });
});

/** A recorder kind for the socket tests: pause and resume with their refusals, and a slow display list. */
class TestControl extends RecorderControl {
    readonly kind = "meeting";
    readonly methods: readonly RecorderMethod[] = ["status", "pause", "resume", "stop", "displays.list", "jobs.list"];
    state: RecorderState = "recording";
    server?: LiveRecordingServer;

    async status(): Promise<RecorderStatus> {
        return { kind: this.kind, title: "Planning", state: this.state, displays: [], frames: 0 };
    }

    async pause(): Promise<{ state: RecorderState }> {
        if (this.state === "paused") {
            throw new RpcError(RPC_ERRORS.alreadyPaused, "already paused");
        }

        this.state = "paused";
        this.server?.update({ state: this.state });
        return { state: this.state };
    }

    async resume(): Promise<{ state: RecorderState }> {
        this.state = "recording";
        return { state: this.state };
    }

    async stop(): Promise<StopAnswer> {
        return { state: "stopped", outcome: "requested" };
    }

    override async listDisplays(): Promise<DisplayEntry[]> {
        await Bun.sleep(20);
        return [];
    }
}

describe("recording markers", () => {
    test("marker.add reaches addMarker with a trimmed label, refuses an empty one, and is unsupported by default", async () => {
        const plain = new TestControl();
        await expect(RECORDER_DISPATCH["marker.add"](plain, { label: "x" })).rejects.toThrow("marker.add");

        const marking = new TestControl();
        marking.addMarker = async (label: string) => ({ atMs: 1200, label });
        expect(await RECORDER_DISPATCH["marker.add"](marking, { label: "  login done " })).toEqual({
            atMs: 1200,
            label: "login done",
        });
        await expect((async () => RECORDER_DISPATCH["marker.add"](marking, { label: "  " }))()).rejects.toThrow(
            "1 to 80 characters"
        );
    });
});

describe("renaming a recording", () => {
    test("only the title changes, an unknown key survives, and an empty title or a plain folder is refused", () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-rec-rename-"));
        const manifest = {
            version: 1,
            id: "rec-1",
            title: "old",
            startedAt: "2026-11-04T05:00:00.000Z",
            displays: [],
            settings: { markers: [{ atMs: 5, label: "a" }] },
            frames: [],
            warnings: [],
            extra: { kept: true },
        };
        writeFileSync(join(folder, "recording.json"), SafeJSON.stringify(manifest));

        expect(renameRecording(folder, "  New name ").title).toBe("New name");
        const saved = SafeJSON.parse(readFileSync(join(folder, "recording.json"), "utf8"), { strict: true });
        expect(saved).toEqual({ ...manifest, title: "New name" });
        expect(() => renameRecording(folder, " ")).toThrow("1 to 120 characters");
        expect(() => renameRecording(mkdtempSync(join(tmpdir(), "gt-rec-plain-")), "x")).toThrow("no recording.json");
    });
});

test("mutations from two clients share one recorder queue", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const control = new TestControl();
    let calls = 0;
    control.pause = async () => {
        calls += 1;
        if (control.state !== "recording") {
            throw new RpcError(RPC_ERRORS.alreadyPaused, "already paused");
        }
        entered.resolve();
        await release.promise;
        control.state = "paused";
        return { state: "paused" };
    };
    const dir = mkdtempSync(join(tmpdir(), "live-queue-"));
    chmodSync(dir, 0o755);
    const server = new LiveRecordingServer({ id: "queue", kind: "meeting", title: "Fixture", control, dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(liveSocketPath(dir, "queue")).mode & 0o777).toBe(0o600);
    const first = await RecorderClient.connect("queue", { dir });
    const second = await RecorderClient.connect("queue", { dir });
    try {
        const one = first.pause();
        await withTimeout(entered.promise, 1000, new Error("first pause did not start"));
        // A pending `expect(two).rejects` would block this test until two settles (bun 1.4.2), so it keeps the error.
        const two = second.pause().then(
            () => undefined,
            (error: unknown) => error
        );
        await Bun.sleep(20);
        expect(calls).toBe(1);
        release.resolve();
        await one;
        expect(await two).toBeInstanceOf(Error);
        expect(String(await two)).toContain("already paused");
        expect(calls).toBe(2);
        expect(await second.resume()).toEqual({ state: "recording" });
    } finally {
        release.resolve();
        first.close();
        second.close();
        server.close();
    }
});

describe("live recordings", () => {
    test("a discard waits as long as a stop for the post-processing; other calls keep the short deadline", () => {
        const short = callTimeoutFor("pause", undefined);
        expect(callTimeoutFor("discard", undefined)).toBe(callTimeoutFor("stop", {}));
        expect(callTimeoutFor("discard", undefined)).toBeGreaterThan(short);
        expect(callTimeoutFor("stop", { wait: false })).toBe(short);
    });

    test("closing inside stop removes discovery immediately and delivers the final answer", async () => {
        const dir = mkdtempSync(join(tmpdir(), "live-rec-close-"));
        const control = new TestControl();
        const server = new LiveRecordingServer({ id: "closing", kind: "meeting", title: "Closing", dir, control });
        control.stop = async () => {
            server.close("requested");
            expect(existsSync(join(dir, "closing.json"))).toBe(false);
            expect(existsSync(server.current.socket)).toBe(false);
            return { state: "stopped", outcome: "requested" };
        };
        const client = await RecorderClient.connect("closing", { dir });
        try {
            expect(await client.stop()).toEqual({ state: "stopped", outcome: "requested" });
        } finally {
            client.close();
            server.close();
        }
    });

    test("an entry and its socket answer JSON-RPC calls, send events to subscribers, and go when it closes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "live-rec-"));
        const control = new TestControl();
        const server = new LiveRecordingServer({
            id: "meeting-m1",
            kind: "meeting",
            title: "Planning",
            displays: [{ id: 1, name: "Built-in" }],
            dir,
            control,
        });
        control.server = server;

        expect(listLiveRecordings(dir).map((entry) => [entry.id, entry.state, entry.pid])).toEqual([
            ["meeting-m1", "recording", process.pid],
        ]);
        expect(readLiveRecording("meeting-m1", dir)?.socket).toBe(join(dir, "meeting-m1.sock"));

        const client = await RecorderClient.connect("meeting-m1", { dir });
        const events: LiveNotification[] = [];
        const ended = Promise.withResolvers<void>();
        await client.subscribe(
            (event) => {
                events.push(event);

                if (event.event === "ended") {
                    ended.resolve();
                }
            },
            ["state", "warning", "ended"]
        );

        expect(client.kind).toBe("meeting");
        expect(client.methods).toEqual(control.methods);
        expect(await client.status()).toMatchObject({ kind: "meeting", state: "recording" });
        expect(await client.pause()).toEqual({ state: "paused" });
        await expect(client.pause()).rejects.toMatchObject({ code: RPC_ERRORS.alreadyPaused });
        await expect(client.discard()).rejects.toMatchObject({ code: RPC_ERRORS.unsupported });
        await expect(client.call("nonsense")).rejects.toMatchObject({ code: RPC_ERRORS.methodNotFound });
        expect(await client.stop()).toEqual({ state: "stopped", outcome: "requested" });
        expect(await client.listJobs()).toEqual([]);

        server.update({ frames: 3, warning: "a note" });
        server.update({ warning: undefined });
        const saved = SafeJSON.parse(readFileSync(join(dir, "meeting-m1.json"), "utf8"), { strict: true });

        expect(saved).toMatchObject({ version: 1, state: "paused", frames: 3, controls: [...control.methods] });
        expect(saved).not.toHaveProperty("warning");

        server.close("requested");
        await withTimeout(ended.promise, 2_000, new Error("ended event timed out"));

        expect(events.map((event) => event.event)).toEqual(["state", "warning", "warning", "ended"]);
        expect(events.filter((event) => event.event === "warning").map((event) => event.params)).toEqual([
            { warning: "a note" },
            { warning: null },
        ]);
        expect(existsSync(join(dir, "meeting-m1.json"))).toBe(false);
        expect(existsSync(join(dir, "meeting-m1.sock"))).toBe(false);
        await expect(RecorderClient.connect("meeting-m1", { dir })).rejects.toThrow(/No running recording/);
    });

    test("several requests in one write get one answer each, in their order", async () => {
        const dir = mkdtempSync(join(tmpdir(), "live-rec-"));
        const server = new LiveRecordingServer({
            id: "batch",
            kind: "meeting",
            title: "Batch",
            dir,
            control: new TestControl(),
        });
        let received = "";
        const answered = Promise.withResolvers<void>();
        const socket = await Bun.connect({
            unix: server.current.socket,
            socket: {
                data: (_socket, chunk) => {
                    received += new TextDecoder().decode(chunk);

                    if (received.split("\n").filter(Boolean).length >= 3) {
                        answered.resolve();
                    }
                },
            },
        });
        socket.write(
            '{"jsonrpc":"2.0","id":1,"method":"subscribe"}\n{"jsonrpc":"2.0","id":2,"method":"displays.list"}\r\n{"jsonrpc":"2.0","id":3,"method":"status"}\n'
        );
        await withTimeout(answered.promise, 2_000, new Error("batch replies timed out"));

        const ids = received
            .split("\n")
            .filter(Boolean)
            .map((line) => z.object({ id: z.number() }).parse(SafeJSON.parse(line, { strict: true })).id);
        socket.end();
        server.close();

        expect(ids).toEqual([1, 2, 3]);
    });

    test("an entry whose process is gone is not listed, and a socket nobody listens on counts as gone", async () => {
        const dir = mkdtempSync(join(tmpdir(), "live-rec-"));
        const entry = (id: string, pid: number) =>
            SafeJSON.stringify({
                version: 1,
                id,
                kind: "meeting",
                title: "",
                pid,
                startedAt: "2026-11-03T12:00:00.000Z",
                state: "recording",
                socket: join(dir, `${id}.sock`),
            });
        writeFileSync(join(dir, "gone.json"), entry("gone", 999_999));
        writeFileSync(join(dir, "stale.json"), entry("stale", process.pid));

        expect(listLiveRecordings(dir).map((one) => one.id)).toEqual(["stale"]);
        await expect(RecorderClient.connect("stale", { dir })).rejects.toThrow(/does not answer/);
    });

    test("a socket path too long for macOS falls back to a hash of the id", () => {
        const path = liveSocketPath(`/tmp/${"x".repeat(60)}`, "meeting-2026-11-03_15-00-a-long-meeting-title");

        expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103);
        expect(path).toMatch(/[0-9a-f]{16}\.sock$/);
    });
});

describe("library recording frames", () => {
    /** Two frames per piece, then waits out the piece (or the stop). */
    class PieceRecorder extends FrameRecorder {
        readonly id = "native" as const;
        readonly supports: FrameRecorderSupport = {
            followFocus: false,
            displayId: true,
            motionBoxes: false,
            heartbeat: false,
            liveControl: false,
            parallelCaptures: true,
            audio: false,
        };
        readonly framesSeenAtCapture: number[] = [];
        folder = "";

        async available(): Promise<{ ok: true }> {
            return { ok: true };
        }

        async displays(): Promise<DisplayInfo[]> {
            return [{ id: 1, index: 0, name: "left", main: true, widthPt: 64, heightPt: 40, scale: 1 }];
        }

        async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
            const startedAtMs = Date.now();
            this.framesSeenAtCapture.push(readdirSync(join(this.folder, "frames")).length);
            mkdirSync(request.outDir, { recursive: true });
            const frames: CaptureResult["frames"] = [];

            for (const atMs of [0, 10]) {
                const path = join(request.outDir, `keep-${atMs}.png`);
                writeFileSync(path, "png");
                frames.push({ path, atMs, displayId: 1, changePercent: 12.5, reason: atMs === 0 ? "first" : "change" });
            }

            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, request.durationSec * 1000);
                signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            return { startedAtMs, frames };
        }
    }

    test("frames stay in the pieces until the stop, then move to frames/ as elapsed-ms names in the manifest", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-lib-frames-"));
        const recorder = new PieceRecorder();
        recorder.folder = join(root, "rec");
        const recording = await startRecording({
            recorder,
            folder: recorder.folder,
            liveDir: join(root, "live"),
            maxDurationSec: 0.5,
            pieceSec: 0.2,
        });
        expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 3_000 })).toBe(true);
        const answer = await recording.stop();
        const files = readdirSync(join(recording.folder, "frames")).sort();
        const manifest = readRecordingManifest(recording.folder)!;

        expect(answer).toMatchObject({ state: "stopped", outcome: "done", frames: files.length });
        expect(recorder.framesSeenAtCapture.every((count) => count === 0)).toBe(true);
        expect(files.length).toBeGreaterThanOrEqual(2);
        expect(files.every((name) => /^\d{8}-d1\.png$/.test(name))).toBe(true);
        expect(manifest.frames.map((frame) => frame.file)).toEqual(files.map((name) => `frames/${name}`));
        expect(manifest.frames[0]).toMatchObject({ displayId: 1, changePercent: 12.5, reason: "first" });
        expect(manifest.frames.map((frame) => frame.atMs)).toEqual(files.map((name) => Number(name.slice(0, 8))));
        expect(existsSync(join(recording.folder, ".pieces"))).toBe(false);
        expect(files.some((name) => name.endsWith(".ocr.json"))).toBe(false);
    });
    test("flush per piece: JPEG frames and their ocr.jsonl rows exist while it records, under wall-clock names", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-lib-piece-"));
        const recorder = new PieceRecorder();
        recorder.folder = join(root, "rec");
        const converted: number[] = [];
        const recording = await startRecording({
            recorder,
            folder: recorder.folder,
            liveDir: join(root, "live"),
            maxDurationSec: 0.5,
            pieceSec: 0.2,
            ocr: { enabled: true, minChars: 5 },
            ocrSink: "jsonl",
            frames: { format: "jpeg", jpegQuality: 0.6, naming: "wall-clock", flush: "piece" },
            deps: {
                convert: async (_source, target, quality) => {
                    converted.push(quality);
                    writeFileSync(target, "jpeg");
                },
                recognize: async () => ({
                    text: "Sprint board",
                    blocks: [{ text: "Sprint board", confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
                }),
            },
        });
        expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 3_000 })).toBe(true);
        await recording.stop();
        const files = readdirSync(join(recording.folder, "frames")).sort();
        const rows = readFileSync(join(recording.folder, "ocr.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line, { strict: true }));

        expect(recorder.framesSeenAtCapture.slice(1).every((count) => count > 0)).toBe(true);
        expect(files.every((name) => /^\d{2}-\d{2}-\d{2}-\d{3}-d1\.jpg$/.test(name))).toBe(true);
        expect(converted.every((quality) => quality === 0.6)).toBe(true);
        expect(rows.map((row: { file: string }) => row.file).sort()).toEqual(files.map((name) => `frames/${name}`));
        expect(rows[0]).toMatchObject({ displayId: 1, changePercent: 12.5, text: "Sprint board" });
        expect(readRecordingManifest(recording.folder)!.frames.map((frame) => frame.file)).toEqual(
            files.map((name) => `frames/${name}`)
        );
    });

    /** Each `running` and `done` of a finalize step, as a subscriber of the recording's socket sees them. */
    async function finalizeSteps(id: string, dir: string) {
        const steps: string[] = [];
        const client = await RecorderClient.connect(id, { dir });
        await client.subscribe(
            (event) => {
                const params = event.params as { step: string; unit: string; message?: string };

                if (params.unit === "steps" && (params.message === "running" || params.message === "done")) {
                    steps.push(`${params.step} ${params.message}`);
                }
            },
            ["progress"]
        );
        return { steps, client };
    }

    test("characterization (finish): captures, then frames, then manifest; a later stop names the same job, or waits for its answer", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-lib-finish-"));
        const recorder = new PieceRecorder();
        recorder.folder = join(root, "rec");
        const liveDir = join(root, "live");
        const recording = await startRecording({ recorder, folder: recorder.folder, liveDir, pieceSec: 0.2 });
        expect(await waitForPath(liveSocketPath(liveDir, recording.id), { timeoutMs: 3_000 })).toBe(true);
        const { steps, client } = await finalizeSteps(recording.id, liveDir);
        // Over the socket: its answer comes after the progress events, in the same stream.
        const answer = await client.stop();
        // Later stops get the same job: without waiting its id, waiting its answer.
        const early = await recording.stop({ wait: false });
        const again = await recording.stop();
        const jobs = await recording.listJobs();
        client.close();

        expect(early).toEqual({ state: "stopping", job: answer.job });
        expect(answer).toEqual({
            state: "stopped",
            outcome: "done",
            job: expect.any(String),
            frames: readdirSync(join(recording.folder, "frames")).length,
            notes: [],
        });
        expect(again).toEqual(answer);
        expect(jobs).toMatchObject([{ id: early.job, kind: "finalize", state: "done" }]);
        expect(steps).toEqual([
            "captures running",
            "captures done",
            "frames running",
            "frames done",
            "manifest running",
            "manifest done",
        ]);
        expect(listLiveRecordings(liveDir)).toEqual([]);
    });

    test("characterization (finish): a failed frames step fails the stop, skips the manifest and still closes the socket", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-lib-finish-fail-"));
        const recorder = new PieceRecorder();
        recorder.folder = join(root, "rec");
        const liveDir = join(root, "live");
        const recording = await startRecording({
            recorder,
            folder: recorder.folder,
            liveDir,
            pieceSec: 0.2,
            frames: { format: "jpeg", jpegQuality: 0.6, naming: "elapsed", flush: "finish" },
            deps: {
                convert: async () => {
                    throw new Error("sips failed: disk full");
                },
            },
        });
        expect(await waitForPath(liveSocketPath(liveDir, recording.id), { timeoutMs: 3_000 })).toBe(true);
        const { steps, client } = await finalizeSteps(recording.id, liveDir);
        const failed = await client.stop().catch((error: unknown) => error);
        const jobs = await recording.listJobs();
        client.close();

        expect(failed).toBeInstanceOf(Error);
        expect((failed as Error).message).toContain("disk full");
        expect(jobs).toMatchObject([
            { kind: "finalize", state: "failed", error: expect.stringContaining("disk full") },
        ]);
        expect(steps).toEqual(["captures running", "captures done", "frames running"]);
        expect(listLiveRecordings(liveDir)).toEqual([]);
    });
});

describe("frame output", () => {
    test("a JPEG conversion that hangs ends at its deadline with the reason, instead of holding the recording", async () => {
        const run = bounded.boundedCommand;
        const commands: string[][] = [];
        // A sleep stands in for a sips that never returns; the runner's deadline and group kill stay real.
        const hung = spyOn(bounded, "boundedCommand").mockImplementation((options) => {
            commands.push(options.command);
            return run({ ...options, command: ["sleep", "5"] });
        });
        const startedAt = Date.now();

        try {
            await expect(sipsJpegWithin(300)("frame.png", "frame.jpg", 0.75)).rejects.toThrow(
                "sips did not end within 0.3 s for frame.png"
            );
            expect(Date.now() - startedAt).toBeLessThan(3_000);
            expect(commands).toEqual([
                ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "75", "frame.png", "--out", "frame.jpg"],
            ]);
        } finally {
            hung.mockRestore();
        }
    });

    const frameIn = (dir: string) => {
        const path = join(dir, "keep.png");
        writeFileSync(path, "png");
        return { path, atMs: 0, displayId: 2, changePercent: 3, reason: "change" };
    };

    test("a sidecar is written only for a read with minChars or more; OCR off still gives the jsonl sink a row", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-frame-out-"));
        let enabled = true;
        const recognize = async () => ({ text: "abc", blocks: [] });
        const sidecar = new FrameOutput({
            folder: dir,
            naming: "elapsed",
            format: { kind: "original" },
            ocr: {
                settings: () => ({ enabled, languages: ["en-US"], minChars: 4, ...OCR_READ_DEFAULTS }),
                sink: new SidecarOcrSink(),
                recognize,
            },
        });
        const kept = await sidecar.keep(frameIn(dir), { atMs: 5_000, originMs: 1_000, displayId: 2 });

        expect(kept).toMatchObject({
            file: "frames/00004000-d2.png",
            elapsedMs: 4_000,
            bytes: 3,
            read: { text: "abc" },
        });
        expect(existsSync(`${kept.path}.ocr.json`)).toBe(false);

        const jsonl = new FrameOutput({
            folder: dir,
            naming: "elapsed",
            format: { kind: "original" },
            ocr: {
                settings: () => ({ enabled, languages: ["en-US"], minChars: 0, ...OCR_READ_DEFAULTS }),
                sink: ocrSinkFor("jsonl", dir),
                recognize,
            },
        });
        enabled = false;
        const quiet = await jsonl.keep(frameIn(dir), { atMs: 6_000, originMs: 1_000, displayId: 2 });

        expect(quiet.read).toBeUndefined();
        expect(SafeJSON.parse(readFileSync(join(dir, "ocr.jsonl"), "utf8"), { strict: true })).toEqual({
            file: "frames/00005000-d2.png",
            at: new Date(6_000).toISOString(),
            displayId: 2,
            changePercent: 3,
            reason: "change",
            text: "",
            blocks: [],
        });
    });

    test("kept frames, their frames folder and the OCR file are owner-only, an older 0755 folder included", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-frame-out-"));
        mkdirSync(join(dir, "frames"), { mode: 0o755 });
        chmodSync(join(dir, "frames"), 0o755);
        const output = new FrameOutput({
            folder: dir,
            naming: "elapsed",
            format: { kind: "original" },
            ocr: {
                settings: () => ({ enabled: true, languages: ["en-US"], minChars: 0, ...OCR_READ_DEFAULTS }),
                sink: ocrSinkFor("jsonl", dir),
                recognize: async () => ({ text: "abc", blocks: [] }),
            },
        });
        const kept = await output.keep(frameIn(dir), { atMs: 5_000, originMs: 1_000, displayId: 2 });

        expect(statSync(join(dir, "frames")).mode & 0o777).toBe(0o700);
        expect(statSync(kept.path).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, "ocr.jsonl")).mode & 0o777).toBe(0o600);
    });

    test("two frames of one display in the same millisecond keep two files, the second named a millisecond later", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-frame-out-"));
        const rows: string[] = [];
        const output = new FrameOutput({
            folder: dir,
            naming: "wall-clock",
            format: { kind: "jpeg", quality: 0.8 },
            convert: async (source, target) => {
                await Bun.sleep(5);
                writeFileSync(target, readFileSync(source));
            },
            ocr: {
                settings: () => ({ enabled: false, languages: [], minChars: 0, ...OCR_READ_DEFAULTS }),
                sink: { write: (row) => rows.push(row.file) },
            },
        });
        const atMs = new Date(2026, 10, 4, 23, 33, 16, 102).getTime();
        const [first, second] = await Promise.all([
            output.keep(frameIn(dir), { atMs, originMs: atMs, displayId: 4 }),
            output.keep(frameIn(dir), { atMs, originMs: atMs, displayId: 4 }),
        ]);

        expect([first.file, second.file]).toEqual(["frames/23-33-16-102-d4.jpg", "frames/23-33-16-103-d4.jpg"]);
        expect(readdirSync(output.framesDir).sort()).toEqual(["23-33-16-102-d4.jpg", "23-33-16-103-d4.jpg"]);
        expect(rows).toEqual([first.file, second.file]);
        expect(second.at.getTime()).toBe(atMs);
    });
});

/** A PNG holding only its signature, the IHDR chunk with this size, and IEND: enough for a header read of its size. */
function pngHeader(width: number, height: number): Buffer {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "ascii");
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    ihdr.writeUInt8(8, 16);
    const iend = Buffer.alloc(12);
    iend.write("IEND", 4, "ascii");
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, iend]);
}

/** A Vision block at a pixel rectangle of a 1000×500 frame (normalized, bottom-left origin, as Vision reports it). */
function blockAt(text: string, x: number, y: number, width: number, height: number) {
    return {
        text,
        confidence: 1,
        bounds: { x: x / 1000, y: 1 - (y + height) / 500, width: width / 1000, height: height / 500 },
    };
}

describe("OCR read savings: which kept frames are read", () => {
    const size = () => ({ width: 1000, height: 500 });
    const previous = [blockAt("Agenda", 100, 50, 200, 20)];
    const on = { threshold: 1, skipTextless: true, region: "frame" } as const;

    test("a frame without a previous read, without motion facts, or not a change is read whole", () => {
        const change = { changePercent: 0.2, reason: "change", motionBoxes: [[600, 300, 40, 40]] as MotionBox[] };

        expect(planRead({ frame: change, settings: on, previous: undefined, size })).toEqual({ kind: "frame" });
        expect(
            planRead({ frame: { ...change, motionBoxes: undefined }, settings: on, previous, size }),
            "a streamed frame has no change percent: it is never skipped"
        ).toEqual({ kind: "frame" });
        expect(planRead({ frame: { ...change, reason: "first" }, settings: on, previous, size })).toEqual({
            kind: "frame",
        });
        expect(planRead({ frame: { ...change, reason: "display-switch" }, settings: on, previous, size })).toEqual({
            kind: "frame",
        });
    });

    test("a change below the OCR threshold skips; the default threshold 0 never does", () => {
        const frame = { changePercent: 0.5, reason: "change", motionBoxes: [[100, 50, 16, 16]] as MotionBox[] };

        expect(planRead({ frame, settings: on, previous, size })).toEqual({ kind: "skip", reason: "below-threshold" });
        expect(
            planRead({ frame: { ...frame, reason: "heartbeat", motionBoxes: [] }, settings: on, previous, size })
        ).toEqual({
            kind: "skip",
            reason: "below-threshold",
        });
        expect(planRead({ frame, settings: OCR_READ_DEFAULTS, previous, size })).toEqual({ kind: "frame" });
    });

    test("only a changed area with no text before is checked, padded and inside the frame", () => {
        const at = (motionBoxes: MotionBox[]) => ({ changePercent: 3, reason: "change", motionBoxes });

        expect(planRead({ frame: at([[600, 300, 40, 40]]), settings: on, previous, size })).toEqual({
            kind: "area",
            areas: [{ x: 576, y: 276, width: 88, height: 88 }],
            checkTextless: true,
            readArea: false,
        });
        expect(planRead({ frame: at([[980, 490, 16, 16]]), settings: on, previous, size })).toEqual({
            kind: "area",
            areas: [{ x: 956, y: 466, width: 44, height: 34 }],
            checkTextless: true,
            readArea: false,
        });
        expect(planRead({ frame: at([[250, 60, 16, 16]]), settings: on, previous, size }), "text was there").toEqual({
            kind: "frame",
        });
        expect(planRead({ frame: at([[0, 0, 800, 400]]), settings: on, previous, size }), "most of the frame").toEqual({
            kind: "frame",
        });
        expect(
            planRead({ frame: at([[600, 300, 40, 40]]), settings: { ...on, skipTextless: false }, previous, size })
        ).toEqual({
            kind: "frame",
        });
    });

    test("a skipped frame keeps the previous text of its display and says why in its row", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-frame-skip-"));
        const rows: OcrRow[] = [];
        const calls: string[] = [];
        let cropText = "";
        const output = new FrameOutput({
            folder: dir,
            naming: "elapsed",
            format: { kind: "original" },
            crop: async (_source, target, box) => {
                calls.push(`crop ${box.x},${box.y},${box.width}x${box.height}`);
                writeFileSync(target, pngHeader(box.width, box.height));
            },
            ocr: {
                settings: () => ({ enabled: true, languages: ["en-US"], minChars: 0, ...on }),
                sink: { write: (row) => rows.push(row) },
                recognize: async (image, _languages, options) => {
                    const crop = image.includes("gt-ocr-crop-");
                    calls.push(`${crop ? "crop" : "frame"} read ${options?.level ?? "accurate"}`);
                    return crop
                        ? { text: cropText, blocks: cropText ? [blockAt(cropText, 0, 0, 10, 10)] : [] }
                        : {
                              text: `Agenda ${calls.length}`,
                              blocks: [blockAt(`Agenda ${calls.length}`, 100, 50, 200, 20)],
                          };
                },
            },
        });
        let n = 0;
        const keep = (frame: Omit<CapturedFrame, "path" | "atMs">, displayId = 2) => {
            const path = join(dir, `in-${++n}.png`);
            writeFileSync(path, pngHeader(1000, 500));
            return output.keep({ path, atMs: 0, ...frame }, { atMs: 1_000 * n, originMs: 0, displayId });
        };

        await keep({ changePercent: 100, reason: "first", motionBoxes: [] });
        const small = await keep({ changePercent: 0.4, reason: "change", motionBoxes: [[100, 50, 16, 16]] });
        await keep({ changePercent: 4, reason: "change", motionBoxes: [[600, 300, 40, 40]] });
        cropText = "New";
        await keep({ changePercent: 4, reason: "change", motionBoxes: [[600, 300, 40, 40]] });
        await keep({ changePercent: 0.4, reason: "change", motionBoxes: [[100, 50, 16, 16]] }, 4);

        expect(calls).toEqual([
            "frame read accurate",
            "crop 576,276,88x88",
            "crop read fast",
            "crop 576,276,88x88",
            "crop read fast",
            "frame read accurate",
            "frame read accurate",
        ]);
        expect(rows.map((row) => [row.displayId, row.text, row.skipped])).toEqual([
            [2, "Agenda 1", undefined],
            [2, "Agenda 1", "below-threshold"],
            [2, "Agenda 1", "no-text"],
            [2, "Agenda 6", undefined],
            [4, "Agenda 7", undefined],
        ]);
        expect(rows[1]?.blocks).toEqual(rows[0]?.blocks ?? []);
        expect(small.read?.text).toBe("Agenda 1");
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith(`gt-ocr-crop-${process.pid}-`))).toEqual([]);
    });

    test("scattered changes stay apart areas, overlapping ones join, and at most four are read", () => {
        // Two corners of the frame: their joined box would be the whole frame, the two areas are under 1% of it.
        const corners = changedAreas({
            boxes: [
                [0, 0, 16, 16],
                [976, 476, 16, 16],
            ],
            previous: [],
            size: size(),
        });

        expect(corners).toEqual([
            { x: 0, y: 0, width: 40, height: 40 },
            { x: 952, y: 452, width: 48, height: 48 },
        ]);
        expect(
            planRead({
                frame: {
                    changePercent: 3,
                    reason: "change",
                    motionBoxes: [
                        [0, 0, 16, 16],
                        [976, 476, 16, 16],
                    ],
                },
                settings: { threshold: 0, skipTextless: false, region: "changed" },
                previous,
                size,
            })
        ).toEqual({ kind: "area", areas: corners, checkTextless: false, readArea: true });
        expect(
            changedAreas({
                boxes: [
                    [100, 100, 16, 16],
                    [130, 100, 16, 16],
                ],
                previous: [],
                size: size(),
            })
        ).toEqual([{ x: 76, y: 76, width: 94, height: 64 }]);

        const six = changedAreas({
            boxes: [0, 1, 2, 3, 4, 5].map((index): MotionBox => [index * 160, 200, 16, 16]),
            previous: [],
            size: size(),
        });

        expect(six).toHaveLength(4);
        expect(six.reduce((sum, box) => sum + box.width * box.height, 0)).toBeLessThan(0.5 * 1000 * 500);
    });

    test("a read of a crop moves its blocks into the whole frame's coordinates", () => {
        const moved = blockInFrame(
            { text: "New", confidence: 1, bounds: { x: 0.25, y: 0.5, width: 0.5, height: 0.2 } },
            { x: 500, y: 200, width: 200, height: 100 },
            { width: 1000, height: 500 }
        );

        expect(pixelBox(moved.bounds, { width: 1000, height: 500 })).toEqual({
            x: 550,
            y: 230,
            width: 100,
            height: 20,
        });
    });

    test("an area read replaces the lines inside the area, keeps the rest, and drops cut-off copies at its edge", () => {
        const previous = {
            text: "Agenda\nOld\nEdge",
            blocks: [
                blockAt("Agenda", 100, 50, 200, 20),
                blockAt("Old", 550, 230, 100, 20),
                blockAt("Edge", 640, 270, 200, 20),
            ],
        };
        // The crop at (500, 200), 200×100: "New" where "Old" was, and "Edg", the cut-off left part of "Edge".
        const read = {
            text: "New\nEdg",
            blocks: [
                { text: "New", confidence: 1, bounds: { x: 0.25, y: 0.5, width: 0.5, height: 0.2 } },
                { text: "Edg", confidence: 1, bounds: { x: 0.7, y: 0.1, width: 0.3, height: 0.2 } },
            ],
        };
        const merged = mergeAreaRead({
            previous,
            area: { x: 500, y: 200, width: 200, height: 100 },
            read,
            size: { width: 1000, height: 500 },
        });

        expect(merged.text).toBe("Agenda\nNew\nEdge");
        expect(merged.blocks.map((block) => pixelBox(block.bounds, { width: 1000, height: 500 }))).toEqual([
            { x: 100, y: 50, width: 200, height: 20 },
            { x: 550, y: 230, width: 100, height: 20 },
            { x: 640, y: 270, width: 200, height: 20 },
        ]);
        expect(
            mergeAreaRead({ previous, area: { x: 0, y: 400, width: 100, height: 100 }, read, size: size() }).text
        ).toBe("Agenda\nOld\nEdge\nNew\nEdg");
    });

    test("with region changed, an area that touches a line grows to hold the whole line and is read alone", async () => {
        const changed = { threshold: 0, skipTextless: false, region: "changed" } as const;

        expect(
            planRead({
                frame: { changePercent: 3, reason: "change", motionBoxes: [[250, 60, 16, 16]] },
                settings: changed,
                previous,
                size,
            })
        ).toEqual({
            kind: "area",
            areas: [{ x: 100, y: 36, width: 200, height: 64 }],
            checkTextless: false,
            readArea: true,
        });

        const dir = mkdtempSync(join(tmpdir(), "gt-frame-area-"));
        const rows: OcrRow[] = [];
        const calls: string[] = [];
        const output = new FrameOutput({
            folder: dir,
            naming: "elapsed",
            format: { kind: "original" },
            crop: async (_source, target, box) => {
                calls.push(`crop ${box.x},${box.y},${box.width}x${box.height}`);
                writeFileSync(target, pngHeader(box.width, box.height));
            },
            ocr: {
                settings: () => ({ enabled: true, languages: ["en-US"], minChars: 0, ...changed }),
                sink: { write: (row) => rows.push(row) },
                recognize: async (image, _languages, options) => {
                    const crop = image.includes("gt-ocr-crop-");
                    calls.push(`${crop ? "crop" : "frame"} read fallback ${options?.fastFallback ?? true}`);
                    // The crop's own coordinates: "Agenda 2" fills its middle, as the whole line did in the frame.
                    return crop
                        ? {
                              text: "Agenda 2",
                              blocks: [
                                  {
                                      text: "Agenda 2",
                                      confidence: 1,
                                      bounds: { x: 0, y: 30 / 64, width: 1, height: 20 / 64 },
                                  },
                              ],
                          }
                        : {
                              text: "Agenda\nClock",
                              blocks: [blockAt("Agenda", 100, 50, 200, 20), blockAt("Clock", 900, 10, 80, 20)],
                          };
                },
            },
        });
        let n = 0;
        const keep = (frame: Omit<CapturedFrame, "path" | "atMs">) => {
            const path = join(dir, `in-${++n}.png`);
            writeFileSync(path, pngHeader(1000, 500));
            return output.keep({ path, atMs: 0, ...frame }, { atMs: 1_000 * n, originMs: 0, displayId: 2 });
        };

        await keep({ changePercent: 100, reason: "first", motionBoxes: [] });
        await keep({ changePercent: 3, reason: "change", motionBoxes: [[250, 60, 16, 16]] });
        await keep({ changePercent: 60, reason: "change", motionBoxes: [[0, 0, 1000, 500]] });

        expect(calls).toEqual([
            "frame read fallback true",
            "crop 100,36,200x64",
            "crop read fallback false",
            "frame read fallback true",
        ]);
        expect(rows.map((row) => [row.text, row.regions])).toEqual([
            ["Agenda\nClock", undefined],
            ["Agenda 2\nClock", [[100, 36, 200, 64]]],
            ["Agenda\nClock", undefined],
        ]);
        expect(pixelBox(rows[1]?.blocks[0]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }, size())).toEqual({
            x: 100,
            y: 50,
            width: 200,
            height: 20,
        });
    });

    test("with the default settings every kept frame is read whole and no row says skipped", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-frame-skip-"));
        const rows: OcrRow[] = [];
        let reads = 0;
        const output = new FrameOutput({
            folder: dir,
            naming: "elapsed",
            format: { kind: "original" },
            crop: async () => {
                throw new Error("no crop with the defaults");
            },
            ocr: {
                settings: () => ({ enabled: true, languages: ["en-US"], minChars: 0, ...OCR_READ_DEFAULTS }),
                sink: { write: (row) => rows.push(row) },
                recognize: async () => ({ text: `read ${++reads}`, blocks: [] }),
            },
        });

        for (const [index, frame] of [
            { changePercent: 100, reason: "first", motionBoxes: [] as MotionBox[] },
            { changePercent: 0.1, reason: "change", motionBoxes: [[600, 300, 40, 40]] as MotionBox[] },
            { changePercent: 0, reason: "heartbeat", motionBoxes: [] as MotionBox[] },
        ].entries()) {
            const path = join(dir, `in-${index}.png`);
            writeFileSync(path, pngHeader(1000, 500));
            await output.keep({ path, atMs: 0, ...frame }, { atMs: 1_000 * (index + 1), originMs: 0, displayId: 2 });
        }

        expect(rows.map((row) => row.text)).toEqual(["read 1", "read 2", "read 3"]);
        expect(rows.every((row) => !("skipped" in row))).toBe(true);
    });
});

/** The structure of a JSON value: each leaf is its type name, an array is the shape of its first item. */
function shapeOf(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.length > 0 ? [shapeOf(value[0])] : [];
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item)]));
    }

    return value === null ? "null" : typeof value;
}

describe("characterization: what a library recording asks its recorder for", () => {
    const left: DisplayInfo = { id: 1, index: 0, name: "left", main: true, widthPt: 64, heightPt: 40, scale: 1 };
    const right: DisplayInfo = { id: 4, index: 1, name: "right", main: false, widthPt: 64, heightPt: 40, scale: 1 };

    /** Each capture: `frames` (two frames) or `empty`, then it waits out its piece or the abort. */
    class ScriptRecorder extends FrameRecorder {
        readonly id = "native" as const;
        readonly requests: CaptureRequest[] = [];
        readonly commands: string[] = [];
        started = Promise.withResolvers<void>();
        /** The live mute command throws. */
        muteFails = false;
        /** The live mute command of this display's capture throws. */
        muteFailsOn?: number;
        /** The device list throws. */
        devicesFail = false;
        /** The live switch throws this. */
        switchFails?: Error;
        /** The live switch waits for this before it answers. */
        switchGate?: Promise<void>;
        private readonly waiters: Array<{ count: number; resolve: () => void }> = [];
        private readonly running = new Map<() => void, number>();

        /** Ends every running capture (or those of one display) as if its piece had run out. */
        finishAll(displayId?: number): void {
            for (const [finish, display] of this.running) {
                if (displayId === undefined || display === displayId) {
                    finish();
                }
            }
        }

        constructor(
            private readonly script: {
                step?: "frames" | "empty";
                audio?: boolean;
                liveSettings?: boolean;
                /** The live channel also mutes and switches the microphone. */
                liveAudio?: boolean;
                /** False: the capture offers no live channel. */
                live?: boolean;
                /** Each capture announces its frame as it lands (`onFrame`). */
                stream?: boolean;
            } = {}
        ) {
            super();
        }

        /** Resolves once `count` captures have started (and offered their live channel). */
        waitFor(count: number): Promise<void> {
            if (this.requests.length >= count) {
                return Promise.resolve();
            }

            const waiter = Promise.withResolvers<void>();
            this.waiters.push({ count, resolve: waiter.resolve });
            return withTimeout(waiter.promise, 3_000);
        }

        override async audioDevices() {
            if (this.devicesFail) {
                throw new Error("ax-tool audio-devices exited 1");
            }

            return {
                inputs: [
                    { id: "built-in-mic", name: "Built-in Microphone", channels: 1, default: true },
                    { id: "desk-mic", name: "Desk Mic", channels: 1, default: false },
                ],
                outputs: [],
            };
        }

        get supports(): FrameRecorderSupport {
            return {
                followFocus: false,
                displayId: true,
                motionBoxes: false,
                heartbeat: false,
                liveControl: true,
                parallelCaptures: true,
                audio: this.script.audio === true,
            };
        }

        async available(): Promise<{ ok: true }> {
            return { ok: true };
        }

        async displays(): Promise<DisplayInfo[]> {
            return [left, right];
        }

        async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
            this.requests.push(request);
            const startedAtMs = Date.now();
            const displayId = request.target.kind === "display" ? request.target.displayId : 0;

            if (this.script.live !== false) {
                request.hooks?.onLive?.({
                    switchDisplay: async (id) => {
                        await this.switchGate;

                        if (this.switchFails) {
                            throw this.switchFails;
                        }

                        this.commands.push(`switch ${id}`);
                    },
                    pause: () => this.commands.push(`pause ${displayId}`),
                    resume: () => this.commands.push(`resume ${displayId}`),
                    ...(this.script.liveSettings
                        ? {
                              setRates: async (active: number, idle: number) => {
                                  this.commands.push(`rates ${displayId} ${active} ${idle}`);
                              },
                              setThreshold: async (percent: number) => {
                                  this.commands.push(`threshold ${displayId} ${percent}`);
                              },
                              setMaxLongSide: async (px: number) => {
                                  this.commands.push(`long side ${displayId} ${px}`);
                              },
                          }
                        : {}),
                    ...(this.script.liveAudio
                        ? {
                              mute: async (source: string, muted: boolean) => {
                                  if (this.muteFails || this.muteFailsOn === displayId) {
                                      throw new Error("the capture did not take the mute");
                                  }

                                  this.commands.push(`${muted ? "mute" : "unmute"} ${displayId} ${source}`);
                              },
                              setMic: async (deviceId: string) => {
                                  this.commands.push(`mic ${displayId} ${deviceId}`);
                              },
                          }
                        : {}),
                });
            }

            this.started.resolve();

            for (const waiter of this.waiters.filter((one) => one.count <= this.requests.length)) {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                waiter.resolve();
            }
            mkdirSync(request.outDir, { recursive: true });
            const frames: CaptureResult["frames"] = [];

            if (this.script.step !== "empty") {
                const path = join(request.outDir, "keep-0.png");
                writeFileSync(path, "png");
                frames.push({ path, atMs: 0, displayId, changePercent: 5, reason: "first" });

                if (this.script.stream) {
                    request.hooks?.onFrame?.(frames[0]!);
                }
            }

            await new Promise<void>((resolve) => {
                const finish = () => {
                    clearTimeout(timer);
                    this.running.delete(finish);
                    resolve();
                };
                const timer = setTimeout(finish, request.durationSec * 1000);
                this.running.set(finish, displayId);
                signal?.addEventListener("abort", finish);
            });
            return { startedAtMs, frames };
        }
    }

    const start = (recorder: ScriptRecorder, options: Partial<Parameters<typeof startRecording>[0]> = {}) => {
        const root = mkdtempSync(join(tmpdir(), "gt-lib-char-"));
        return startRecording({
            recorder,
            folder: join(root, "rec"),
            liveDir: join(root, "live"),
            maxDurationSec: 30,
            pieceSec: 5,
            ...options,
        } as Parameters<typeof startRecording>[0] & { recorder: FrameRecorder });
    };

    test("stage 2: main, all, ids (deduplicated), an index, an unknown id, and follow-focus refused without the recorder's support", async () => {
        const shown = async (displays: "all" | "main" | number[]) => {
            const recording = await start(new ScriptRecorder(), { displays });
            const status = await recording.status();
            await recording.stop();
            return status.displays.map((one) => one.id);
        };

        expect(await shown("main")).toEqual([1]);
        expect(await shown("all")).toEqual([1, 4]);
        expect(await shown([4, 4])).toEqual([4]);
        await expect(start(new ScriptRecorder(), { displays: [99] })).rejects.toMatchObject({
            code: RPC_ERRORS.unknownDisplay,
        });

        const recording = await start(new ScriptRecorder());
        expect((await recording.setDisplayMode(1)).chosen).toEqual([4]);
        // Follow-focus is one capture that follows the focus; a recorder that cannot leaves the choice as it was.
        await expect(recording.setDisplayMode("follow-focus")).rejects.toMatchObject({ code: RPC_ERRORS.unsupported });
        expect((await recording.status()).displays.map((one) => one.id)).toEqual([4]);
        expect((await recording.setDisplayMode("main")).chosen).toEqual([1]);
        await recording.stop();
    });

    test("stage 3: one capture per display per piece, the sound on every capture, numbered outDirs, the piece cut to the time left", async () => {
        const recorder = new ScriptRecorder({ audio: true });
        const recording = await start(recorder, {
            displays: "all",
            audio: { mic: true },
            maxDurationSec: 0.5,
            pieceSec: 0.4,
        });
        expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 5_000 })).toBe(true);
        await recording.stop();
        const shape = recorder.requests.map((request) => ({
            target: request.target,
            outDir: request.outDir.split("/").slice(-2).join("/"),
            audio: request.audio,
            durationSec: request.durationSec,
        }));

        expect(shape.slice(0, 2)).toEqual([
            {
                target: { kind: "display", displayId: 1 },
                outDir: ".pieces/d1-1",
                audio: { sources: ["mic"] },
                durationSec: 0.4,
            },
            {
                target: { kind: "display", displayId: 4 },
                outDir: ".pieces/d4-2",
                audio: { sources: ["mic"] },
                durationSec: 0.4,
            },
        ]);
        expect(shape[2]).toMatchObject({ outDir: ".pieces/d1-3", durationSec: 0.4 });
    });

    test("stage 3: three pieces in a row without a frame end the recording with a warning", async () => {
        const recorder = new ScriptRecorder({ step: "empty" });
        const recording = await start(recorder, { maxDurationSec: 30, pieceSec: 0.05 });
        expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 5_000 })).toBe(true);
        const answer = await recording.stop();

        expect(recorder.requests).toHaveLength(3);
        expect(answer.notes).toContain("three captures in a row recorded nothing; the recording ends");
    });

    test("stage 4: settings change live through every capture, else restart; heartbeat always restarts; pause and resume go live", async () => {
        const live = new ScriptRecorder({ liveSettings: true });
        const recording = await start(live, { displays: "all" });
        await live.started.promise;
        await Bun.sleep(20);

        expect(await recording.setSettings({ activeFps: 3, idleFps: 1, threshold: 4 })).toMatchObject({
            applied: "live",
        });
        expect((await recording.setSettings({ ocr: { minChars: 3 } })).applied).toBe("live");
        expect(await recording.pause()).toEqual({ state: "paused" });
        expect(await recording.resume()).toEqual({ state: "recording" });
        expect(live.commands.sort()).toEqual(
            [
                "rates 1 3 1",
                "rates 4 3 1",
                "threshold 1 4",
                "threshold 4 4",
                "pause 1",
                "pause 4",
                "resume 1",
                "resume 4",
            ].sort()
        );
        expect((await recording.setSettings({ heartbeatSec: 5 })).applied).toBe("restart");
        await recording.stop();

        const plain = new ScriptRecorder();
        const restarted = await start(plain, { displays: "main" });
        await plain.started.promise;
        plain.started = Promise.withResolvers<void>();
        expect((await restarted.setSettings({ activeFps: 3 })).applied).toBe("restart");
        await plain.started.promise;
        await restarted.stop();
        expect(plain.requests.map((request) => request.activeFps)).toEqual([2, 3]);
    });

    test("stage 5 (displays): add, remove and mode restart over the chosen ids, the last display stays, and a live switch moves the running capture", async () => {
        const recorder = new ScriptRecorder();
        const recording = await start(recorder, { displays: "main" });
        await recorder.waitFor(1);

        expect(await recording.listDisplays()).toEqual([
            { ...left, recorded: true },
            { ...right, recorded: false },
        ]);
        expect(await recording.addDisplay(4)).toEqual({ mode: "all", chosen: [1, 4], applied: "restart" });
        await recorder.waitFor(3);
        expect((await recording.status()).displays).toEqual([
            { id: 1, name: "left" },
            { id: 4, name: "right" },
        ]);
        expect(await recording.removeDisplay(1)).toEqual({ mode: "all", chosen: [4], applied: "restart" });
        await recorder.waitFor(4);
        await expect(recording.removeDisplay(4)).rejects.toMatchObject({ code: RPC_ERRORS.lastDisplay });
        await expect(recording.addDisplay(99)).rejects.toMatchObject({ code: RPC_ERRORS.unknownDisplay });
        expect(await recording.switchDisplay(1)).toEqual({ mode: "all", chosen: [1], applied: "live" });
        expect((await recording.status()).displays).toEqual([{ id: 1, name: "left" }]);
        expect(await recording.listDisplays()).toEqual([
            { ...left, recorded: true },
            { ...right, recorded: false },
        ]);
        await recording.stop();

        expect(recorder.commands).toEqual(["switch 1"]);
        expect(recorder.requests.map((request) => request.target)).toEqual([
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 4 },
            { kind: "display", displayId: 4 },
        ]);
    });

    test("stage 6 (sound): a mute goes live to every capture and an unmute restarts them, an unrecorded source is refused as unsupported, and a microphone switch goes live or restarts", async () => {
        const recorder = new ScriptRecorder({ audio: true, liveAudio: true });
        const recording = await start(recorder, { displays: "all", audio: { mic: true } });
        await recorder.waitFor(2);

        expect(await recording.muteAudio("mic", true)).toMatchObject({
            sources: ["mic"],
            muted: { mic: true, system: false },
        });
        await expect(recording.muteAudio("system", true)).rejects.toMatchObject({ code: RPC_ERRORS.unsupported });
        expect(await recording.setAudioInput("desk-mic")).toMatchObject({ micDevice: "desk-mic" });
        expect(recorder.commands.sort()).toEqual(["mic 1 desk-mic", "mic 4 desk-mic", "mute 1 mic", "mute 4 mic"]);
        expect(await recording.muteAudio("mic", false)).toMatchObject({ muted: { mic: false, system: false } });
        await recorder.waitFor(4);
        await recording.stop();

        expect(recorder.requests.map((request) => request.audio)).toEqual([
            { sources: ["mic"] },
            { sources: ["mic"] },
            { sources: ["mic"], micDeviceId: "desk-mic" },
            { sources: ["mic"], micDeviceId: "desk-mic" },
        ]);

        const plain = new ScriptRecorder({ audio: true });
        const restarted = await start(plain, { displays: "main", audio: { mic: true } });
        await plain.waitFor(1);
        expect(await restarted.setAudioInput("desk-mic")).toMatchObject({ micDevice: "desk-mic" });
        await plain.waitFor(2);
        await restarted.stop();
        expect(plain.requests.map((request) => request.audio?.micDeviceId)).toEqual([undefined, "desk-mic"]);
    });

    test("sound: an unknown microphone is refused, a failed device list is unsupported, an unmute of a source that is not muted restarts nothing, and a failed live mute changes nothing", async () => {
        const recorder = new ScriptRecorder({ audio: true, liveAudio: true });
        const recording = await start(recorder, { displays: "all", audio: { mic: true } });
        await recorder.waitFor(2);

        await expect(recording.setAudioInput("nope")).rejects.toMatchObject({ code: RPC_ERRORS.unknownDevice });
        expect(await recording.muteAudio("mic", false)).toMatchObject({ muted: { mic: false, system: false } });
        recorder.muteFails = true;
        await expect(recording.muteAudio("mic", true)).rejects.toMatchObject({ code: RPC_ERRORS.internal });
        expect((await recording.getSettings()).audio.muted.mic).toBe(false);
        recorder.devicesFail = true;
        await expect(recording.listAudioDevices()).rejects.toMatchObject({ code: RPC_ERRORS.unsupported });
        await Bun.sleep(50);
        expect(recorder.requests).toHaveLength(2);
        await recording.stop();
    });

    test("sound: a mute that only some captures take restarts every capture, so none stays silent under an unmuted state", async () => {
        const recorder = new ScriptRecorder({ audio: true, liveAudio: true });
        const recording = await start(recorder, { displays: "all", audio: { mic: true } });
        await recorder.waitFor(2);

        recorder.muteFailsOn = 4;
        await expect(recording.muteAudio("mic", true)).rejects.toMatchObject({ code: RPC_ERRORS.internal });
        expect(recorder.commands).toEqual(["mute 1 mic"]);
        expect((await recording.getSettings()).audio.muted.mic).toBe(false);
        await recorder.waitFor(4);
        expect(recorder.requests.slice(2).map((request) => request.audio)).toEqual([
            { sources: ["mic"] },
            { sources: ["mic"] },
        ]);
        await recording.stop();
    });

    test("the live frame count keeps each running capture's streamed frames, the status carries the last frame time, and a frame event says when", async () => {
        const recorder = new ScriptRecorder({ stream: true });
        const recording = await start(recorder, { displays: "all" });
        await recorder.waitFor(2);
        const client = await RecorderClient.connect(recording.id, { dir: join(recording.folder, "..", "live") });
        const events: unknown[] = [];
        await client.subscribe((event) => events.push(event.params), ["frame"]);

        expect(await recording.status()).toMatchObject({ frames: 2, lastFrameAt: expect.any(String) });
        recorder.finishAll(1);
        await Bun.sleep(50);
        expect((await recording.status()).frames).toBe(2);
        expect((await recording.setSettings({ heartbeatSec: 5 })).applied).toBe("restart");
        await recorder.waitFor(4);
        await Bun.sleep(50);
        client.close();
        await recording.stop();

        expect(events).toEqual([
            { displayId: 1, at: expect.any(String), file: expect.stringContaining("keep-0.png") },
            { displayId: 4, at: expect.any(String), file: expect.stringContaining("keep-0.png") },
        ]);
    });

    test("a discard whose move to the trash was refused fails and keeps the folder, instead of answering discarded", async () => {
        const recorder = new ScriptRecorder();
        const recording = await start(recorder);
        await recorder.waitFor(1);
        const refused = spyOn(rm, "moveToTrash").mockReturnValue(null);

        try {
            await expect(recording.discard()).rejects.toThrow("changed before it could be discarded");
            expect(refused).toHaveBeenCalledTimes(1);
            expect(existsSync(recording.folder)).toBe(true);
        } finally {
            refused.mockRestore();
        }
    });

    test("an error in the capture loop ends the library recording by itself, with the finish and the reason in its notes", async () => {
        const recorder = new ScriptRecorder();
        const recording = await start(recorder, { displays: "main" });
        await recorder.waitFor(1);
        // The next capture's folder cannot be made: a file holds its name.
        writeFileSync(join(recording.folder, ".pieces", "d1-2"), "taken");
        recorder.finishAll();

        expect(await withTimeout(recording.finished, 3_000)).toMatchObject({
            state: "stopped",
            outcome: "done",
            notes: [expect.stringContaining("the recording stopped on an error")],
        });
        expect(recorder.requests).toHaveLength(1);
        expect(readRecordingManifest(recording.folder)?.frames).toHaveLength(1);
    });

    test("a live switch answers a missing display as unknownDisplay, and a switch whose capture ended meanwhile restarts instead of reviving it", async () => {
        const recorder = new ScriptRecorder();
        const recording = await start(recorder, { displays: "main" });
        await recorder.waitFor(1);
        recorder.switchFails = new CaptureError("display-missing", "display 4 left");

        await expect(recording.switchDisplay(4)).rejects.toMatchObject({ code: RPC_ERRORS.unknownDisplay });

        recorder.switchFails = undefined;
        const gate = Promise.withResolvers<void>();
        recorder.switchGate = gate.promise;
        const switching = recording.switchDisplay(4);
        recorder.finishAll();
        await recorder.waitFor(2);
        gate.resolve();

        expect(await switching).toEqual({ mode: "all", chosen: [4], applied: "restart" });
        await recorder.waitFor(3);
        await recording.stop();
        expect(recorder.requests.map((request) => request.target)).toEqual([
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 4 },
        ]);
    });

    test("stage 7 (pause): a pause without a live channel ends the piece, no capture starts while paused, and resume starts the next", async () => {
        const recorder = new ScriptRecorder({ live: false });
        const recording = await start(recorder);
        await recorder.waitFor(1);

        expect(await recording.pause()).toEqual({ state: "paused" });
        await Bun.sleep(80);
        expect(recorder.requests).toHaveLength(1);
        expect((await recording.status()).state).toBe("paused");
        await expect(recording.pause()).rejects.toMatchObject({ code: RPC_ERRORS.alreadyPaused });
        expect(await recording.resume()).toEqual({ state: "recording" });
        await recorder.waitFor(2);
        await expect(recording.resume()).rejects.toMatchObject({ code: RPC_ERRORS.notPaused });
        const answer = await recording.stop();

        expect(answer).toMatchObject({ state: "stopped", outcome: "done", frames: 2 });
        await expect(recording.pause()).rejects.toMatchObject({ code: RPC_ERRORS.alreadyStopped });
    });

    test("stage 8 (shapes): the status while it records, and recording.json after", async () => {
        const recorder = new ScriptRecorder();
        const recording = await start(recorder, { displays: "all", title: "Demo" });
        await recorder.waitFor(2);

        expect(await recording.status()).toEqual({
            kind: "library",
            title: "Demo",
            state: "recording",
            displays: [
                { id: 1, name: "left" },
                { id: 4, name: "right" },
            ],
            frames: 0,
            folder: recording.folder,
        });
        await recording.stop();
        const manifest = SafeJSON.parse(readFileSync(join(recording.folder, "recording.json"), "utf8"), {
            strict: true,
        });

        expect(shapeOf(manifest)).toEqual({
            version: "number",
            id: "string",
            title: "string",
            startedAt: "string",
            endedAt: "string",
            displays: [{ id: "number", name: "string" }],
            settings: {
                activeFps: "number",
                idleFps: "number",
                threshold: "number",
                maxLongSide: "number",
                heartbeatSec: "number",
                ocr: {
                    enabled: "boolean",
                    languages: ["string"],
                    minChars: "number",
                    threshold: "number",
                    skipTextless: "boolean",
                    region: "string",
                },
                audio: { sources: [], muted: { mic: "boolean", system: "boolean" } },
                tracks: [],
            },
            frames: [
                { file: "string", atMs: "number", displayId: "number", changePercent: "number", reason: "string" },
            ],
            warnings: [],
        });
        expect(manifest.displays).toEqual([
            { id: 1, name: "left" },
            { id: 4, name: "right" },
        ]);
    });

    test("stage 9 (markers): marker.add over the socket at its movie time, a pause included, saved into recording.json at once, refused while paused or stopping", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-lib-marker-"));
        const liveDir = join(root, "live");
        const recorder = new ScriptRecorder();
        const recording = await start(recorder, { liveDir, folder: join(root, "rec") });
        await recorder.waitFor(1);
        const client = await RecorderClient.connect(recording.id, { dir: liveDir });
        const before = Date.now();
        const first = await client.addMarker("login done");
        const after = Date.now();
        const saved = readRecordingManifest(recording.folder);
        await recording.pause();
        const paused = await client.addMarker("while paused").catch((error: unknown) => error);
        await Bun.sleep(150);
        await recording.resume();
        const second = await client.addMarker("after the pause");
        client.close();
        // The socket closes as soon as the finish ends, so the refusal while it stops is asked of the core itself.
        await recording.stop({ wait: false });
        const stopping = await recording.addMarker("too late").catch((error: unknown) => error);
        await recording.stop();
        const manifest = readRecordingManifest(recording.folder);
        const startedMs = recording.startedAt.getTime();

        expect(first.label).toBe("login done");
        expect(first.atMs).toBeGreaterThanOrEqual(before - startedMs);
        expect(first.atMs).toBeLessThanOrEqual(after - startedMs);
        // Saved while it records: the marker, no end time (a reader still sees it record), no frame out of place.
        expect(saved?.endedAt).toBeUndefined();
        expect(saved?.settings.markers).toEqual([first]);
        expect(saved?.frames).toEqual([]);
        expect(paused).toBeInstanceOf(RpcError);
        expect((paused as RpcError).code).toBe(RPC_ERRORS.unsupported);
        expect((paused as RpcError).message).toBe("a marker needs a running recording; this one is paused");
        // The movie holds the last frame through a pause, so the paused time is movie time.
        expect(second.atMs - first.atMs).toBeGreaterThanOrEqual(150);
        expect((stopping as RpcError).code).toBe(RPC_ERRORS.unsupported);
        expect((stopping as RpcError).message).toBe("a marker needs a running recording; this one is stopping");
        expect(recording.markers).toEqual([first, second]);
        expect(manifest?.endedAt).toEqual(expect.any(String));
        expect(manifest?.settings.markers).toEqual([first, second]);
        expect(manifest?.frames.length).toBeGreaterThan(0);
    });
});

test("native settings wait for the preceding command acknowledgement", async () => {
    const sent: string[] = [];
    const live = new NativeLiveCapture(
        (text) => sent.push(text),
        1,
        {},
        new Set(["set-max-long-side", "set-threshold"])
    );
    const resize = live.setMaxLongSide!(1200);
    const threshold = live.setThreshold!(2);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    live.receive('{"event":"settings"}');
    await resize;
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    live.receive('{"event":"settings"}');
    await threshold;
});

test("malformed native stderr is ignored without losing valid events", () => {
    const frames: string[] = [];
    const live = new NativeLiveCapture(() => undefined, 1, { onFrame: (frame) => frames.push(frame.path) });
    expect(() => live.receive("{unfinished")).not.toThrow();
    live.receive(SafeJSON.stringify({ event: "frame", path: "frame.png", timestampMs: 1, reason: "change" }));
    expect(frames).toEqual(["frame.png"]);
});

test("duplicate live recording ownership does not steal the first socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-owner-"));
    const options = { id: "same", kind: "meeting", title: "Fixture", dir, control: new TestControl() };
    const first = new LiveRecordingServer(options);
    let second: LiveRecordingServer | undefined;

    try {
        expect(() => {
            second = new LiveRecordingServer(options);
        }).toThrow();
        const client = await RecorderClient.connect("same", { dir });

        try {
            expect((await client.status()).title).toBe("Planning");
        } finally {
            client.close();
        }
    } finally {
        second?.close();
        first.close();
    }
});

test("peekaboo display output rejects incomplete JSON as a capture error", async () => {
    const commands = await import("@genesiscz/utils/process/bounded-command");
    const { PeekabooFrameRecorder } = await import("./peekaboo");
    const run = spyOn(commands, "boundedCommand").mockResolvedValue({
        status: 0,
        stdout: "{unfinished",
        stderr: "",
        signal: null,
    });

    try {
        await expect(new PeekabooFrameRecorder().displays()).rejects.toBeInstanceOf(CaptureError);
    } finally {
        run.mockRestore();
    }
});
