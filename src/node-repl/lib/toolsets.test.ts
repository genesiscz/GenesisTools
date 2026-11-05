import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingSession, type SegmentRecorder } from "@app/control/lib/recording-session";
import { SessionRecorderControl } from "@app/control/lib/recording-session-control";
import { meetingLiveId } from "@app/meetings/lib/recorder-shared";
import { settingsPatchFromFlags } from "@app/meetings/lib/settings-flags";
import { ReplEngine } from "@app/node-repl/lib/engine";
import { MeetingsToolset } from "@app/node-repl/lib/toolsets/meetings";
import { missingCameraWarning } from "@app/recorder/lib/camera-recorder";
import {
    collapseUndo,
    defaultExportName,
    editProject,
    inItsFolder,
    transcriptWords,
    undoDepth,
    undoEdit,
} from "@app/recorder/lib/edit";
import { framesStartOf, recordFrames, refuseOtherKindFlags, wantsFrames } from "@app/recorder/lib/frames-recording";
import {
    chapterMetadata,
    chaptersOf,
    chaptersOfPart,
    markersOf,
    recordingFolderOf,
    spreadTimes,
} from "@app/recorder/lib/moments";
import {
    DEFAULT_COUNTDOWN_SECONDS,
    parseStartFlags,
    readStartArgs,
    type StartRequest,
} from "@app/recorder/lib/start-options";
import { type MovieRecorderDeps, MoviesToolset, moviesApi } from "@app/recorder/lib/toolset";
import { RecordingStartCancelled, recordVideo } from "@app/recorder/lib/video-recording";
import { renderDocs } from "@genesiscz/utils/api-descriptor";
import { withTimeout } from "@genesiscz/utils/async";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import * as ocr from "@genesiscz/utils/macos/ocr";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { closeStartGate, startGatePath } from "@genesiscz/utils/process/start-gate";
import transcriptCuts from "@genesiscz/utils/recording-editor/__fixtures__/transcript-cuts.json";
import transcriptWordsFixture from "@genesiscz/utils/recording-editor/__fixtures__/transcript-words.json";
import { RecordingEditor } from "@genesiscz/utils/recording-editor/editor";
import { readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import { readShowable } from "@genesiscz/utils/repl/show";
import type { ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { type Clip, EditorToolset, editorApi, ReplJob } from "@genesiscz/utils/repl/toolsets/editor";
import {
    RecordingHandle,
    recorderApi,
    recorderStartSchema,
    settingsPatchOf,
} from "@genesiscz/utils/repl/toolsets/recorder";
import {
    RecorderControl,
    type RecorderMethod,
    type RecorderSettings,
    type RecorderSettingsPatch,
    type RecorderStatus,
    type RecordingMarker,
    recorderSettingsSchema,
    type SettingsAnswer,
    type StopAnswer,
} from "@genesiscz/utils/screen-recorder/control";
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
    /** Runs inside a live display switch, before it answers. */
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

        // cut({ from, to }) works like cut(from, to); an object with another key is still refused.
        const folder = mkdtempSync(join(tmpdir(), "named-args-"));
        const path = join(folder, "edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "screen.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );
        const opened = movies.open(path);
        const cut = Reflect.get(opened, "cut") as (...args: unknown[]) => Promise<{ clips: unknown[] }>;
        expect((await cut({ from: 1, to: 2 })).clips).toHaveLength(2);
        await expect(cut({ start: 1, to: 2 })).rejects.toThrow("Invalid arguments for movies.Movie.cut");

        // itemsAt names what plays at an output time: after the 1 s cut, output 2 s is source 3 s.
        const text = Reflect.get(opened, "text") as (options: unknown) => Promise<unknown>;
        await text({ from: 2.5, to: 4, text: "Hello" });
        const itemsAt = Reflect.get(opened, "itemsAt") as (at: unknown) => Promise<Record<string, unknown>>;
        const now = await itemsAt(2);
        expect(now).toMatchObject({ output: 2, source: 3, zoom: null, caption: null });
        expect(now.texts).toMatchObject([{ text: "Hello", from: 2.5, to: 4, plays: { from: 1.5, to: 3 } }]);
        expect((await itemsAt(60)).warnings).toEqual(["60 s is past the end; this is the last moment, 9 s"]);
    });
});

