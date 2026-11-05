import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import {
    type DisplayEntry,
    RECORDER_DISPATCH,
    RecorderControl,
    type RecorderMethod,
    type RecorderState,
    type RecorderStatus,
    type StopAnswer,
} from "./control";
import { outputScaleFor, parseDisplayList } from "./displays";
import { FrameOutput, ocrSinkFor, SidecarOcrSink } from "./frame-output";
import { readRecordingManifest, renameRecording } from "./library";
import {
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
import { peekabooCaptureError } from "./peekaboo";
import { startRecording } from "./start";
import {
    CaptureError,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderSupport,
    type LiveCapture,
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
        let channel: LiveCapture | undefined;
        const controller = new AbortController();
        const capture = recorder.capture(
            {
                ...request({ outDir, durationSec: 30 }),
                hooks: {
                    onFrame: (frame) => streamed.push(frame.displayId),
                    onLive: (live) => {
                        channel = live;
                    },
                },
            },
            controller.signal
        );
        const deadline = Date.now() + 5_000;

        while ((streamed.length === 0 || !channel) && Date.now() < deadline) {
            await Bun.sleep(20);
        }

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

describe("live recordings", () => {
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
        await client.subscribe((event) => events.push(event), ["state", "ended"]);

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
        const deadline = Date.now() + 2_000;

        while (!events.some((event) => event.event === "ended") && Date.now() < deadline) {
            await Bun.sleep(20);
        }

        expect(events.map((event) => event.event)).toEqual(["state", "ended"]);
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
        const socket = await Bun.connect({
            unix: server.current.socket,
            socket: {
                data: (_socket, chunk) => {
                    received += new TextDecoder().decode(chunk);
                },
            },
        });
        socket.write(
            '{"jsonrpc":"2.0","id":1,"method":"subscribe"}\n{"jsonrpc":"2.0","id":2,"method":"displays.list"}\r\n{"jsonrpc":"2.0","id":3,"method":"status"}\n'
        );
        const deadline = Date.now() + 2_000;

        while (received.split("\n").filter(Boolean).length < 3 && Date.now() < deadline) {
            await Bun.sleep(10);
        }

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
                settings: () => ({ enabled, languages: ["en-US"], minChars: 4 }),
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
                settings: () => ({ enabled, languages: ["en-US"], minChars: 0 }),
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
                settings: () => ({ enabled: false, languages: [], minChars: 0 }),
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

describe("characterization: what a library recording asks its recorder for", () => {
    const left: DisplayInfo = { id: 1, index: 0, name: "left", main: true, widthPt: 64, heightPt: 40, scale: 1 };
    const right: DisplayInfo = { id: 4, index: 1, name: "right", main: false, widthPt: 64, heightPt: 40, scale: 1 };

    /** Each capture: `frames` (two frames) or `empty`, then it waits out its piece or the abort. */
    class ScriptRecorder extends FrameRecorder {
        readonly id = "native" as const;
        readonly requests: CaptureRequest[] = [];
        readonly commands: string[] = [];
        started = Promise.withResolvers<void>();

        constructor(
            private readonly script: { step?: "frames" | "empty"; audio?: boolean; liveSettings?: boolean } = {}
        ) {
            super();
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
            request.hooks?.onLive?.({
                switchDisplay: async (id) => {
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
            });
            this.started.resolve();
            mkdirSync(request.outDir, { recursive: true });
            const frames: CaptureResult["frames"] = [];

            if (this.script.step !== "empty") {
                const path = join(request.outDir, "keep-0.png");
                writeFileSync(path, "png");
                frames.push({ path, atMs: 0, displayId, changePercent: 5, reason: "first" });
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

    test("stage 2: main, all, ids (deduplicated), an index, an unknown id, and follow-focus records every display", async () => {
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
        expect((await recording.setDisplayMode("follow-focus")).chosen).toEqual([1, 4]);
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
