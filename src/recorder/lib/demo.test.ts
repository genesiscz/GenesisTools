import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as captureRunner from "@app/control/lib/capture-runner";
import * as runner from "@app/control/lib/runner";
import * as cli from "@genesiscz/utils/cli";
import type { EditOp } from "@genesiscz/utils/recording-editor/project";
import * as projectOps from "@genesiscz/utils/recording-editor/project";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { type DemoDriver, demoEditOps, demoScriptSchema, runDemo, subtractRanges } from "./demo";
import * as edit from "./edit";
import * as library from "./library";
import * as serviceClient from "./service-client";
import { changedParts, everyTimes, Movie, movieDemoDriver } from "./toolset";
import { recordVideo } from "./video-recording";

const steps = [
    { caption: "Open the settings", startMs: 2000, runEndMs: 3000, endMs: 4000 },
    { caption: "Turn on dark mode", startMs: 9000, runEndMs: 9500, endMs: 10_500 },
    { caption: "Done", startMs: 11_000, runEndMs: 11_000, endMs: 12_000 },
];

describe("demoEditOps", () => {
    test("cuts the lead-in, each long wait between steps, and the tail; adds a caption per step", () => {
        const ops = demoEditOps({ steps, durationMs: 20_000 });
        expect(ops.filter((op) => op.op === "cut")).toEqual([
            { op: "cut", from: 0, to: 1.5 },
            { op: "cut", from: 4.3, to: 8.7 },
            { op: "cut", from: 13, to: 20 },
        ]);
        expect(ops.filter((op) => op.op === "text")).toEqual([
            { op: "text", from: 2, to: 4, text: "Open the settings", y: 0.88 },
            { op: "text", from: 9, to: 10.8, text: "Turn on dark mode", y: 0.88 },
            { op: "text", from: 11, to: 12.8, text: "Done", y: 0.88 },
        ]);
    });

    test("keeps a short wait and puts captions on top", () => {
        const ops = demoEditOps({
            steps,
            durationMs: 13_000,
            edit: { minWaitSeconds: 1, captionPosition: "top", leadSeconds: 5 },
        });
        // The 0.5 s between step 2 and 3 stays; nothing before step 1 is cut with a 5 s lead.
        expect(ops.filter((op) => op.op === "cut").map((op) => [op.from, op.to])).toEqual([[4.3, 8.7]]);
        expect(ops.find((op) => op.op === "text")).toMatchObject({ y: 0.1 });
    });

    test("cuts the still waiting while a step's code runs, never its first moments or its hold", () => {
        const long = [{ caption: "Load the page", startMs: 1000, runEndMs: 9000, endMs: 10_000 }];
        // Still from 0.5 s to 10 s: the page loads behind a spinner, then the result stays still in the hold.
        const ops = demoEditOps({
            steps: long,
            durationMs: 10_000,
            idleMs: [[500, 10_000]],
            edit: { captions: false },
        });
        // The 0.5 s before the step is shorter than the 0.8 s a cut wait needs, so it stays.
        expect(ops).toEqual([{ op: "cut", from: 1.3, to: 8.7 }]);
        expect(
            demoEditOps({
                steps: long,
                durationMs: 10_000,
                idleMs: [[500, 10_000]],
                edit: { captions: false, cutIdle: false },
            })
        ).toEqual([]);
    });

    test("no steps or no movie give no ops; captions and cuts can be turned off", () => {
        expect(demoEditOps({ steps: [], durationMs: 5000 })).toEqual([]);
        expect(demoEditOps({ steps, durationMs: 0 })).toEqual([]);
        expect(
            demoEditOps({ steps, durationMs: 20_000, edit: { cutWaits: false, captions: false, cutIdle: false } })
        ).toEqual([]);
    });
});