describe("movie chapters in a movie file", () => {
    test("a part keeps the chapter it starts in at 0 and moves the ones inside it", () => {
        const chapters = [
            { at: 0, label: "Intro" },
            { at: 6, label: "Settings" },
            { at: 30, label: "Wrap up" },
        ];
        expect(chaptersOfPart(chapters, { from: 5, to: 20 })).toEqual([
            { at: 0, label: "Intro" },
            { at: 1, label: "Settings" },
        ]);
        expect(
            chapterMetadata(
                [
                    { at: 0, label: "A=b; #1" },
                    { at: 1.5, label: "Next" },
                ],
                4
            )
        ).toBe(
            ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=A\\=b\\; \\#1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=4000\ntitle=Next\n"
        );
    });
});

describe("markers of a recording and of its edit", () => {
    test("list both in time order, each where it plays, and the edit's with the id unmarker takes", () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-markers-"));
        writeFileSync(
            join(folder, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id: "rec",
                title: "Rec",
                startedAt: "2026-11-04T10:00:00.000Z",
                displays: [],
                frames: [],
                settings: { markers: [{ atMs: 3000, label: "Recorded" }] },
            })
        );
        const project = {
            ...wholeProject({ video: join(folder, "screen.mp4"), durationUs: 10_000_000, width: 100, height: 100 }),
            clips: [{ id: "a", fromUs: 2_000_000, toUs: 10_000_000, speed: 1 }],
            markers: [
                { id: "m1", atUs: 1_000_000, label: "Cut away" },
                { id: "m2", atUs: 6_000_000, label: "Edited" },
            ],
        };

        expect(markersOf({ path: join(folder, "edit.json"), project })).toEqual([
            { at: 1, plays: null, label: "Cut away", id: "m1" },
            { at: 3, plays: 1, label: "Recorded" },
            { at: 6, plays: 4, label: "Edited", id: "m2" },
        ]);
    });
});

