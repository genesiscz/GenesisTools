import { describe, expect, it, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { readProject, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import * as video from "@genesiscz/utils/video/process";
import { createCanvas } from "@napi-rs/canvas";
import { readUndoSteps } from "./edit";
import { prepareFramesMovie, switchDisplay } from "./frames-movie";
import { audioOncePerSource, boxInFrame, boxInProxy, chosenPlan, framesForPlan, makeProxy, proxyCanvas } from "./proxy";
import { findOnScreen } from "./screen-search";

test("proxy retains valid audio before a truncated index row", async () => {
    const folder = mkdtempSync(join(tmpdir(), "proxy-audio-"));
    const startedAt = "2026-11-05T10:00:00.000Z";
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "fixture",
            title: "Fixture",
            startedAt,
            frames: [{ file: "frame.png", atMs: 0, displayId: 1 }],
            displays: [{ id: 1, name: "one" }],
        })
    );
    writeFileSync(join(folder, "frame.png"), createCanvas(64, 40).toBuffer("image/png"));
    writeFileSync(join(folder, "audio.m4a"), "fixture");
    writeFileSync(join(folder, "audio.jsonl"), `${SafeJSON.stringify({ file: "audio.m4a", at: startedAt })}\n{"file":`);
    const encode = spyOn(video, "runVideoCommand").mockImplementation(async (options) => {
        expect(options.command).toContain(join(folder, "audio.m4a"));
        writeFileSync(join(folder, ".proxy.partial.mp4"), "fixture output");
        return "";
    });
    try {
        expect((await makeProxy(folder)).audioPieces).toBe(1);
        expect(encode).toHaveBeenCalledTimes(1);
    } finally {
        encode.mockRestore();
    }
});

/**
 * A frames recording of displays 1 and 2 whose captures each recorded the system sound: `tracks` are the pieces as
 * recording.json lists them (start after the recording's start, length).
 */
function duplicateSoundFolder(tracks: Array<{ display: number; atMs: number; durationMs: number }>): {
    folder: string;
    files: string[];
} {
    const folder = mkdtempSync(join(tmpdir(), "proxy-sound-once-"));
    const startedAt = "2026-11-05T10:00:00.000Z";
    const startedMs = Date.parse(startedAt);
    mkdirSync(join(folder, "audio"));
    const files = tracks.map((track) => {
        const file = join(folder, "audio", `${startedMs + track.atMs}-d${track.display}-audio-system.m4a`);
        writeFileSync(file, "fixture");
        return file;
    });
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "fixture",
            title: "Fixture",
            startedAt,
            endedAt: "2026-11-05T10:00:10.000Z",
            frames: [
                { file: "a.png", atMs: 0, displayId: 1 },
                { file: "b.png", atMs: 0, displayId: 2 },
            ],
            displays: [
                { id: 1, name: "one" },
                { id: 2, name: "two" },
            ],
            settings: {
                tracks: tracks.map((track, index) => ({
                    source: "system",
                    path: files[index],
                    durationMs: track.durationMs,
                    mutedSpans: [],
                    displayId: track.display,
                    startedAtMs: startedMs + track.atMs,
                })),
            },
        })
    );
    writeFileSync(join(folder, "a.png"), createCanvas(64, 40).toBuffer("image/png"));
    writeFileSync(join(folder, "b.png"), createCanvas(64, 40).toBuffer("image/png"));
    return { folder, files };
}