function fakeDriver() {
    let clock = 0;
    const marks: string[] = [];
    const edits: EditOp[][] = [];
    let stopped = false;
    const driver: DemoDriver = {
        async start() {
            return {
                async mark(label: string) {
                    marks.push(label);
                    return { atMs: clock };
                },
                async stop() {
                    stopped = true;
                    return "/library/video-demo";
                },
            };
        },
        async durationMs() {
            return clock + 500;
        },
        async idleMs() {
            return [];
        },
        async edit(_folder, ops) {
            edits.push(ops);
        },
        async exportMovie(folder) {
            return { path: `${folder}/demo.mp4`, outputSeconds: 4 };
        },
        async sleep(ms) {
            clock += ms;
        },
        now: () => clock,
    };
    return { driver, marks, edits, isStopped: () => stopped, advance: (ms: number) => (clock += ms) };
}

test("subtractRanges keeps what lies outside the kept parts", () => {
    expect(
        subtractRanges(
            [[0, 10]],
            [
                [2, 3],
                [5, 12],
            ]
        )
    ).toEqual([
        [0, 2],
        [3, 5],
    ]);
    expect(subtractRanges([[0, 1]], [[1, 2]])).toEqual([[0, 1]]);
});

describe("runDemo", () => {
    test("marks each step, times it with its hold, edits the movie and exports it", async () => {
        const fake = fakeDriver();
        const result = await runDemo({
            driver: fake.driver,
            settleSeconds: 1,
            steps: [
                { caption: "Open the settings", run: () => fake.advance(2000), holdSeconds: 0.5 },
                { caption: "Wait for the page", run: () => fake.advance(6000) },
            ],
        });
        expect(fake.marks).toEqual(["Open the settings", "Wait for the page"]);
        expect(result.steps).toEqual([
            { caption: "Open the settings", startMs: 1000, runEndMs: 3000, endMs: 3500 },
            { caption: "Wait for the page", startMs: 3500, runEndMs: 9500, endMs: 10_500 },
        ]);
        expect(result.exported).toEqual({ path: "/library/video-demo/demo.mp4", outputSeconds: 4 });
        expect(fake.edits).toHaveLength(1);
        expect(fake.edits[0].filter((op) => op.op === "text")).toHaveLength(2);
        expect(result.failed).toEqual([]);
    });

    test("a step that throws is noted, the next one runs and the recording still stops", async () => {
        const fake = fakeDriver();
        const result = await runDemo({
            driver: fake.driver,
            export: false,
            steps: [
                {
                    caption: "Broken",
                    run: () => {
                        throw new Error("no such button");
                    },
                },
                { caption: "Next", run: () => fake.advance(100) },
            ],
        });
        expect(result.failed).toEqual([{ caption: "Broken", error: "no such button" }]);
        expect(result.steps.map((step) => step.caption)).toEqual(["Broken", "Next"]);
        expect(result.exported).toBeUndefined();
        expect(fake.isStopped()).toBe(true);
    });

    test("refuses a demo without steps", async () => {
        await expect(runDemo({ driver: fakeDriver().driver, steps: [] })).rejects.toThrow("at least one step");
    });
});

describe("demo script (the JSON door)", () => {
    test("takes tools, shell and wait steps with defaults, and names a step without a caption", () => {
        const script = demoScriptSchema.parse({
            steps: [
                { caption: "Reload", tools: ["control", "key", "cmd+r"] },
                { caption: "Read", wait: 2 },
            ],
        });
        expect(script.record).toEqual({});
        expect(script.steps[0].tools).toEqual(["control", "key", "cmd+r"]);
        expect(demoScriptSchema.safeParse({ steps: [{ shell: "true" }] }).success).toBe(false);
        expect(demoScriptSchema.safeParse({ steps: [] }).success).toBe(false);
    });
});

const markerList = z.array(z.object({ atMs: z.number(), label: z.string() }));
const hasFfmpeg = Bun.which("ffmpeg") !== null;

