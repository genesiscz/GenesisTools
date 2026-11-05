import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplEngine } from "@app/node-repl/lib/engine";
import { renderDocs } from "@genesiscz/utils/api-descriptor";
import { withTimeout } from "@genesiscz/utils/async";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import * as ocr from "@genesiscz/utils/macos/ocr";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { RecordingEditor } from "@genesiscz/utils/recording-editor/editor";
import type { ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { type Clip, EditorToolset, editorApi, ReplJob } from "@genesiscz/utils/repl/toolsets/editor";
import { RecordingHandle, recorderApi } from "@genesiscz/utils/repl/toolsets/recorder";
import { RecorderControl } from "@genesiscz/utils/screen-recorder/control";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import {
    LiveRecordingServer,
    liveRecordingsDir,
    RecorderClient,
    readLiveRecording,
} from "@genesiscz/utils/screen-recorder/live";
import { LibraryRecording, startRecording } from "@genesiscz/utils/screen-recorder/start";
import {
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderSupport,
    type LiveCapture,
} from "@genesiscz/utils/screen-recorder/types";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { createCanvas } from "@napi-rs/canvas";

/** Writes one PNG every 60 ms of a colour that changes with each frame, until the capture ends. */
class FakeRecorder extends FrameRecorder {
    readonly id = "native" as const;
    readonly supports: FrameRecorderSupport = {
        followFocus: false,
        displayId: true,
        motionBoxes: false,
        heartbeat: false,
        liveControl: true,
        parallelCaptures: true,
        audio: false,
    };
    readonly calls: string[] = [];

    async available(): Promise<{ ok: true }> {
        return { ok: true };
    }

    async displays(): Promise<DisplayInfo[]> {
        return [
            { id: 1, index: 0, name: "left", main: true, widthPt: 64, heightPt: 40, scale: 1 },
            { id: 4, index: 1, name: "right", main: false, widthPt: 64, heightPt: 40, scale: 1 },
        ];
    }

    async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        const startedAtMs = Date.now();
        let displayId = request.target.kind === "display" ? request.target.displayId : 0;
        let paused = false;
        const live: LiveCapture = {
            switchDisplay: async (to) => {
                this.calls.push(`switch ${to}`);
                displayId = to;
            },
            pause: () => {
                paused = true;
            },
            resume: () => {
                paused = false;
            },
            setRates: async (active) => {
                this.calls.push(`rates ${active}`);
            },
        };
        request.hooks?.onLive?.(live);
        this.calls.push(`capture ${displayId} fps ${request.activeFps}`);
        mkdirSync(request.outDir, { recursive: true });
        const frames: CaptureResult["frames"] = [];
        const deadline = startedAtMs + request.durationSec * 1000;

        while (!signal?.aborted && Date.now() < deadline) {
            if (!paused) {
                const canvas = createCanvas(64, 40);
                const context = canvas.getContext("2d");
                context.fillStyle = `rgb(${(frames.length * 40) % 256}, 80, ${displayId * 50})`;
                context.fillRect(0, 0, 64, 40);
                const path = join(request.outDir, `f${frames.length}.png`);
                await Bun.write(path, canvas.toBuffer("image/png"));
                const frame = { path, atMs: Date.now() - startedAtMs, displayId, changePercent: 50, reason: "change" };
                frames.push(frame);
                request.hooks?.onFrame?.(frame);
            }

            await Bun.sleep(60);
        }

        return { startedAtMs, frames };
    }
}

class ControlledRecorder extends FakeRecorder {
    readonly requests: CaptureRequest[] = [];
    finish: () => void = () => undefined;
    announce?: (request: CaptureRequest) => void;
    canMute = true;
    onSwitch?: () => Promise<void>;