describe("a frames recording plays each source's sound once, though every display capture recorded it", () => {
    it("of two system pieces of displays 1 and 2 that start 0.2 s apart, one plays", () => {
        expect(
            audioOncePerSource([
                { path: "d1.m4a", delayMs: 1000, source: "system", displayId: 1, durationMs: 3000 },
                { path: "d2.m4a", delayMs: 1200, source: "system", displayId: 2, durationMs: 2800 },
            ])
        ).toEqual([{ path: "d1.m4a", delayMs: 1000 }]);
    });

    it("a mic piece and a system piece of one display both play, and so does a later piece after a gap", () => {
        expect(
            audioOncePerSource([
                { path: "late.m4a", delayMs: 9000, source: "system", displayId: 1, durationMs: 1000 },
                { path: "system.m4a", delayMs: 1000, source: "system", displayId: 1, durationMs: 3000 },
                { path: "mic.m4a", delayMs: 1000, source: "mic", displayId: 1, durationMs: 3000 },
            ])
        ).toEqual([
            { path: "system.m4a", delayMs: 1000 },
            { path: "mic.m4a", delayMs: 1000 },
            { path: "late.m4a", delayMs: 9000 },
        ]);
    });

    it("a duplicate adds only the sound no kept piece holds, and a jitter sliver of it plays not at all", () => {
        expect(
            audioOncePerSource([
                // Display 1 started 30 ms before display 2 (jitter); a later display 1 piece runs on after 4 s.
                { path: "d1.m4a", delayMs: 970, source: "system", displayId: 1, durationMs: 2030 },
                { path: "d2.m4a", delayMs: 1000, source: "system", displayId: 2, durationMs: 3000 },
                { path: "d1-on.m4a", delayMs: 3500, source: "system", displayId: 1, durationMs: 2500 },
            ])
        ).toEqual([
            { path: "d2.m4a", delayMs: 1000 },
            { path: "d1-on.m4a", delayMs: 4000, part: { fromMs: 500, toMs: 2500 } },
        ]);
    });

    it("a piece of unknown length, and a meeting's piece without a source, play whole and hide nothing", () => {
        expect(
            audioOncePerSource([
                { path: "unknown.m4a", delayMs: 1000, source: "system", displayId: 2 },
                { path: "d1.m4a", delayMs: 1000, source: "system", displayId: 1, durationMs: 3000 },
                { path: "meeting.m4a", delayMs: 0 },
            ])
        ).toEqual([
            { path: "meeting.m4a", delayMs: 0 },
            { path: "unknown.m4a", delayMs: 1000 },
            { path: "d1.m4a", delayMs: 1000 },
        ]);
    });

    it("the proxy mixes one of two system pieces that start 0.2 s apart, and the later piece after a gap", async () => {
        const { folder, files } = duplicateSoundFolder([
            { display: 1, atMs: 1000, durationMs: 3000 },
            { display: 2, atMs: 1200, durationMs: 2800 },
            { display: 1, atMs: 6000, durationMs: 1000 },
        ]);
        const commands: string[][] = [];
        const encode = spyOn(video, "runVideoCommand").mockImplementation(async (options) => {
            if (options.command[0] === "ffprobe") {
                throw new Error("recording.json names every piece's length; nothing is probed");
            }

            commands.push(options.command);
            writeFileSync(join(folder, ".proxy.partial.mp4"), "fixture output");
            return "";
        });

        try {
            expect((await makeProxy(folder, { display: 1 })).audioPieces).toBe(2);
        } finally {
            encode.mockRestore();
        }

        const argv = commands[0] ?? [];
        const graph = argv[argv.indexOf("-filter_complex") + 1] ?? "";
        expect(graph).toContain("amix=inputs=2:");
        expect(argv).toContain(files[0]);
        expect(argv).not.toContain(files[1]);
        expect(argv).toContain(files[2]);
    });

    it("the proxy plays the run-on of a duplicate from the kept piece's end", async () => {
        const { folder, files } = duplicateSoundFolder([
            { display: 1, atMs: 1000, durationMs: 3000 },
            { display: 2, atMs: 3500, durationMs: 2500 },
        ]);
        const commands: string[][] = [];
        const encode = spyOn(video, "runVideoCommand").mockImplementation(async (options) => {
            commands.push(options.command);
            writeFileSync(join(folder, ".proxy.partial.mp4"), "fixture output");
            return "";
        });

        try {
            expect((await makeProxy(folder, { display: 1 })).audioPieces).toBe(2);
        } finally {
            encode.mockRestore();
        }

        const argv = commands[0] ?? [];
        expect(argv.filter((arg) => files.includes(arg))).toEqual(files);
        expect(argv[argv.indexOf("-filter_complex") + 1]).toContain(
            "[2:a]atrim=start=0.500:end=2.500,asetpts=PTS-STARTPTS,adelay=4000:all=1[a1]"
        );
    });
});

