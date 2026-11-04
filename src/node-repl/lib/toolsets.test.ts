import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplEngine } from "@app/node-repl/lib/engine";
import { collapseUndo, defaultExportName, editProject, undoDepth, undoEdit } from "@app/recorder/lib/edit";
import { chaptersOf, recordingFolderOf, spreadTimes } from "@app/recorder/lib/moments";
import { MoviesToolset } from "@app/recorder/lib/toolset";
import { renderDocs } from "@genesiscz/utils/api-descriptor";
import { withTimeout } from "@genesiscz/utils/async";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import * as ocr from "@genesiscz/utils/macos/ocr";
import { readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import type { ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { type Clip, EditorToolset, editorApi } from "@genesiscz/utils/repl/toolsets/editor";
import { RecordingHandle, recorderApi } from "@genesiscz/utils/repl/toolsets/recorder";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { liveRecordingsDir, RecorderClient, readLiveRecording } from "@genesiscz/utils/screen-recorder/live";
import { startRecording } from "@genesiscz/utils/screen-recorder/start";
import {
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderSupport,
    type LiveCapture,
} from "@genesiscz/utils/screen-recorder/types";
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

    override async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        this.requests.push(request);
        const done = new Promise<void>((resolve) => {
            this.finish = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        request.hooks?.onLive?.({
            pause: () => undefined,
            resume: () => undefined,
            switchDisplay: async () => undefined,
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

describe("toolset method names", () => {
    test("a missing method names the real ones, while inspection and await still read missing names", async () => {
        const ctx: ToolsetContext = { scratchDir: tmpdir(), show: async () => {}, write: () => {} };
        const { movies } = (await new MoviesToolset().load(ctx)) as {
            movies: { open(recording: string): object; opn?: unknown };
        };

        expect(() => movies.opn).toThrow(
            'movies has no "opn" (did you mean open?); it has: list, search, open, record'
        );
        const movie = movies.open("anything");
        expect(() => Reflect.get(movie, "trim")).toThrow('movies.Movie has no "trim"');
        expect(Reflect.get(movie, "then")).toBeUndefined();
        expect(Bun.inspect(movie)).toContain("Movie");

        // A bad argument of an async method rejects, so `.catch()` sees it, with one line per problem.
        const clicks = Reflect.get(movie, "clicks") as (options: unknown) => Promise<unknown>;
        await expect(clicks({ color: "red" })).rejects.toThrow("  - color: a color is #RRGGBB");
    });
});

describe("movie sheet times", () => {
    test("each frame sits in the middle of its share of the range, never on an end", () => {
        expect(spreadTimes({ fromUs: 0, toUs: 6_000_000, count: 3 })).toEqual([1_000_000, 3_000_000, 5_000_000]);
        expect(spreadTimes({ fromUs: 2_000_000, toUs: 2_000_000, count: 2 })).toEqual([2_000_000, 2_000_000]);
    });
});

describe("movie chapters", () => {
    test("an intro at 0:00, cut and too-close markers left out, hours shown past an hour", () => {
        const markers = [
            { plays: 75.4, label: "Settings" },
            { plays: null, label: "cut away" },
            { plays: 3, label: "too early" },
            { plays: 80, label: "too close" },
            { plays: 3725, label: "Wrap up" },
        ];
        expect(chaptersOf(markers)).toEqual(["0:00 Intro", "1:15 Settings", "1:02:05 Wrap up"]);
        expect(
            chaptersOf(
                [
                    { plays: 0.4, label: "Start" },
                    { plays: 30, label: "Next" },
                ],
                { intro: "x" }
            )
        ).toEqual(["0:00 Start", "0:30 Next"]);
        expect(chaptersOf([])).toEqual([]);
    });

    test("undo outlives one process: it steps back through the saved steps, collapses, and refuses after another save", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-undo-"));
        const path = join(root, "talk.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(root, "talk.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );

        await editProject(path, [{ op: "text", from: 1, to: 2, text: "Title" }]);
        await editProject(path, [{ op: "redact", from: 0, to: 1, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }]);
        expect(undoDepth(path)).toBe(2);
        const once = await undoEdit(path);
        expect(once.project.redactions ?? []).toEqual([]);
        expect(once.project.texts?.length).toBe(1);
        expect((await undoEdit(path)).project.texts).toBeUndefined();
        await expect(undoEdit(path)).rejects.toThrow("nothing to undo");

        const depth = undoDepth(path);
        await editProject(path, [{ op: "text", from: 1, to: 2, text: "A" }]);
        await editProject(path, [{ op: "text", from: 2, to: 3, text: "B" }]);
        collapseUndo(path, depth);
        expect(undoDepth(path)).toBe(depth + 1);

        // The editor window saving in between: the undo refuses rather than drop its change.
        writeProject(path, { ...(await undoEdit(path)).project }, "window");
        await editProject(path, [{ op: "text", from: 1, to: 2, text: "C" }]);
        writeProject(path, readProject(path), "window");
        await expect(undoEdit(path)).rejects.toThrow("by window");
    });

    test("an export is named after the recording's title, made safe, else after the movie", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-name-"));
        const recording = join(root, "rec");
        mkdirSync(recording);
        writeFileSync(
            join(recording, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id: "r",
                title: " login/flow: v2. ",
                startedAt: "x",
                displays: [],
                frames: [],
            })
        );
        expect(defaultExportName(join(recording, "screen.mp4"))).toBe("login-flow- v2");
        expect(defaultExportName(join(root, "talk.mov"))).toBe("talk-edited");
    });

    test("a copied recording's edit belongs to the copy, even when its movie is still the original's", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-folder-"));
        const original = join(root, "original");
        const copy = join(root, "copy");
        const plain = join(root, "plain");
        for (const folder of [original, copy, plain]) {
            mkdirSync(folder, { recursive: true });
        }
        writeFileSync(join(original, "recording.json"), "{}");
        writeFileSync(join(copy, "recording.json"), "{}");
        const project = wholeProject({
            video: join(original, "screen.mp4"),
            durationUs: 1_000_000,
            width: 10,
            height: 10,
        });

        expect(recordingFolderOf({ path: join(copy, "edit.json"), project })).toBe(copy);
        expect(recordingFolderOf({ path: join(original, "edit.json"), project })).toBe(original);
        const loose = wholeProject({ video: join(plain, "movie.mp4"), durationUs: 1_000_000, width: 10, height: 10 });
        expect(recordingFolderOf({ path: join(plain, "movie.edit.json"), project: loose })).toBeUndefined();
    });
});

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
        expect(() => Reflect.apply(clip.speed, clip, ["fast"])).toThrow("editor.Clip.speed(factor: number");
        const trimmedJob = clip.trim({ from: 0, to: 0.1 });
        const trimmed = await trimmedJob.done;
        expect(await trimmedJob).toBe(trimmed);
        expect(() => Reflect.apply(trimmed.speed, trimmed, ["fast"])).toThrow("editor.Clip.speed(factor: number");
        const framesJob = clip.frames({ changeOnly: true, threshold: 2 });
        const events: string[] = [];
        framesJob.on("progress", (event) => events.push(`${event.step} ${event.done}/${event.total} ${event.unit}`));
        const frames = await framesJob;
        expect(frames.frames.length).toBeGreaterThan(0);
        const grid = clip.grid({ frames, cols: 3, rows: 3, labels: "time" });
        const paths = await grid.show();
        expect(paths.length).toBeGreaterThan(0);
        expect(shown).toEqual(paths);
        expect(events.some((line) => line.includes("frames"))).toBe(true);
        handle.close();
    }, 30_000);
});
