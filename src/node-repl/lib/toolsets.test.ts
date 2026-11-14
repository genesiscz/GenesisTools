import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RecordingSession, type SegmentRecorder } from "@app/control/lib/recording-session";
import { SessionRecorderControl } from "@app/control/lib/recording-session-control";
import type { AppStatus } from "@app/macos/lib/permissions/app";
import * as appModule from "@app/macos/lib/permissions/app";
import { DecisionJournal } from "@app/meetings/lib/decision-journal";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import { meetingLiveId } from "@app/meetings/lib/recorder-shared";
import { settingsPatchFromFlags } from "@app/meetings/lib/settings-flags";
import { ReplEngine } from "@app/node-repl/lib/engine";
import { BrowserToolset } from "@app/node-repl/lib/toolsets/browser";
import { MeetingsToolset } from "@app/node-repl/lib/toolsets/meetings";
import { missingCameraWarning } from "@app/recorder/lib/camera-recorder";
import { defaultExportName, editProject, inItsFolder, transcriptWords, undoDepth } from "@app/recorder/lib/edit";
import { withEditSession } from "@app/recorder/lib/edit-session";
import { framesStartOf, recordFrames, refuseOtherKindFlags, wantsFrames } from "@app/recorder/lib/frames-recording";
import { requireRecorderPart } from "@app/recorder/lib/library";
import {
    chapterLines,
    chapterMetadata,
    chapterPoints,
    chaptersOf,
    chaptersOfPart,
    EMBEDDED_CHAPTER_MIN_SECONDS,
    exportChapterPoints,
    markersOf,
    recordingFolderOf,
    spreadTimes,
} from "@app/recorder/lib/moments";
import { forwardsToService } from "@app/recorder/lib/movie-client";
import {
    DEFAULT_COUNTDOWN_SECONDS,
    parseStartFlags,
    readStartArgs,
    refuseTargetOffScreen,
    START_LIMITS,
    type StartRequest,
    withStartOptions,
} from "@app/recorder/lib/start-options";
import {
    fixOutcome,
    laneRemovalReason,
    Movie,
    type MovieRecorderDeps,
    MoviesToolset,
    moviesApi,
    silentMovieReason,
    withLength,
} from "@app/recorder/lib/toolset";
import { RecordingStartCancelled, recordVideo } from "@app/recorder/lib/video-recording";
import { renderDocs } from "@genesiscz/utils/api-descriptor";
import { withTimeout } from "@genesiscz/utils/async";
import * as converter from "@genesiscz/utils/audio/converter";
import * as cli from "@genesiscz/utils/cli";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import * as ocr from "@genesiscz/utils/macos/ocr";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { closeStartGate, startGatePath } from "@genesiscz/utils/process/start-gate";
import transcriptCuts from "@genesiscz/utils/recording-editor/__fixtures__/transcript-cuts.json";
import transcriptWordsFixture from "@genesiscz/utils/recording-editor/__fixtures__/transcript-words.json";
import * as denoise from "@genesiscz/utils/recording-editor/denoise";
import { RecordingEditor } from "@genesiscz/utils/recording-editor/editor";
import {
    readProject,
    transcriptCachePath,
    wholeProject,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { searchMethods } from "@genesiscz/utils/repl/discovery";
import { readShowable } from "@genesiscz/utils/repl/show";
import type { ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { type Clip, EditorToolset, editorApi, editSourceOf, ReplJob } from "@genesiscz/utils/repl/toolsets/editor";
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
import { FRAMES_START_LIMITS, LibraryRecording, startRecording } from "@genesiscz/utils/screen-recorder/start";
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
import { Command } from "commander";

/** The CLI's undo and collapse with no recorder service: each on a short-lived session of the edit file. */
const undoEdit = (path: string) => withEditSession(path, (session) => session.undo({ by: "agent" }));
const collapseUndo = (path: string, depth: number) => withEditSession(path, (session) => session.collapseUndo(depth));

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

/** One opened meeting, as the meetings tests call it. */
interface MeetingHandle {
    readonly id: string;
    readonly title: string;
    readonly record: { items: Array<{ id: string; status: string }> };
    items: {
        add(input: unknown): Promise<unknown>;
        confirm(input: unknown): Promise<{ decided: string[]; token?: string }>;
        reopen(input: unknown): Promise<{ reopened: string[] }>;
        reject(input: unknown): Promise<{ decided: string[] }>;
        list(input?: unknown): unknown[];
    };
    set(input: unknown): Promise<{ project: string | null; labels: string[] }>;
    settings(): Promise<SettingsAnswer>;
    setSettings(patch: unknown): Promise<SettingsAnswer>;
    mark(label: string): Promise<RecordingMarker>;
}

/** The meetings toolset's global, as the meetings tests call it. */
interface MeetingsHandle {
    list(): Array<{ id: string; seconds: number | null }>;
    open(ref: string): MeetingHandle;
    config: { get(path?: string): Promise<unknown> };
    projects: {
        labels(input: unknown): Promise<string[]>;
        pair(input: unknown): Promise<unknown>;
        unpair(input: unknown): Promise<unknown>;
        people(input?: unknown): Promise<Array<{ project: string; name: string }>>;
    };
}

/** Loads the meetings toolset and gives its global the one shape the tests share. */
async function loadMeetings(): Promise<MeetingsHandle> {
    const { meetings } = (await new MeetingsToolset().load(ctx)) as { meetings: MeetingsHandle };
    return meetings;
}

/** The browser toolset's global, as its test calls it. */
interface BrowserHandle {
    open(input: { port: number; url: string }): Promise<{ id: string; url: string; title: string }>;
}

/** A browser toolset whose CDP port is a fake driver: the tab opens and loads, and the tab list then fails. */
class TabsFailBrowser extends BrowserToolset {
    constructor(port: number) {
        super();
        this.drivers.set(port, {
            tabs: async () => {
                throw new Error("the browser dropped the connection");
            },
            evaluate: async () => undefined,
            navigate: async () => true,
            open: async () => ({ id: "tab-1", url: "about:blank", title: "" }),
            waitForRequest: async () => {
                throw new Error("not used");
            },
            close: () => undefined,
        });
    }
}

describe("browser toolset", () => {
    // An open tab whose details could not be read was refused, so the caller never got the id to close it with.
    test("open still answers the tab's id when the tab list fails after the load", async () => {
        const { browser } = (await new TabsFailBrowser(9555).load(ctx)) as { browser: BrowserHandle };
        expect(await browser.open({ port: 9555, url: "https://example.com/" })).toEqual({
            id: "tab-1",
            url: "https://example.com/",
            title: "",
        });
    });
});

describe("toolset method names", () => {
    test("a missing method names the real ones, while inspection and await still read missing names", async () => {
        const ctx: ToolsetContext = { scratchDir: tmpdir(), show: async () => {}, write: () => {} };
        const { movies } = (await new MoviesToolset().load(ctx)) as {
            movies: { open(recording: string): object; opn?: unknown };
        };

        expect(() => movies.opn).toThrow(
            'movies has no "opn" (did you mean open?); it has: list, search, open, record'
        );
        // NR11: a name that matches nothing used to answer a Movie; it is refused at once now (intended change).
        expect(() => movies.open("nr11-no-such-recording")).toThrow();
        const project = join(mkdtempSync(join(tmpdir(), "missing-method-")), "edit.json");
        writeProject(
            project,
            wholeProject({ video: join(dirname(project), "screen.mp4"), durationUs: 1_000_000, width: 10, height: 10 })
        );
        const movie = movies.open(project);
        expect(() => Reflect.get(movie, "trim")).toThrow('movies.Movie has no "trim"');
        expect(Reflect.get(movie, "then")).toBeUndefined();
        // NR11: printing a Movie showed the worker's context, its scratch path and a private method.
        expect(Bun.inspect(movie)).toBe(
            `Movie ${SafeJSON.stringify(project)} (info() reads its edit; help() lists its methods)`
        );

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
        const cut = Reflect.get(opened, "cut") as (...args: unknown[]) => Promise<Record<string, unknown>>;
        // NR23: an edit answers one summary line and where it is, not the whole edit (about 1,500 characters); info() has it.
        const answer = await cut({ from: 1, to: 2 });
        expect(Object.keys(answer).sort()).toEqual(["changed", "outputSeconds", "path", "revision", "summary"]);
        expect(String(answer.summary)).toContain("2 clips");
        const info = Reflect.get(opened, "info") as () => Promise<{ clips: unknown[] }>;
        expect((await info()).clips).toHaveLength(2);
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

describe("itemsAt agrees with the frame the renderer draws", () => {
    const fixture = (segments: Array<{ text: string; start: number; end: number }>) => {
        const folder = mkdtempSync(join(tmpdir(), "items-at-frame-"));
        const video = join(folder, "screen.mp4");
        const path = join(folder, "edit.json");
        writeProject(path, wholeProject({ video, durationUs: 12_000_000, width: 100, height: 100 }));
        writeFileSync(transcriptCachePath(video), SafeJSON.stringify({ text: "", segments }));
        return new Movie(path);
    };

    test("itemsAt names a caption only while captions show, the line the renderer picks, and what is said in spoken", async () => {
        const movie = fixture([
            { text: "Hello", start: 0.5, end: 3 },
            { text: "Next", start: 2.5, end: 4 },
        ]);

        // No captions op: the export draws no caption, and the transcript line is still said there.
        expect(await movie.itemsAt(1)).toMatchObject({ caption: null, spoken: "Hello" });
        await movie.captions({ show: true });
        expect(await movie.itemsAt(1)).toMatchObject({ caption: "Hello", spoken: "Hello" });
        // Two lines overlap at 2.7 s: the renderer draws the later one (CaptionTrack.line picks the last started line).
        expect(await movie.itemsAt(2.7)).toMatchObject({ caption: "Next", spoken: "Next" });
        await movie.captions({ show: false });
        expect(await movie.itemsAt(2.7)).toMatchObject({ caption: null, spoken: "Next" });
        expect(await movie.itemsAt(5)).toMatchObject({ caption: null, spoken: null });
    });

    test("itemsAt names a canvas zoom and a picture zoom that play together, the glide between linked zooms and a lens", async () => {
        const movie = fixture([]);
        await movie.zoom({ from: 1, to: 7, target: "canvas", scale: 1.5 });
        await movie.zoom({ from: 2, to: 4, scale: 2 });
        await movie.zoom({ from: 4.3, to: 6, scale: 2.5 });
        await movie.lens({ from: 2.8, to: 3.2 });

        const now = await movie.itemsAt(3);
        expect(now.zoom).toMatchObject({ from: 2, to: 4, scale: 2 });
        expect(now.canvasZoom).toMatchObject({ from: 1, to: 7, scale: 1.5, target: "canvas" });
        expect(now.lenses).toMatchObject([{ from: 2.8, to: 3.2 }]);
        // 2-4 s and 4.3-6 s are linked (0.3 s apart, under one ease out and one ease in): the view glides between them
        // from 3.55 s to 4.75 s, the gap at 4.15 s included.
        expect((await movie.itemsAt(4.15)).zoom).toMatchObject({
            glide: { from: { from: 2, to: 4 }, to: { from: 4.3, to: 6 } },
        });
        expect((await movie.itemsAt(5)).zoom).toMatchObject({ from: 4.3, to: 6, scale: 2.5 });
        // Control: before the picture zooms only the canvas zoom shows, and no lens.
        const early = await movie.itemsAt(1.5);
        expect(early).toMatchObject({ zoom: null, lenses: [] });
        expect(early.canvasZoom).toMatchObject({ target: "canvas" });
        expect((await movie.itemsAt(8)).canvasZoom).toBeNull();
    });

    test("itemsAt names the hidden parts the export snaps to a cut or to the next part, with their own times", async () => {
        const movie = fixture([]);
        const rect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
        await movie.redact({ from: 7, to: 8, rect, style: "black" });
        await movie.redact({ from: 8.2, to: 9.85, rect, style: "black" });
        await movie.cut(10, 11.5);

        // The 0.2 s gap between the parts closes, and the second part's end 0.15 s before the cut runs to the cut.
        const gap = await movie.itemsAt(8.1);
        expect(gap.redactions).toMatchObject([{ from: 7, to: 8, drawn: { from: 7, to: 8.2 } }]);
        expect((await movie.itemsAt(9.9)).redactions).toMatchObject([{ from: 8.2, to: 9.85, drawn: { to: 10 } }]);
        // Control: snapMs 0 draws each part exactly as placed.
        await movie.redactionJoins({ snapMs: 0 });
        expect((await movie.itemsAt(8.1)).redactions).toEqual([]);
        expect((await movie.itemsAt(9.9)).redactions).toEqual([]);
        expect((await movie.itemsAt(7.5)).redactions).toMatchObject([{ from: 7, to: 8 }]);
    });
});

// NR1 (deep test 2026-11-06): find() ran tools transcribe on a movie with no transcript and no sound; a vault-key
// dialog stayed on the user's screen after the turn timed out. The spy throws, so a path that reaches it fails loudly.
describe("a read call never starts the paid transcription", () => {
    test("find() reads the cached transcript only, while transcript() still reaches tools transcribe", async () => {
        const spawned: string[][] = [];
        const run = spyOn(cli, "execTool").mockImplementation(async (args: readonly string[]) => {
            spawned.push([...args]);
            throw new Error(`execTool reached: ${args.join(" ")}`);
        });
        // transcript() reads the movie's audio tracks and mixes them before the paid call (91af263157); the movie here
        // is only a path, so one track is reported and the mix is skipped.
        const tracks = spyOn(denoise, "audioTrackCount").mockResolvedValue(1);
        const mix = spyOn(converter, "convertFileToMonoMp3").mockImplementation(async (_input, output) => output);

        try {
            const { movies } = (await new MoviesToolset().load(ctx)) as {
                movies: { open(recording: string): Record<string, (...args: unknown[]) => Promise<unknown>> };
            };
            const folder = mkdtempSync(join(tmpdir(), "gt-find-no-transcript-"));
            const path = join(folder, "edit.json");
            writeProject(
                path,
                wholeProject({ video: join(folder, "screen.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
            );
            const movie = movies.open(path);

            await expect(movie.find("anything")).rejects.toThrow("this movie has no transcript yet");
            expect(spawned).toEqual([]);

            // The negative control: the method that declares the paid run still starts it.
            await expect(movie.transcript()).rejects.toThrow("execTool reached: transcribe");
            expect(spawned.map((args) => args[0])).toEqual(["transcribe"]);

            writeFileSync(
                join(folder, "screen.transcript.json"),
                SafeJSON.stringify({ segments: [{ text: " hello there", start: 1, end: 2 }] })
            );
            expect(await movie.find("hello")).toMatchObject([{ text: "hello there" }]);
            expect(spawned).toHaveLength(1);
        } finally {
            run.mockRestore();
            tracks.mockRestore();
            mix.mockRestore();
        }
    });

    test("the methods whose effect stopped being read keep running in the caller, not in the recorder service", () => {
        const methods = moviesApi.handles?.find((handle) => handle.name === "Movie")?.methods ?? [];
        const routed = (name: string) => {
            const method = methods.find((candidate) => candidate.name === name);
            return method ? forwardsToService(method) : undefined;
        };

        expect(["transcript", "still", "sheet", "reveal", "copy"].map(routed)).toEqual([
            false,
            false,
            false,
            false,
            false,
        ]);
        expect(routed("cut")).toBe(true);
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

describe("the clicks of a movie, grouped", () => {
    test("clicks under 3 s apart are one group, with its source and output time and the clicks a cut hides", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-click-groups-"));
        const cursor = join(folder, "cursor.jsonl");
        // Source 20 s; the edit keeps 0-4, 6-12 and 16-20, so 4-6 and 12-16 are cut.
        const rows = [
            { t: 1000, x: 0.1, y: 0.1, click: "left" },
            { t: 1500, x: 0.1, y: 0.1, click: "left" },
            { t: 2000, x: 0.2, y: 0.2, click: "left" },
            { t: 3000, x: 0.3, y: 0.3 },
            { t: 5000, x: 0.4, y: 0.4, click: "left" },
            { t: 7000, x: 0.5, y: 0.5, click: "right" },
            { t: 14000, x: 0.6, y: 0.6, click: "left" },
            { t: 14500, x: 0.6, y: 0.6, click: "left" },
            { t: 18000, x: 0.7, y: 0.7, click: "left" },
        ];
        writeFileSync(cursor, `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
        const path = join(folder, "screen.edit.json");
        writeProject(path, {
            ...wholeProject({
                video: join(folder, "screen.mp4"),
                cursor,
                durationUs: 20_000_000,
                width: 100,
                height: 100,
            }),
            clips: [
                { id: "a", fromUs: 0, toUs: 4_000_000, speed: 1 },
                { id: "b", fromUs: 6_000_000, toUs: 12_000_000, speed: 1 },
                { id: "c", fromUs: 16_000_000, toUs: 20_000_000, speed: 1 },
            ],
        });

        expect(await new Movie(path).clickGroups()).toEqual([
            { from: 1, to: 2, count: 3, plays: { from: 1, to: 2 }, cut: 0 },
            { from: 5, to: 7, count: 2, plays: { from: 5, to: 5 }, cut: 1 },
            { from: 14, to: 14.5, count: 2, plays: null, cut: 2 },
            { from: 18, to: 18, count: 1, plays: { from: 12, to: 12 }, cut: 0 },
        ]);

        // A movie with no cursor track has no clicks to read, which is not the same as no clicks.
        const bare = join(folder, "bare.edit.json");
        writeProject(
            bare,
            wholeProject({ video: join(folder, "bare.mp4"), durationUs: 1_000_000, width: 1, height: 1 })
        );
        await expect(new Movie(bare).clickGroups()).rejects.toThrow("no cursor track");
    });
});

// NR11: editor.open() of a video recording's folder read it as frames, and the first use threw "holds no frames".
test("editor.open of a video recording's folder opens its movie, a frames folder stays, a missing path throws at once", () => {
    const folder = mkdtempSync(join(tmpdir(), "gt-video-recording-"));
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "rec",
            title: "Rec",
            startedAt: "2026-11-05T10:00:00.000Z",
            displays: [],
            frames: [],
            settings: { kind: "video" },
        })
    );
    writeFileSync(join(folder, "screen.mp4"), "not really a movie");
    expect(editSourceOf(folder)).toEqual({ file: join(folder, "screen.mp4") });
    mkdirSync(join(folder, "frames"));
    expect(editSourceOf(join(folder, "frames"))).toEqual({ file: join(folder, "screen.mp4") });
    // A folder of its own inside the recording is edited as the frames it holds.
    mkdirSync(join(folder, "picked"));
    expect(editSourceOf(join(folder, "picked"))).toEqual({ file: join(folder, "picked") });

    const frames = mkdtempSync(join(tmpdir(), "gt-frames-folder-"));
    expect(editSourceOf(frames)).toEqual({ file: frames });
    expect(() => editSourceOf(join(frames, "nope.mp4"))).toThrow("No such file or folder");
});

// NR33: movies.list() gave no length and no size, so an agent that wanted a short recording opened each one.
test("a library row carries its length and its movie's size", () => {
    const folder = mkdtempSync(join(tmpdir(), "gt-library-length-"));
    const movie = join(folder, "screen.mp4");
    writeFileSync(movie, "x".repeat(1234));
    const row = {
        id: "rec",
        title: "Rec",
        folder,
        startedAt: "2026-11-05T10:00:00.000Z",
        endedAt: "2026-11-05T10:01:30.400Z",
        movie,
        frames: 0,
        edited: false,
    };
    expect(withLength(row)).toMatchObject({ seconds: 90, bytes: 1234 });
    expect(withLength({ ...row, endedAt: undefined, movie: undefined })).toMatchObject({ seconds: null, bytes: null });
});

// Round 2 hunt (r2-movies-list-length): seconds was the wall time from start to stop, so a paused recording read longer
// than its movie and a plain-movie duplicate read 0 s.
test("a library row's length is its movie's length, the wall span only without one", () => {
    const row = {
        id: "rec",
        title: "Rec",
        folder: "/nowhere",
        startedAt: "2026-11-05T10:00:00.000Z",
        endedAt: "2026-11-05T10:00:30.000Z",
        frames: 0,
        edited: false,
    };
    expect(withLength({ ...row, durationMs: 12_400 }).seconds).toBe(12);
    expect(withLength(row).seconds).toBe(30);
    expect(withLength({ ...row, endedAt: row.startedAt, durationMs: 5_000 }).seconds).toBe(5);
    expect(withLength({ ...row, endedAt: undefined, recording: true }).seconds).toBeNull();
});

// NR37: removeLane('zooms') removed the built-in zoom lane, and the movie had no lane for zooms after it.
test("the last lane that holds zooms cannot be removed; another lane for zooms lets it go", () => {
    expect(laneRemovalReason([{ id: "zooms", kinds: ["zoom"] }], "zooms")).toContain(
        "the zooms lane is the only lane that holds zooms"
    );
    expect(laneRemovalReason([{ id: "zooms", kinds: ["zoom"] }, { id: "all" }], "zooms")).toBeUndefined();
    expect(
        laneRemovalReason(
            [
                { id: "zooms", kinds: ["zoom"] },
                { id: "texts", kinds: ["text"] },
            ],
            "texts"
        )
    ).toBeUndefined();
    expect(laneRemovalReason([{ id: "zooms", kinds: ["zoom"] }], "nope")).toBeUndefined();
});

// NR35: switchDisplay on a video recording said "has no frames to make a movie of".
test("switchDisplay on a video recording says it needs a frames recording", async () => {
    const folder = mkdtempSync(join(tmpdir(), "gt-video-switch-"));
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "rec",
            title: "Rec",
            startedAt: "2026-11-05T10:00:00.000Z",
            displays: [],
            frames: [],
            settings: { kind: "video" },
        })
    );
    const path = join(folder, "screen.edit.json");
    writeProject(
        path,
        wholeProject({ video: join(folder, "screen.mp4"), durationUs: 2_000_000, width: 10, height: 10 })
    );
    await expect(new Movie(path).switchDisplay({ from: 0, to: 1, display: 2 })).rejects.toThrow(
        "this is a video recording: it has no display frames to switch between"
    );
});

// NR43: fix() counted an action that changed nothing as fixed.
test("fix() reports an issue check() still finds after its action as unchanged, never as fixed", () => {
    const issue = (message: string, fixable = true) => ({
        severity: "fix" as const,
        item: "text",
        message,
        ...(fixable ? { action: { label: "fix it", ops: [] } } : {}),
    });
    const before = [issue("text t1 is too short to read"), issue("zoom z1 never shows"), issue("no transcript", false)];
    const after = [issue("text t1 is too short to read"), issue("no transcript", false)];
    expect(fixOutcome(before, after)).toEqual({
        fixed: ["zoom z1 never shows"],
        unchanged: ["text t1 is too short to read"],
    });
});

// NR36 and NR34: denoise() on a movie without sound saved, check() said ok and every export failed; mute(0) did nothing.
describe("an edit of the sound on a movie without sound", () => {
    const video = (types: string[]) => ({
        path: "/movies/demo/screen.mp4",
        bytes: 1,
        durationSec: 2,
        streams: types.map((type) => ({ type, codec: "x", attachedPicture: false })),
    });

    test("is refused with the reason when the video has no audio track, and allowed when it has one or is unknown", () => {
        expect(silentMovieReason(video(["video"]), "clean")).toBe(
            "this movie has no sound to clean: its video screen.mp4 has no audio track"
        );
        expect(silentMovieReason(video(["video", "audio"]), "clean")).toBeUndefined();
        expect(silentMovieReason(undefined, "mute")).toBeUndefined();
    });
});

describe("a movie method that needs the recorder part of the app", () => {
    const app = (built: boolean, parts: string[]): AppStatus => ({
        bundlePath: "/Applications/GenesisTools.app",
        launcherPath: "/Applications/GenesisTools.app/Contents/MacOS/GenesisTools",
        built,
        stale: false,
        parts,
        identityStable: true,
    });

    test("refuses with the command that adds it and starts no build: a build outlives the turn (R2-NR3)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-no-part-"));
        const path = join(folder, "screen.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "screen.mp4"), durationUs: 4_000_000, width: 100, height: 100 })
        );
        const build = spyOn(appModule, "buildApp").mockImplementation(() => {
            throw new Error("a REPL method started an app build");
        });
        const status = spyOn(appModule, "appStatus").mockReturnValue(app(true, []));

        try {
            await expect(new Movie(path).still(1)).rejects.toThrow(
                "movie.still() cannot run: GenesisTools.app was built without the recorder part, so nothing was started."
            );
            await expect(new Movie(path).export()).rejects.toThrow("macos permissions build --add-part recorder");
            status.mockReturnValue(app(false, []));
            await expect(new Movie(path).show()).rejects.toThrow(
                "GenesisTools.app is not built, so nothing was started."
            );
            expect(build).not.toHaveBeenCalled();
            status.mockReturnValue(app(true, ["recorder"]));
            expect(() => requireRecorderPart("movie.still()")).not.toThrow();
        } finally {
            build.mockRestore();
            status.mockRestore();
        }
    });
});

describe("what a cut costs, in the answer of the call", () => {
    test("a cut that hides a marker or shortens a text says so once in its answer, and check() names them", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-cut-losses-"));
        writeFileSync(
            join(folder, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id: "rec",
                title: "Rec",
                startedAt: "2026-11-05T10:00:00.000Z",
                displays: [],
                frames: [],
                settings: { markers: [{ atMs: 5000, label: "Recorded" }] },
            })
        );
        const path = join(folder, "screen.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "screen.mp4"), durationUs: 10_000_000, width: 100, height: 100 })
        );
        const movie = new Movie(path);
        await movie.text({ from: 1, to: 4, text: "Title" });
        expect((await movie.marker(6.2, "Step two")).warnings).toBeUndefined();
        const marker = readProject(path).markers?.[0]?.id ?? "";
        const text = readProject(path).texts?.[0]?.id ?? "";

        expect((await movie.cut(2, 6.5)).warnings).toEqual([
            `The text "Title" (1 to 4 s) loses 2 s of its 3 s to a cut and plays for 1 s; movie.retime({ id: "${text}", to: 7 }) fixes it`,
            `The marker "Step two" at 6.2 s never plays: that time is cut, so it is no chapter; movie.apply([{"op":"unmarker","id":"${marker}"},{"op":"marker","at":6.5,"label":"Step two"}]) fixes it`,
            'The recorded marker "Recorded" at 5 s never plays: that time is cut, so it is no chapter; movie.marker(6.5, "Recorded") fixes it',
        ]);
        // A change that costs nothing more says nothing again.
        expect((await movie.zoom({ from: 7, to: 9 })).warnings).toBeUndefined();
        expect((await movie.check()).issues.map((issue) => issue.item)).toEqual([
            `marker ${marker}`,
            `text ${text}`,
            'recorded marker "Recorded"',
        ]);
    });
});

describe("the answer of fix() with nothing to fix and of undo()", () => {
    // R2-NR4: both answered the whole edit (clips, zooms, audio, export, lanes: about 2,500 chars) where every other
    // edit answers one line and where it is.
    test("is the short answer of every edit, plus what each did", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-short-answer-"));
        const path = join(folder, "screen.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "screen.mp4"), durationUs: 6_000_000, width: 100, height: 100 })
        );
        const movie = new Movie(path);
        await movie.cut(1, 2);
        const fixed = await movie.fix();
        expect(Object.keys(fixed).sort()).toEqual(
            ["fixed", "outputSeconds", "path", "revision", "summary", "unchanged", "warnings"].sort()
        );
        expect(fixed).toMatchObject({
            fixed: [],
            warnings: ["check() found nothing that fix() can fix"],
            outputSeconds: 5,
        });
        const undone = await movie.undo();
        expect(Object.keys(undone).sort()).toEqual(
            ["outputSeconds", "path", "revision", "stepsLeft", "summary", "undone"].sort()
        );
        expect(undone).toMatchObject({ undone: ["cut"], stepsLeft: 0, outputSeconds: 6, path });
        expect(undone.summary).toStartWith("6 s long");
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

    // Round 1 hunt (intro-card-export-clock): chapters() and `markers --chapters` printed output times for the exported
    // file's description, so each link opened the upload the intro card's length early.
    test("on the exported file's clock: the card's title at 0:00 once, every marker the card's length later", () => {
        const folder = join(tmpdir(), "gt-no-such-recording");
        const project = {
            ...wholeProject({ video: join(folder, "talk.mp4"), durationUs: 60_000_000, width: 100, height: 100 }),
            cards: { intro: { title: "Demo", seconds: 3 } },
            markers: [
                { id: "m1", atUs: 12_000_000, label: "Login" },
                { id: "m2", atUs: 30_000_000, label: "Dashboard" },
            ],
        };
        const opened = { path: join(folder, "talk.edit.json"), project };

        expect(exportChapterPoints(opened, { minSeconds: 1 })).toEqual([
            { at: 0, label: "Demo" },
            { at: 15, label: "Login" },
            { at: 33, label: "Dashboard" },
        ]);
        expect(chapterLines(exportChapterPoints(opened))).toEqual(["0:00 Demo", "0:15 Login", "0:33 Dashboard"]);
        expect(chapterLines(exportChapterPoints(opened, { intro: "Start" }))[0]).toBe("0:00 Start");
        expect(chapterLines(exportChapterPoints(opened, { clock: "output" }))).toEqual([
            "0:00 Intro",
            "0:12 Login",
            "0:30 Dashboard",
        ]);
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
        await collapseUndo(path, depth);
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

    // Round 2 hunt (r2-default-export-name): the window's EditExporter.defaultName is the reference. It trims spaces and
    // dots from both ends together, keeps 80 characters as the eye counts them, and reads any recording.json's title.
    test("the default export name follows the window's rule", () => {
        const nameFor = (manifest: Record<string, unknown>) => {
            const folder = mkdtempSync(join(tmpdir(), "gt-export-name-"));
            writeFileSync(join(folder, "recording.json"), SafeJSON.stringify(manifest));
            return defaultExportName(join(folder, "screen.mp4"));
        };

        expect(nameFor({ title: ". Demo: part 1 ." })).toBe("Demo- part 1");
        expect(nameFor({ title: `${"a".repeat(79)}😀b` })).toBe(`${"a".repeat(79)}😀`);
        expect(nameFor({ title: "..." })).toBe("screen-edited");
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

describe("embedded movie chapters and the progress bar", () => {
    test("markers under a second apart make one chapter named by the first, as the bar divides", () => {
        const markers = [
            { plays: 0.4, label: "Start" },
            { plays: 5, label: "Five" },
            { plays: 5.4, label: "Five and a bit" },
            { plays: 9, label: "Nine" },
        ];
        expect(chapterPoints(markers, { minSeconds: EMBEDDED_CHAPTER_MIN_SECONDS })).toEqual([
            { at: 0, label: "Start" },
            { at: 5, label: "Five" },
            { at: 9, label: "Nine" },
        ]);
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
        // Three REPL engines start one after another; inside the full parallel suite on a busy Mac (2026-11-05) the
        // test ran past 10 s while it passes alone, so the ceiling leaves room for slow starts.
    }, 30_000);

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

    // NR41: js_reset right after recorder.start left an empty recording in the library without a word.
    test("reset names an owned recording that stopped with no frames", async () => {
        class EmptyRecorder extends FakeRecorder {
            override async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
                mkdirSync(request.outDir, { recursive: true });
                await new Promise<void>((resolve) =>
                    signal?.addEventListener("abort", () => resolve(), { once: true })
                );
                return { startedAtMs: Date.now(), frames: [] };
            }
        }
        const engine = new ReplEngine({
            toolsets: ["recorder"],
            recorder: { create: async () => new EmptyRecorder() },
        });
        try {
            const started = await engine.run('const rec = await recorder.start({ displays: "all" }); rec.id', 10_000);
            expect(started.error).toBeUndefined();
            const notes = await engine.reset();
            expect(notes).toHaveLength(1);
            expect(notes[0]).toStartWith(
                `the recording ${started.text} stopped with no frames; its folder stays in the library: `
            );
        } finally {
            await engine.shutdown();
        }
    }, 30_000);

    // NR42: "Error: RpcError: no display 99999" and "no display -5" named neither the class once nor the real displays.
    test("an unknown display is refused once, naming the displays that are there", async () => {
        const engine = new ReplEngine({ toolsets: ["recorder"], recorder: { create: async () => new FakeRecorder() } });
        try {
            const refused = await engine.run("await recorder.start({ displays: [99999] })", 10_000);
            expect(refused.error).toBe("no display 99999; the displays: 1, 4");

            await engine.run('const rec = await recorder.start({ displays: "all" })', 10_000);
            const switched = await engine.run("await rec.displays.switch(5)", 10_000);
            expect(switched.error).toEndWith("; the displays: 1, 4");
            await engine.run("await rec.stop()", 10_000);
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

    test("follow-focus records one capture that follows the focus, and a recorder without it refuses", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-focus-rec-"));
        const liveDir = join(root, "live");
        const plain = await startRecording({ recorder: new FakeRecorder(), liveDir, folder: join(root, "plain") });
        try {
            await expect(plain.setDisplayMode("follow-focus")).rejects.toThrow("cannot follow focus");
        } finally {
            await plain.stop();
        }

        const recorder = new ControlledRecorder();
        recorder.supports.followFocus = true;
        const first = recorder.next();
        const recording = await startRecording({ recorder, liveDir, folder: join(root, "focus") });
        try {
            expect((await first).target).toEqual({ kind: "display", displayId: 1 });
            const focused = recorder.next();
            await recording.setDisplayMode("follow-focus");
            expect((await focused).target).toEqual({ kind: "follow-focus" });
            expect((await recording.status()).displays.map((display) => display.id)).toEqual([1]);
            // Leaving follow-focus restarts the capture on a fixed display.
            const fixed = recorder.next();
            await recording.setDisplayMode("main");
            expect((await fixed).target).toEqual({ kind: "display", displayId: 1 });
        } finally {
            await recording.stop();
        }

        // A list of ids leaves it too. A fresh recording: a third empty piece in a row would end the first one.
        const second = await startRecording({ recorder, liveDir, folder: join(root, "removed") });
        try {
            const focused = recorder.next();
            await second.setDisplayMode("follow-focus");
            expect((await focused).target).toEqual({ kind: "follow-focus" });
            const removed = recorder.next();
            await second.removeDisplay(4);
            expect((await removed).target).toEqual({ kind: "display", displayId: 1 });
        } finally {
            await second.stop();
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
            for (const source of [result.recordingId, result.folder ?? ""]) {
                const frames = await editor.open(source).frames();
                expect(frames.frames).toHaveLength(1);
            }
        } finally {
            client.close();
            server.close();
        }
    });

    test("waitFor keeps its own deadline when the recording stops answering", async () => {
        class StalledControl extends RecorderControl {
            readonly kind = "movie";
            readonly methods = ["status", "stop"] as const;
            async status(): Promise<never> {
                return new Promise(() => undefined);
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
        const dir = mkdtempSync(join(tmpdir(), "gt-repl-wait-"));
        const id = `movie-stalled-${process.pid}`;
        const server = new LiveRecordingServer({
            id,
            kind: "movie",
            title: "Stalled",
            dir,
            control: new StalledControl(),
        });
        const client = await RecorderClient.connect(id, { dir });
        try {
            const started = performance.now();
            await expect(new RecordingHandle(client).waitFor(() => true, { timeoutMs: 200 })).rejects.toThrow(
                "within 200 ms"
            );
            expect(performance.now() - started).toBeLessThan(1_500);
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
        ocr: { enabled: true, languages: ["en-US"], minChars: 4, threshold: 0, skipTextless: false, region: "frame" },
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
            measure: async () => 1000,
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

    test("movies: search() gives each hit its own signature line, and apply's op list only through describe()", () => {
        const lines = searchMethods([moviesApi], "click").split("\n");
        expect(
            lines.find((line) => line.startsWith("movies.Movie.clickGroups(options?: { gapSeconds?:"))
        ).toBeDefined();
        const apply = lines.find((line) => line.startsWith("movies.Movie.apply("));
        expect(apply).toStartWith("movies.Movie.apply(ops: {…}[]) → ");
        expect(apply).toContain('describe("movies.Movie.apply") prints it in full');
        expect(apply?.length).toBeLessThan(600);
    });

    test("movies: every time argument names its base, SourceTime or OutputTime, and the notes define both", () => {
        const docs = renderDocs(moviesApi);
        expect(docs).toContain("movie.cut(from: SourceTime, to: SourceTime) →");
        expect(docs).toContain("movie.still(at?: Time, out?: string, full?: boolean, source?: boolean) →");
        expect(docs).toContain("movie.range(options: { from: OutputTime; to: OutputTime;");
        expect(docs).toContain('{ op: "cut"; from: SourceTime; to: SourceTime }');
        expect(docs).toContain('{ op: "range"; from: OutputTime; to: OutputTime;');
        // A time spelled out as its type has lost its base.
        expect(docs).not.toContain("number (≥0) | string");
        expect(docs).toContain("Note: SourceTime is");
        expect(docs).toContain("Note: OutputTime is");
        expect(docs).toContain("Note: Time (still(), sheet()) is OutputTime, or SourceTime with source: true.");
    });

    test("movies: the docs of a MovieRecording's settings name the keys a movie takes and the ones it keeps", async () => {
        const { moviesApi } = await import("@app/recorder/lib/toolset");
        const docs = moviesApi.handles?.find((handle) => handle.name === "MovieRecording")?.methods ?? [];
        const doc = (name: string) => docs.find((method) => method.name === name)?.doc ?? "";
        expect(doc("setSettings")).toContain("fps, idleFps or threshold");
        expect(doc("setSettings")).toContain("maxLongSide, heartbeatSec and ocr");
        expect(doc("settings")).toContain("fixed");
    });

    // Round 2 hunt (r2-docs-units): movies.record said it records "with an on-screen countdown" while it starts at once
    // unless countdown is given, and cameraHide said touching hidden parts "are joined" while each stays its own item.
    test("movies: record says it starts at once unless countdown is given, and cameraHide keeps touching parts apart", async () => {
        const { moviesApi } = await import("@app/recorder/lib/toolset");
        const record = moviesApi.methods.find((method) => method.name === "record")?.doc ?? "";
        const movie = moviesApi.handles?.find((handle) => handle.name === "Movie")?.methods ?? [];
        const cameraHide = movie.find((method) => method.name === "cameraHide")?.doc ?? "";
        expect(record).toContain("starts at once unless countdown");
        expect(record).not.toContain("with an on-screen countdown");
        expect(cameraHide).toContain("stays hidden across the join");
        expect(cameraHide).not.toContain("are joined");
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

    test("meetings: an opened meeting shows the findings items.add stored", async () => {
        const record = await new MeetingStore().create(
            { title: "Findings", start: "2026-11-02T16:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
        const meeting = meetings.open(record.id);
        const answer = await meeting.items.add({
            findings: [{ kind: "question", from: 0, to: 5, question: "Who spoke first?" }],
        });
        expect(meeting.record.items).toHaveLength(1);
        // The answer is the added item, not the meeting record (NR5).
        expect(answer).toMatchObject({ added: [{ kind: "question", status: "suggested" }], warnings: [] });
        expect(Object.keys(answer as object).sort()).toEqual(["added", "duplicates", "warnings"]);
        const store = new MeetingStore();
        const before = readFileSync(store.path(record.id), "utf8");
        const retry = await meeting.items.add({
            findings: [{ kind: "question", from: 0, to: 5, question: "Who spoke first?" }],
        });
        expect(retry).toMatchObject({ added: [], duplicates: ["i1"] });
        expect(readFileSync(store.path(record.id), "utf8")).toBe(before);
        expect(new MeetingStore().read(record.id)?.items).toHaveLength(1);
        await meeting.items.add({
            findings: [{ kind: "question", from: 0, to: 5, question: "Who spoke first?" }],
            allowDuplicates: true,
        });
        expect(new MeetingStore().read(record.id)?.items).toHaveLength(2);
    });

    // #805: the items.add schema took force, but the adapter did not pass it on, so force: true still refused the term.
    test("meetings: items.add refuses a dead line term anchor and adds it with force", async () => {
        const record = await new MeetingStore().create(
            { title: "Forced anchor", start: "2026-11-02T16:30:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const source: SourceMeeting = {
            sourceMeetingId: "forced-anchor",
            title: "Forced anchor",
            start: "2026-11-02T16:30:00.000Z",
            participants: [],
            speakers: [],
            folders: [],
            transcript: [
                { startSec: 0, speaker: "Speaker 1", text: "Hello there" },
                { startSec: 5, speaker: "Speaker 2", text: "Other voice" },
            ],
        };
        const loaded = spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue(source);
        try {
            const meetings = await loadMeetings();
            const meeting = meetings.open(record.id);
            const finding = {
                kind: "term",
                at: 0,
                heard: "Other",
                proposed: "Another",
                scope: "line",
                confidence: 0.8,
                reason: "a fixture",
            };
            await expect(meeting.items.add({ findings: [finding] })).rejects.toThrow("pass --force");
            expect(new MeetingStore().read(record.id)?.items).toHaveLength(0);
            await meeting.items.add({ findings: [finding], force: true });
            expect(new MeetingStore().read(record.id)?.items).toMatchObject([{ kind: "term", status: "suggested" }]);
        } finally {
            loaded.mockRestore();
        }
    });

    test("meetings: items.suggest names the items it retired beside the fresh ones", async () => {
        const record = await new MeetingStore().create(
            { title: "Suggest", start: "2026-11-02T17:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const runner = await import("@app/meetings/lib/suggest-run");
        const run = spyOn(runner, "runSuggest").mockResolvedValue({ fresh: [], retired: ["i7"], warnings: [] });

        try {
            const { meetings } = (await new MeetingsToolset().load(ctx)) as {
                meetings: { open(ref: string): { items: { suggest(input?: unknown): Promise<unknown> } } };
            };
            expect(
                await meetings.open(record.id).items.suggest({ attendance: "teams", attendanceId: "chat-b" })
            ).toEqual({
                fresh: [],
                retired: ["i7"],
                warnings: [],
            });
            expect(run.mock.calls[0][0]).toMatchObject({ attendance: "teams", attendanceId: "chat-b" });
        } finally {
            run.mockRestore();
        }
    });

    // NR20: the handle had no id, a confirm's token had no door back, and an unknown config path printed nothing.
    // NR33: meetings.list() gave the start only, so an agent that wanted a short meeting opened each one.
    test("meetings: list gives each meeting's length in seconds, null while it has no end", async () => {
        const store = new MeetingStore();
        const ended = await store.create(
            { title: "Short", start: "2026-11-02T18:00:00.000Z", end: "2026-11-02T18:25:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const running = await store.create(
            { title: "Running", start: "2026-11-02T19:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
        const rows = meetings.list();
        expect(rows.find((row) => row.id === ended.id)?.seconds).toBe(1500);
        expect(rows.find((row) => row.id === running.id)?.seconds).toBeNull();
    });

    test("meetings: a handle names its meeting, a confirm is undone with its token, and an unknown config path is refused", async () => {
        const record = await new MeetingStore().create(
            { title: "Undo", start: "2026-11-02T17:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
        const meeting = meetings.open(record.id);
        expect(meeting.id).toBe(record.id);
        expect(meeting.title).toBe("Undo");
        // R2-NR5: it printed every getter and function (about 1,000 chars) and no title.
        expect(Bun.inspect(meeting)).toBe(
            `Meeting ${record.id} "Undo" (info() reads it; describe("meetings.Meeting") lists its methods)`
        );

        // A question is answered by ear, so the fixture is a term with its spelling, which a confirm takes as it is.
        await meeting.items.add({
            findings: [{ kind: "term", at: 1, heard: "jason", proposed: "JSON", confidence: 0.9, reason: "a fixture" }],
        });
        const [item] = meeting.record.items;
        const confirmed = await meeting.items.confirm({ ids: [item.id] });
        expect(confirmed.decided).toEqual([item.id]);
        expect(confirmed.token).toBeString();
        expect((await meeting.items.reopen({ ids: [item.id], token: confirmed.token })).reopened).toEqual([item.id]);
        expect(meeting.record.items[0].status).toBe("suggested");

        await expect(meetings.config.get("global.no.such.key")).rejects.toThrow(
            '"global.no.such.key" is not set and has no default'
        );
    });

    // A rename through the REPL is a decision as `tools meetings speakers rename` is: in the decision journal, with
    // who made it, and undone by its token.
    test("meetings: speakers.rename is a decision journal entry, and its token undoes it", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Rename", start: "2026-11-02T15:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const { meetings } = (await new MeetingsToolset().load(ctx)) as {
            meetings: {
                open(ref: string): {
                    speakers: { rename(label: string, name: string): Promise<{ token: string | null }> };
                    items: { reopen(input: unknown): Promise<{ reopened: string[]; skipped: unknown[] }> };
                };
            };
        };
        const meeting = meetings.open(record.id);
        const renamed = await meeting.speakers.rename("Speaker 2", "Alex Example");

        const journal = new DecisionJournal({ store });
        const [entry] = journal.read(record.id);
        expect(entry).toMatchObject({
            action: { kind: "rename", label: "Speaker 2", name: "Alex Example" },
            labels: [{ label: "Speaker 2", after: "Alex Example" }],
        });
        expect(renamed.token).toBe(entry!.token);
        expect(store.read(record.id)?.speakers.labels).toEqual({ "Speaker 2": "Alex Example" });

        // eve PR #754 r2: the toolset gave no token back, and items.reopen refused a call with no ids.
        await expect(meeting.items.reopen({})).rejects.toThrow("items.reopen needs ids, or the token");
        expect(await meeting.items.reopen({ token: renamed.token })).toEqual({ reopened: [], skipped: [] });
        expect(store.read(record.id)?.speakers.labels).toEqual({});
    });

    // R2-MC9: the toolset had its own copy of set, which took a label the meeting does not carry and wrote a history
    // line for it, while the CLI refused.
    test("meetings: set refuses to remove a label the meeting does not carry, and writes no history line", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Labels", start: "2026-11-02T14:00:00.000Z", createdBy: "new", labels: ["kickoff"] },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
        const meeting = meetings.open(record.id);
        await expect(meeting.set({ unlabel: ["nosuch"] })).rejects.toThrow(
            `${record.id} has no label "nosuch". Its labels: kickoff`
        );
        expect(store.read(record.id)?.history).toHaveLength(record.history.length);
        expect((await meeting.set({ unlabel: ["Kickoff"] })).labels).toEqual([]);
    });

    // R2-MC10: an unknown project answered [] here, while the CLI refused it.
    test("meetings: projects.labels refuses a project nobody knows, and adding a label makes one", async () => {
        const meetings = await loadMeetings();
        await expect(meetings.projects.labels({ project: "r2-mc10-nosuch" })).rejects.toThrow(
            "No project r2-mc10-nosuch. The known ones:"
        );
        expect(await meetings.projects.labels({ project: "r2-mc10-new", add: ["Kickoff"] })).toEqual(["Kickoff"]);
        expect(await meetings.projects.labels({ project: "r2-mc10-new" })).toEqual(["Kickoff"]);
    });

    // R2-MC11: kind was any string, so a misspelt kind answered no rows, which reads as "the meeting has none".
    test("meetings: items.list refuses a kind that does not exist and names the kinds", async () => {
        const record = await new MeetingStore().create(
            { title: "Kinds", start: "2026-11-02T13:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
        const meeting = meetings.open(record.id);
        expect(() => meeting.items.list({ kind: "bogus" })).toThrow(
            'expected one of "speaker-range"|"label"|"join"|"term"|"question"'
        );
        expect(meeting.items.list({ kind: "term" })).toEqual([]);
    });

    // R2-MC12: confirm and reject shared one schema, so a reject took speaker and proposed and kept nothing of them.
    test("meetings: items.reject refuses the values only a confirm takes, and rejects by id", async () => {
        const record = await new MeetingStore().create(
            { title: "Reject", start: "2026-11-02T12:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
        const meeting = meetings.open(record.id);
        await meeting.items.add({
            findings: [{ kind: "term", at: 1, heard: "jason", proposed: "JSON", confidence: 0.9, reason: "a fixture" }],
        });
        const [item] = meeting.record.items;
        await expect(meeting.items.reject({ ids: [item.id], proposed: "Jason" })).rejects.toThrow('"proposed"');
        await expect(meeting.items.reject({ ids: [item.id], speaker: "Alice" })).rejects.toThrow('"speaker"');
        expect(meeting.record.items[0].status).toBe("suggested");
        expect((await meeting.items.reject({ ids: [item.id] })).decided).toEqual([item.id]);
    });

    test("meetings: an opened meeting reads and changes the settings of its live recording, and says so when it is not recording", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Planning", start: "2026-11-02T15:00:00.000Z", createdBy: "new" },
            { command: "new", change: "test" }
        );
        const meetings = await loadMeetings();
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
        const meetings = await loadMeetings();
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
    /**
     * A fake `tools recorder start`: the CLI's own flag parse, then a live movie entry, as the real one makes, which
     * gains its first frame `firstFrameAfterMs` later.
     */
    function fakeRecorder(firstFrameAfterMs = 0) {
        const started: StartRequest[] = [];
        const servers: LiveRecordingServer[] = [];
        const start: MovieRecorderDeps["start"] = (args) => {
            expect(args.slice(0, 2)).toEqual(["recorder", "start"]);
            const request = parseStartFlags(readStartArgs(args.slice(2)));
            started.push(request);
            const server = new LiveRecordingServer({
                id: `movie-start-${process.pid}-${started.length}`,
                kind: "movie",
                title: request.title ?? "Screen recording",
                folder: join(mkdtempSync(join(tmpdir(), "movie-start-")), `video-${started.length}`),
                control: new SettingsControl(),
            });
            servers.push(server);
            const frame = () => server.update({ firstFrameAt: new Date().toISOString() });

            if (firstFrameAfterMs === 0) {
                frame();
            } else {
                setTimeout(frame, firstFrameAfterMs);
            }
        };
        const close = () => {
            for (const server of servers.splice(0)) {
                server.close();
            }
        };
        // One 1512 x 982 display at the origin, instead of `ax-tool screens`.
        const checkTarget: MovieRecorderDeps["checkTarget"] = async (target) =>
            refuseTargetOffScreen(target, [
                {
                    index: 0,
                    name: "Built-in",
                    isPrimary: true,
                    points: { width: 1512, height: 982 },
                    scaleFactor: 2,
                    framePixels: { width: 3024, height: 1964 },
                    originCG: { x: 0, y: 0 },
                },
            ]);
        return { start, started, close, checkTarget };
    }

    test("an area, the idle rate, the threshold, the countdown, the cursor, the shortcuts and the microphone reach the recorder", async () => {
        const fake = fakeRecorder();
        const { movies } = (await new MoviesToolset({ start: fake.start, checkTarget: fake.checkTarget }).load(
            ctx
        )) as {
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
        const { movies } = (await new MoviesToolset({ start: fake.start, checkTarget: fake.checkTarget }).load(
            ctx
        )) as {
            movies: { record(options: unknown): Promise<unknown> };
        };
        // The schema check throws at the call, the CLI's parse inside the promise: both must refuse.
        const record = (options: unknown) => Promise.resolve().then(() => movies.record(options));

        await expect(record({ threshold: 120 })).rejects.toThrow("threshold");
        await expect(record({ countdown: 11 })).rejects.toThrow("countdown");
        await expect(record({ idleFps: 0 })).rejects.toThrow("idleFps");
        await expect(record({ region: "10,20,300" })).rejects.toThrow("--region takes x,y,width,height");
        // Below the only display: refused here, instead of a child that refuses and a start that times out.
        await expect(record({ region: "1,1300,300,200" })).rejects.toThrow("meets no display");
        await expect(record({ display: 2 })).rejects.toThrow("--display 2 is not connected");
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

    test("record() resolves once the movie has its first frame, not when its entry appears", async () => {
        const fake = fakeRecorder(700);
        const { movies } = (await new MoviesToolset({ start: fake.start, checkTarget: fake.checkTarget }).load(
            ctx
        )) as {
            movies: { record(options: unknown): Promise<{ entry: { firstFrameAt?: string } }> };
        };

        try {
            const asked = Date.now();
            const recording = await movies.record({ title: "First frame" });
            expect(Date.now() - asked).toBeGreaterThanOrEqual(650);
            expect(recording.entry.firstFrameAt).toBeString();
        } finally {
            fake.close();
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

describe("tools recorder start names the limits each kind of recording checks", () => {
    const help = (flag: string) =>
        withStartOptions(new Command()).options.find((option) => option.long === flag)?.description ?? "";

    test("--fps and --max-seconds name the movie and the --frames ranges", () => {
        expect(help("--fps")).toContain(`${START_LIMITS.fps.min}–${START_LIMITS.fps.max} for a movie`);
        expect(help("--fps")).toContain(`${FRAMES_START_LIMITS.fps.min}–${FRAMES_START_LIMITS.fps.max} with --frames`);
        expect(help("--max-seconds")).toContain(
            `1–${FRAMES_START_LIMITS.maxDurationSec.max} with --frames (default ${FRAMES_START_LIMITS.defaultMaxDurationSec})`
        );
    });

    test("recorder.start() refuses what the limits refuse", () => {
        expect(recorderStartSchema.safeParse({ fps: FRAMES_START_LIMITS.fps.max + 1 }).success).toBe(false);
        expect(recorderStartSchema.safeParse({ fps: FRAMES_START_LIMITS.fps.min }).success).toBe(true);
        expect(
            recorderStartSchema.safeParse({ maxDurationSec: FRAMES_START_LIMITS.maxDurationSec.max + 1 }).success
        ).toBe(false);
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