/** A frames recording of two displays of one width and two heights: display 1 at 64x40, display 2 at 64x36. */
function twoDisplayFolder(): string {
    const folder = mkdtempSync(join(tmpdir(), "proxy-canvas-"));
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "fixture",
            title: "Fixture",
            startedAt: "2026-11-05T10:00:00.000Z",
            endedAt: "2026-11-05T10:00:20.000Z",
            frames: [
                { file: "a.png", atMs: 0, displayId: 1 },
                { file: "b.png", atMs: 5000, displayId: 2 },
            ],
            displays: [
                { id: 1, name: "one" },
                { id: 2, name: "two" },
            ],
        })
    );
    writeFileSync(join(folder, "a.png"), createCanvas(64, 40).toBuffer("image/png"));
    writeFileSync(join(folder, "b.png"), createCanvas(64, 36).toBuffer("image/png"));
    return folder;
}

/**
 * ffmpeg writes the partial movie and keeps its video filter; ffprobe answers the size and length of the movie on disk
 * (`made` is the length of each movie ffmpeg makes).
 */
function fakeVideo(folder: string, movie: { width: number; height: number; seconds?: number }, made = 20) {
    const filters: string[] = [];
    const spy = spyOn(video, "runVideoCommand").mockImplementation(async (options) => {
        if (options.command[0] === "ffprobe") {
            const duration = (movie.seconds ?? 20).toFixed(6);
            return SafeJSON.stringify({
                streams: [{ width: movie.width, height: movie.height, duration, codec_name: "h264" }],
                format: { duration },
            });
        }

        movie.seconds = made;

        const filter = options.command[options.command.indexOf("-vf") + 1] ?? "";
        filters.push(filter);
        const fitted = /^scale=(\d+):(\d+):force/.exec(filter);
        movie.width = fitted ? Number(fitted[1]) : 64;
        movie.height = fitted ? Number(fitted[2]) : 36;
        writeFileSync(join(folder, ".proxy.partial.mp4"), "fixture output");
        return "";
    });
    return { filters, spy };
}

