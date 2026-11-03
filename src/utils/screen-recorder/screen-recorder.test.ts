import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import {
    type DisplayEntry,
    RecorderControl,
    type RecorderMethod,
    type RecorderState,
    type RecorderStatus,
    type StopAnswer,
} from "./control";
import { outputScaleFor, parseDisplayList } from "./displays";
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
import { captureErrorKind, flagsInHelp, NativeFrameRecorder, nativeArgv } from "./native";
import { peekabooCaptureError } from "./peekaboo";
import { CaptureError, type CaptureRequest, type LiveCapture } from "./types";

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
    });
});

describe("a failed peekaboo capture", () => {
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

    test("another error is no missing display, and output without JSON keeps the log", () => {
        const denied = SafeJSON.stringify({ success: false, error: { message: "Screen Recording permission denied" } });

        expect(peekabooCaptureError(1, denied, stderr).kind).toBe("no-permission");
        expect(peekabooCaptureError(1, "", stderr).message).toBe(`peekaboo exited 1: ${stderr}`);
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

describe("live recordings", () => {
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