describe("a copied recording folder", () => {
    test("reads its own movie and cursor track, and the original when the copy has a different movie", () => {
        const root = mkdtempSync(join(tmpdir(), "copied-rec-"));
        const original = join(root, "original");
        const copy = join(root, "copy");

        for (const folder of [original, copy]) {
            mkdirSync(folder);
            writeFileSync(join(folder, "screen.mp4"), "movie bytes");
            writeFileSync(join(folder, "cursor.jsonl"), "{}\n");
        }

        const project = wholeProject({
            video: join(original, "screen.mp4"),
            cursor: join(original, "cursor.jsonl"),
            durationUs: 1_000_000,
            width: 100,
            height: 100,
        });
        expect(inItsFolder(join(copy, "edit.json"), project).source).toMatchObject({
            video: join(copy, "screen.mp4"),
            cursor: join(copy, "cursor.jsonl"),
        });
        expect(inItsFolder(join(original, "edit.json"), project)).toBe(project);
        writeFileSync(join(copy, "screen.mp4"), "another, longer movie");
        expect(inItsFolder(join(copy, "edit.json"), project).source.video).toBe(join(original, "screen.mp4"));
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

    test("a line's words come as cutWords reads them, and the editor's pick of one place cuts only that place", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-words-"));
        const path = join(root, "talk.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(root, "talk.mp4"), durationUs: 30_000_000, width: 100, height: 100 })
        );
        writeFileSync(
            join(root, "talk.transcript.json"),
            SafeJSON.stringify({ segments: [{ text: " So jako, we start jako now.", start: 10, end: 14 }] })
        );
        const [line] = await transcriptWords(path, { at: 11 });
        expect(line.text).toBe("So jako, we start jako now.");
        expect(line.plays).toBe(10);
        expect(line.words.map((word) => word.fold)).toEqual(["so", "jako", "we", "start", "jako", "now"]);
        expect(line.words.every((word) => word.estimated)).toBe(true);
        expect(await transcriptWords(path)).toHaveLength(1);

        // The second "jako" alone, the way the editor sends it through tools recorder apply.
        await editProject(path, [{ op: "cutWords", at: line.start, words: "jako", occurrence: 2, padMs: 0 }]);
        const [kept] = readProject(path).clips.slice(1);
        expect(kept.fromUs).toBe(Math.round(line.words[4].end * 1_000_000));
    });

    // The editor's word pick decodes this file (RecorderEditTests.swift), so it reads what the door prints.
    test("the words door prints the shared transcript-words fixture", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-words-fixture-"));
        const path = join(root, "talk.edit.json");
        const project = wholeProject({
            video: join(root, "talk.mp4"),
            durationUs: transcriptWordsFixture.durationUs,
            width: 100,
            height: 100,
        });
        project.clips = transcriptWordsFixture.clips.map(([fromUs, toUs, speed], index) => ({
            id: `c${index}`,
            fromUs,
            toUs,
            speed,
        }));
        writeProject(path, project);
        writeFileSync(join(root, "talk.transcript.json"), SafeJSON.stringify({ segments: transcriptCuts.segments }));

        expect(await transcriptWords(path)).toEqual(transcriptWordsFixture.lines);
    });

    test("an edit that hides an item warns, and an edit that changes nothing saves nothing", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-warn-"));
        const path = join(root, "talk.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(root, "talk.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );
        await editProject(path, [{ op: "text", from: 4, to: 5, text: "Bonus" }]);
        const cut = await editProject(path, [{ op: "cut", from: 3.5, to: 5.5 }]);
        expect(cut.warnings?.[0]).toContain('The text "Bonus" (4 to 5 s) never shows');
        const revision = readProject(path).revision;
        const depth = undoDepth(path);
        const same = await editProject(path, [{ op: "volume", volume: 1 }]);
        expect(same.warnings).toEqual(["nothing changed, so nothing was saved"]);
        expect(readProject(path).revision).toBe(revision);
        expect(undoDepth(path)).toBe(depth);
    });

    test("undo outlives one process: it steps back through the saved steps, collapses, and refuses after another save", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-undo-"));
        const path = join(root, "talk.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(root, "talk.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );

        await editProject(path, [{ op: "text", from: 1, to: 2, text: "Title" }]);
        const late = await editProject(path, [
            { op: "redact", from: 0, to: 12, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } },
        ]);
        expect(late.warnings).toEqual([
            "redact: to 12 s is past the end of the source (10 s), so it was clamped to the end",
        ]);
        expect(undoDepth(path)).toBe(2);
        const once = await undoEdit(path);
        expect(once.undone).toEqual(["redact"]);
        expect(once.project.redactions ?? []).toEqual([]);
        expect(once.project.texts?.length).toBe(1);
        expect((await undoEdit(path)).project.texts).toBeUndefined();
        await expect(undoEdit(path)).rejects.toThrow("nothing to undo");

        const depth = undoDepth(path);
        await editProject(path, [{ op: "text", from: 1, to: 2, text: "A" }]);
        await editProject(path, [{ op: "text", from: 2, to: 3, text: "B" }]);
        collapseUndo(path, depth);
        expect(undoDepth(path)).toBe(depth + 1);
        const collapsed = await undoEdit(path);
        expect(collapsed.undone).toEqual(["text", "text"]);
        await editProject(path, [{ op: "text", from: 1, to: 2, text: "A" }]);

        // The editor window saving in between: the undo refuses rather than drop its change.
        writeProject(path, readProject(path), "window");
        await editProject(path, [{ op: "text", from: 1, to: 2, text: "C" }]);
        writeProject(path, readProject(path), "window");
        await expect(undoEdit(path)).rejects.toThrow("by window");
    });

    test("an edit saved by another writer between this edit's read and its write survives: the ops run again on it", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rec-race-"));
        const path = join(root, "talk.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(root, "talk.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );

        // Both read revision 1 before either writes: the second writer finds revision 2 on disk.
        const [first, second] = await Promise.all([
            editProject(path, [{ op: "text", from: 1, to: 2, text: "first" }]),
            editProject(path, [{ op: "volume", volume: 0.4 }]),
        ]);
        const saved = readProject(path);

        expect([first.project.revision, second.project.revision]).toEqual([2, 3]);
        expect(saved.texts?.map((text) => text.text)).toEqual(["first"]);
        expect(saved.audio.volume).toBe(0.4);
        expect((await undoEdit(path)).project.texts?.map((text) => text.text)).toEqual(["first"]);
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
                // The startup budget is what this test expires; the preload gets room, since loading the toolset
                // took over 1 s at load 99 (2026-11-05) and failed the test for the wrong reason.
                preloadTimeoutMs: 30_000,
                recordingStartupTimeoutMs: 1_000,
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
        await expect(handle.mark("while paused")).rejects.toThrow("cannot marker.add");
        await handle.resume();
        const marked = await handle.mark("login done");
        expect(marked).toEqual({ atMs: expect.any(Number), label: "login done" });
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
        expect(manifest?.settings.markers).toEqual([marked]);
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

/** A live recording that serves `settings.get` and `settings.set` and keeps the settings it was given. */
class SettingsControl extends RecorderControl {
    readonly kind = "meeting";
    readonly methods: readonly RecorderMethod[] = ["status", "stop", "marker.add", "settings.get", "settings.set"];
    settings: RecorderSettings = recorderSettingsSchema.parse({
        activeFps: 2,
        idleFps: 0.5,
        threshold: 3,
        maxLongSide: 1600,
        heartbeatSec: 30,
        ocr: { enabled: true, languages: ["en-US"], minChars: 4 },
    });
    readonly patches: RecorderSettingsPatch[] = [];

    async status(): Promise<RecorderStatus> {
        return { kind: this.kind, title: "Planning", state: "recording", displays: [], frames: 0 };
    }

    async pause(): Promise<{ state: "paused" }> {
        return { state: "paused" };
    }

    async resume(): Promise<{ state: "recording" }> {
        return { state: "recording" };
    }

    async stop(): Promise<StopAnswer> {
        return { state: "stopped" };
    }

    override async getSettings(): Promise<SettingsAnswer> {
        return { settings: this.settings, audio: { sources: ["mic"], muted: { mic: false, system: false } } };
    }

    override async setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        this.patches.push(patch);
        const { ocr: ocrPatch, ...rest } = patch;
        this.settings = recorderSettingsSchema.parse({
            ...this.settings,
            ...rest,
            ocr: { ...this.settings.ocr, ...ocrPatch },
        });
        return { ...(await this.getSettings()), applied: "live" };
    }

    override async addMarker(label: string): Promise<RecordingMarker> {
        return { atMs: 1234, label };
    }
}