    override async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        this.requests.push(request);
        const done = new Promise<void>((resolve) => {
            this.finish = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        request.hooks?.onLive?.({
            pause: () => undefined,
            resume: () => undefined,
            switchDisplay: async () => this.onSwitch?.(),
            ...(this.canMute ? { mute: async () => undefined } : {}),
        });
        this.announce?.(request);
        await done;
        return { startedAtMs: Date.now(), frames: [] };
    }

    next(): Promise<CaptureRequest> {
        return withTimeout(
            new Promise((resolve) => {
                this.announce = resolve;
            }),
            2_000
        );
    }
}

const shown: string[] = [];
const ctx: ToolsetContext = {
    scratchDir: tmpdir(),
    show: async (input) => {
        shown.push(String(input));
    },
    write: () => undefined,
};

describe("recorder and editor toolsets", () => {
    test("native preparation is excluded from the recording deadline and frame offsets", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-ready-"));
        const recorder = new FakeRecorder();
        let readyAt = 0;
        const preparation = Bun.sleep(150).then(() => {
            readyAt = Date.now();
        });
        recorder.available = async () => {
            await preparation;
            return { ok: true };
        };
        const recording = await startRecording({
            recorder,
            folder: join(root, "rec"),
            liveDir: join(root, "live"),
            maxDurationSec: 0.1,
        });
        expect(recording.startedAt.getTime()).toBeGreaterThanOrEqual(readyAt);
        expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 3_000 })).toBe(true);
        const manifest = readRecordingManifest(recording.folder)!;
        expect(manifest.frames.length).toBeGreaterThan(0);
        expect(manifest.frames[0].atMs).toBeLessThan(150);
    });

    test("parent startup expires at every async stage and late completion starts no capture", async () => {
        for (const stage of ["create", "available", "displays"]) {
            const gate = Promise.withResolvers<void>();
            const entered = Promise.withResolvers<void>();
            const recorder = new ControlledRecorder();
            const wait = async () => {
                entered.resolve();
                await gate.promise;
            };
            if (stage === "available") {
                recorder.available = async () => {
                    await wait();
                    return { ok: true };
                };
            }
            if (stage === "displays") {
                const displays = await recorder.displays();
                recorder.displays = async () => {
                    await wait();
                    return displays;
                };
            }
            const engine = new ReplEngine({
                toolsets: ["recorder"],
                preloadTimeoutMs: 1_000,
                recorder: {
                    create: async () => {
                        if (stage === "create") {
                            await wait();
                        }
                        return recorder;
                    },
                },
            });
            try {
                expect((await engine.run("true")).ok).toBe(true);
                const turn = engine.run("await recorder.start()", 100);
                await withTimeout(entered.promise, 2_000);
                expect((await turn).ok).toBe(false);
                await withTimeout(engine.reset(), 2_000);
                gate.resolve();
                await Bun.sleep(100);
                expect(recorder.requests).toHaveLength(0);
            } finally {
                gate.resolve();
                await engine.shutdown();
            }
        }
    }, 10_000);

    test("OCR sidecars include the minimum length and exclude a read one character shorter", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-ocr-boundary-"));
        const recorder = new FakeRecorder();
        const original = recorder.capture.bind(recorder);
        const captured = Promise.withResolvers<void>();
        let captures = 0;
        recorder.capture = async (request, signal) => {
            const result = await original({ ...request, durationSec: 0.01 }, signal);
            if (++captures === 2) {
                captured.resolve();
            }
            return result;
        };
        const recognize = spyOn(ocr, "recognizeText").mockImplementation(async (file) => ({
            text: file.endsWith("-d1.png") ? "abc" : "abcd",
            blocks: [],
        }));
        const recording = await startRecording({
            recorder,
            displays: "all",
            folder: join(root, "rec"),
            liveDir: join(root, "live"),
            ocr: { enabled: true, minChars: 4 },
        });
        try {
            await withTimeout(captured.promise, 2000);
            await recording.stop();
            const frames = readRecordingManifest(recording.folder)!.frames;
            expect(new Set(frames.map((frame) => frame.displayId))).toEqual(new Set([1, 4]));
            for (const frame of frames) {
                const sidecar = join(recording.folder, `${frame.file}.ocr.json`);
                expect(existsSync(sidecar)).toBe(frame.displayId === 4);
                if (frame.displayId === 4) {
                    expect(SafeJSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ text: "abcd", blocks: [] });
                }
            }
        } finally {
            recognize.mockRestore();
            await recording.stop();
        }
    });

    test("OCR failures preserve frames, audio and the finalized manifest", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-ocr-"));
        const recorder = new FakeRecorder();
        const original = recorder.capture.bind(recorder);
        const captured = Promise.withResolvers<void>();
        recorder.capture = async (request, signal) => {
            const result = await original(
                {
                    ...request,
                    hooks: {
                        ...request.hooks,
                        onFrame: (frame) => {
                            request.hooks?.onFrame?.(frame);
                            captured.resolve();
                        },
                    },
                },
                signal
            );
            const track = join(request.outDir, "mic.m4a");
            await Bun.write(track, "audio fixture");
            return { ...result, tracks: [{ source: "mic", path: track, durationMs: 10, mutedSpans: [] }] };
        };
        const recognize = spyOn(ocr, "recognizeText").mockRejectedValue(new Error("OCR fixture failure"));
        const recording = await startRecording({
            recorder,
            folder: join(root, "rec"),
            liveDir: join(root, "live"),
            ocr: { enabled: true },
        });
        try {
            await withTimeout(captured.promise, 2_000);
            const answer = await recording.stop();
            expect(answer.state).toBe("stopped");
            expect(recognize).toHaveBeenCalled();
            const manifest = readRecordingManifest(recording.folder)!;
            expect(manifest.frames.length).toBeGreaterThan(0);
            expect(manifest.frames.every((frame) => existsSync(join(recording.folder, frame.file)))).toBe(true);
            expect(manifest.warnings?.some((warning) => warning.includes("OCR fixture failure"))).toBe(true);
            expect(existsSync(join(recording.folder, "audio"))).toBe(true);
            expect(existsSync(join(recording.folder, ".pieces"))).toBe(false);
        } finally {
            recognize.mockRestore();
            await recording.stop();
        }
    });

    test("duration expiry and three empty captures finalize without an explicit stop", async () => {
        for (const maxDurationSec of [0, 10]) {
            const root = mkdtempSync(join(tmpdir(), "gt-rec-end-"));
            const recorder = new FakeRecorder();
            recorder.capture = async () => ({ startedAtMs: Date.now(), frames: [] });
            const recording = await startRecording({
                recorder,
                folder: join(root, "rec"),
                liveDir: join(root, "live"),
                maxDurationSec,
            });
            expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 2_000 })).toBe(true);
            expect((await recording.stop()).state).toBe("stopped");
            expect(existsSync(join(recording.folder, ".pieces"))).toBe(false);
        }
    });

    test("a paused piece still reaches the recording deadline", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-pause-"));
        const recorder = new ControlledRecorder();
        const recording = await startRecording({
            recorder,
            folder: join(root, "rec"),
            liveDir: join(root, "live"),
            maxDurationSec: 0.2,
        });
        await recording.pause();
        recorder.finish();
        expect(await waitForPath(join(recording.folder, "recording.json"), { timeoutMs: 2_000 })).toBe(true);
        expect((await recording.stop()).state).toBe("stopped");
    });

    test("muted sources stay excluded across pieces and unsupported live mute is refused", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-mute-"));
        const recorder = new ControlledRecorder();
        recorder.supports.audio = true;
        const firstCapture = recorder.next();
        const recording = await startRecording({
            recorder,
            folder: join(root, "rec"),
            liveDir: join(root, "live"),
            audio: { mic: true },
        });
        try {
            await firstCapture;
            expect(recorder.requests[0].audio?.sources).toEqual(["mic"]);
            await recording.muteAudio("mic", true);
            const next = recorder.next();
            recorder.finish();
            expect((await next).audio?.sources ?? []).toEqual([]);
            const resumed = recorder.next();
            await recording.muteAudio("mic", false);
            expect((await resumed).audio?.sources).toEqual(["mic"]);
        } finally {
            await recording.stop();
        }
        const unsupported = new ControlledRecorder();
        unsupported.supports.audio = true;
        unsupported.canMute = false;
        const unsupportedCapture = unsupported.next();
        const second = await startRecording({
            recorder: unsupported,
            folder: join(root, "unsupported"),
            liveDir: join(root, "live"),
            audio: { mic: true },
        });
        try {
            await unsupportedCapture;
            await expect(second.muteAudio("mic", true)).rejects.toThrow("cannot mute");
            expect((await second.getSettings()).audio.muted.mic).toBe(false);
        } finally {
            await second.stop();
        }
    });
    test("a parent-owned recording survives a timed-out turn and reset finalizes it", async () => {
        const engine = new ReplEngine({ toolsets: ["recorder"], recorder: { create: async () => new FakeRecorder() } });
        try {
            const started = await engine.run('const rec = await recorder.start({ displays: "all" }); rec.id', 10_000);
            expect(started.error).toBeUndefined();
            expect(started.ok).toBe(true);
            const id = started.text;
            const expired = await engine.run("await new Promise(() => {})", 100);
            expect(expired.ok).toBe(false);
            const listed = await engine.run("await recorder.list()");
            expect(listed.text).toContain(id);
            const attached = await engine.run(
                `const attached = await recorder.attach(${SafeJSON.stringify(id)}); await attached.status()`
            );
            expect(attached.ok).toBe(true);
            const folder = await engine.run("attached.folder");
            const entry = readLiveRecording(id)!;
            await engine.reset();
            expect(readRecordingManifest(folder.text)?.endedAt).toBeDefined();
            expect(existsSync(join(liveRecordingsDir(), `${id}.json`))).toBe(false);
            expect(existsSync(entry.socket)).toBe(false);
        } finally {
            await engine.shutdown();
        }
    }, 30_000);

    test("serial recorders reject multiple displays before capture and on live selection", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-serial-rec-"));
        const recorder = new FakeRecorder();
        recorder.supports.parallelCaptures = false;
        const options = { recorder, liveDir: join(root, "live"), folder: join(root, "rec") };
        await expect(startRecording({ ...options, displays: "all" })).rejects.toThrow("one display");
        expect(recorder.calls).toEqual([]);
        const recording = await startRecording({ ...options, displays: "main" });
        try {
            await expect(recording.setDisplayMode("all")).rejects.toThrow("one display");
            await expect(recording.addDisplay(4)).rejects.toThrow("one display");
            expect((await recording.status()).displays.map((display) => display.id)).toEqual([1]);
        } finally {
            await recording.stop();
        }
    });

    test("a finalized recording reports and publishes stopped", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-stopped-rec-"));
        const liveDir = join(root, "live");
        const recording = await startRecording({
            recorder: new ControlledRecorder(),
            folder: join(root, "rec"),
            liveDir,
        });
        const client = await RecorderClient.connect(recording.id, { dir: liveDir });
        const stopped = Promise.withResolvers<void>();
        try {
            await client.subscribe((event) => {
                if (
                    event.event === "state" &&
                    event.params !== null &&
                    typeof event.params === "object" &&
                    "state" in event.params &&
                    event.params.state === "stopped"
                ) {
                    stopped.resolve();
                }
            });
            expect((await recording.stop()).state).toBe("stopped");
            expect((await recording.status()).state).toBe("stopped");
            await withTimeout(stopped.promise, 2000, new Error("final state event missing"));
            expect((await recording.stop()).state).toBe("stopped");
        } finally {
            client.close();
            await recording.stop();
        }
    });

    test("an attached meeting hands its stored id and frames folder to the editor", async () => {
        const meetingId = "fixture-meeting";
        const folder = toolDataDir("meetings", meetingId);
        mkdirSync(join(folder, "frames"), { recursive: true });
        await Bun.write(join(folder, "frames", "12-00-00-000.jpg"), createCanvas(16, 16).toBuffer("image/jpeg"));
        class MeetingControl extends RecorderControl {
            readonly kind = "meeting";
            readonly methods = ["status", "pause", "resume", "stop"] as const;
            async status() {
                return { kind: this.kind, title: "Fixture", state: "recording" as const, displays: [], frames: 1 };
            }
            async pause() {
                return { state: "paused" as const };
            }
            async resume() {
                return { state: "recording" as const };
            }
            async stop() {
                return { state: "stopped" as const };
            }
        }
        const dir = mkdtempSync(join(tmpdir(), "gt-meeting-handoff-"));
        const id = `meeting-${meetingId}`;
        const server = new LiveRecordingServer({
            id,
            kind: "meeting",
            title: "Fixture",
            folder,
            dir,
            control: new MeetingControl(),
        });
        const client = await RecorderClient.connect(id, { dir });
        try {
            const result = await new RecordingHandle(client).stop();
            expect(result.recordingId).toBe(meetingId);
            expect(result.folder).toBe(join(folder, "frames"));
            const { editor } = (await new EditorToolset().load(ctx)) as { editor: { open(source: string): Clip } };
            for (const source of [result.recordingId, result.folder!]) {
                const frames = await editor.open(source).frames();
                expect(frames.frames).toHaveLength(1);
            }
        } finally {
            client.close();
            server.close();
        }
    });

    test("docs come from the descriptors, handles included", () => {
        const recorder = renderDocs(recorderApi);
        expect(recorder).toContain('recording.audio.mute(source: "mic" | "system") → AudioState [reversible]');
        expect(recorder).toContain("recording.displays.switch(displayId: number) → DisplaySelection");
        expect(recorder).toContain("recorder.start(options?: {");
        const editor = renderDocs(editorApi);
        expect(editor).toContain("clip.grid(options?: {");
        expect(editor).toContain("editor.open(source: string) → Clip [read]");
    });

    test("a recording started through the screen-recorder module is controlled over its socket, stops after post-processing, and the editor cuts it", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-repl-rec-"));
        const liveDir = join(root, "live");
        const recorder = new FakeRecorder();
        const recording = await startRecording({
            recorder,
            displays: "all",
            fps: 2,
            liveDir,
            folder: join(root, "rec"),
            pieceSec: 30,
        });
        const handle = new RecordingHandle(await RecorderClient.connect(recording.id, { dir: liveDir }), recording);
        const progress: unknown[] = [];
        const offProgress = handle.on("progress", (event) => progress.push(event));
        expect(typeof offProgress).toBe("function");
        let stateEvents = 0;
        const offState = handle.on("state", () => {
            stateEvents += 1;
        });
        expect(typeof offState).toBe("function");
        offState();

        const ready = await handle.waitFor((status) => status.frames >= 4, { timeoutMs: 5_000 });
        expect(ready.displays.map((display) => display.id)).toEqual([1, 4]);
        expect((await handle.set({ fps: 8 })).applied).toBe("live");
        expect(recorder.calls).toContain("rates 8");
        await handle.pause();
        expect((await handle.status()).state).toBe("paused");
        await handle.resume();
        await expect(handle.audio.mute("mic")).rejects.toThrow("cannot audio.mute");
        expect((await handle.displays.switch(4)).applied).toBe("live");
        expect(recorder.calls).toContain("switch 4");
        await Bun.sleep(300);

        const liveEntry = readLiveRecording(recording.id, liveDir)!;
        const stopped = await handle.stop();
        expect(stopped.state).toBe("stopped");
        expect(existsSync(join(liveDir, `${recording.id}.json`))).toBe(false);
        expect(existsSync(liveEntry.socket)).toBe(false);
        expect(stateEvents).toBe(0);
        offProgress();
        expect(stopped.frames).toBeGreaterThan(4);
        expect(progress.length).toBeGreaterThan(0);
        const manifest = readRecordingManifest(recording.folder);
        expect(manifest?.frames.length).toBe(stopped.frames);
        expect(existsSync(join(recording.folder, ".pieces"))).toBe(false);

        const toolset = new EditorToolset();
        const { editor } = (await toolset.load(ctx)) as { editor: { open(source: string): Clip } };
        expect(() => Reflect.apply(editor.open, editor, [{ recording: "x" }])).toThrow("editor.open(source: string)");
        const clip = editor.open(recording.folder);
        expect(() => Reflect.apply(clip.speed, clip, ["fast"])).toThrow("editor.Clip.speed(factor: number)");
        const trimmedJob = clip.trim({ from: 0, to: 0.1 });
        const trimmed = await trimmedJob.done;
        expect(await trimmedJob).toBe(trimmed);
        expect(() => Reflect.apply(trimmed.speed, trimmed, ["fast"])).toThrow("editor.Clip.speed(factor: number)");
        const framesJob = clip.frames({ changeOnly: true, threshold: 2 });
        const events: string[] = [];
        framesJob.on("progress", (event) => events.push(`${event.step} ${event.done}/${event.total} ${event.unit}`));
        const frames = await framesJob;
        const edit = new RecordingEditor().run({ source: clip.source, steps: [{ kind: "frames" }] });
        const rejected = new ReplJob(edit, () => {
            throw new Error("mapping failed");
        });
        await edit.done;
        await Bun.sleep(0);
        await expect(rejected.done).rejects.toThrow("mapping failed");
        const otherClip = editor.open(recording.folder);
        expect(() => otherClip.grid({ frames })).toThrow("this clip");
        expect((await trimmed.info()).durationUs).toBeLessThan((await clip.info()).durationUs);
        expect(frames.frames.length).toBeGreaterThan(0);
        const grid = clip.grid({ frames, cols: 3, rows: 3, labels: "time" });
        const paths = await grid.show();
        expect(paths.length).toBeGreaterThan(0);
        expect(shown).toEqual(paths);
        expect(events.some((line) => line.includes("frames"))).toBe(true);
        handle.close();
    }, 30_000);
});