describe("a display switch keeps the proxy's picture, and the edit made on it", () => {
    it("a plan that shows one display still makes the picture of every display with frames", async () => {
        const folder = twoDisplayFolder();
        const { filters, spy } = fakeVideo(folder, { width: 0, height: 0 });

        try {
            await makeProxy(folder, { display: 2 });
            await makeProxy(folder);
        } finally {
            spy.mockRestore();
        }

        expect(filters[0]).toContain("scale=64:40:force_original_aspect_ratio=decrease");
        expect(filters[0]).toBe(filters[1]);
    });

    it("boxInFrame takes a box of the letterboxed picture back to its frame", () => {
        const canvas = proxyCanvas([
            { width: 2880, height: 1800 },
            { width: 2560, height: 1440 },
        ]);
        const box = { x: 0.066, y: 0.168, width: 0.046, height: 0.022 };
        const back = boxInFrame(
            boxInProxy(box, { width: 2560, height: 1440 }, canvas),
            { width: 2560, height: 1440 },
            canvas
        );

        expect(back.x).toBeCloseTo(box.x, 12);
        expect(back.y).toBeCloseTo(box.y, 12);
        expect(back.width).toBeCloseTo(box.width, 12);
        expect(back.height).toBeCloseTo(box.height, 12);
        expect(boxInFrame(box, { width: 64, height: 36 }, { width: 64, height: 36, letterboxed: false })).toEqual(box);
    });

    it("a switch moves an edit made on a one-display proxy onto the same frame pixels of the fixed picture", async () => {
        const folder = twoDisplayFolder();
        const proxy = join(folder, "proxy.mp4");
        writeFileSync(proxy, "an older proxy of display 2 alone");
        writeFileSync(
            join(folder, "proxy.json"),
            SafeJSON.stringify({
                version: 1,
                policy: "display",
                windowSec: 10,
                ranges: [{ fromUs: 0, toUs: 5_000_001, displayId: 2 }],
            })
        );
        const editPath = join(folder, "edit.json");
        const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 };
        writeProject(editPath, {
            ...wholeProject({ video: proxy, durationUs: 20_000_000, width: 64, height: 36 }),
            redactions: [
                {
                    id: "r1",
                    startUs: 6_000_000,
                    endUs: 9_000_000,
                    ...box,
                    style: "black",
                    track: [{ atUs: 6_000_000, ...box }],
                    exclude: [{ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }],
                },
            ],
            shapes: [
                {
                    id: "s1",
                    startUs: 6_000_000,
                    endUs: 9_000_000,
                    kind: "box",
                    x1: 0.1,
                    y1: 0.1,
                    x2: 0.3,
                    y2: 0.2,
                    color: "#FF3B30",
                    width: 0.006,
                },
            ],
            zooms: [
                {
                    id: "z1",
                    startUs: 6_000_000,
                    endUs: 9_000_000,
                    scale: 1.5,
                    mode: "manual",
                    focusX: 0.5,
                    focusY: 0.25,
                    easeInMs: 450,
                    easeOutMs: 450,
                },
                {
                    id: "z2",
                    startUs: 6_000_000,
                    endUs: 9_000_000,
                    scale: 1.5,
                    mode: "manual",
                    focusX: 0.5,
                    focusY: 0.25,
                    easeInMs: 450,
                    easeOutMs: 450,
                    target: "canvas",
                },
            ],
            lens: {
                items: [
                    {
                        id: "l1",
                        startUs: 6_000_000,
                        endUs: 9_000_000,
                        radius: 0.12,
                        magnification: 2,
                        follow: false,
                        x: 0.5,
                        y: 0.1,
                        ring: "#FFFFFF",
                    },
                ],
            },
        });
        const { spy } = fakeVideo(folder, { width: 64, height: 36 });

        try {
            await switchDisplay(folder, { fromUs: 0, toUs: 4_000_000, displayId: 1 });
            const fitted = readProject(editPath);
            const [part] = fitted.redactions ?? [];
            const expected = boxInProxy(
                box,
                { width: 64, height: 36 },
                proxyCanvas([
                    { width: 64, height: 40 },
                    { width: 64, height: 36 },
                ])
            );

            expect(fitted.source).toMatchObject({ width: 64, height: 40, durationUs: 20_000_000 });
            expect(part.x).toBeCloseTo(0.1, 6);
            expect(part.y).toBeCloseTo(0.14, 6);
            expect(part.width).toBeCloseTo(0.2, 6);
            expect(part.height).toBeCloseTo(0.09, 6);
            expect(part.y).toBeCloseTo(expected.y, 6);
            expect(part.track?.[0].y).toBeCloseTo(0.14, 6);
            expect(part.exclude?.[0].y).toBeCloseTo(0.14, 6);
            expect(part.exclude?.[0].height).toBeCloseTo(0.045, 6);
            expect(fitted.shapes?.[0].y1).toBeCloseTo(0.14, 6);
            expect(fitted.shapes?.[0].y2).toBeCloseTo(0.23, 6);
            expect(fitted.zooms.find((zoom) => zoom.id === "z1")?.focusY).toBeCloseTo(0.275, 6);
            expect(fitted.zooms.find((zoom) => zoom.id === "z2")?.focusY).toBe(0.25);
            expect(fitted.lens?.items[0].y).toBeCloseTo(0.14, 6);

            const [step] = readUndoSteps(editPath);
            expect(step.ops).toEqual(["fitToProxy"]);
            expect(step.before.redactions?.[0].y).toBe(0.1);
            expect(step.afterRevision).toBe(fitted.revision);

            // The picture no longer changes with the plan, so the next switch leaves the edit as it is.
            const text = readFileSync(editPath, "utf8");
            await switchDisplay(folder, { fromUs: 0, toUs: 4_000_000, displayId: 2 });
            expect(readFileSync(editPath, "utf8")).toBe(text);
            expect(readUndoSteps(editPath)).toHaveLength(1);
        } finally {
            spy.mockRestore();
        }
    });

    it("an edit an earlier switch left on its first picture is moved onto the proxy's picture at the next remake", async () => {
        const folder = twoDisplayFolder();
        const proxy = join(folder, "proxy.mp4");
        // An older switch remade the movie letterboxed, but the edit kept the size of the display-2 proxy it was made on.
        writeFileSync(proxy, "an older letterboxed proxy");
        writeFileSync(
            join(folder, "proxy.json"),
            SafeJSON.stringify({
                version: 1,
                policy: "most-change",
                windowSec: 10,
                ranges: [
                    { fromUs: 0, toUs: 4_000_000, displayId: 1 },
                    { fromUs: 4_000_000, toUs: 5_000_001, displayId: 2 },
                ],
            })
        );
        const editPath = join(folder, "edit.json");
        writeProject(editPath, {
            ...wholeProject({ video: proxy, durationUs: 20_000_000, width: 64, height: 36 }),
            redactions: [
                {
                    id: "r1",
                    startUs: 6_000_000,
                    endUs: 9_000_000,
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.1,
                    style: "black",
                },
            ],
        });
        const { spy } = fakeVideo(folder, { width: 64, height: 40 });

        try {
            const made = await prepareFramesMovie(folder, {});
            expect(made.fittedEdit).toMatchObject({ path: editPath, moved: 1, unplaced: 0 });
        } finally {
            spy.mockRestore();
        }

        const fitted = readProject(editPath);
        expect(fitted.source).toMatchObject({ width: 64, height: 40 });
        expect(fitted.redactions?.[0].y).toBeCloseTo(0.14, 6);
        expect(fitted.redactions?.[0].height).toBeCloseTo(0.09, 6);
    });

    it("a remade proxy that is shorter moves the edit's length by as much and cuts its clips there", async () => {
        const folder = twoDisplayFolder();
        const proxy = join(folder, "proxy.mp4");
        writeFileSync(proxy, "an older proxy made long by an empty range");
        const editPath = join(folder, "edit.json");
        // The window measured the old movie 20 ms longer than ffprobe does (its sound's tail).
        writeProject(editPath, {
            ...wholeProject({ video: proxy, durationUs: 21_100_000, width: 64, height: 40 }),
            redactions: [
                {
                    id: "r1",
                    startUs: 1_000_000,
                    endUs: 2_000_000,
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.1,
                    style: "blur",
                },
            ],
        });
        const { spy } = fakeVideo(folder, { width: 64, height: 40, seconds: 21.08 }, 20);

        try {
            await switchDisplay(folder, { fromUs: 0, toUs: 4_000_000, displayId: 1 });
        } finally {
            spy.mockRestore();
        }

        const fitted = readProject(editPath);
        expect(fitted.source).toMatchObject({ width: 64, height: 40, durationUs: 20_020_000 });
        expect(fitted.clips.map((clip) => [clip.fromUs, clip.toUs])).toEqual([[0, 20_020_000]]);
        expect(fitted.redactions?.[0]).toMatchObject({ x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    });

    it("find-screen places a box of the one display a plan shows in the picture of every display", () => {
        const folder = twoDisplayFolder();
        writeFileSync(
            join(folder, "ocr.jsonl"),
            SafeJSON.stringify({
                file: "b.png",
                atMs: 5000,
                displayId: 2,
                text: "secret",
                blocks: [{ text: "secret", bounds: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 } }],
            })
        );
        writeFileSync(
            join(folder, "proxy.json"),
            SafeJSON.stringify({
                version: 1,
                policy: "display",
                windowSec: 10,
                ranges: [{ fromUs: 0, toUs: 5_000_001, displayId: 2 }],
            })
        );

        const [box] = findOnScreen(folder, "secret")[0].boxes;
        expect(box.x).toBeCloseTo(0.1, 6);
        expect(box.y).toBeCloseTo(0.14, 6);
        expect(box.width).toBeCloseTo(0.2, 6);
        expect(box.height).toBeCloseTo(0.09, 6);
    });

    it("a switch past the last frame leaves no empty range that pulls in another display's frame", () => {
        const frames = [
            { path: "a.png", atUs: 0, displayId: 1 },
            { path: "b.png", atUs: 5_000_000, displayId: 2 },
            { path: "c.png", atUs: 12_000_000, displayId: 1 },
        ];
        const plan = chosenPlan(frames, { overrides: [{ fromUs: 0, toUs: 15_000_000, displayId: 2 }] });

        expect(plan.ranges).toEqual([{ fromUs: 0, toUs: 12_000_001, displayId: 2 }]);
        // A plan saved before the fix keeps its empty range; the movie still shows only display 2.
        const saved = [
            { fromUs: 0, toUs: 12_000_001, displayId: 2 },
            { fromUs: 15_000_000, toUs: 12_000_001, displayId: 1 },
        ];
        expect(framesForPlan(frames, saved).map((frame) => frame.displayId)).toEqual([2]);
    });
});

// Regression test: deep test 2026-11-06 RE14 — proxy on a movie recording said it "has no frames to make a movie of".
test("proxy on a recording that has its movie says a proxy is for frames recordings", async () => {
    const folder = mkdtempSync(join(tmpdir(), "proxy-movie-"));
    writeFileSync(join(folder, "screen.mp4"), "fixture");

    await expect(makeProxy(folder)).rejects.toThrow(
        "has its movie (screen.mp4); a proxy is only for a frames recording"
    );
});