describe("live recording settings from the movies and meetings toolsets", () => {
    test("movies: a movie recording changes fps, idleFps and threshold through its real control, and refuses the keys it keeps", async () => {
        const { MovieRecording } = await import("@app/recorder/lib/toolset");
        const root = mkdtempSync(join(tmpdir(), "gt-movie-rates-"));
        const runs: Array<{ rates?: unknown; signal: AbortSignal }> = [];
        // The segment recorder is the boundary to ax-tool: each run records until the session aborts it.
        const recorder: SegmentRecorder = {
            record: ({ rates, output, signal, onRecording }) => {
                runs.push({ rates, signal });
                onRecording();
                return new Promise((resolve) =>
                    signal.addEventListener(
                        "abort",
                        () => {
                            writeFileSync(output, "movie");
                            resolve({ ok: true, endedBy: "stop", durationMs: 1000 });
                        },
                        { once: true }
                    )
                );
            },
        };
        let control: SessionRecorderControl | undefined;
        const session = new RecordingSession({
            target: { kind: "display", screenIndex: 0 },
            directory: join(root, "segments"),
            output: join(root, "screen.mp4"),
            recorder,
            rates: { activeFps: 60, idleFps: 60, threshold: 0.5 },
            join: async () => ({ durationMs: 2000 }),
            emit: (event) => control?.observe(event),
            tickMs: 0,
            slowStartMs: 0,
        });
        control = new SessionRecorderControl(session, { target: { kind: "display", screenIndex: 0 } });
        const server = new LiveRecordingServer({
            id: `movie-rates-${process.pid}`,
            kind: control.kind,
            title: "Movie",
            control,
        });
        await session.start();

        try {
            const recording = new MovieRecording(server.current);
            expect(await recording.settings()).toMatchObject({
                settings: { activeFps: 60, idleFps: 60, threshold: 0.5 },
            });
            const changed = await recording.setSettings({ fps: 30, idleFps: 1, threshold: 2 });
            expect(changed).toMatchObject({
                applied: "restart",
                settings: { activeFps: 30, idleFps: 1, threshold: 2 },
            });
            expect(runs.map((run) => run.rates)).toEqual([
                { activeFps: 60, idleFps: 60, threshold: 0.5 },
                { activeFps: 30, idleFps: 1, threshold: 2 },
            ]);
            await expect(recording.setSettings({ ocr: { enabled: true }, heartbeatSec: 5 })).rejects.toThrow(
                "a movie recording keeps heartbeatSec, ocr as they are"
            );
            expect(runs).toHaveLength(2);
        } finally {
            server.close();
            await session.command({ cmd: "discard" });
        }
    });

    test("movies: the docs of a MovieRecording's settings name the keys a movie takes and the ones it keeps", async () => {
        const { moviesApi } = await import("@app/recorder/lib/toolset");
        const docs = moviesApi.handles?.find((handle) => handle.name === "MovieRecording")?.methods ?? [];
        const doc = (name: string) => docs.find((method) => method.name === name)?.doc ?? "";
        expect(doc("setSettings")).toContain("fps, idleFps or threshold");
        expect(doc("setSettings")).toContain("maxLongSide, heartbeatSec and ocr");
        expect(doc("settings")).toContain("fixed");
    });

    test("movies: a MovieRecording reads and changes the settings of a real library recording's control over its socket", async () => {
        const { MovieRecording } = await import("@app/recorder/lib/toolset");
        const root = mkdtempSync(join(tmpdir(), "gt-movie-settings-"));
        const recorder = new FakeRecorder();
        const recording = await startRecording({
            recorder,
            folder: join(root, "rec"),
            ocr: { enabled: true, minChars: 4 },
            pieceSec: 30,
        });

        try {
            const movie = new MovieRecording(readLiveRecording(recording.id)!);
            expect(await movie.settings()).toMatchObject({
                settings: { activeFps: 2, threshold: 1, ocr: { enabled: true, minChars: 4 } },
                audio: { sources: [] },
            });
            // The fake capture changes its rates live but has no live threshold, so every capture restarts.
            expect(await movie.setSettings({ threshold: 7.5, fps: 6, ocr: { enabled: false } })).toMatchObject({
                applied: "restart",
                settings: { activeFps: 6, threshold: 7.5, ocr: { enabled: false, minChars: 4 } },
            });
            const deadline = Date.now() + 3_000;

            while (!recorder.calls.includes("capture 1 fps 6") && Date.now() < deadline) {
                await Bun.sleep(20);
            }

            expect(recorder.calls).toContain("capture 1 fps 6");
            expect(await movie.settings()).toMatchObject({ settings: { activeFps: 6, threshold: 7.5 } });
            await expect(movie.setSettings({ threshold: 120 })).rejects.toThrow();
        } finally {
            await recording.stop();
        }
    });

    test("meetings: an opened meeting reads and changes the settings of its live recording, and says so when it is not recording", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Planning", start: "2026-11-02T15:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const { meetings } = (await new MeetingsToolset().load(ctx)) as {
            meetings: {
                open(ref: string): {
                    settings(): Promise<SettingsAnswer>;
                    setSettings(patch: unknown): Promise<SettingsAnswer>;
                    mark(label: string): Promise<RecordingMarker>;
                };
            };
        };
        const meeting = meetings.open(record.id);
        await expect(meeting.settings()).rejects.toThrow("not being recorded");
        await expect(meeting.mark("demo starts")).rejects.toThrow("not being recorded");

        const control = new SettingsControl();
        const server = new LiveRecordingServer({
            id: meetingLiveId(record.id),
            kind: "meeting",
            title: "Planning",
            control,
        });

        try {
            expect((await meeting.settings()).settings.threshold).toBe(3);
            const changed = await meeting.setSettings({ threshold: 9, ocr: { enabled: false } });
            expect(changed).toMatchObject({ applied: "live", settings: { threshold: 9, ocr: { enabled: false } } });
            expect(control.patches).toEqual([{ threshold: 9, ocr: { enabled: false } }]);
            await expect(meeting.setSettings({ threshold: -1 })).rejects.toThrow();
            expect(await meeting.mark("demo starts")).toEqual({ atMs: 1234, label: "demo starts" });
            await expect(meeting.mark("")).rejects.toThrow();
        } finally {
            server.close();
        }

        const docs = new MeetingsToolset().api.handles?.find((handle) => handle.name === "Meeting")?.methods ?? [];
        expect(docs.map((method) => method.name)).toEqual(expect.arrayContaining(["settings", "setSettings", "mark"]));
    });

    test("meetings: labels, people pairings and unpairing by entry through the REPL, each method documented", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Offers review", start: "2026-11-03T15:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        type Meeting = { set(input: unknown): Promise<{ project: string | null; labels: string[] }> };
        const { meetings } = (await new MeetingsToolset().load(ctx)) as {
            meetings: {
                open(ref: string): Meeting;
                projects: {
                    labels(input: unknown): Promise<string[]>;
                    pair(input: unknown): Promise<unknown>;
                    unpair(input: unknown): Promise<unknown>;
                    people(input?: unknown): Promise<Array<{ project: string; name: string }>>;
                };
            };
        };
        const set = await meetings.open(record.id).set({ project: "repl-offers", labels: ["Offers 2.0"] });

        expect(set).toMatchObject({ project: "repl-offers", labels: ["Offers 2.0"] });
        expect(await meetings.projects.labels({ project: "repl-offers" })).toEqual(["Offers 2.0"]);
        await meetings.projects.pair({
            project: "repl-offers",
            people: [{ name: "Alice Novak", email: "alice@example.com" }],
        });
        expect((await meetings.projects.people({ project: "repl-offers" })).map((one) => one.name)).toEqual([
            "Alice Novak",
        ]);
        expect(await meetings.projects.unpair({ entryId: "no-such-entry" })).toEqual([]);
        expect(
            await meetings.projects.unpair({
                project: "repl-offers",
                person: { name: "alice@example.com", email: "alice@example.com" },
            })
        ).toEqual({ removed: true });

        const api = new MeetingsToolset().api;
        const top = api.methods.map((method) => method.name);
        const handle = api.handles?.find((one) => one.name === "Meeting")?.methods.map((method) => method.name) ?? [];
        expect(top).toEqual(
            expect.arrayContaining([
                "projects.labels",
                "projects.pair",
                "projects.unpair",
                "projects.people",
                "assign.sweep",
            ])
        );
        expect(handle).toEqual(expect.arrayContaining(["assign.proposals", "assign.ask", "assign.apply"]));
    });
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
        calls += 1;

        if (calls > 1) {
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

test("a completed display switch cannot replace the next capture's ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "switch-ownership-"));
    const recorder = new ControlledRecorder();
    const first = recorder.next();
    const recording = await startRecording({ recorder, folder: join(root, "rec"), liveDir: join(root, "live") });
    await first;
    // The capture ends while the switch is in flight, and the next piece's capture starts before it answers.
    recorder.onSwitch = async () => {
        const next = recorder.next();
        recorder.finish();
        await next;
    };

    try {
        const selection = await recording.switchDisplay(4);
        expect(selection.applied).toBe("restart");
        expect(selection.chosen).toEqual([4]);
        const restarted = await recorder.next().catch(() => undefined);
        expect(restarted?.target).toEqual({ kind: "display", displayId: 4 });
    } finally {
        const stopped = recording.stop();
        recorder.finish();
        await withTimeout(stopped, 2_000);
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
                created += 1;

                if (created === 1) {
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

describe("movies.record() takes the options of tools recorder start", () => {
    /** A fake `tools recorder start`: the CLI's own flag parse, then a live movie entry, as the real one makes. */
    function fakeRecorder() {
        const started: StartRequest[] = [];
        const servers: LiveRecordingServer[] = [];
        const start: MovieRecorderDeps["start"] = (args) => {
            expect(args.slice(0, 2)).toEqual(["recorder", "start"]);
            const request = parseStartFlags(readStartArgs(args.slice(2)));
            started.push(request);
            servers.push(
                new LiveRecordingServer({
                    id: `movie-start-${process.pid}-${started.length}`,
                    kind: "movie",
                    title: request.title ?? "Screen recording",
                    folder: join(mkdtempSync(join(tmpdir(), "movie-start-")), `video-${started.length}`),
                    control: new SettingsControl(),
                })
            );
        };
        const close = () => {
            for (const server of servers.splice(0)) {
                server.close();
            }
        };
        return { start, started, close };
    }

    test("an area, the idle rate, the threshold, the countdown, the cursor, the shortcuts and the microphone reach the recorder", async () => {
        const fake = fakeRecorder();
        const { movies } = (await new MoviesToolset({ start: fake.start }).load(ctx)) as {
            movies: { record(options: unknown): Promise<{ folder?: string }> };
        };

        try {
            const recording = await movies.record({
                region: "10,20,300,200",
                fps: 30,
                idleFps: 1,
                threshold: 2.5,
                countdown: 4,
                systemCursor: true,
                shortcuts: false,
                audio: ["mic"],
                micDevice: "BuiltInMicrophoneDevice",
                excludeWindowIds: [41, 42],
                title: "Area demo",
                maxSeconds: 90,
                controls: false,
                indicator: false,
            });
            expect(recording.folder).toContain("/video-1");
            expect(fake.started).toHaveLength(1);
            expect(fake.started[0]).toMatchObject({
                target: { kind: "region", x: 10, y: 20, width: 300, height: 200 },
                fps: 30,
                idleFps: 1,
                threshold: 2.5,
                countdownSeconds: 4,
                systemCursor: true,
                shortcuts: false,
                audio: ["mic"],
                micDevice: "BuiltInMicrophoneDevice",
                excludeWindowIds: [41, 42],
                title: "Area demo",
                maxSeconds: 90,
                panel: false,
                indicator: false,
            });
            expect(fake.started[0].startGate).toEndWith(".gate");

            // countdown: true is the picker's 3 s; nothing named records the screen in use.
            await movies.record({ countdown: true });
            expect(fake.started[1]).toMatchObject({ countdownSeconds: DEFAULT_COUNTDOWN_SECONDS, target: undefined });
        } finally {
            fake.close();
        }
    });

    test("an option the CLI would refuse is refused before anything starts, with the CLI's message", async () => {
        const fake = fakeRecorder();
        const { movies } = (await new MoviesToolset({ start: fake.start }).load(ctx)) as {
            movies: { record(options: unknown): Promise<unknown> };
        };
        // The schema check throws at the call, the CLI's parse inside the promise: both must refuse.
        const record = (options: unknown) => Promise.resolve().then(() => movies.record(options));

        await expect(record({ threshold: 120 })).rejects.toThrow("threshold");
        await expect(record({ countdown: 11 })).rejects.toThrow("countdown");
        await expect(record({ idleFps: 0 })).rejects.toThrow("idleFps");
        await expect(record({ region: "10,20,300" })).rejects.toThrow("--region takes x,y,width,height");
        await expect(record({ micDevice: "BuiltInMicrophoneDevice" })).rejects.toThrow(
            "--mic-device needs --audio mic"
        );
        expect(fake.started).toHaveLength(0);
        expect(() => parseStartFlags(readStartArgs(["--countdown", "2.5"]))).toThrow(
            "--countdown takes a whole number from 1 to 10"
        );
        expect(() => parseStartFlags(readStartArgs(["--window", "12,x"]))).toThrow("--window takes CG window ids");
    });

    test("describe() lists every start option with its limits", () => {
        const docs = renderDocs(moviesApi);
        const line = docs.split("\n").find((text) => text.includes("movies.record(")) ?? "";

        for (const field of [
            "region?: string",
            "idleFps?: number (0.1–5)",
            "threshold?: number (0–100)",
            "countdown?: boolean | number (1–10)",
            "systemCursor?: boolean",
            "shortcuts?: boolean",
            "micDevice?: string",
            "excludeWindowIds?: number (>0)[]",
            "display?: number (0–16)",
        ]) {
            expect(line).toContain(field);
        }
    });

    test("the camera is refused while the menu bar recorder does not run, from the REPL and from the core", async () => {
        const fake = fakeRecorder();
        let face: "held" | "free" = "free";
        const { movies } = (await new MoviesToolset({ start: fake.start, recorderFace: () => face }).load(ctx)) as {
            movies: { record(options: unknown): Promise<{ folder?: string }> };
        };

        try {
            await expect(movies.record({ camera: true })).rejects.toThrow(
                "The camera needs the menu bar recorder of GenesisTools.app"
            );
            expect(fake.started).toHaveLength(0);

            face = "held";
            await movies.record({ camera: true });
            expect(fake.started[0]).toMatchObject({ camera: true });
        } finally {
            fake.close();
        }

        // `tools recorder start --camera` refuses in the core before anything is built or recorded.
        let prepared = false;
        await expect(
            recordVideo({
                target: { kind: "display", screenIndex: 0 },
                camera: true,
                recorderFace: () => "free",
                countdownSeconds: 1,
                prepare: async () => {
                    prepared = true;
                },
            })
        ).rejects.toThrow("it is not running, so the movie would have no camera");
        expect(prepared).toBe(false);
    });

    test("a recording that asked for the camera says so when no camera.json came", async () => {
        const folder = mkdtempSync(join(tmpdir(), "camera-end-"));
        expect(await missingCameraWarning({ folder, timeoutMs: 50 })).toContain("camera.json is missing");
        writeFileSync(join(folder, "camera.json"), "{}");
        expect(await missingCameraWarning({ folder, timeoutMs: 50 })).toBeUndefined();
    });

    test("the countdown runs after the slow part and before the start gate, so a caller that gave up still cancels", async () => {
        const gates = mkdtempSync(join(tmpdir(), "countdown-gate-"));
        const gate = startGatePath(gates);
        expect(await closeStartGate(gate)).toEqual({ status: "cancelled" });
        const order: string[] = [];

        await expect(
            recordVideo({
                target: { kind: "display", screenIndex: 0 },
                startGate: gate,
                countdownSeconds: 2,
                prepare: async () => {
                    order.push("prepare");
                },
                countdown: async (seconds) => {
                    order.push(`countdown ${seconds}`);
                },
            })
        ).rejects.toBeInstanceOf(RecordingStartCancelled);
        expect(order).toEqual(["prepare", "countdown 2"]);
    });
});

describe("the CLI doors of a frames recording and of the live OCR settings take the REPL's values", () => {
    test("tools recorder start --frames gives the options recorder.start() takes, checked by its schema", () => {
        const flags = readStartArgs([
            "--frames",
            "jpeg",
            "--jpeg-quality",
            "0.6",
            "--naming",
            "wall-clock",
            "--flush",
            "piece",
            "--ocr",
            "--ocr-languages",
            "en-US,cs-CZ",
            "--ocr-min-chars",
            "5",
            "--ocr-sink",
            "jsonl",
            "--displays",
            "all",
            "--fps",
            "2",
            "--idle-fps",
            "0.5",
            "--threshold",
            "3",
            "--max-long-side",
            "1600",
            "--heartbeat",
            "30",
            "--piece-seconds",
            "20",
            "--max-seconds",
            "600",
            "--audio",
            "mic",
            "--mic-device",
            "BuiltInMicrophoneDevice",
            "--title",
            "Standup",
        ]);
        expect(wantsFrames(flags)).toBe(true);
        expect(framesStartOf(flags)).toEqual(
            recorderStartSchema.parse({
                title: "Standup",
                displays: "all",
                audio: { mic: true, system: false, micDeviceId: "BuiltInMicrophoneDevice" },
                fps: 2,
                idleFps: 0.5,
                threshold: 3,
                maxLongSide: 1600,
                heartbeatSec: 30,
                ocr: { languages: ["en-US", "cs-CZ"], minChars: 5 },
                ocrSink: "jsonl",
                frames: { format: "jpeg", jpegQuality: 0.6, naming: "wall-clock", flush: "piece" },
                maxDurationSec: 600,
                pieceSec: 20,
            })
        );
        // A bare --frames is the REPL's default (the recorder's own files); --displays takes ids too.
        expect(framesStartOf(readStartArgs(["--frames", "--displays", "1,4"]))).toMatchObject({ displays: [1, 4] });
        // A movie still defaults to 60 fps: the default left the flag so a frames recording keeps its own.
        expect(parseStartFlags(readStartArgs([])).fps).toBe(60);
    });

    test("each kind refuses the other kind's flags, and a bad value names its flag", () => {
        const frames = (args: string[]) => () => framesStartOf(readStartArgs(args));
        expect(frames(["--frames", "--region", "1,2,3,4", "--camera"])).toThrow(
            "A frames recording (--frames) does not take --region, --camera"
        );
        expect(() => refuseOtherKindFlags(readStartArgs(["--ocr", "--flush", "piece"]))).toThrow(
            "--flush, --ocr need --frames"
        );
        expect(frames(["--frames", "jpeg", "--jpeg-quality", "2"])).toThrow("--jpeg-quality: Too big");
        expect(frames(["--frames", "png"])).toThrow("--frames:");
        expect(frames(["--frames", "--max-seconds", "9000"])).toThrow("--max-seconds: Too big");
        expect(frames(["--frames", "--mic-device", "BuiltInMicrophoneDevice"])).toThrow(
            "--mic-device needs --audio mic"
        );
    });

    test("recordFrames records JPEG frames with their OCR rows and ends with the finish's answer", async () => {
        const converted: number[] = [];
        const result = await recordFrames({
            start: framesStartOf(
                readStartArgs([
                    "--frames",
                    "jpeg",
                    "--flush",
                    "piece",
                    "--ocr",
                    "--ocr-sink",
                    "jsonl",
                    "--title",
                    "Frames",
                ])
            ),
            recorder: () => new FakeRecorder(),
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
            // A few of the fake's frames (one each 60 ms), then the stop the CLI's Ctrl-C would send.
            onStart: (recording) => {
                void Bun.sleep(300).then(() => recording.stop());
            },
        });
        const rows = readFileSync(join(result.folder, "ocr.jsonl"), "utf8").trim().split("\n");

        expect(result).toMatchObject({ state: "stopped", outcome: "done" });
        expect(result.frames).toBeGreaterThan(0);
        expect(converted.length).toBeGreaterThan(0);
        expect(SafeJSON.parse(rows[0], { strict: true })).toMatchObject({ text: "Sprint board" });
        expect(readRecordingManifest(result.folder)?.title).toBe("Frames");
    }, 30_000);

    test("tools meetings record set sends the patch the REPL's setSettings() sends, OCR included", () => {
        expect(
            settingsPatchFromFlags({
                activeFps: "3",
                threshold: "2",
                ocr: false,
                ocrLanguages: "en-US, cs-CZ",
                ocrMinChars: "6",
            })
        ).toEqual(
            settingsPatchOf({
                fps: 3,
                threshold: 2,
                ocr: { enabled: false, languages: ["en-US", "cs-CZ"], minChars: 6 },
            })
        );
        expect(settingsPatchFromFlags({ ocr: true })).toEqual({ ocr: { enabled: true } });
        expect(settingsPatchFromFlags({})).toEqual({});
        expect(() => settingsPatchFromFlags({ ocrMinChars: "2000" })).toThrow("--ocr-min-chars: Too big");
        expect(() => settingsPatchFromFlags({ ocrLanguages: " , " })).toThrow("--ocr-languages:");
    });
});