test("default recording IDs remain distinct within one clock second", () => {
    const recordings = Array.from({ length: 8 }, () => new LibraryRecording({ recorder: new FakeRecorder() }));
    expect(new Set(recordings.map((recording) => recording.id)).size).toBe(recordings.length);
});

test("recording startup refuses an existing folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "owned-recording-"));
    await Bun.write(join(root, "keep.txt"), "unrelated");
    const recording = new LibraryRecording({ recorder: new FakeRecorder(), folder: root, liveDir: join(root, "live") });
    let started = false;
    try {
        await expect(
            recording.start().then((value) => {
                started = true;
                return value;
            })
        ).rejects.toThrow();
        expect(await Bun.file(join(root, "keep.txt")).text()).toBe("unrelated");
    } finally {
        if (started) {
            await recording.stop();
        }
    }
});

test("a MIME hint cannot turn arbitrary bytes into an image", async () => {
    const { readShowable } = await import("@genesiscz/utils/repl/show");
    await expect(readShowable({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" })).rejects.toThrow(
        "not a PNG"
    );
});

test("library capture reuses readiness completed during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "rec-ready-once-"));
    const recorder = new FakeRecorder();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    recorder.available = async () => {
        if (++calls > 1) {
            await gate.promise;
        }
        return { ok: true };
    };
    const recording = await startRecording({ recorder, folder: join(root, "rec"), liveDir: join(root, "live") });
    try {
        await withTimeout(recording.stop(), 300);
        expect(calls).toBe(1);
    } finally {
        gate.resolve();
        await recording.stop();
    }
});

test("completed recordings leave the parent ownership set", async () => {
    const engine = new ReplEngine({ toolsets: ["recorder"], recorder: { create: async () => new FakeRecorder() } });
    try {
        const result = await engine.run("const rec = await recorder.start(); await rec.stop(); true");
        expect(result.ok).toBe(true);
        const owned: Set<LibraryRecording> = Reflect.get(engine, "recordings");
        expect(owned.size).toBe(0);
    } finally {
        await engine.shutdown();
    }
});

test("shutdown prevents a worker timer from starting another recording during finalization", async () => {
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let created = 0;
    const engine = new ReplEngine({
        toolsets: ["recorder"],
        recorder: {
            create: async () => {
                const recorder = new FakeRecorder();
                if (++created === 1) {
                    const capture = recorder.capture.bind(recorder);
                    recorder.capture = async (...args) => {
                        const result = await capture(...args);
                        stopping.resolve();
                        await release.promise;
                        return result;
                    };
                }
                return recorder;
            },
        },
    });
    let shutdown: Promise<void> | undefined;
    try {
        expect(
            (await engine.run("await recorder.start(); setTimeout(() => void recorder.start(), 100); true")).ok
        ).toBe(true);
        shutdown = engine.shutdown();
        await withTimeout(stopping.promise, 2000);
        await Bun.sleep(150);
        release.resolve();
        await shutdown;
        expect(created).toBe(1);
    } finally {
        release.resolve();
        await shutdown;
        await engine.shutdown();
    }
});

test("a completed display switch cannot replace the next capture's ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "switch-ownership-"));
    const recorder = new ControlledRecorder();
    const recording = await startRecording({ recorder, folder: join(root, "rec"), liveDir: join(root, "live") });
    recorder.onSwitch = async () => {
        const next = recorder.next();
        recorder.finish();
        await next;
    };
    try {
        const selection = await recording.switchDisplay(4);
        expect(selection.applied).toBe("restart");
        expect(selection.chosen).toEqual([4]);
    } finally {
        const stopped = recording.stop();
        recorder.finish();
        await withTimeout(stopped, 2_000);
    }
});