/**
 * `movieDemoDriver` on a real recording. What runs for real: the driver, `record()` with its start gate and its wait
 * for the live entry, `recordVideo`, the session control and its marker door over the live socket, the segment join,
 * the project open, the idle search and the edit. What is faked, each at the lowest seam that needs a screen or the
 * app: the detached `tools recorder start` process (the test runs `recordVideo` in this process instead, so the
 * commander flag parsing of src/recorder/index.ts is not covered), the ScreenCaptureKit capture child (it writes a
 * small real movie), the native build, and the editor part's export render.
 */
describe.skipIf(!hasFfmpeg)("movieDemoDriver on a recording session", () => {
    let scratch: string;
    let clip: string;

    beforeAll(async () => {
        scratch = mkdtempSync(join(tmpdir(), "gt-demo-driver-"));
        clip = join(scratch, "clip.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=10:duration=3",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                clip,
            ],
        });
    });

    afterAll(async () => {
        const { rm } = await import("node:fs/promises");
        await rm(scratch, { recursive: true, force: true });
    });

    test("starts the recorder with its start gate, marks each step over the live socket, edits the recorded movie", async () => {
        const argvs: string[][] = [];
        const recordings: Array<ReturnType<typeof recordVideo>> = [];
        const exported: Array<{ path: string; out?: string }> = [];
        const spies = [
            spyOn(runner, "ensureBinaryAsync").mockResolvedValue("/unused"),
            spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(
                async ({ plan, signal, onRecording }) => {
                    const output = plan.capture?.videoOut;

                    if (!output) {
                        throw new Error("the segment names no movie");
                    }

                    copyFileSync(clip, output);
                    onRecording?.();

                    if (!signal.aborted) {
                        await new Promise<void>((resolve) =>
                            signal.addEventListener("abort", () => resolve(), { once: true })
                        );
                    }

                    return {
                        ...({} as Awaited<ReturnType<typeof captureRunner.runCapturePlanWithSignal>>),
                        captureFailed: false,
                        sessionDir: join(scratch, "no-session"),
                        warnings: [],
                        capture: { data: { stats: { durationMs: 3000 } } },
                    };
                }
            ),
            // `tools recorder start`, run in this process: it reads --title and --start-gate the way the command does.
            spyOn(cli, "spawnToolDetached").mockImplementation((args) => {
                argvs.push(args);
                const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
                recordings.push(
                    recordVideo({
                        target: { kind: "display", screenIndex: 0, name: "Built-in" },
                        title: flagValue("--title"),
                        startGate: flagValue("--start-gate"),
                        audio: args.includes("--audio") ? ["system"] : undefined,
                    })
                );
                return process.pid;
            }),
            spyOn(library, "requireRecorderPart").mockReturnValue(undefined),
            spyOn(edit, "exportAs").mockImplementation(async (value, options) => {
                exported.push({ path: value, out: options?.out });
                const project = await edit.openProject(value);
                return { ok: true, path: project.project.source.video, bytes: 1, seconds: 0 };
            }),
        ];

        try {
            const driver = movieDemoDriver({ title: "Northwind checkout", audio: ["system"] });
            const result = await runDemo({
                driver,
                settleSeconds: 0.1,
                holdSeconds: 0.1,
                steps: [
                    { caption: "Open the cart", run: () => Bun.sleep(150) },
                    {
                        caption: "Break",
                        run: () => {
                            throw new Error("no such button");
                        },
                    },
                    { caption: "Pay", run: () => Bun.sleep(150) },
                ],
            });
            await recordings[0];

            // What the driver sent: one detached `recorder start` with the recording's options and a start gate.
            expect(argvs).toHaveLength(1);
            expect(argvs[0].slice(0, 2)).toEqual(["recorder", "start"]);
            expect(argvs[0]).toEqual(expect.arrayContaining(["--title", "Northwind checkout", "--audio", "system"]));
            expect(argvs[0]).toContain("--start-gate");

            // What the demo recorded: the recording ended, its marks are the step captions, and the steps start at them.
            const manifest = readRecordingManifest(result.folder);
            expect(manifest?.endedAt).toBeDefined();
            expect(manifest?.title).toBe("Northwind checkout");
            const markers = markerList.parse(manifest?.settings.markers);
            expect(markers.map((marker) => marker.label)).toEqual(["Open the cart", "Break", "Pay"]);
            expect(result.steps.map((step) => step.startMs)).toEqual(markers.map((marker) => marker.atMs));
            expect(result.failed).toEqual([{ caption: "Break", error: "no such button" }]);

            // The recording stopped: no live entry is left, and the driver read the movie it made.
            expect(listLiveRecordings().filter((entry) => entry.folder === result.folder)).toEqual([]);
            expect(result.sourceSeconds).toBe(3);

            // The edit reached the project of that movie: one caption per step.
            const { project } = await edit.openProject(result.folder);
            const captions = readFileSync(join(result.folder, "edit.json"), "utf8");
            expect(project.source.video).toBe(join(result.folder, "screen.mp4"));
            for (const caption of ["Open the cart", "Break", "Pay"]) {
                expect(captions).toContain(caption);
            }

            expect(result.ops).toBeGreaterThanOrEqual(3);
            expect(exported).toHaveLength(1);
            expect(result.exported?.outputSeconds).toBe(3);
        } finally {
            for (const spy of spies) {
                spy.mockRestore();
            }
        }
    }, 60_000);
});