describe("meetings toolset", () => {
    test("a meeting handle shows the findings items.add stored", async () => {
        const created = await new MeetingStore().create(
            { title: "Toolset fixture", start: "2026-11-03T12:00:00.000Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );
        const engine = new ReplEngine({ toolsets: ["meetings"] });
        try {
            const opened = await engine.run(
                `const meeting = meetings.open({ ref: ${SafeJSON.stringify(created.id)} }); 1`
            );
            expect(opened.error).toBeUndefined();
            const added = await engine.run(
                'await meeting.items.add({ findings: [{ kind: "question", from: 0, to: 5, question: "Who spoke first?" }] }); meeting.record.items.length'
            );
            expect(added.error).toBeUndefined();
            expect(added.text).toBe("1");
        } finally {
            await engine.reset();
        }
    });
});

test("waitFor bounds a stalled subscription without closing concurrent waits or control calls", async () => {
    class Control extends RecorderControl {
        readonly kind = "meeting";
        readonly methods = ["status", "pause", "resume", "stop"] as const;
        async status() {
            return { kind: this.kind, title: "Fixture", state: "recording" as const, displays: [], frames: 1 };
        }
        async pause() {
            return { state: "paused" as const };
        }
        async resume() {
            return { state: "recording" as const };
        }
        async stop() {
            return { state: "stopped" as const };
        }
    }
    const dir = mkdtempSync(join(tmpdir(), "gt-wait-deadline-"));
    const server = new LiveRecordingServer({
        id: "deadline",
        kind: "meeting",
        title: "Fixture",
        dir,
        control: new Control(),
    });
    const client = await RecorderClient.connect("deadline", { dir });
    const pending = Promise.withResolvers<void>();
    const subscribe = spyOn(client, "subscribe").mockReturnValue(pending.promise);
    try {
        const handle = new RecordingHandle(client);
        const longer = handle.waitFor(() => true, { timeoutMs: 1000 });
        await expect(
            withTimeout(
                new RecordingHandle(client).waitFor(() => true, { timeoutMs: 20 }),
                500,
                new Error("outer deadline")
            )
        ).rejects.toThrow("within 20 ms");
        await expect(client.status()).resolves.toMatchObject({ state: "recording" });
        pending.resolve();
        await expect(longer).resolves.toMatchObject({ state: "recording" });
        await expect(handle.pause()).resolves.toMatchObject({ state: "paused" });
    } finally {
        pending.resolve();
        subscribe.mockRestore();
        client.close();
        server.close();
    }
});