describe("a recording folder without its movie", () => {
    test("a movie recording whose movie went away says so instead of offering a proxy", async () => {
        const folder = mkdtempSync(join(tmpdir(), "lost-movie-"));
        writeFileSync(join(folder, "recording.json"), '{"settings":{"kind":"video","video":{"file":"screen.mp4"}}}');
        await expect(edit.openProject(folder)).rejects.toThrow("screen.mp4 is missing: recording.json names it");
        const frames = mkdtempSync(join(tmpdir(), "frames-only-"));
        writeFileSync(join(frames, "02-31-11-904-d1.jpg"), "a frame");
        await expect(edit.openProject(frames)).rejects.toThrow("has no movie yet; make one with");
        // Neither a movie nor a frame: a proxy could make nothing, so it is not offered.
        await expect(edit.openProject(mkdtempSync(join(tmpdir(), "empty-")))).rejects.toThrow(
            "has no movie and no frames: there is nothing to edit"
        );
    });
});

describe("movie.sheet() bounds", () => {
    test("a count or a list of times outside 1 to 48 is refused before any frame is drawn", async () => {
        const movie = new Movie(join(tmpdir(), "no-such-recording"));
        await expect(movie.sheet({ count: 0 })).rejects.toThrow("a whole number from 1 to 48 (got 0)");
        await expect(movie.sheet({ count: 100_000 })).rejects.toThrow("(got 100000)");
        await expect(movie.sheet({ count: Number.NaN })).rejects.toThrow("(got NaN)");
        await expect(movie.sheet({ at: Array.from({ length: 49 }, (_, index) => index) })).rejects.toThrow(
            "1 to 48 times (got 49)"
        );
        // A valid count passes the bound and fails later, on the missing recording.
        await expect(movie.sheet({ count: 48 })).rejects.not.toThrow("1 to 48");
    });

    test("every spreads cells a fixed step apart, both ends in, and refuses more than a sheet holds", () => {
        expect(everyTimes({ fromUs: 2_000_000, toUs: 4_000_000, everyUs: 500_000 })).toEqual([
            2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000,
        ]);
        expect(() => everyTimes({ fromUs: 0, toUs: 30_000_000, everyUs: 500_000 })).toThrow("61 cells");
    });
});

describe("movie survey on one time base", () => {
    /** An edit of a 10 s movie with 2…4 s cut: source 5 s plays at output 3 s. */
    function cutEdit(): string {
        const folder = mkdtempSync(join(tmpdir(), "survey-"));
        const path = join(folder, "screen.edit.json");
        const project = projectOps.wholeProject({
            video: join(folder, "screen.mp4"),
            durationUs: 10_000_000,
            width: 496,
            height: 1080,
        });
        projectOps.writeProject(path, {
            ...project,
            clips: [
                { id: "c1", fromUs: 0, toUs: 2_000_000, speed: 1 },
                { id: "c2", fromUs: 4_000_000, toUs: 10_000_000, speed: 1 },
            ],
        });
        return path;
    }

    test("a source sheet renders the recording as recorded at source seconds and names each cell on both clocks", async () => {
        const path = cutEdit();
        const part = spyOn(library, "requireRecorderPart").mockImplementation(() => undefined);
        const sheet = spyOn(serviceClient, "hostSheet").mockImplementation(async (request) => ({
            ok: true,
            path: request.out,
            width: 100,
            height: 50,
            times: request.times,
            columns: request.columns ?? 3,
        }));

        try {
            const answer = await new Movie(path).sheet({ source: true, at: [1, 3, 5], columns: 3 });
            const request = sheet.mock.calls[0][0];
            // Not the edit itself: a one-clip copy, so the cut 3 s still shows.
            expect(request.path).not.toBe(path);
            const rendered = projectOps.readProject(request.path);
            expect(rendered.clips).toHaveLength(1);
            expect(rendered.source.durationUs).toBe(10_000_000);
            expect(request.times).toEqual([1, 3, 5]);
            expect(request.columns).toBe(3);
            expect(answer.labels).toBe("source");
            expect(answer.cells).toEqual([
                { source: 1, output: 1, export: 1 },
                { source: 3, output: null, export: null },
                { source: 5, output: 3, export: 3 },
            ]);
            // The edit is as it was.
            expect(projectOps.readProject(path).clips).toHaveLength(2);

            const output = await new Movie(path).sheet({ at: [3] });
            expect(sheet.mock.calls[1][0].path).toBe(path);
            expect(output.cells).toEqual([{ source: 5, output: 3, export: 3 }]);
            await expect(new Movie(path).sheet({ at: [9] })).rejects.toThrow(
                "source: true takes the recording's own seconds"
            );
        } finally {
            part.mockRestore();
            sheet.mockRestore();
        }
    });

    test("an edit call's summary is the edit after it, and changed names what that call did", async () => {
        const path = cutEdit();
        const movie = new Movie(path);
        const texted = await movie.apply([{ op: "text", from: 0, to: 1, text: "Hello" }]);
        expect(texted.summary).toContain("1 text,");
        expect(texted.changed).toBe("0 texts → 1 text");
        const framed = await movie.frame({ aspect: "16:9" });
        expect(framed.summary).toContain("1 text,");
        expect(framed.changed).toBe("frame off → frame 16:9");
        expect(changedParts(projectOps.readProject(path), projectOps.readProject(path))).toBe("nothing");
    });

    test("a full source still asks the renderer for the export's size and answers both clocks", async () => {
        const path = cutEdit();
        const part = spyOn(library, "requireRecorderPart").mockImplementation(() => undefined);
        const still = spyOn(serviceClient, "hostStill").mockImplementation(async (request) => ({
            ok: true,
            path: request.out ?? "x.png",
            width: 496,
            height: 1080,
        }));

        try {
            const answer = await new Movie(path).still(3, undefined, true, true);
            expect(still.mock.calls[0][0].full).toBe(true);
            expect(still.mock.calls[0][0].path).not.toBe(path);
            expect(answer).toMatchObject({ source: 3, output: null });
            expect((await new Movie(path).still(3)).source).toBe(5);
        } finally {
            part.mockRestore();
            still.mockRestore();
        }
    });
});
