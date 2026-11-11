import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { OverwriteInputError } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    alignCameraMovie,
    bubbleFromSidecar,
    bubbleRect,
    bubbleShowsAt,
    CAMERA_SIDECAR,
    cameraBubbleSchema,
    cameraTrimPlan,
    readCameraSidecar,
} from "@genesiscz/utils/recording-editor/camera";
import {
    canvasShape,
    checkProject,
    fixOps,
    frameCrop,
    groupIssues,
    issueSummary,
    textBox,
    textBoxes,
    zoomView,
} from "@genesiscz/utils/recording-editor/check";
import {
    addComment,
    commentsPathFor,
    readComments,
    removeComment,
    updateComment,
} from "@genesiscz/utils/recording-editor/comments";
import {
    editorFrozenRanges,
    FreezePrint,
    findIdle,
    idleRanges,
    silenceDetectArgs,
} from "@genesiscz/utils/recording-editor/idle";
import { laneItems, resolveLanes } from "@genesiscz/utils/recording-editor/lanes";
import { audibleTracks, integratedLoudness, transcribedTracks } from "@genesiscz/utils/recording-editor/loudness";
import {
    annotateClicks,
    applyOp,
    autoZoom,
    cameraOpSchema,
    describeProject,
    editOpSchema,
    editProjectSchema,
    effectsOnSourceTime,
    exportFps,
    exportPlanOf,
    findInTranscript,
    opPlacementWarnings,
    outputDurationUs,
    outputTimeOf,
    parseEditOps,
    partOf,
    readCursorTrack,
    readProject,
    replaceWordsInLines,
    shortcutsOf,
    sourceTimeOf,
    TEXT_ALIGNS,
    trackDrawsCursor,
    transcriptCachePath,
    transcriptLines,
    voiceoverExportSpans,
    wholeProject,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { RECORDING_MANIFEST, readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { skip } from "@genesiscz/utils/test/skip";
import { prepareVideoEvidence } from "@genesiscz/utils/video/evidence";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { createCanvas } from "@napi-rs/canvas";
import { ZodError } from "zod";
import cameraOps from "./__fixtures__/camera-ops.json";
import cardVoiceovers from "./__fixtures__/card-voiceovers.json";
import editMarkers from "./__fixtures__/edit-markers.json";
import legacyEvidence from "./__fixtures__/legacy-evidence.json";
import logoPictureTypes from "./__fixtures__/logo-picture-types.json";
import partAudio from "./__fixtures__/part-audio.json";
import transcriptCuts from "./__fixtures__/transcript-cuts.json";
import { denoisedSourceArgv, denoisedSourcePath, denoiseSchema, syncDenoisedTranscript } from "./denoise";
import { MAX_SAMPLE_TIMES, RecordingEditor, sampleTimes } from "./editor";
import { atempoChain, concatList, exportVideoArgv, sampleFpsFilter, speedArgv, trimArgv } from "./ffmpeg";
import { PICTURE_EXTENSIONS } from "./overlays";
import { parseEditPlan, timeToUs } from "./plan";
import { redactionBoxAt } from "./private-data";
import * as projectOps from "./project";
import { locateSource } from "./source";
import { formatSubtitles, subtitleCues } from "./subtitles";
import { layoutText } from "./text-metrics";
import textCases from "./text-metrics.cases.json";
import { cutRanges, fillerCuts, fillerList, transcriptSegmentSchema, wordCuts, wordSpans } from "./transcript-cuts";
import { voiceoverSchema } from "./voiceovers";
import { pointerBusyRanges } from "./waits";

function workspace(): string {
    return mkdtempSync(join(tmpdir(), "gt-editor-"));
}

/** `source` with a cursor track of one click, which the clicks op needs before it turns rings or the tick on. */
function withClickTrack<T extends object>(source: T): T & { cursor: string } {
    const path = join(workspace(), "cursor.jsonl");
    writeFileSync(path, `${SafeJSON.stringify({ t: 1000, x: 0.5, y: 0.5, click: "left" })}\n`);
    return { ...source, cursor: path };
}

/** A recording folder like startRecording writes: frames of two displays with a recording.json. */
function recordingFolder(): string {
    const dir = workspace();
    mkdirSync(join(dir, "frames"));
    const frames: Array<{ file: string; atMs: number; displayId: number }> = [];

    for (const [index, shade] of [10, 10, 200, 200, 90].entries()) {
        for (const displayId of [1, 2]) {
            const canvas = createCanvas(64, 40);
            const context = canvas.getContext("2d");
            context.fillStyle = `rgb(${shade}, ${displayId * 60}, 40)`;
            context.fillRect(0, 0, 64, 40);
            const file = `frames/d${displayId}-${index}.png`;
            writeFileSync(join(dir, file), canvas.toBuffer("image/png"));
            frames.push({ file, atMs: index * 1000, displayId });
        }
    }

    writeFileSync(
        join(dir, RECORDING_MANIFEST),
        SafeJSON.stringify({
            version: 1,
            id: "rec-test",
            title: "test",
            startedAt: "2026-11-03T20:00:00.000Z",
            displays: [
                { id: 1, name: "one" },
                { id: 2, name: "two" },
            ],
            frames,
        })
    );
    return dir;
}

function sha(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("edit plans", () => {
    test("a plan is validated before any work and names the wrong field", () => {
        expect(() => parseEditPlan({ source: { file: "/x.mp4" }, steps: [] })).toThrow(ZodError);
        expect(() => parseEditPlan({ source: { file: "/x.mp4" }, steps: [{ kind: "grid", cols: 3 }] })).toThrow(
            "a grid needs a frames step before it"
        );
        expect(() =>
            parseEditPlan({
                source: { file: "/x.mp4" },
                steps: [{ kind: "frames" }, { kind: "grid", cols: 8, rows: 8 }],
            })
        ).toThrow("at most 32 frames");
        expect(() => parseEditPlan({ source: { file: "/x.mp4" }, steps: [{ kind: "frames", threshold: 2 }] })).toThrow(
            "threshold needs changeOnly"
        );
        expect(() => parseEditPlan({ source: { file: "/x.mp4" }, steps: [{ kind: "speed", factor: 40 }] })).toThrow(
            ZodError
        );
        const plan = parseEditPlan({
            source: { recording: "rec-1" },
            steps: [
                { kind: "frames", changeOnly: true, threshold: 2 },
                { kind: "grid", cols: 3, rows: 3 },
            ],
        });
        expect(plan.steps[1]).toEqual({ kind: "grid", cols: 3, rows: 3, labels: "time" });
    });

    test("times read as seconds, mm:ss and h:mm:ss; ffmpeg helpers stay in range", () => {
        expect(timeToUs("00:05")).toBe(5_000_000);
        expect(timeToUs("1:02:03.5")).toBe(3_723_500_000);
        expect(timeToUs(0.25)).toBe(250_000);
        expect(timeToUs("12s")).toBe(12_000_000);
        expect(() => timeToUs("nope")).toThrow('"nope" is not a time');
        expect(() => timeToUs("1::2")).toThrow("is not a time");
        expect(() => timeToUs(Number.NaN)).toThrow("is not a time");
        expect(atempoChain(4)).toBe("atempo=2,atempo=2");
        expect(atempoChain(0.3)).toBe("atempo=0.5,atempo=0.6");
        expect(
            concatList([
                { path: "/a.png", atUs: 0 },
                { path: "/b.png", atUs: 500_000 },
            ])
        ).toBe(
            "ffconcat version 1.0\nfile '/a.png'\nduration 0.500000\nfile '/b.png'\nduration 1.000000\nfile '/b.png'\n"
        );
    });
});

describe("the editor on a recording folder", () => {
    test("a still range at a rate that asks for too many frames is refused before any array is made", async () => {
        expect(sampleTimes({ fromUs: 0, toUs: 2_000_000, fps: 2 })).toEqual([0, 500_000, 1_000_000, 1_500_000]);
        expect(() => sampleTimes({ fromUs: 0, toUs: 100_000_000 * 1_000_000, fps: 30 })).toThrow(
            `the most is ${MAX_SAMPLE_TIMES}`
        );

        const started = performance.now();
        const run = new RecordingEditor().run({
            source: { file: recordingFolder() },
            output: join(workspace(), "edit"),
            steps: [
                { kind: "range" as const, from: 0, to: 100_000_000 },
                { kind: "frames" as const, fps: 30 },
            ],
        });
        await expect(run.done).rejects.toThrow("shorten the range or lower the fps");
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test("a grid with rows alone keeps that many rows", async () => {
        const result = await new RecordingEditor().run({
            source: { file: recordingFolder() },
            output: join(workspace(), "edit"),
            steps: [
                { kind: "range" as const, from: 0, to: "00:03" },
                { kind: "frames" as const, changeOnly: true, threshold: 1 },
                { kind: "grid" as const, rows: 1, labels: "none" as const },
            ],
        }).done;

        expect(result.sheets.map((sheet) => [sheet.columns, sheet.rows])).toEqual([
            [3, 1],
            [1, 1],
        ]);
    });

    test("change-only frames per display, a grid, progress events, and a rerun that skips every finished step", async () => {
        const source = recordingFolder();
        const output = join(workspace(), "edit");
        const editor = new RecordingEditor();
        const plan = {
            source: { file: source },
            output,
            steps: [
                { kind: "range" as const, from: 0, to: "00:03" },
                { kind: "frames" as const, changeOnly: true, threshold: 1 },
                { kind: "grid" as const, cols: 2, rows: 2, labels: "time" as const },
            ],
        };
        const job = editor.run(plan);
        const units = new Set<string>();
        job.on("progress", (event) => units.add(`${event.step}:${event.unit}`));
        const result = await job.done;
        // Display 1 and 2 each change once (frames 0 → 2); frame 1 and 3 repeat the frame before them.
        expect(result.frames).toHaveLength(8);
        expect(result.kept.map((frame) => [frame.displayId, frame.actualUs])).toEqual([
            [1, 0],
            [2, 0],
            [1, 2_000_000],
            [2, 2_000_000],
        ]);
        expect(result.sheets).toHaveLength(1);
        expect(result.sheets[0]).toMatchObject({ columns: 2, rows: 2, frameIds: ["0", "1", "4", "5"] });
        expect(units.has("changes-1:frames")).toBe(true);
        expect(units.has("grid-2:frames")).toBe(true);

        const again = await editor.run(plan).done;
        expect(again.steps.every((step) => step.skipped)).toBe(true);
        expect(again.sheets).toEqual(result.sheets);

        unlinkSync(result.sheets[0].path);
        const repaired = await editor.run(plan).done;
        expect(repaired.steps.filter((step) => !step.skipped).map((step) => step.name)).toEqual(["grid-2"]);
        expect(existsSync(result.sheets[0].path)).toBe(true);
    });

    test("an output that is an input is refused: the source folder, or a source frame as the export file", async () => {
        const source = recordingFolder();
        const editor = new RecordingEditor();
        await expect(
            editor.run({ source: { file: source }, output: source, steps: [{ kind: "frames" }] }).done
        ).rejects.toThrow(OverwriteInputError);
        const frame = join(source, "frames", "d1-0.png");
        const before = sha(frame);
        await expect(
            editor.run({
                source: { file: source },
                output: join(workspace(), "edit"),
                steps: [{ kind: "frames" }, { kind: "export", format: "mp4", output: frame }],
            }).done
        ).rejects.toThrow(OverwriteInputError);
        expect(sha(frame)).toBe(before);
    });

    test("exports cannot overwrite the source recording manifest", async () => {
        const source = recordingFolder();
        const manifest = join(source, RECORDING_MANIFEST);
        const before = readFileSync(manifest, "utf8");
        await expect(
            new RecordingEditor().run({
                source: { file: source },
                output: workspace(),
                steps: [
                    { kind: "frames", displays: [1] },
                    { kind: "export", format: "mp4", output: manifest },
                ],
            }).done
        ).rejects.toThrow(OverwriteInputError);
        expect(readFileSync(manifest, "utf8")).toBe(before);
    });

    test("receipt fingerprints include nested manifest frames", () => {
        const source = recordingFolder();
        const before = locateSource({ file: source }).fingerprint;
        writeFileSync(join(source, "frames", "d1-0.png"), "changed frame bytes");
        expect(locateSource({ file: source }).fingerprint).not.toEqual(before);
    });

    test("layout changes rebuild sheets at the requested location", async () => {
        const editor = new RecordingEditor();
        const plan = {
            source: { file: recordingFolder() },
            output: workspace(),
            steps: [{ kind: "frames" as const }, { kind: "grid" as const, perImage: 4 }],
        };
        const workspaceResult = await editor.run(plan).done;
        const flat = await editor.run(plan, { layout: "flat" }).done;
        expect(flat.sheets[0].path).not.toBe(workspaceResult.sheets[0].path);
        expect(flat.sheets[0].path).not.toContain("/steps/");
        expect(existsSync(flat.sheets[0].path)).toBe(true);
    });

    test("frames are resampled after trim, speed, range and display selection", async () => {
        for (const transform of [
            { kind: "trim" as const, from: 1, to: 3 },
            { kind: "speed" as const, factor: 2 },
            { kind: "range" as const, from: 1, to: 3 },
        ]) {
            const result = await new RecordingEditor().run({
                source: { file: recordingFolder() },
                output: workspace(),
                steps: [
                    { kind: "frames" },
                    transform,
                    { kind: "frames", displays: [1] },
                    { kind: "grid", perImage: 4 },
                ],
            }).done;
            expect(result.frames.length).toBeGreaterThan(0);
            expect(result.frames.every((frame) => frame.displayId === 1)).toBe(true);
            expect(result.sheets.length).toBeGreaterThan(0);
            expect(result.steps.find((step) => step.name === "frames-2")?.skipped).toBe(false);
        }
    });

    test("an unknown recording id is a clear error", () => {
        expect(() =>
            new RecordingEditor().run({ source: { recording: "no-such-recording-xyz" }, steps: [{ kind: "frames" }] })
        ).toThrow('No recording "no-such-recording-xyz"');
    });
});

test("cached results wait for an active writer in the same workspace", async () => {
    const source = recordingFolder();
    const output = workspace();
    const editor = new RecordingEditor();
    const plan = {
        source: { file: source },
        output,
        steps: [
            { kind: "frames" as const, displays: [1] },
            { kind: "grid" as const, perImage: 4 },
        ],
    };
    await editor.run(plan).done;
    const writer = editor.run(plan, { receipts: false });
    let finished = false;
    const first = writer.done.then(() => {
        finished = true;
    });
    const reader = editor.run(plan);
    await reader.done;
    expect(finished).toBe(true);
    await first;
});

test("still sampling advances through irregular changes and can be cancelled", async () => {
    const source = recordingFolder();
    const editor = new RecordingEditor();
    const result = await editor.run({
        source: { file: source },
        steps: [
            { kind: "range", from: 0.5, to: 3.5 },
            { kind: "frames", fps: 2, displays: [1] },
        ],
    }).done;
    expect(result.frames.map((frame) => frame.actualUs)).toEqual([0, 1000000, 1000000, 2000000, 2000000, 3000000]);
    const controller = new AbortController();
    const job = editor.run(
        {
            source: { file: source },
            steps: [
                { kind: "range", from: 0, to: 10000 },
                { kind: "frames", fps: 30 },
            ],
        },
        { signal: controller.signal, receipts: false }
    );
    const outcome = job.done.catch((error: unknown) => error);
    await yieldToEventLoop();
    controller.abort(new Error("sampling cancelled"));
    expect(await outcome).toBeInstanceOf(Error);
    expect(((await outcome) as Error).message).toContain("cancel");
});

test("trimmed stills sample through the transformed endpoint", async () => {
    const source = recordingFolder();
    const result = await new RecordingEditor().run({
        source: { file: source },
        output: workspace(),
        steps: [
            { kind: "trim", from: 0.25, to: 0.75 },
            { kind: "speed", factor: 2 },
            { kind: "frames", fps: 8, displays: [1] },
        ],
    }).done;
    expect(result.frames.map((frame) => frame.requestedUs)).toEqual([0, 125000]);
});

describe.skipIf(skip.integration)("the editor on a video, and the frame review over it", () => {
    test("a survey's sampled frame at t is the frame the editor shows at t on a variable-frame-rate movie", async () => {
        const root = workspace();
        const movie = join(root, "vfr.mp4");
        // Frame N is grey level N*4; frames 0..19 at N*0.1 s, then a gap to 2 s and 0.37 s steps (variable rate).
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=32x32:r=10:d=4",
                "-vf",
                "geq=lum='min(250,N*4)':cb=128:cr=128,setpts='if(lt(N,20),N*0.1,2+(N-20)*0.37)/TB'",
                "-fps_mode",
                "vfr",
                "-c:v",
                "libx264",
                "-qp",
                "0",
                "-pix_fmt",
                "yuv444p",
                movie,
            ],
        });
        const sampled = async (filter: string) => {
            const stdout = await runVideoCommand({
                command: [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-i",
                    movie,
                    "-vf",
                    `${filter},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
                    "-f",
                    "null",
                    "-",
                ],
            });
            return [...stdout.matchAll(/pts_time:([0-9.]+)[\s\S]*?YAVG=([0-9.]+)/g)].map(
                (match) => [Number(match[1]), Math.round(Number(match[2]) / 4)] as const
            );
        };
        // The frames as stored (the stream rounds each time to its time base).
        const times = (
            await runVideoCommand({
                command: [
                    "ffprobe",
                    "-v",
                    "error",
                    "-select_streams",
                    "v",
                    "-show_entries",
                    "frame=pts_time",
                    "-of",
                    "csv=p=0",
                    movie,
                ],
            })
        )
            .trim()
            .split("\n")
            .map((line) => Number.parseFloat(line) || 0);
        // The editor shows the latest frame whose time is at or before t (AVFoundation, zero tolerance).
        const shownAt = (t: number) => times.findLastIndex((time) => time <= t + 1e-6);
        const editorFrames = await sampled(sampleFpsFilter(2));
        expect(editorFrames.length).toBeGreaterThan(8);
        expect(editorFrames.filter(([t, frame]) => frame !== shownAt(t))).toEqual([]);
        // ffmpeg's default rounding picks the nearest frame, up to half a step LATER than the editor shows.
        const plain = await sampled("fps=2");
        expect(plain.some(([t, frame]) => frame !== shownAt(t))).toBe(true);
    });

    test("expanded extraction filenames cannot overwrite a video input", async () => {
        const root = workspace();
        const source = join(root, "source-00000.png");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=size=16x16:duration=1",
                "-f",
                "mp4",
                source,
            ],
        });
        const before = sha(source);
        await expect(
            new RecordingEditor().run(
                { source: { file: source }, steps: [{ kind: "frames", fps: 1 }] },
                { outputDir: root, layout: "flat" }
            ).done
        ).rejects.toThrow();
        expect(sha(source)).toBe(before);
    });

    test("prepareVideoEvidence gives the frames and grids the editor gives for the same settings", async () => {
        const root = workspace();
        const source = join(root, "source.mp4");
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
                source,
            ],
        });
        const evidence = await prepareVideoEvidence({
            input: source,
            outputRoot: join(root, "evidence"),
            settings: { fps: 4, framesPerImage: 4, minimumDifferencePct: 0 },
        });
        // Measured on the implementation before the adapter: 12 samples, 3 sheets of 2 × 2.
        expect(evidence.counts).toEqual({ candidates: 12, kept: 12, skipped: 0, images: 3, lastImageFrames: 4 });
        expect(evidence.sheets.map((sheet) => [sheet.columns, sheet.rows])).toEqual([
            [2, 2],
            [2, 2],
            [2, 2],
        ]);

        const direct = await new RecordingEditor().run({
            source: { file: source },
            output: join(root, "edit"),
            steps: [
                { kind: "frames", fps: 4, changeOnly: true, threshold: 0 },
                { kind: "grid", perImage: 4, labels: "sample" },
            ],
        }).done;
        expect(direct.frames.map((frame) => [frame.id, frame.actualUs, frame.kept])).toEqual(
            evidence.frames.map((frame) => [frame.id, frame.actualUs, frame.kept])
        );
        expect(direct.sheets.map((sheet) => [sheet.columns, sheet.rows, sheet.frameIds])).toEqual(
            evidence.sheets.map((sheet) => [sheet.columns, sheet.rows, sheet.frameIds])
        );
        expect(direct.frames.map((frame) => sha(frame.path))).toEqual(evidence.frames.map((frame) => sha(frame.path)));
        expect(direct.sheets.map((sheet) => sha(sheet.path))).toEqual(evidence.sheets.map((sheet) => sha(sheet.path)));

        // Frozen from the pre-adapter implementation at 13733a8342 using the same generated video.
        expect(evidence.frames.map((frame) => sha(frame.path))).toEqual(legacyEvidence[0].frames);
        expect(evidence.sheets.map((sheet) => sha(sheet.path))).toEqual(legacyEvidence[0].sheets);
        const ranged = await prepareVideoEvidence({
            input: source,
            outputRoot: join(root, "ranged"),
            settings: { fps: 4, framesPerImage: 4, minimumDifferencePct: 2, startUs: 500_000, endUs: 2_000_000 },
        });
        expect(ranged.counts).toEqual(legacyEvidence[1].counts);
        expect(ranged.frames.map((frame) => sha(frame.path))).toEqual(legacyEvidence[1].frames);
        expect(ranged.sheets.map((sheet) => sha(sheet.path))).toEqual(legacyEvidence[1].sheets);

        for (const grid of [false, true]) {
            const plan = {
                source: { file: source },
                output: join(root, `repair-${grid}`),
                steps: [
                    { kind: "frames" as const, fps: 4, changeOnly: true, threshold: 0 },
                    ...(grid ? [{ kind: "grid" as const, perImage: 4 }] : []),
                ],
            };
            const editor = new RecordingEditor();
            const first = await editor.run(plan).done;
            const expected = sha(first.frames[0].path);
            unlinkSync(first.frames[0].path);
            const repaired = await editor.run(plan).done;
            expect(sha(repaired.frames[0].path)).toBe(expected);
            expect(repaired.steps.find((step) => step.name === "frames-0")?.skipped).toBe(false);
        }

        const rangedSpeed = await new RecordingEditor().run({
            source: { file: source },
            output: join(root, "ranged-speed"),
            steps: [
                { kind: "range", from: 1, to: 2 },
                { kind: "speed", factor: 2 },
                { kind: "frames", fps: 4 },
                { kind: "export", format: "mp4" },
            ],
        }).done;
        expect(rangedSpeed.frames.map((frame) => frame.requestedUs)).toEqual([500000, 750000]);
        const exportedRange = await probeVideo({ input: rangedSpeed.exports[0].path });
        expect(exportedRange.durationUs).toBeGreaterThanOrEqual(400000);
        expect(exportedRange.durationUs).toBeLessThan(700000);

        const trimmed = await new RecordingEditor().run({
            source: { file: source },
            output: join(root, "edit"),
            steps: [
                { kind: "trim", from: 1, to: 2 },
                { kind: "speed", factor: 2 },
                { kind: "frames", fps: 4 },
                { kind: "export", format: "gif" },
            ],
        }).done;
        expect(trimmed.video?.info.durationUs).toBeLessThan(700_000);
        expect(trimmed.frames.length).toBeGreaterThan(0);
        expect(existsSync(trimmed.exports[0].path)).toBe(true);
        await expect(
            new RecordingEditor().run({
                source: { file: source },
                output: join(root, "edit"),
                steps: [{ kind: "export", format: "mp4", output: source }],
            }).done
        ).rejects.toThrow(OverwriteInputError);
    }, 60_000);
});

describe("a part export's audio", () => {
    // A part sounds like the same stretch of the whole export. The case is shared with the Swift TimelineMap.part
    // (Tests/RecorderHuntR2PartExportAudioTests.swift), so the two part makers fail together.
    test("keeps a voiceover that plays across the part's start and the music's place in the whole (part-audio.json)", () => {
        const whole = editProjectSchema.parse(partAudio.edit);
        const part = partOf(whole, partAudio.part.fromUs, partAudio.part.toUs);
        expect(part.audio.voiceovers).toEqual(partAudio.voiceovers.map((clip) => voiceoverSchema.parse(clip)));
        expect(part.audio.music?.inWhole).toEqual(partAudio.inWhole);
        const { cards: _cards, ...exported } = part;
        expect(voiceoverExportSpans(exported)).toEqual(partAudio.spans);
        // A part of a part counts from the same whole.
        const inner = partOf(exported, 1_000_000, 3_000_000);
        expect(inner.audio.music?.inWhole).toEqual({ atUs: partAudio.inWhole.atUs + 1_000_000, lengthUs: 23_000_000 });
        expect(inner.audio.voiceovers?.find((clip) => clip.id === "v1")).toMatchObject({
            skipUs: 3_000_000,
            durationUs: 3_000_000,
        });
    });

    test("the keep op still makes the kept range the new whole: no music place, voiceovers as they were", () => {
        const whole = editProjectSchema.parse(partAudio.edit);
        const kept = applyOp(whole, editOpSchema.parse({ op: "range", action: "keep", from: 6, to: 12 }));
        expect(kept.audio.music?.inWhole).toBeUndefined();
        expect(kept.audio.voiceovers).toEqual(whole.audio.voiceovers);
    });
});

describe("edit project (edit.json)", () => {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };

    test("a cut, a speed change and a zoom keep source times and shorten the output", () => {
        let project = wholeProject(source);
        project = applyOp(project, { op: "cut", from: 1, to: 2 });
        project = applyOp(project, { op: "speed", from: 4, to: 8, factor: 2 });
        project = applyOp(project, { op: "zoom", from: "0:03", to: 5, scale: 2, focus: { x: 0.3, y: 0.3 } });

        expect(project.clips.map((clip) => [clip.fromUs, clip.toUs, clip.speed])).toEqual([
            [0, 1_000_000, 1],
            [2_000_000, 4_000_000, 1],
            [4_000_000, 8_000_000, 2],
            [8_000_000, 10_000_000, 1],
        ]);
        expect(outputDurationUs(project)).toBe(7_000_000);
        expect(outputTimeOf(project, 1_500_000)).toBeUndefined();
        expect(outputTimeOf(project, 6_000_000)).toBe(4_000_000);
        expect(project.zooms[0]).toMatchObject({ startUs: 3_000_000, endUs: 5_000_000, scale: 2, focusX: 0.3 });
    });

    test("a new edit's clip has the same id every time, so an id printed before the first save still names it", () => {
        expect(wholeProject(source).clips[0].id).toBe(wholeProject(source).clips[0].id);
        const split = applyOp(wholeProject(source), { op: "split", at: 4 });
        expect(new Set(split.clips.map((clip) => clip.id)).size).toBe(2);
        const faster = applyOp(wholeProject(source), {
            op: "clipSpeed",
            clip: wholeProject(source).clips[0].id,
            factor: 2,
        });
        expect(outputDurationUs(faster)).toBe(5_000_000);
    });

    test("a zoom op takes its ease times, so a slow push over a still screen needs no second setZoom op", () => {
        const project = applyOp(wholeProject(source), {
            op: "zoom",
            from: 1,
            to: 6,
            scale: 1.2,
            easeInMs: 4500,
            easeOutMs: 300,
        });
        expect(project.zooms.map((zoom) => [zoom.easeInMs, zoom.easeOutMs])).toEqual([[4500, 300]]);
        const plain = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 6 });
        expect(plain.zooms.map((zoom) => [zoom.easeInMs, zoom.easeOutMs])).toEqual([[450, 450]]);
    });

    test("effect lanes: items find their lane, new lanes save in order, and a removed lane hands its items on", () => {
        const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
        let project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 2 });
        project = applyOp(project, { op: "redact", from: 3, to: 4, rect });
        project = applyOp(project, { op: "text", from: 5, to: 6, text: "Step one" });
        const lanes = (p: typeof project) => describeProject(p, "/x").lanes.map((lane) => [lane.id, lane.items.length]);

        // Never saved: the zoom lane, then a lane per family that has an item.
        expect(project.lanes).toBeUndefined();
        expect(lanes(project)).toEqual([
            ["zooms", 1],
            ["auto-hide", 1],
            ["auto-text", 1],
        ]);

        project = applyOp(project, { op: "addLane", kinds: ["zoom", "text"], name: "Second" });
        expect(project.lanes?.map((lane) => lane.id)).toEqual(["zooms", "auto-hide", "auto-text", "lane4"]);
        project = applyOp(project, { op: "zoom", from: 7, to: 8, lane: "lane4" });
        expect(project.zooms.find((zoom) => zoom.startUs === 7_000_000)?.lane).toBe("lane4");
        expect(lanes(project)).toEqual([
            ["zooms", 1],
            ["auto-hide", 1],
            ["auto-text", 1],
            ["lane4", 1],
        ]);

        const text = project.texts?.[0].id ?? "";
        project = applyOp(project, { op: "moveToLane", id: text, lane: "lane4" });
        project = applyOp(project, { op: "moveLane", id: "lane4", to: 0 });
        expect(lanes(project)).toEqual([
            ["lane4", 2],
            ["zooms", 1],
            ["auto-hide", 1],
            ["auto-text", 0],
        ]);
        expect(() =>
            applyOp(project, { op: "moveToLane", id: project.redactions?.[0].id ?? "", lane: "zooms" })
        ).toThrow("not hide");
        expect(() => applyOp(project, { op: "zoom", from: 9, to: 9.5, lane: "nope" })).toThrow("no lane nope");

        // The lane's items fall back to the first lane that holds them; none left keeps its lane.
        project = applyOp(project, { op: "removeLane", id: "lane4" });
        expect(project.texts?.[0].lane).toBeUndefined();
        expect(lanes(project)).toEqual([
            ["zooms", 2],
            ["auto-hide", 1],
            ["auto-text", 1],
        ]);
        // The saved shape round-trips through the schema (the window writes the same keys).
        expect(editProjectSchema.parse(SafeJSON.parse(SafeJSON.stringify(project))).lanes).toEqual(project.lanes);
    });

    test("range actions read OUTPUT times: after a cut and a speed-up they edit what plays there", () => {
        let project = applyOp(wholeProject(source), { op: "range", from: 0, to: 1, action: "cut" });
        expect(outputDurationUs(project)).toBe(9_000_000);
        // Output 1..3 is source 2..4 now; played at 2 it takes 1 s.
        project = applyOp(project, { op: "range", from: 1, to: 3, action: "speed" });
        expect(project.clips.map((clip) => [clip.fromUs, clip.toUs, clip.speed])).toEqual([
            [1_000_000, 2_000_000, 1],
            [2_000_000, 4_000_000, 2],
            [4_000_000, 10_000_000, 1],
        ]);
        project = applyOp(project, { op: "range", from: 1, to: 2, action: "zoom", scale: 2 });
        expect(project.zooms.map((zoom) => [zoom.startUs, zoom.endUs, zoom.scale])).toEqual([
            [2_000_000, 4_000_000, 2],
        ]);
        project = applyOp(project, { op: "range", from: 2, to: 3, action: "text", text: "Next" });
        expect(project.texts?.map((note) => [note.startUs, note.endUs, note.text])).toEqual([
            [4_000_000, 5_000_000, "Next"],
        ]);
        expect(() => applyOp(project, { op: "range", from: 0, to: 1, action: "spotlight", lane: "zooms" })).toThrow(
            "not spotlight"
        );
        expect(() => applyOp(project, { op: "range", from: 3, to: 2, action: "cut" })).toThrow("before it starts");
    });

    test("a marker from a range sits at the range's start where it plays, numbered unless named, and unmarker removes it", () => {
        // Output 1 s plays source 2 s after the first second was cut.
        let project = applyOp(wholeProject(source), { op: "range", from: 0, to: 1, action: "cut" });
        project = applyOp(project, { op: "range", from: 1, to: 3, action: "marker" });
        project = applyOp(project, { op: "range", from: 0.5, to: 2, action: "marker", text: "Login" });
        project = applyOp(project, { op: "marker", at: 8, label: "  Wrap up " });

        expect(project.markers?.map((marker) => [marker.atUs, marker.label])).toEqual([
            [1_500_000, "Login"],
            [2_000_000, "Marker 1"],
            [8_000_000, "Wrap up"],
        ]);
        expect(project.markers?.every((marker) => /^m[0-9a-f]{8}$/.test(marker.id))).toBe(true);
        expect(editProjectSchema.parse(SafeJSON.parse(SafeJSON.stringify(project))).markers).toEqual(project.markers);

        const [login] = project.markers ?? [];
        const rest = applyOp(project, { op: "unmarker", id: login.id });
        expect(rest.markers?.map((marker) => marker.label)).toEqual(["Marker 1", "Wrap up"]);
        expect(() => applyOp(rest, { op: "unmarker", id: login.id })).toThrow(`no marker ${login.id}`);
        expect(() => applyOp(rest, { op: "marker", at: 99 })).toThrow("outside the 10 s movie");
        const none = (rest.markers ?? []).reduce(
            (next, marker) => applyOp(next, { op: "unmarker", id: marker.id }),
            rest
        );
        expect(none.markers).toBeUndefined();

        // The window decodes the shared edit.json (RecorderTimelineTests.swift); these ops still make its markers.
        const shared = editMarkers.ops.reduce(
            (next, op) => applyOp(next, editOpSchema.parse(op)),
            wholeProject({ video: "/rec/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 })
        );
        const strip = (list: Array<{ atUs: number; label: string }> = []) =>
            list.map(({ atUs, label }) => ({ atUs, label }));
        expect(strip(shared.markers)).toEqual(strip(editProjectSchema.parse(editMarkers.edit).markers));
    });

    test("review comments: added, changed and removed as appended lines, read back in time order", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-comments-"));
        writeFileSync(join(dir, "recording.json"), "{}");
        const path = commentsPathFor(join(dir, "screen.mp4"));
        expect(path).toBe(join(dir, "comments.jsonl"));
        expect(commentsPathFor("/movies/talk.mov")).toBe("/movies/talk.comments.jsonl");

        const late = addComment(path, { atUs: 5_000_000, text: "Too fast here", author: "alice" });
        const early = addComment(path, {
            atUs: 1_000_000,
            toUs: 2_000_000,
            text: "Cut this",
            link: "https://example.com/b/1",
        });
        updateComment(path, late.id, { resolved: true });
        removeComment(path, early.id);
        writeFileSync(path, `${readFileSync(path, "utf8")}not json\n`);

        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(5);
        expect(readComments(path).map((comment) => [comment.id, comment.atUs, comment.resolved])).toEqual([
            [late.id, 5_000_000, true],
        ]);
        expect(() => updateComment(path, early.id, { text: "x" })).toThrow(`no comment ${early.id}`);
        expect(() => addComment(path, { atUs: 3_000_000, toUs: 2_000_000, text: "x" })).toThrow("before it starts");
        // The editor window's rules: a range of no length is a moment, and a long text keeps 2000 characters.
        const moment = addComment(path, { atUs: 3_000_000, toUs: 3_000_000, text: ` ${"a".repeat(2100)} ` });
        expect(moment).not.toHaveProperty("toUs");
        expect(moment.text).toHaveLength(2000);
    });

    test("refuses a cut of everything, and a zoom where no zoom fits, naming why", () => {
        const project = applyOp(wholeProject(source), { op: "zoom", from: 0, to: 10 });
        expect(() => applyOp(project, { op: "cut", from: 0, to: 10 })).toThrow("whole movie");
        expect(() => applyOp(project, { op: "zoom", from: 2, to: 4 })).toThrow("no room for a zoom here");
    });

    test("parses ops with one readable line per problem", () => {
        expect(parseEditOps({ op: "split", at: 2 })).toEqual([{ op: "split", at: 2 }]);
        expect(() => parseEditOps([{ op: "bogus" }, { op: "cut", from: 1 }])).toThrow(
            /op 1: "op" must be one of split[\s\S]*op 2 \(cut\) to: is required/
        );
    });

    test("auto zoom groups clicks under 3 s apart and follows the cursor", () => {
        const samples = [
            { ms: 1000, x: 0.2, y: 0.2, click: "left" },
            { ms: 2000, x: 0.4, y: 0.4, click: "left" },
            { ms: 7000, x: 0.8, y: 0.8, click: "left" },
        ];
        const zooms = autoZoom(wholeProject(source), samples).zooms;
        expect(zooms.map((zoom) => [zoom.startUs, zoom.endUs, zoom.mode])).toEqual([
            [400_000, 3_600_000, "follow"],
            [6_400_000, 8_600_000, "follow"],
        ]);
        expect(zooms[0].focusX).toBeCloseTo(0.3);

        // A manual zoom stays, a click group over it is left out, and no clicks changes nothing.
        const manual = applyOp(wholeProject(source), { op: "zoom", from: 7, to: 8, scale: 2 });
        const kept = autoZoom(manual, samples).zooms;
        expect(kept.map((zoom) => zoom.mode)).toEqual(["follow", "manual"]);
        expect(() => autoZoom(manual, [])).toThrow("no cursor track");
        expect(() => autoZoom(manual, [{ ms: 1, x: 0, y: 0 }])).toThrow("no clicks");
    });

    describe("autoZoom replaces only its own zooms", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 30_000_000, width: 1920, height: 1080 };
        const clicks = [
            { ms: 5000, x: 0.3, y: 0.3, click: "left" },
            { ms: 12_000, x: 0.7, y: 0.7, click: "left" },
        ];
        const spans = (project: ReturnType<typeof wholeProject>) =>
            project.zooms.map((zoom) => [
                zoom.startUs / 1e6,
                zoom.endUs / 1e6,
                zoom.target ?? "picture",
                zoom.origin ?? "-",
            ]);

        test("keeps a hand-made follow zoom and a canvas zoom, replaces an earlier auto zoom, and zooms under a canvas zoom", () => {
            let project = autoZoom(wholeProject(source), [clicks[1]], 1.6);
            expect(spans(project)).toEqual([[11.4, 13.6, "picture", "auto"]]);
            project = applyOp(project, { op: "zoom", from: 20, to: 22, follow: true, scale: 2.5 });
            project = applyOp(project, { op: "zoom", from: 4, to: 7, target: "canvas", scale: 2.5 });

            const again = autoZoom(project, clicks, 1.6);
            expect(spans(again)).toEqual([
                [4, 7, "canvas", "-"],
                [4.4, 6.6, "picture", "auto"],
                [11.4, 13.6, "picture", "auto"],
                [20, 22, "picture", "-"],
            ]);
        });

        test("a picture zoom still blocks a click group, and setZoom and duplicate make an auto zoom the user's", () => {
            const manual = applyOp(wholeProject(source), { op: "zoom", from: 5, to: 6 });
            expect(spans(autoZoom(manual, clicks, 1.6))).toEqual([
                [5, 6, "picture", "-"],
                [11.4, 13.6, "picture", "auto"],
            ]);

            const auto = autoZoom(wholeProject(source), clicks, 1.6);
            const id = auto.zooms[0]?.id ?? "";
            expect(applyOp(auto, { op: "setZoom", id, scale: 2 }).zooms[0]).not.toHaveProperty("origin");
            const copied = applyOp(auto, { op: "duplicate", id });
            expect(copied.zooms.filter((zoom) => zoom.origin === "auto")).toHaveLength(2);
        });
    });

    describe("a frame's background image is a picture the renderer decodes", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
        const folder = mkdtempSync(join(tmpdir(), "bg-picture-"));
        const svg = join(folder, "bg.svg");
        const png = join(folder, "bg.png");
        writeFileSync(svg, "<svg/>");
        writeFileSync(png, "png");

        test("frame refuses an SVG background, takes a PNG, and an edit that holds an SVG can still change its padding", () => {
            expect(() => applyOp(wholeProject(source), { op: "frame", background: { image: svg } })).toThrow(
                "is not a picture"
            );
            expect(
                applyOp(wholeProject(source), { op: "frame", background: { image: png } }).frame?.background
            ).toMatchObject({
                kind: "image",
                image: png,
            });

            const old = applyOp(wholeProject(source), { op: "frame", background: { image: png } });
            const holding = {
                ...old,
                frame: old.frame ? { ...old.frame, background: { ...old.frame.background, image: svg } } : undefined,
            };
            expect(applyOp(holding, { op: "frame", padding: 0.1 }).frame?.padding).toBe(0.1);

            const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
            expect(checkProject(holding, facts).some((issue) => issue.kind === "background-not-picture")).toBe(true);
            expect(checkProject(old, facts).some((issue) => issue.kind === "background-not-picture")).toBe(false);
        });
    });

    describe("click rings and the click sound need a cursor track", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };

        test("the clicks op refuses rings or a tick on a movie with no cursor track, and still turns them off", () => {
            expect(() => applyOp(wholeProject(source), { op: "clicks", highlight: true })).toThrow("no cursor track");
            expect(() => applyOp(wholeProject(source), { op: "clicks", highlight: false, sound: true })).toThrow(
                "no cursor track"
            );
            const off = applyOp(wholeProject(source), { op: "clicks", highlight: false, sound: false });
            expect(off.clicks?.highlight).toBe(false);
        });

        test("check() names a saved clicks setting whose movie has no cursor track, with an op that turns it off", () => {
            const saved = {
                ...wholeProject(source),
                clicks: { highlight: true, color: "#FFD60A", radius: 0.03, durationMs: 450 },
            };
            const facts = { hasTranscript: true, hasCursorTrack: false, musicFileExists: true };
            const issue = checkProject(saved, facts).find((each) => each.kind === "clicks-missing-cursor");
            expect(issue?.severity).toBe("fix");
            expect(issue?.action?.ops).toEqual([{ op: "clicks", highlight: false, sound: false }]);
            expect(
                checkProject(saved, { ...facts, hasCursorTrack: true }).some(
                    (each) => each.kind === "clicks-missing-cursor"
                )
            ).toBe(false);
        });
    });

    describe("the camera bubble and the captions share the bottom band", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const withCamera = (
            camera: Partial<projectOps.EditProject["camera"]>,
            aspect?: "9:16",
            position: "bottom" | "top" = "bottom"
        ): projectOps.EditProject => {
            const whole = wholeProject(source);
            return {
                ...(aspect ? applyOp(whole, { op: "frame", aspect }) : whole),
                captions: { show: true, size: 0.038, position },
                camera: cameraBubbleSchema.parse({ file: "camera.mov", ...camera }),
            };
        };

        test("a custom bubble near the middle of the caption band lifts the captions, with a fix to a top corner", () => {
            const issue = checkProject(withCamera({ corner: "custom", x: 0.5, y: 0.9 }), facts).find(
                (each) => each.kind === "camera-lifts-captions"
            );
            expect(issue?.severity).toBe("check");
            expect(issue?.action?.ops).toEqual([{ op: "camera", corner: "topRight" }]);
        });

        test("the default bubble on a landscape canvas only narrows the captions, so check() says nothing", () => {
            expect(checkProject(withCamera({}), facts).some((each) => each.kind === "camera-lifts-captions")).toBe(
                false
            );
        });

        test("the default bubble on a phone-portrait canvas lifts the captions", () => {
            expect(
                checkProject(withCamera({}, "9:16"), facts).some((each) => each.kind === "camera-lifts-captions")
            ).toBe(true);
        });

        test("captions at the top, a hidden bubble or a bubble at the top give nothing", () => {
            const middle = { corner: "custom" as const, x: 0.5, y: 0.9 };
            const none = (project: projectOps.EditProject) =>
                !checkProject(project, facts).some((each) => each.kind === "camera-lifts-captions");
            expect(none(withCamera(middle, undefined, "top"))).toBe(true);
            expect(none(withCamera({ ...middle, show: false }))).toBe(true);
            expect(none(withCamera({ corner: "topRight" }))).toBe(true);
        });
    });

    describe("a caption fix is keyed the way its readers look it up", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 20_000_000, width: 1920, height: 1080 };
        const segments = [
            { text: "First line.", start: 1, end: 4 },
            { text: "Old words here.", start: 8.0025, end: 10 },
        ];

        test("fixLine on a line that starts on a half millisecond shows the fix, and unfixLine removes it", () => {
            const fixed = applyOp(
                wholeProject(source),
                { op: "fixLine", from: 9, text: "New words here." },
                {
                    transcript: segments,
                }
            );
            expect(transcriptLines({ segments }, fixed).map((line) => line.text)).toEqual([
                "First line.",
                "New words here.",
            ]);
            expect(
                replaceWordsInLines(segments, fixed.transcript?.fixes ?? {}, { find: "New", replace: "Fresh" })
            ).toEqual([{ from: 8.0025, text: "Fresh words here.", was: "New words here." }]);

            const back = applyOp(fixed, { op: "unfixLine", from: 9 }, { transcript: segments });
            expect(back.transcript).toBeUndefined();
        });

        test("a fix saved under the old double-rounded key still shows", () => {
            const old = { ...wholeProject(source), transcript: { fixes: { "8003": "Saved before." } } };
            expect(transcriptLines({ segments }, old).map((line) => line.text)).toEqual([
                "First line.",
                "Saved before.",
            ]);
            expect(
                applyOp(old, { op: "unfixLine", from: 8.0025 }, { transcript: segments }).transcript
            ).toBeUndefined();
        });
    });

    describe("check() lays texts out and counts frames on the export's own canvas and rate", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const retina = { video: "/movies/screen.mp4", durationUs: 20_000_000, width: 4112, height: 2570 };
        const overlapping = () => {
            // One line on a 1080 px or 1600 px short side, two lines on 720: the second line reaches the text under it.
            let project = applyOp(wholeProject(retina), {
                op: "text",
                from: 1,
                to: 4,
                text: "Open the settings and pick the export size you want fo",
                size: 0.05,
                x: 0.5,
                y: 0.4,
            });
            project = applyOp(project, { op: "text", from: 1, to: 4, text: "Below", size: 0.03, x: 0.5, y: 0.484 });
            return project;
        };
        const overlaps = (project: ReturnType<typeof wholeProject>) =>
            checkProject(project, facts).filter((issue) => issue.kind === "text-overlap");

        test("a text that wraps only on the Chat preset's 720 px canvas overlaps the text under it there", () => {
            const project = overlapping();
            expect(overlaps(project)).toEqual([]);
            expect(overlaps(applyOp(project, { op: "exportSettings", maxHeight: 720 }))).toHaveLength(1);
            expect(
                overlaps(applyOp(project, { op: "exportSettings", maxHeight: 720, size: { height: 1080 } }))
            ).toEqual([]);
        });

        test("a short hidden part names its frames at the export's rate, and none when the rate is not known", () => {
            const project = applyOp(wholeProject(retina), {
                op: "redact",
                from: 10,
                to: 10.1,
                rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
            });
            const short = (nominalFps?: number) =>
                checkProject(project, { ...facts, ...(nominalFps === undefined ? {} : { nominalFps }) }).find(
                    (issue) => issue.kind === "hiding-too-short"
                )?.message;
            expect(short(45)).toContain("about 6 frames at 60 fps");
            expect(short(30)).toContain("about 3 frames at 30 fps");
            expect(short()).not.toContain("fps");
        });

        test("exportPlanOf follows the renderer's rate rule and the cases the Swift test holds plannedOutput to", () => {
            expect([exportFps(45), exportFps(28.9), exportFps(8)]).toEqual([60, 29, 30]);
            const gif = applyOp(wholeProject(retina), { op: "exportSettings", format: "gif" });
            expect(exportPlanOf(gif)).toEqual({ fps: 10, canvas: { width: 960, height: 600 } });

            const cases = SafeJSON.parse(readFileSync(join(import.meta.dir, "export-size.cases.json"), "utf8"), {
                strict: true,
            }) as ExportSizeCases;
            for (const row of cases.cases) {
                let project = wholeProject({ video: "/movies/x.mp4", durationUs: 1_000_000, ...row.source });
                project = { ...project, export: { ...project.export, ...row.export } };

                if (row.aspect) {
                    project = applyOp(project, { op: "frame", aspect: row.aspect });
                }

                expect({ name: row.name, ...exportPlanOf(project, { nominalFps: row.nominalFps }) }).toEqual({
                    name: row.name,
                    fps: row.fps,
                    canvas: row.canvas,
                });
            }
        });
    });

    describe("a drawn hidden part keeps the piece inside the picture on every edge", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };

        test("a rectangle that starts left of or above the picture is clipped, not refused", () => {
            const left = applyOp(wholeProject(source), {
                op: "redact",
                from: 1,
                to: 2,
                rect: { x: -0.1, y: 0.2, width: 0.3, height: 0.2 },
            }).redactions?.[0];
            expect(left?.x).toBe(0);
            expect(left?.width).toBeCloseTo(0.2);
            expect(left?.y).toBeCloseTo(0.2);

            const above = applyOp(wholeProject(source), {
                op: "spotlight",
                from: 1,
                to: 2,
                rect: { x: 0.5, y: -0.05, width: 0.2, height: 0.25 },
            }).redactions?.[0];
            expect(above?.y).toBe(0);
            expect(above?.height).toBeCloseTo(0.2);

            const past = applyOp(wholeProject(source), {
                op: "redact",
                from: 1,
                to: 2,
                rect: { x: 0.9, y: 0.9, width: 0.3, height: 0.3 },
            }).redactions?.[0];
            expect(past?.width).toBeCloseTo(0.1);
            expect(past?.height).toBeCloseTo(0.1);

            expect(() =>
                applyOp(wholeProject(source), {
                    op: "redact",
                    from: 1,
                    to: 2,
                    rect: { x: -0.3, y: 0.2, width: 0.305, height: 0.2 },
                })
            ).toThrow("at least 0.01");
        });
    });

    test("check names a zoom whose ease out starts before a cut, so its last frames before the cut snap out", () => {
        // The zoom runs into the cut at 5 s, but its 450 ms ease out starts at 4.75 s: the 0.25 s before the cut
        // show the fast start of the ease out, a snap. Ending it at 5.5 s puts the whole ease out in the cut.
        let project = applyOp(wholeProject(source), { op: "cut", from: 5, to: 7 });
        project = applyOp(project, { op: "zoom", from: 2, to: 5.2, scale: 1.5 });
        // The zoom after the cut plays 1.5 s after it: too far to link with, so the first one eases out.
        project = applyOp(project, { op: "zoom", from: 8.5, to: 9.5, scale: 1.5 });
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const snaps = checkProject(project, facts).filter((issue) => issue.kind === "zoom-eases-out-at-cut");
        expect(snaps).toHaveLength(1);
        expect(snaps[0]).toMatchObject({ severity: "check", at: 5 });
        expect(snaps[0]?.message).toContain("0.25 s");
        expect(snaps[0]?.action?.ops).toEqual([{ op: "retime", id: project.zooms[0]?.id, to: 5.5 }]);
        const fixed = applyOp(project, { op: "retime", id: project.zooms[0]?.id ?? "", to: 5.5 });
        expect(checkProject(fixed, facts).filter((issue) => issue.kind === "zoom-eases-out-at-cut")).toEqual([]);
    });

    describe("the caption and the hidden parts as the renderer draws them", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };

        test("captionAt draws the later of two overlapping lines, only while captions show, with the fix after the pick", () => {
            const raw = {
                segments: [
                    { text: " first ", start: 1, end: 5 },
                    { text: "second", start: 4.5, end: 6 },
                    { text: "", start: 6, end: 7 },
                    { text: "backwards", start: 8, end: 7.5 },
                ],
            };
            const off = wholeProject(source);
            expect(projectOps.captionAt(off, raw, 2_000_000)).toBeNull();
            expect(projectOps.spokenLineAt(off, raw, 2_000_000)).toBe("first");
            // The captions op needs a transcript file on disk, so these set the field the op would set.
            const on = { ...off, captions: projectOps.captionsSchema.parse({ show: true }) };
            expect(projectOps.captionAt(on, raw, 2_000_000)).toBe("first");
            expect(projectOps.captionAt(on, raw, 4_700_000)).toBe("second");
            // A line with no words, or one that ends before it starts, is no line.
            expect(projectOps.captionAt(on, raw, 6_500_000)).toBeNull();
            expect(projectOps.captionAt(on, raw, 7_700_000)).toBeNull();
            // A fix with no words hides the picked line, and the earlier line under it does not show through.
            const hidden = { ...on, transcript: { fixes: { "4500": "" } } };
            expect(projectOps.captionAt(hidden, raw, 4_700_000)).toBeNull();
            const fixed = { ...on, transcript: { fixes: { "4500": "Second, fixed" } } };
            expect(projectOps.captionAt(fixed, raw, 4_700_000)).toBe("Second, fixed");
            expect(
                projectOps.captionAt(
                    { ...on, captions: projectOps.captionsSchema.parse({ show: false }) },
                    raw,
                    4_700_000
                )
            ).toBeNull();
        });

        test("snappedRedactionSpans runs a blur that ends 200 ms before a cut up to the cut, and closes a short gap", () => {
            const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
            let project = applyOp(wholeProject(source), { op: "redact", from: 1, to: 2, rect });
            project = applyOp(project, { op: "redact", from: 2.2, to: 3.8, rect, style: "black" });
            project = applyOp(project, { op: "redact", from: 6.2, to: 7, rect });
            project = applyOp(project, { op: "redact", from: 1, to: 3.8, rect, style: "spotlight" });
            project = applyOp(project, { op: "cut", from: 4, to: 6 });
            const drawn = (edit: projectOps.EditProject) =>
                projectOps.snappedRedactionSpans(edit).map((part) => [part.style, part.startUs, part.endUs]);

            expect(drawn(project)).toEqual([
                ["blur", 1_000_000, 2_200_000],
                ["black", 2_200_000, 4_000_000],
                ["blur", 6_000_000, 7_000_000],
                ["spotlight", 1_000_000, 3_800_000],
            ]);
            expect(drawn(applyOp(project, { op: "redactionJoins", snapMs: 0 }))).toEqual([
                ["blur", 1_000_000, 2_000_000],
                ["black", 2_200_000, 3_800_000],
                ["blur", 6_200_000, 7_000_000],
                ["spotlight", 1_000_000, 3_800_000],
            ]);
        });
    });

    describe("played time: the renderer's ramps and links", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 30_000_000, width: 1920, height: 1080 };
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const comingIn = (project: projectOps.EditProject) =>
            checkProject(project, facts).filter((issue) => issue.kind === "text-animation-too-long");

        test("check names a text still coming in when it ends, in the time the viewer sees", () => {
            // A 1 s text that types over 3 s never shows its last words; one that types in 0.5 s leaves 0.5 s to read.
            const slow = applyOp(wholeProject(source), {
                op: "text",
                from: 1,
                to: 2,
                text: "Typing the address",
                animate: { kind: "typewriter", ms: 3000 },
            });
            const id = slow.texts?.[0]?.id ?? "";
            const issues = comingIn(slow);
            expect(issues).toHaveLength(1);
            expect(issues[0]).toMatchObject({ severity: "check", at: 1, target: { list: "texts" } });
            expect(issues[0]?.action?.ops).toEqual([{ op: "setText", id, animate: { kind: "typewriter", ms: 600 } }]);
            const fixed = applyOp(slow, { op: "setText", id, animate: { kind: "typewriter", ms: 600 } });
            expect(comingIn(fixed)).toEqual([]);
            const quick = applyOp(wholeProject(source), {
                op: "text",
                from: 1,
                to: 2,
                text: "Typing the address",
                animate: { kind: "typewriter", ms: 500 },
            });
            expect(comingIn(quick)).toEqual([]);

            // 4 s of the movie at 4x play 1 s: a 900 ms way in leaves 0.1 s.
            let sped = applyOp(wholeProject(source), { op: "speed", from: 1, to: 5, factor: 4 });
            sped = applyOp(sped, { op: "text", from: 1, to: 5, text: "Fast", animate: { kind: "slideUp", ms: 900 } });
            expect(comingIn(sped)).toHaveLength(1);
            expect(comingIn(sped)[0]?.message).toContain("plays for 1 s");
        });

        test("zooms whose played gap is shorter than one ease out and one ease in are linked, across a cut too", () => {
            let project = applyOp(wholeProject(source), { op: "zoom", from: 2, to: 5, scale: 2 });
            project = applyOp(project, { op: "zoom", from: 10, to: 13, scale: 2 });
            const [first, second] = project.zooms;
            expect(projectOps.zoomsLinked(project, first, second)).toBe(false);
            const cut = applyOp(project, { op: "cut", from: 5, to: 10 });
            expect(projectOps.zoomsLinked(cut, cut.zooms[0], cut.zooms[1])).toBe(true);
            expect(projectOps.zoomsLinked(cut, cut.zooms[1], cut.zooms[0])).toBe(false);
            // A canvas zoom never links with a picture zoom: each kind has its own view.
            const canvas = { ...cut.zooms[1], target: "canvas" as const };
            expect(projectOps.zoomsLinked(cut, cut.zooms[0], canvas)).toBe(false);
        });

        test("check names no ease out at a cut for a zoom linked to the next one, because the view holds or glides on", () => {
            // 2-5 s and 5.3-8 s with 4.8-6 s cut touch in what plays. Alone, the first one eases out 0.25 s before the cut.
            const first = { op: "zoom", from: 2, to: 5, scale: 2, focus: { x: 0.3, y: 0.3 } } as const;
            const cutOp = { op: "cut", from: 4.8, to: 6 } as const;
            const easesAtCut = (project: projectOps.EditProject) =>
                checkProject(project, facts).filter((issue) => issue.kind === "zoom-eases-out-at-cut");
            const alone = applyOp(applyOp(wholeProject(source), first), cutOp);
            expect(easesAtCut(alone).map((issue) => issue.message)).toEqual([
                expect.stringContaining("starts its ease out 0.25 s before the cut at 4.8 s"),
            ]);

            for (const focus of [
                { x: 0.3, y: 0.3 },
                { x: 0.7, y: 0.7 },
            ]) {
                let linked = applyOp(wholeProject(source), first);
                linked = applyOp(linked, { op: "zoom", from: 5.3, to: 8, scale: 2, focus });
                expect(easesAtCut(applyOp(linked, cutOp))).toEqual([]);
            }
        });

        test("auto zoom joins clicks that play under 3 s apart after a cut, and zooms on no click that is cut", () => {
            const samples = [
                { ms: 5000, x: 0.3, y: 0.3, click: "left" },
                { ms: 8000, x: 0.9, y: 0.9, click: "left" },
                { ms: 14000, x: 0.5, y: 0.5, click: "left" },
            ];
            const cut = applyOp(wholeProject(source), { op: "cut", from: 6.8, to: 13.2 });
            expect(autoZoom(cut, samples).zooms.map((zoom) => [zoom.startUs, zoom.endUs])).toEqual([
                [4_400_000, 15_600_000],
            ]);
            // Without the cut the clicks play 3 s and 6 s apart: three zooms, as before.
            expect(autoZoom(wholeProject(source), samples).zooms).toHaveLength(3);
        });
    });

    test("a voiceover on the intro or end card plays from the card's start, and the export lays each clip as the golden file says", () => {
        // The shared golden file: the Swift export lays the same clips at the same places (RecorderEditTests).
        const golden = editProjectSchema.parse(cardVoiceovers.edit);
        expect(voiceoverExportSpans(golden)).toEqual(cardVoiceovers.spans);
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        expect(checkProject(golden, facts).filter((issue) => issue.kind?.startsWith("voiceover"))).toEqual([
            expect.objectContaining({ kind: "voiceover-cut-at-end", item: "voiceover vlate" }),
        ]);
        const info = describeProject(golden, "/x").voiceovers;
        expect(info.map((clip) => [clip.id, clip.card ?? null, clip.plays, clip.exportPlays])).toEqual([
            ["vintro", "intro", null, 0.4],
            ["vmovie", null, 1, 4],
            ["vlate", null, 7.5, 10.5],
            ["vend", "end", null, 11.5],
        ]);

        // The op: `card` anchors `at` to the card; the card must exist and `at` must fall inside it.
        const folder = mkdtempSync(join(tmpdir(), "card-voice-"));
        const voice = join(folder, "voice.mp3");
        writeFileSync(voice, "");
        const bare = wholeProject(source);
        expect(() =>
            applyOp(bare, { op: "voiceover", card: "intro", at: 0.4, file: voice }, { voiceoverDurationUs: 1_000_000 })
        ).toThrow("no intro card");
        const carded = applyOp(bare, { op: "introCard", title: "Demo", seconds: 3 });
        expect(() =>
            applyOp(
                carded,
                { op: "voiceover", card: "intro", at: 3.2, file: voice },
                { voiceoverDurationUs: 1_000_000 }
            )
        ).toThrow("past the intro card's 3 s");
        const voiced = applyOp(
            carded,
            { op: "voiceover", card: "intro", at: 0.4, file: voice, label: "Hello" },
            { voiceoverDurationUs: 1_000_000 }
        );
        expect(voiced.audio.voiceovers?.map((clip) => [clip.card, clip.atUs, clip.durationUs])).toEqual([
            ["intro", 400_000, 1_000_000],
        ]);
        // A card that goes away leaves its voiceover with nothing to play over: check() says so.
        const gone = applyOp(voiced, { op: "introCard", enabled: false });
        expect(checkProject(gone, facts).map((issue) => issue.kind)).toContain("voiceover-card-missing");
    });

    // Regression test: hunt r2-card-voiceovers. A card line whose card went away refused every change (even its
    // volume), and check() never said a line past a shortened card plays nowhere.
    test("a card voiceover whose card is gone or shorter stays editable and check() names it", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const folder = mkdtempSync(join(tmpdir(), "card-voice-"));
        const voice = join(folder, "voice.mp3");
        writeFileSync(voice, "");

        const carded = applyOp(wholeProject(source), { op: "introCard", title: "Demo", seconds: 3 });
        const voiced = applyOp(
            carded,
            { op: "voiceover", card: "intro", at: 0.4, file: voice },
            { voiceoverDurationUs: 1_000_000 }
        );
        const id = voiced.audio.voiceovers?.[0]?.id ?? "";
        const gone = applyOp(voiced, { op: "introCard", enabled: false });
        const quieter = applyOp(gone, { op: "voiceover", id, volume: 0.5 });
        expect(quieter.audio.voiceovers?.[0]?.volume).toBe(0.5);
        expect(() => applyOp(gone, { op: "voiceover", id, at: 0.2 })).toThrow("no intro card");

        // An end card shortened under its clip's start: the clip plays nowhere.
        const ended = applyOp(wholeProject(source), { op: "endCard", text: "Bye", seconds: 4 });
        const endVoiced = applyOp(
            ended,
            { op: "voiceover", card: "end", at: 3, file: voice },
            { voiceoverDurationUs: 1_000_000 }
        );
        const shorter = applyOp(endVoiced, { op: "endCard", seconds: 2 });
        const past = checkProject(shorter, facts).find((issue) => issue.kind === "voiceover-past-card");
        expect(past?.severity).toBe("fix");
        expect(past?.message).toContain("does not play");
    });

    test("check names a voiceover that runs past the movie's end, where the export cuts it off", () => {
        // The renderer mixes a voice clip into the movie only: an end card does not carry it, so the words after the
        // movie's last frame are lost. A clip that ends inside the movie is no issue.
        const whole = wholeProject(source);
        const voiced = applyOp(
            {
                ...whole,
                audio: {
                    ...whole.audio,
                    voiceovers: [
                        { id: "v1", atUs: 1_000_000, file: "/voice/one.mp3", durationUs: 1_500_000, volume: 1 },
                        { id: "v2", atUs: 8_000_000, file: "/voice/two.mp3", durationUs: 3_000_000, volume: 1 },
                    ],
                },
            },
            { op: "cut", from: 3, to: 5 }
        );
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const late = checkProject(voiced, facts).filter((issue) => issue.kind === "voiceover-cut-at-end");
        expect(late).toHaveLength(1);
        expect(late[0]).toMatchObject({ severity: "fix", item: "voiceover v2", at: 8 });
        expect(late[0]?.message).toContain("1 s");
    });

    describe("check() ducks the music by the renderer's rule", () => {
        const voice = { id: "v1", atUs: 1_000_000, file: "/voice/one.mp3", durationUs: 1_500_000, volume: 1 };

        function withMusic(
            duck: number,
            ducking?: Partial<NonNullable<projectOps.EditProject["audio"]["ducking"]>>,
            voiced = false,
            video = source.video
        ): projectOps.EditProject {
            const project = wholeProject({ ...source, video });
            return {
                ...project,
                audio: {
                    ...project.audio,
                    music: { file: "/m.m4a", volume: 0.25, duck, fadeMs: 1500 },
                    ...(ducking
                        ? { ducking: { db: 12, fadeMs: 300, transcript: true, voiceovers: true, ...ducking } }
                        : {}),
                    ...(voiced ? { voiceovers: [voice] } : {}),
                },
            };
        }

        const facts = (hasTranscript: boolean) => ({ hasTranscript, hasCursorTrack: true, musicFileExists: true });
        const musicIssues = (project: projectOps.EditProject, hasTranscript: boolean) =>
            checkProject(project, facts(hasTranscript)).filter((issue) => issue.item === "music");
        const asksForTranscript = (project: projectOps.EditProject) =>
            musicIssues(project, false).some((issue) => issue.kind === "no-transcript");
        const describedDucks = (project: projectOps.EditProject) => {
            const music = describeProject(project, "/x").audio.music;
            return music && "ducks" in music ? music.ducks : undefined;
        };

        test("check's no-transcript music warning follows the ducking object, as describe() and the renderer do", () => {
            // The older share alone: it ducks under the transcript, so check() asks for one (as before).
            expect(asksForTranscript(withMusic(0.6))).toBe(true);
            // The dB object decides the amount: 12 dB ducks although the older share is 0.
            expect(asksForTranscript(withMusic(0, {}))).toBe(true);
            // Off under the transcript: a transcript changes nothing.
            expect(asksForTranscript(withMusic(0.6, { transcript: false }))).toBe(false);
            // 0 dB never ducks, whatever the older share says.
            expect(asksForTranscript(withMusic(0.6, { db: 0 }))).toBe(false);
            // A voiceover ducks the music unless the ducking object turns that off.
            expect(asksForTranscript(withMusic(0.6, undefined, true))).toBe(false);
            expect(asksForTranscript(withMusic(0.6, { voiceovers: false }, true))).toBe(true);
        });

        test("with ducking under the transcript off and no voiceover, check() says nothing ducks without asking for a transcript", () => {
            const off = withMusic(0.6, { transcript: false });
            const without = musicIssues(off, false);
            expect(without).toEqual([
                expect.objectContaining({ severity: "check", kind: "music-ducks-nothing", item: "music" }),
            ]);
            expect(without[0]?.fix).toBeUndefined();
            expect(without[0]?.message ?? "").not.toContain("transcript()");

            // With a transcript, the switch back on is the call that makes the music duck.
            expect(musicIssues(off, true)).toEqual([
                expect.objectContaining({
                    kind: "music-ducks-nothing",
                    fix: "await movie.ducking({ transcript: true })",
                }),
            ]);
            // A voiceover gives it something to duck under; 0 dB asks for no duck at all.
            expect(musicIssues(withMusic(0.6, { transcript: false }, true), false)).toEqual([]);
            expect(musicIssues(withMusic(0.6, { db: 0, transcript: false }), true)).toEqual([]);
            // The older share with a transcript ducks under it: nothing to say.
            expect(musicIssues(withMusic(0.6), true)).toEqual([]);
        });

        test("describe()'s ducks uses the same rule as check()", () => {
            const video = join(workspace(), "screen.mp4");
            writeFileSync(transcriptCachePath(video), "[]");

            // With a cached transcript.
            expect(describedDucks(withMusic(0.6, undefined, false, video))).toBe(true);
            expect(describedDucks(withMusic(0, {}, false, video))).toBe(true);
            expect(describedDucks(withMusic(0.6, { transcript: false }, false, video))).toBe(false);
            expect(describedDucks(withMusic(0.6, { db: 0 }, false, video))).toBe(false);
            // Without one, only a voiceover ducks the music.
            expect(describedDucks(withMusic(0.6))).toBe(false);
            expect(describedDucks(withMusic(0.6, undefined, true))).toBe(true);
            expect(describedDucks(withMusic(0.6, { voiceovers: false }, true))).toBe(false);
            expect(describedDucks(withMusic(0, { transcript: false }, true))).toBe(true);
        });
    });

    test("check finds what never shows, what is missing and what flashes past, fixes first", () => {
        let project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 2, scale: 2 });
        project = applyOp(project, { op: "text", from: 3, to: 5, text: "Step one" });
        project = applyOp(project, { op: "text", from: 4, to: 6, text: "Step two" });
        project = applyOp(project, {
            op: "spotlight",
            from: 7,
            to: 7.2,
            rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
        });
        project = applyOp(project, { op: "cut", from: 0.5, to: 2.5 });
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const issues = checkProject(project, facts);
        const zoomId = project.zooms[0]?.id;
        expect(issues[0]).toMatchObject({ severity: "fix", fix: `movie.unzoom("${zoomId}")` });
        expect(issues[0]?.message).toContain("The zoom at 1 s (1 to 2 s) never shows");
        expect(issues[0]?.target).toEqual({ list: "zooms", id: zoomId });
        expect(issues[0]?.action).toEqual({ label: "Remove", ops: [{ op: "unzoom", id: zoomId ?? "" }] });
        expect(issues.map((issue) => issue.severity)).toEqual(["fix", "check", "check"]);
        expect(issues[1]?.message).toContain('"Step one" and "Step two"');
        const stepTwo = project.texts?.find((note) => note.text === "Step two");
        expect(issues[1]?.action).toEqual({
            label: "Move After",
            ops: [{ op: "retime", id: stepTwo?.id ?? "", at: 5 }],
        });
        // Two 0.3 s titles in one place: lengthening both makes them meet again, so fixOps runs the check again.
        let blinks = applyOp(wholeProject(source), { op: "text", from: 0.5, to: 0.8, text: "Welcome" });
        blinks = applyOp(blinks, { op: "text", from: 0.6, to: 0.9, text: "Step 1" });
        const all = fixOps(blinks, facts);
        const fixedEdit = all.ops.reduce((next, op) => applyOp(next, op), blinks);
        expect(checkProject(fixedEdit, facts).filter((issue) => issue.action)).toEqual([]);
        expect(all.fixed.length).toBeGreaterThan(2);
        const apart = (issues[1]?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), project);
        expect(checkProject(apart, facts).some((issue) => issue.message.includes("same time"))).toBe(false);
        expect(issues[2]?.message).toContain("too short to read");
        const unscored = {
            ...project,
            audio: { ...project.audio, music: { file: "/gone/song.m4a", volume: 0.25, duck: 0.6, fadeMs: 1500 } },
        };
        expect(checkProject(unscored, { ...facts, musicFileExists: false })[0]?.message).toBe(
            'The music file "song.m4a" is gone, so the export plays without music (it was /gone/song.m4a)'
        );
        const spotId = project.redactions?.[0]?.id;
        expect(issues[2]?.fix).toBe(`movie.retime({ id: "${spotId}", to: 8.5 })`);
        expect(applyOp(project, { op: "retime", id: spotId ?? "", to: 8.5 }).redactions?.[0]?.endUs).toBe(8_500_000);
        const captioned = {
            ...wholeProject(source),
            captions: { show: true, size: 0.038, position: "bottom" as const },
        };
        expect(checkProject(captioned, { ...facts, hasTranscript: false }).map((issue) => issue.item)).toEqual([
            "captions",
        ]);
        expect(checkProject(wholeProject(source), facts)).toEqual([]);
    });

    // Move After rounded the earlier text's end down to a tenth: 5.04 gave at: 5, the two still showed together and
    // fixOps stopped with the issue open.
    describe("Move After starts the later text at the earlier text's exact end", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const overlaps = (project: Parameters<typeof checkProject>[0]) =>
            checkProject(project, facts).filter((issue) => issue.kind === "text-overlap");

        test("an end 0.04 s past a tenth: Move After and its REPL line say 5.04, and the overlap is gone", () => {
            let project = applyOp(wholeProject(source), { op: "text", from: 1, to: 5.04, text: "First" });
            project = applyOp(project, { op: "text", from: 3, to: 6, text: "Second" });
            const second = project.texts?.find((note) => note.text === "Second");
            const [issue] = overlaps(project);
            expect(issue?.action).toEqual({
                label: "Move After",
                ops: [{ op: "retime", id: second?.id ?? "", at: 5.04 }],
            });
            expect(issue?.fix).toBe(`movie.retime({ id: "${second?.id}", at: 5.04 })`);
            const moved = (issue?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), project);
            expect(moved.texts?.find((note) => note.text === "Second")?.startUs).toBe(5_040_000);
            expect(overlaps(moved)).toEqual([]);
        });

        test("Lengthen then Move After in one fixOps run leaves check() with nothing to fix", () => {
            let project = applyOp(wholeProject(source), { op: "text", from: 1.234, to: 1.534, text: "Open the menu" });
            project = applyOp(project, { op: "text", from: 2, to: 5, text: "Pick Settings" });
            const fixed = fixOps(project, facts).ops.reduce((next, op) => applyOp(next, op), project);
            const pick = fixed.texts?.find((note) => note.text === "Pick Settings");
            const open = fixed.texts?.find((note) => note.text === "Open the menu");
            expect(pick?.startUs).toBeGreaterThanOrEqual(open?.endUs ?? Number.POSITIVE_INFINITY);
            expect(overlaps(fixed)).toEqual([]);
            expect(checkProject(fixed, facts).filter((issue) => issue.action)).toEqual([]);
        });
    });

    // R5 5 redaction edges: check() said clean for each of these, and the export showed the picture there.
    test("check names the holes around hidden parts: a short part, an early end before a cut, a gap between two", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 };
        let project = applyOp(wholeProject(source), { op: "cut", from: 9, to: 9.5 });
        project = applyOp(project, { op: "redact", from: 2, to: 3.9, rect, style: "black" });
        project = applyOp(project, { op: "redact", from: 4, to: 6, rect: { ...rect, x: 0.3 }, style: "black" });
        project = applyOp(project, { op: "redact", from: 6.5, to: 6.6, rect: { ...rect, x: 0.7, y: 0.7 } });
        project = applyOp(project, { op: "redact", from: 7, to: 8.4, rect: { ...rect, x: 0.7 }, style: "pixelate" });
        const [join, , flash, tail] = project.redactions ?? [];
        const issues = checkProject(project, facts).filter((issue) => issue.target?.list === "redactions");
        const about = (id: string | undefined) => issues.filter((issue) => issue.target?.id === id);
        expect(about(join?.id).map((issue) => issue.message)).toEqual([
            "The hidden part at 2 s ends 0.1 s before the hidden part at 4 s starts; the export covers the 0.1 s between by itself (redactionJoins snapMs 250)",
        ]);
        expect(about(join?.id)[0]?.action).toEqual({
            label: "Join",
            ops: [{ op: "retime", id: join?.id ?? "", to: 4 }],
        });
        expect(about(flash?.id)[0]?.message).toContain("covers only 100 ms of the export");
        expect(about(tail?.id)[0]?.message).toBe(
            "The hidden part at 7 s ends 0.6 s before the cut at 9 s; the 0.6 s between show the picture unhidden"
        );
        expect(about(tail?.id)[0]?.action?.ops).toEqual([{ op: "retime", id: tail?.id ?? "", to: 9 }]);
        // A spotlight is not a hiding part; a part that ends at the cut leaves nothing open.
        const covered = fixOps(project, facts).ops.reduce((next, op) => applyOp(next, op), project);
        expect(
            checkProject(covered, facts).filter((issue) => issue.target?.list === "redactions" && issue.action)
        ).toEqual([]);
        // snapMs 0: the same 0.1 s gap is no longer closed by the export, and the message says so.
        const exact = applyOp(project, { op: "redactionJoins", snapMs: 0 });
        expect(checkProject(exact, facts).find((issue) => issue.target?.id === join?.id)?.message).toContain(
            "the 0.1 s between show the picture unhidden"
        );
        expect(describeProject(exact, "/x/edit.json").redactionJoins).toEqual({ snapMs: 0 });
        // A pixelate cell and a hard spotlight are kept by the ops and read back.
        let looks = applyOp(wholeProject(source), { op: "redact", from: 1, to: 2, rect, style: "pixelate", cell: 32 });
        looks = applyOp(looks, { op: "spotlight", from: 2, to: 3, rect, fadeMs: 0 });
        expect(looks.redactions?.map((part) => [part.cell, part.fadeMs])).toEqual([
            [32, undefined],
            [undefined, 0],
        ]);
        const pixelId = looks.redactions?.[0]?.id ?? "";
        // A cell under the default (19 px at 1080p) may leave text readable; check() says so.
        const small = applyOp(looks, { op: "setRedaction", id: pixelId, cell: 6 });
        expect(
            checkProject(small, facts).find((issue) => issue.target?.id === pixelId && issue.message.includes("6 px"))
        ).toBeDefined();
        looks = applyOp(looks, { op: "setRedaction", id: pixelId, cell: 0 });
        expect(looks.redactions?.[0]?.cell).toBeUndefined();
    });

    // R6 9: check() gave 19 to 58 lines, mostly one "starts 0.3 s after a cut" per tracked part, and "same time, same
    // place" for texts side by side.
    test("check groups repeated issues per kind with a count and a severity, and texts overlap by their plates", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        let project = applyOp(wholeProject(source), { op: "cut", from: 2, to: 2.5 });

        for (const x of [0.1, 0.3, 0.5, 0.7]) {
            project = applyOp(project, {
                op: "redact",
                from: 2.8,
                to: 3.8,
                rect: { x, y: 0.4, width: 0.1, height: 0.05 },
                style: "black",
            });
        }

        // One part 0.1 s after the cut: the export closes that by itself, a note.
        project = applyOp(project, {
            op: "redact",
            from: 2.6,
            to: 3.8,
            rect: { x: 0.1, y: 0.8, width: 0.1, height: 0.05 },
            style: "black",
        });
        const issues = checkProject(project, facts);
        const groups = groupIssues(issues);
        expect(groups.map((group) => [group.kind, group.severity, group.count])).toEqual([
            ["hiding-starts-after-cut", "check", 4],
            ["hiding-starts-after-cut", "note", 1],
        ]);
        expect(groups[0]?.at).toEqual([2.5, 2.5, 2.5, 2.5]);
        expect(groups[0]?.fixable).toBe(4);
        const { counts, lines } = issueSummary(issues);
        expect(counts).toEqual({ fix: 0, check: 4, note: 1 });
        expect(lines[0]).toStartWith("check ×4 hiding-starts-after-cut: The hidden part at 2.8 s starts 0.3 s after");
        expect(lines[0]).toEndWith("(and 3 more like it)");
        expect(lines).toHaveLength(2);

        // Side by side on one line: the old rule (anchors 0.25 apart) called them "same place"; the plates do not meet.
        let side = applyOp(wholeProject(source), { op: "text", from: 1, to: 4, text: "Hi", x: 0.35, y: 0.5 });
        side = applyOp(side, { op: "text", from: 1, to: 4, text: "Ok", x: 0.6, y: 0.5 });
        expect(checkProject(side, facts).filter((issue) => issue.kind === "text-overlap")).toEqual([]);
        // Long lines at the same anchors do meet.
        let wide = applyOp(wholeProject(source), {
            op: "text",
            from: 1,
            to: 4,
            text: "Open the settings page",
            x: 0.35,
            y: 0.5,
        });
        wide = applyOp(wide, { op: "text", from: 1, to: 4, text: "Pick the account", x: 0.6, y: 0.5 });
        expect(checkProject(wide, facts).filter((issue) => issue.kind === "text-overlap")).toHaveLength(1);
        // The canvas's shape counts: 0.3 apart across a 9:16 canvas is less room than across 16:9.
        const box = textBox({ text: "Hello", size: 0.05, x: 0.5, y: 0.5 }, canvasShape(wholeProject(source)));
        // The renderer's plate for "Hello" at 54 px is 200 px wide on a 1080 px short side.
        expect(Math.abs((box.right - box.left) * 1080 - 200)).toBeLessThanOrEqual(1);
        expect(canvasShape(applyOp(wholeProject(source), { op: "frame", aspect: "9:16" }))).toEqual({
            width: 1,
            height: 16 / 9,
        });
    });

    // 2026-11-08: a title and a subtitle at one x in one left-aligned block were each centred on x, so their left
    // edges did not line up. x is the block's centre; the alignment puts a plate against the block's edge.
    test("textBox puts a left- or right-aligned plate against its block's edge and centres a centred one on x", () => {
        const canvas = { width: 16 / 9, height: 1 };
        const title = { text: "Invoices", size: 0.06, x: 0.62, y: 0.3 };
        const subtitle = { text: "Send, track and get paid", size: 0.035, x: 0.62, y: 0.42 };
        const left = [
            textBox({ ...title, block: { width: 0.4, align: "left" } }, canvas),
            textBox({ ...subtitle, block: { width: 0.4, align: "left" } }, canvas),
        ];
        expect(left[0]?.right).not.toBeCloseTo(left[1]?.right ?? 0, 2);
        for (const box of left) {
            expect(box.left).toBeCloseTo((0.62 - 0.2) * canvas.width, 5);
        }

        for (const box of [
            textBox({ ...title, block: { width: 0.4, align: "right" } }, canvas),
            textBox({ ...subtitle, block: { width: 0.4, align: "right" } }, canvas),
        ]) {
            expect(box.right).toBeCloseTo((0.62 + 0.2) * canvas.width, 5);
        }

        for (const box of [
            textBox({ ...title, block: { width: 0.4, align: "center" } }, canvas),
            textBox(subtitle, canvas),
        ]) {
            expect((box.left + box.right) / 2).toBeCloseTo(0.62 * canvas.width, 5);
        }

        // A block that reaches past the canvas's edge keeps its plate inside the canvas.
        expect(textBox({ ...title, x: 0.1, block: { width: 0.4, align: "left" } }, canvas).left).toBe(0);
        const nearRight = textBox({ ...title, x: 0.95, block: { width: 0.4, align: "right" } }, canvas);
        expect(nearRight.right).toBeCloseTo(canvas.width, 5);
    });

    // 2026-11-09: a plain title (0.06) and a plain subtitle (0.035) in one left-aligned block had their letters 20 px
    // apart at 1080p, because the plate, which a plain text does not draw, stood at the block's edge and its inset
    // (0.7 x size) grows with the size. A plate text lines up its plate; a plain text lines up its letters.
    test("textBoxes puts a plain text's letters against its block's edge and keeps a plate text's plate there", () => {
        const canvas = { width: 16 / 9, height: 1 };
        const title = { text: "Invoices", size: 0.06, x: 0.62, y: 0.3, style: "plain" as const };
        const subtitle = {
            text: "Send, track and get paid on time",
            size: 0.035,
            x: 0.62,
            y: 0.42,
            style: "plain" as const,
        };
        const blockLeft = (0.62 - 0.2) * canvas.width;
        const blockRight = (0.62 + 0.2) * canvas.width;
        const left = { width: 0.4, align: "left" as const };
        const right = { width: 0.4, align: "right" as const };

        for (const note of [title, subtitle]) {
            const atLeft = textBoxes({ ...note, block: left }, canvas);
            expect(atLeft.letters?.left).toBeCloseTo(blockLeft, 5);
            // The plate, which nobody sees, reaches past the block's edge by its inset.
            expect(atLeft.plate.left).toBeCloseTo(blockLeft - (Math.round(note.size * 1080) * 0.7) / 1080, 5);
            expect(textBoxes({ ...note, block: right }, canvas).letters?.right).toBeCloseTo(blockRight, 5);
            const centred = textBoxes({ ...note, block: { width: 0.4, align: "center" } }, canvas);
            expect(((centred.letters?.left ?? 0) + (centred.letters?.right ?? 0)) / 2).toBeCloseTo(
                0.62 * canvas.width,
                2
            );
        }

        // Two plain texts of different sizes share the letters' edge.
        expect(textBoxes({ ...title, block: left }, canvas).letters?.left).toBeCloseTo(
            textBoxes({ ...subtitle, block: left }, canvas).letters?.left ?? 0,
            5
        );
        expect(textBoxes({ ...title, block: right }, canvas).letters?.right).toBeCloseTo(
            textBoxes({ ...subtitle, block: right }, canvas).letters?.right ?? 0,
            5
        );

        // A plate text keeps its plate against the block's edge, its letters an inset inside it.
        for (const note of [title, subtitle]) {
            const plate = { ...note, style: "plate" as const };
            expect(textBox({ ...plate, block: left }, canvas).left).toBeCloseTo(blockLeft, 5);
            expect(textBox({ ...plate, block: right }, canvas).right).toBeCloseTo(blockRight, 5);
        }

        // Near the canvas's edge a plain text keeps its letters inside the canvas, not its invisible inset: the letters
        // touch the edge and the plate reaches past it.
        const nearLeft = textBoxes({ ...title, x: 0.1, block: left }, canvas);
        expect(nearLeft.letters?.left).toBeCloseTo(0, 5);
        expect(nearLeft.plate.left).toBeLessThan(0);
        const nearRight = textBoxes({ ...title, x: 0.95, block: right }, canvas);
        expect(nearRight.letters?.right).toBeCloseTo(canvas.width, 5);
        expect(nearRight.plate.right).toBeGreaterThan(canvas.width);
    });

    // layoutText takes named options, so its two pixel numbers cannot swap unnoticed; align defaults to center.
    test("layoutText reads text, px, wrapPx and align by name and centres by default", () => {
        const text = "Send, track and get paid on time";
        const centred = layoutText({ text, px: 40, wrapPx: 400 });
        expect(centred).toEqual(layoutText({ text, px: 40, wrapPx: 400, align: "center" }));
        // Wrapped at 400 px the text takes more lines than at 4000 px.
        expect(centred.height).toBeGreaterThan(layoutText({ text, px: 40, wrapPx: 4000 }).height);
    });

    // 2026-11-08: check() said a title and its subtitle overlap while the export showed them apart. At 0.58 em a
    // character the 26-letter title was wider than its block, so the estimate wrapped it into two lines that reached
    // the subtitle; the renderer draws it on one line. The pixel sizes below are the renderer's (TextPlates at 1080p).
    test("check measures a text with the renderer's font, and judges a plain text by its lines, not its plate", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const overlaps = (project: ReturnType<typeof wholeProject>) =>
            checkProject(project, facts).filter((issue) => issue.kind === "text-overlap");
        const block = { width: 0.4, align: "center" as const };
        // A title and its subtitle in one block, as the demo projects place them.
        const note = (text: string, size: number, y: number, style: "plain" | "plate" = "plain") => ({
            op: "text" as const,
            from: 1,
            to: 6,
            text,
            x: 0.735,
            y,
            size,
            style,
            block,
        });
        const title = note("Zákazník napíše do poradny", 0.05, 0.43);
        const subtitle = note("Recepce zrovna telefonuje, zprávu nečte.", 0.029, 0.535);
        const pair = (a: typeof title, b: typeof title) => applyOp(applyOp(wholeProject(source), a), b);
        const pixels = (box: { left: number; top: number; right: number; bottom: number }) => ({
            width: (box.right - box.left) * 1080,
            height: Math.round((box.bottom - box.top) * 1080),
        });

        expect(overlaps(pair(title, subtitle))).toEqual([]);
        const canvas = canvasShape(wholeProject(source));
        const titlePlate = pixels(textBox(title, canvas));
        expect(Math.abs(titlePlate.width - 749)).toBeLessThanOrEqual(1);
        expect(titlePlate.height).toBe(105);
        // The same pair at one y does meet.
        expect(overlaps(pair(title, { ...subtitle, y: 0.43 }))).toHaveLength(1);

        // A long text wraps where the renderer wraps it: four lines of 43 px, 237 px tall with the plate's insets.
        const long = pixels(
            textBox(
                {
                    text: "Každý krok nastavení se v ukázce objeví jako krátký titulek, jeden po druhém, v pořadí, v jakém je projde nový uživatel.",
                    size: 0.04,
                    x: 0.5,
                    y: 0.5,
                    block,
                },
                canvas
            )
        );
        expect(long.height).toBe(237);
        expect(Math.abs(long.width - 728)).toBeLessThanOrEqual(1);

        // Here the plates meet and the lines do not: a drawn plate shows, a plain text's inset is empty space.
        const close = { ...subtitle, y: 0.49 };
        expect(overlaps(pair(title, close))).toEqual([]);
        expect(overlaps(pair({ ...title, style: "plate" }, { ...close, style: "plate" }))).toHaveLength(1);
    });

    // The plates the renderer draws, which RecorderTextMetricsTests records into text-metrics.cases.json and holds the
    // app to, so one set of numbers pins both sides. 2026-11-09: a blank line in a centred or right-aligned text starts
    // at the left edge of TextKit's box and widens the plate, and check() kept it as narrow as the letters.
    test("textBox estimates every plate the renderer drew for text-metrics.cases.json within 2 px", () => {
        // check() lays texts out at a 1080 px short side, the canvas the cases were drawn on.
        expect(textCases.canvas.height).toBe(1080);
        const canvas = { width: textCases.canvas.width / textCases.canvas.height, height: 1 };
        const misses: string[] = [];

        for (const { text, size, block, plate } of textCases.cases) {
            const align = TEXT_ALIGNS.find((value) => value === block?.align);
            const box = textBox({ text, size, x: 0.5, y: 0.5, block: block && { width: block.width, align } }, canvas);
            const width = Math.round((box.right - box.left) * 1080);
            const height = Math.round((box.bottom - box.top) * 1080);

            if (Math.abs(width - plate.width) > 2 || Math.abs(height - plate.height) > 2) {
                misses.push(
                    `${SafeJSON.stringify(text)}: ${width} x ${height}, drawn ${plate.width} x ${plate.height}`
                );
            }
        }

        expect(misses).toEqual([]);
        expect(textCases.cases.length).toBeGreaterThan(10);
    });

    // A blank line widens a plate past its letters (683 px of plate round 521 px of letters below), and a leading one
    // adds a line with no letters. A plate text shows that plate; a plain text shows only its letters.
    test("check judges a plate text with a blank line by its wide plate and a plain one by its letters", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        type Place = { x: number; y: number; size: number; width: number; align: "left" | "center" | "right" };
        const text = (body: string, { x, y, size, width, align }: Place) => ({
            body,
            x,
            y,
            size,
            block: { width, align },
        });
        const overlaps = (style: "plain" | "plate", notes: Array<ReturnType<typeof text>>) => {
            const project = notes.reduce(
                (next, { body, ...at }) => applyOp(next, { op: "text", from: 1, to: 6, text: body, style, ...at }),
                wholeProject(source)
            );
            // applyOp trims a text; an edit.json the editor or a hand wrote keeps a leading "\n".
            const texts = project.texts?.map((note) => ({
                ...note,
                text: notes.find(({ body }) => body.trim() === note.text)?.body ?? note.text,
            }));
            return checkProject({ ...project, texts }, facts).filter((issue) => issue.kind === "text-overlap");
        };

        // Beside it: the label's plate starts inside the title's plate and its letters right of the title's letters.
        const title = text("Nový účet\n\nPřihlášení trvá minutu", {
            x: 0.5,
            y: 0.5,
            size: 0.05,
            width: 0.4,
            align: "center",
        });
        const label = text("Hotovo", { x: 0.73125, y: 0.5, size: 0.03, width: 0.15, align: "left" });
        expect(overlaps("plate", [title, label])).toHaveLength(1);
        expect(overlaps("plain", [title, label])).toEqual([]);

        // Above it: the note's letters end above the confirmation's letters, in the band of its empty first line.
        const confirmation = text("\nPotvrzení přijde e-mailem", {
            x: 0.5,
            y: 0.5,
            size: 0.03,
            width: 0.3,
            align: "right",
        });
        const note = text("Objednávka", { x: 0.5, y: 0.46, size: 0.03, width: 0.3, align: "right" });
        expect(overlaps("plate", [confirmation, note])).toHaveLength(1);
        expect(overlaps("plain", [confirmation, note])).toEqual([]);
    });

    // R7 10: a 1.2x zoom on a phone cut the side labels in half, and check() said nothing.
    test("check names a zoom whose view cuts screen text at its edge, with a smaller zoom that keeps it whole", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const zoomed = applyOp(wholeProject(source), { op: "zoom", from: 2, to: 4, scale: 1.2 });
        const zoomId = zoomed.zooms[0]?.id ?? "";
        const screenText = [
            {
                atUs: 1_500_000,
                untilUs: 3_000_000,
                lines: [
                    { text: "Invoices", x: 0.05, y: 0.5, width: 0.25, height: 0.03 },
                    { text: "Total 120", x: 0.4, y: 0.6, width: 0.2, height: 0.03 },
                ],
            },
            { atUs: 6_000_000, untilUs: 7_000_000, lines: [{ text: "Later", x: 0, y: 0, width: 0.2, height: 0.03 }] },
        ];
        const issues = checkProject(zoomed, { ...facts, screenText }).filter(
            (issue) => issue.kind === "zoom-cuts-text"
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toContain('cuts 1 line of screen text at its edge ("Invoices")');
        expect(issues[0]?.action?.ops).toEqual([
            { op: "setZoom", id: zoomId, scale: 1.12, focus: { x: 0.483, y: 0.5 } },
        ]);
        const fitted = (issues[0]?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), zoomed);
        expect(
            checkProject(fitted, { ...facts, screenText }).filter((issue) => issue.kind === "zoom-cuts-text")
        ).toEqual([]);
        // Nothing read, nothing said; a follow zoom moves with the cursor and is not judged.
        expect(checkProject(zoomed, facts).some((issue) => issue.kind === "zoom-cuts-text")).toBe(false);
        const follow = applyOp(wholeProject(source), { op: "zoom", from: 2, to: 4, scale: 1.2, follow: true });
        expect(checkProject(follow, { ...facts, screenText }).some((issue) => issue.kind === "zoom-cuts-text")).toBe(
            false
        );
        expect(zoomView({ scale: 2, focusX: 0.9, focusY: 0.1 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
    });

    // A 1.2x zoom passed check() inside a phone layout grown 1.5x or a 9:16 cover, yet the frame cut what it showed
    // again, and the Fit Text it offered still cut the lines.
    describe("a zoom judged inside the frame's cover or grown-layout crop", () => {
        type Project = Parameters<typeof checkProject>[0];
        type ScreenText = NonNullable<Parameters<typeof checkProject>[1]["screenText"]>;
        const phone = { video: "/movies/phone.mp4", durationUs: 10_000_000, width: 590, height: 1278 };
        const zoomCuts = (project: Project, screenText: ScreenText) =>
            checkProject(project, {
                hasTranscript: true,
                hasCursorTrack: false,
                musicFileExists: true,
                screenText,
            }).filter((issue) => issue.kind === "zoom-cuts-text");
        const fittedBy = (project: Project, issue: ReturnType<typeof checkProject>[number] | undefined) =>
            (issue?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), project);
        const rounded = (rect: { x: number; y: number; width: number; height: number }) =>
            [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 10_000) / 10_000);

        test("frameCrop is what framePlacement keeps in view (the same cases as RecorderHuntZoomEdgeFrameCropTests)", () => {
            // A phone grown 1.5x in a 16:9 frame, its bottom kept: the whole width, the lower two thirds.
            const grown = frameCrop(
                applyOp(wholeProject(phone), {
                    op: "frame",
                    aspect: "16:9",
                    padding: 0.04,
                    layout: { align: "left", scale: 1.5, focus: { x: 0.5, y: 1 } },
                })
            );
            expect(rounded(grown)).toEqual([0, 0.3333, 1, 0.6667]);
            expect(grown.by).toEqual(["layout"]);
            // A wide movie covering a 9:16 canvas: its middle 0.316, or its right edge for a focus far right.
            const cover = applyOp(wholeProject(source), { op: "frame", aspect: "9:16", fit: "cover", padding: 0 });
            expect(rounded(frameCrop(cover))).toEqual([0.3418, 0, 0.3164, 1]);
            expect(rounded(frameCrop(cover, { x: 0.9, y: 0.2 }))).toEqual([0.6836, 0, 0.3164, 1]);
            expect(frameCrop(cover).by).toEqual(["cover"]);
            // Both: a cover grown 1.5x is cropped inside the cover, around the layout's focus.
            const both = frameCrop(
                applyOp(wholeProject(source), {
                    op: "frame",
                    aspect: "9:16",
                    fit: "cover",
                    padding: 0.05,
                    layout: { scale: 1.5, focus: { x: 0.45, y: 0.4 } },
                })
            );
            expect(rounded(both)).toEqual([0.3843, 0.0667, 0.2012, 0.6667]);
            expect(both.by).toEqual(["cover", "layout"]);
            // No frame, or a phone frame at its fitted size: the whole picture.
            expect(rounded(frameCrop(wholeProject(source)))).toEqual([0, 0, 1, 1]);
            expect(rounded(frameCrop(applyOp(wholeProject(phone), { op: "frame", preset: "phone-left" })))).toEqual([
                0, 0, 1, 1,
            ]);
        });

        test("check judges a zoom by what the frame's grown layout leaves in view, and its Fit Text keeps the lines whole there", () => {
            const framed = applyOp(wholeProject(source), {
                op: "frame",
                aspect: "16:9",
                layout: { align: "left", scale: 1.5, focus: { x: 0.5, y: 1 } },
            });
            const zoomed = applyOp(framed, { op: "zoom", from: 1, to: 5, scale: 1.2, focus: { x: 0.5, y: 0.5 } });
            const screenText = [
                {
                    atUs: 0,
                    untilUs: 6_000_000,
                    lines: [
                        { text: "Status 9:41", x: 0.4, y: 0.35, width: 0.2, height: 0.03 },
                        { text: "Invoices", x: 0.16, y: 0.9, width: 0.2, height: 0.03 },
                    ],
                },
            ];
            const issues = zoomCuts(zoomed, screenText);
            expect(issues).toHaveLength(1);
            expect(issues[0]?.message).toContain(
                'cuts 2 lines of screen text at the edge of what the frame\'s layout crop leaves in view ("Status 9:41", "Invoices"); 1.07x'
            );
            expect(issues[0]?.action?.ops).toEqual([
                { op: "setZoom", id: zoomed.zooms[0]?.id ?? "", scale: 1.07, focus: { x: 0.477, y: 0.484 } },
            ]);
            expect(zoomCuts(fittedBy(zoomed, issues[0]), screenText)).toEqual([]);
            // The frame alone keeps both lines whole: no zoom, no issue.
            expect(zoomCuts(framed, screenText)).toEqual([]);
        });

        test("a phone-left frame grown 1.4x and a 1.3x zoom cut a line near the phone's top that the zoom view alone keeps", () => {
            const framed = applyOp(wholeProject(phone), { op: "frame", preset: "phone-left", layout: { scale: 1.4 } });
            const zoomed = applyOp(framed, { op: "zoom", from: 1, to: 5, scale: 1.3, focus: { x: 0.5, y: 0.5 } });
            const screenText = [
                {
                    atUs: 0,
                    untilUs: 6_000_000,
                    lines: [
                        { text: "9:41 Inbox", x: 0.3, y: 0.2, width: 0.4, height: 0.04 },
                        { text: "Compose", x: 0.35, y: 0.5, width: 0.3, height: 0.04 },
                    ],
                },
            ];
            const zoom = zoomed.zooms[0];
            expect(zoomView(zoom ?? { scale: 1, focusX: 0.5, focusY: 0.5 }).y).toBeLessThan(0.2);
            const issues = zoomCuts(zoomed, screenText);
            expect(issues).toHaveLength(1);
            expect(issues[0]?.message).toContain('("9:41 Inbox")');
            expect(issues[0]?.action?.ops[0]).toMatchObject({ op: "setZoom", id: zoom?.id });
            expect(zoomCuts(fittedBy(zoomed, issues[0]), screenText)).toEqual([]);
        });

        test("under a cover frame a line the cover alone cuts is not the zoom's, and no Fit Text is offered when none keeps the lines whole", () => {
            const cover = applyOp(wholeProject(source), { op: "frame", aspect: "9:16", fit: "cover", padding: 0 });
            const zoomed = applyOp(cover, { op: "zoom", from: 2, to: 4, scale: 1.2 });
            const line = (text: string, x: number, width: number) => [
                { atUs: 0, untilUs: 6_000_000, lines: [{ text, x, y: 0.5, width, height: 0.03 }] },
            ];
            // Whole in the cover alone (x 0.342 to 0.658), cut in the zoom's part of it (x 0.368 to 0.632).
            const issues = zoomCuts(zoomed, [
                ...line("Left label", 0.36, 0.08),
                { atUs: 0, untilUs: 6_000_000, lines: [{ text: "Total", x: 0.45, y: 0.6, width: 0.1, height: 0.03 }] },
            ]);
            expect(issues).toHaveLength(1);
            expect(issues[0]?.message).toContain('the frame\'s cover crop leaves in view ("Left label"); 1.08x');
            expect(zoomCuts(fittedBy(zoomed, issues[0]), line("Left label", 0.36, 0.08))).toEqual([]);
            // The cover alone already cuts a line across its edge at 0.342: that is the frame's, not the zoom's.
            expect(zoomCuts(zoomed, line("Edge", 0.3, 0.1))).toEqual([]);
            // Too wide for any zoom of 1.05x or more inside the cover: the issue stays, with no setZoom.
            const stuck = zoomCuts(zoomed, line("Left label", 0.35, 0.1));
            expect(stuck).toHaveLength(1);
            expect(stuck[0]?.action).toBeUndefined();
            expect(stuck[0]?.message).toContain(
                "no zoom of 1.05x or more keeps them whole inside the frame's cover crop"
            );
            // With a cursor track the export moves the cover with it; the message says where check() put it.
            expect(
                checkProject(zoomed, {
                    hasTranscript: true,
                    hasCursorTrack: true,
                    musicFileExists: true,
                    screenText: line("Left label", 0.36, 0.08),
                }).find((issue) => issue.kind === "zoom-cuts-text")?.message
            ).toContain("with the cursor at the zoom's focus");
        });
    });

    // Regression test: hunt r2-phone-preset-fit. A phone preset over a cover frame kept cover, so the phone was cropped
    // to the canvas instead of shown whole against one side.
    test("a phone preset over a cover frame shows the whole phone, and the op's own fit still wins", () => {
        const cover = applyOp(wholeProject(source), { op: "frame", aspect: "16:9", fit: "cover" });
        const phone = applyOp(cover, { op: "frame", preset: "phone-left" });
        expect(phone.frame?.fit).toBeUndefined();
        expect(phone.frame?.layout?.align).toBe("left");
        const kept = applyOp(cover, { op: "frame", preset: "phone-left", fit: "cover" });
        expect(kept.frame?.fit).toBe("cover");
    });

    // R5 4: a phone in 16:9 filled a quarter of the width, with no way to move it aside or zoom the whole canvas.
    test("a frame preset places a phone against one side, its own fields win, and a canvas zoom may overlap", () => {
        const phone = applyOp(wholeProject(source), { op: "frame", preset: "phone-left", layout: { scale: 1.1 } });
        expect(phone.frame).toMatchObject({ aspect: "16:9", padding: 0.04, layout: { align: "left", scale: 1.1 } });
        const portrait = applyOp(phone, { op: "frame", preset: "phone-portrait" });
        expect(portrait.frame?.aspect).toBe("9:16");
        expect(portrait.frame?.layout).toEqual({ align: "top", scale: 0.88 });
        const right = applyOp(phone, { op: "frame", layout: { align: "right" } });
        expect(right.frame?.layout).toEqual({ align: "right", scale: 1.1 });
        // R7 9: a grown phone keeps the part the focus names in view; a centred unscaled picture with a focus keeps it.
        const bottom = applyOp(phone, { op: "frame", layout: { scale: 1.5, focus: { x: 0.5, y: 1 } } });
        expect(bottom.frame?.layout).toEqual({ align: "left", scale: 1.5, focus: { x: 0.5, y: 1 } });
        const centred = applyOp(wholeProject(source), { op: "frame", layout: { focus: { x: 0.5, y: 0.2 } } });
        expect(centred.frame?.layout?.focus).toEqual({ x: 0.5, y: 0.2 });
        expect(() => applyOp(phone, { op: "frame", layout: { focus: { x: 2, y: 0 } } })).toThrow();
        let zoomed = applyOp(phone, { op: "zoom", from: 1, to: 3, scale: 2 });
        zoomed = applyOp(zoomed, {
            op: "zoom",
            from: 1,
            to: 3,
            scale: 2.5,
            focus: { x: 0.2, y: 0.5 },
            target: "canvas",
        });
        expect(zoomed.zooms.map((zoom) => [zoom.startUs, zoom.target])).toEqual([
            [1_000_000, undefined],
            [1_000_000, "canvas"],
        ]);
        expect(describeProject(zoomed, "/x/edit.json").zooms[1]).toMatchObject({ scale: 2.5, target: "canvas" });
        // A second canvas zoom over the first moves past it, as a picture zoom moves past a picture zoom.
        const second = applyOp(zoomed, { op: "zoom", from: 1.5, to: 2.5, target: "canvas" }).zooms.at(-1);
        expect([second?.startUs, second?.target]).toEqual([3_000_000, "canvas"]);
    });

    // A canvas zoom with follow was saved as mode follow, and the renderer held its focus (ZoomCurve.canvasView).
    describe("canvas zooms hold their focus", () => {
        test("a canvas zoom refuses follow, and setZoom will not make it follow", () => {
            const base = wholeProject(source);
            expect(() =>
                applyOp(base, { op: "zoom", from: 2, to: 6, scale: 2, target: "canvas", follow: true })
            ).toThrow(/canvas zoom holds its focus/);
            const canvas = applyOp(base, {
                op: "zoom",
                from: 2,
                to: 6,
                scale: 2,
                target: "canvas",
                focus: { x: 0.2, y: 0.5 },
            });
            const id = canvas.zooms[0].id;
            expect(canvas.zooms[0]).toMatchObject({ mode: "manual", target: "canvas" });
            expect(() => applyOp(canvas, { op: "setZoom", id, mode: "follow" })).toThrow(/canvas zoom holds its focus/);
            expect(applyOp(canvas, { op: "setZoom", id, scale: 3 }).zooms[0]).toMatchObject({
                mode: "manual",
                scale: 3,
            });
            // An edit saved before the rule loads and stays editable: a change to it stores the manual mode it renders with.
            const saved = { ...canvas, zooms: canvas.zooms.map((zoom) => ({ ...zoom, mode: "follow" as const })) };
            expect(applyOp(saved, { op: "setZoom", id, scale: 3 }).zooms[0]).toMatchObject({
                mode: "manual",
                scale: 3,
            });
            // A picture zoom still follows the cursor, by the zoom op and by setZoom.
            const picture = applyOp(base, { op: "zoom", from: 2, to: 6, follow: true });
            expect(picture.zooms[0].mode).toBe("follow");
            expect(picture.zooms[0].target).toBeUndefined();
            const manual = applyOp(base, { op: "zoom", from: 2, to: 6, focus: { x: 0.3, y: 0.3 } });
            expect(applyOp(manual, { op: "setZoom", id: manual.zooms[0].id, mode: "follow" }).zooms[0].mode).toBe(
                "follow"
            );
        });
    });

    // R5 10: a long callout was cut (setText cut it to 200 characters without a word) and "\n" was undocumented.
    test("a text keeps its line breaks, takes a callout of 500 characters and refuses a longer one aloud", () => {
        const callout = `Step one\n${"word ".repeat(60).trim()}`;
        let project = applyOp(wholeProject(source), {
            op: "text",
            from: 1,
            to: 4,
            text: callout,
            x: 0.7,
            block: { width: 0.4, align: "left" },
        });
        const note = project.texts?.[0];
        expect(note?.text).toBe(callout);
        expect(note?.block).toEqual({ width: 0.4, align: "left" });
        expect(describeProject(project, "/x/edit.json").texts[0]).toMatchObject({ lines: 2 });
        project = applyOp(project, { op: "setText", id: note?.id ?? "", block: { align: "center" } });
        expect(project.texts?.[0]?.block).toEqual({ width: 0.4, align: "center" });
        expect(() => applyOp(project, { op: "setText", id: note?.id ?? "", text: "x".repeat(501) })).toThrow(
            "at most 500 characters"
        );
        // Two two-line texts 0.1 apart overlap, which two one-liners would not.
        let stacked = applyOp(wholeProject(source), { op: "text", from: 1, to: 4, text: "One\nTwo", y: 0.3 });
        stacked = applyOp(stacked, { op: "text", from: 1, to: 4, text: "Three\nFour", y: 0.4 });
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        expect(
            checkProject(stacked, facts).some((issue) => issue.message.includes("same time in the same place"))
        ).toBe(true);
    });

    // Regression test: deep test 2026-11-06 RE5 — Lengthen on a circle that ends at the movie's end changed nothing.
    test("a too-short item at the movie's end is lengthened by starting earlier", () => {
        const project = applyOp(wholeProject(source), { op: "shape", kind: "circle", from: 9.83, to: 10 });
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const [issue] = checkProject(project, facts);
        const lengthened = (issue?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), project);
        expect([lengthened.shapes?.[0]?.startUs, lengthened.shapes?.[0]?.endUs]).toEqual([8_500_000, 10_000_000]);
    });

    // Regression test: unified review 2026-11-08 ED-too-short-ignores-speed.
    test("too short to read is measured in played time, and Lengthen reaches 1.5 s of played time", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        let fast = applyOp(wholeProject(source), { op: "speed", from: 4, to: 8, factor: 8 });
        fast = applyOp(fast, { op: "text", from: 4, to: 6, text: "Saved" });
        const [issue] = checkProject(fast, facts).filter((found) => found.kind === "too-short");
        expect(issue?.message).toContain("0.3 s");
        const lengthened = (issue?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), fast);
        expect([lengthened.texts?.[0]?.startUs, lengthened.texts?.[0]?.endUs]).toEqual([4_000_000, 9_000_000]);
        let slow = applyOp(wholeProject(source), { op: "speed", from: 2, to: 4, factor: 0.25 });
        slow = applyOp(slow, { op: "text", from: 2, to: 2.2, text: "Saved" });
        expect(checkProject(slow, facts).filter((found) => found.kind === "too-short")).toEqual([]);
    });

    // Regression test: review of PR 748, round 2. Lengthen walked the clips one after the other, while the check counts
    // every clip that plays the text: over two clips of the same second it offered 0.5 s, which then played 1 s.
    test("Lengthen reaches 1.5 s of played time over clips that repeat or reorder the source", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const lengthenedOver = (clips: Array<{ id: string; fromUs: number; toUs: number }>) => {
            const project = applyOp(editProjectSchema.parse({ ...wholeProject(source), clips }), {
                op: "text",
                from: 0,
                to: 0.1,
                text: "Saved",
            });
            const [issue] = checkProject(project, facts).filter((found) => found.kind === "too-short");
            const lengthened = (issue?.action?.ops ?? []).reduce((next, op) => applyOp(next, op), project);
            const tooShort = checkProject(lengthened, facts).filter((found) => found.kind === "too-short");
            return { span: [lengthened.texts?.[0]?.startUs, lengthened.texts?.[0]?.endUs], tooShort };
        };
        // The same second twice: 0 to 0.75 s plays 1.5 s.
        expect(
            lengthenedOver([
                { id: "c1", fromUs: 0, toUs: 1_000_000 },
                { id: "c2", fromUs: 0, toUs: 1_000_000 },
            ])
        ).toEqual({ span: [0, 750_000], tooShort: [] });
        // Source 2 to 3 s plays before 0 to 1 s: 0 to 2.5 s plays 1 s and 0.5 s.
        expect(
            lengthenedOver([
                { id: "c1", fromUs: 2_000_000, toUs: 3_000_000 },
                { id: "c2", fromUs: 0, toUs: 1_000_000 },
            ])
        ).toEqual({ span: [0, 2_500_000], tooShort: [] });
    });

    // Regression test: unified review 2026-11-08 ED-voiceover-false-in-cut.
    test("a voiceover at a cut's start plays, so check does not report it as in the cut", () => {
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const cut = applyOp(wholeProject(source), { op: "cut", from: 4, to: 5 });
        const voiced = (atUs: number) =>
            editProjectSchema.parse({
                ...cut,
                audio: { ...cut.audio, voiceovers: [{ id: "v1", atUs, file: "/movies/voice.m4a", durationUs: 1 }] },
            });
        const inCut = (project: projectOps.EditProject) =>
            checkProject(project, facts).filter((found) => found.kind === "voiceover-in-cut");
        expect(voiceoverExportSpans(voiced(4_000_000))).toHaveLength(1);
        expect(inCut(voiced(4_000_000))).toEqual([]);
        expect(inCut(voiced(4_500_000))).toHaveLength(1);
    });

    // Regression test: deep test 2026-11-06 RE5 — `tools recorder fix` printed "fixed" four times for an op that changed nothing.
    test("fix reports nothing fixed for an item that already spans the whole movie", () => {
        const short = { ...source, durationUs: 300_000 };
        const project = applyOp(wholeProject(short), { op: "text", from: 0, to: 0.3, text: "Hi" });
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        expect(fixOps(project, facts).fixed).toEqual([]);
    });

    describe("titleMarkers' seconds are played seconds", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 20_000_000, width: 1920, height: 1080 };
        const facts = { hasTranscript: true, hasCursorTrack: true, musicFileExists: true };
        const span = (op: projectOps.EditOp | undefined) => (op?.op === "text" ? [op.from, op.to] : []);
        const played = (project: ReturnType<typeof wholeProject>, op: projectOps.EditOp | undefined) => {
            const [from, to] = span(op);
            return projectOps.playedUs(project, Number(from) * 1_000_000, Number(to) * 1_000_000);
        };

        test("a title over a cut or a sped-up stretch plays its 2.5 s, and ends by the next marker's title", () => {
            const cut = applyOp(wholeProject(source), { op: "cut", from: 1.5, to: 2.5 });
            const [overCut] = projectOps.markerTitleOps(cut, [{ at: 1, label: "Open" }]);
            expect(overCut).toMatchObject({ op: "text", from: 1, to: 4.5, text: "1. Open" });
            expect(played(cut, overCut)).toBe(2_500_000);

            const fast = applyOp(wholeProject(source), { op: "speed", from: 2, to: 10, factor: 4 });
            const [overSpeed] = projectOps.markerTitleOps(fast, [{ at: 1, label: "Open" }]);
            expect(played(fast, overSpeed)).toBe(2_500_000);

            const close = projectOps.markerTitleOps(wholeProject(source), [
                { at: 1, label: "Open" },
                { at: 2, label: "Pick" },
            ]);
            expect(close.map(span)).toEqual([
                [1, 2],
                [2, 4.5],
            ]);
        });

        test("check leaves a lengthened title alone and offers Lengthen for a text a cut leaves at 1 s", () => {
            const cut = applyOp(wholeProject(source), { op: "cut", from: 1.5, to: 2.5 });
            const titled = projectOps
                .markerTitleOps(cut, [{ at: 1, label: "Open" }])
                .reduce((edit, op) => applyOp(edit, op), cut);
            expect(checkProject(titled, facts).filter((issue) => issue.kind === "cut-shortens-text")).toEqual([]);

            let short = applyOp(wholeProject(source), { op: "text", from: 1, to: 4, text: "Title" });
            short = applyOp(short, { op: "cut", from: 2, to: 6.5 });
            const id = short.texts?.[0]?.id ?? "";
            expect(checkProject(short, facts).filter((issue) => issue.kind === "cut-shortens-text")).toEqual([
                {
                    severity: "check",
                    kind: "cut-shortens-text",
                    item: `text ${id}`,
                    message: 'The text "Title" (1 to 4 s) loses 2 s of its 3 s to a cut and plays for 1 s',
                    at: 1,
                    target: { list: "texts", id },
                    fix: `movie.retime({ id: "${id}", to: 7 })`,
                    action: { label: "Lengthen", ops: [{ op: "retime", id, to: 7 }] },
                },
            ]);
        });
    });

    test("check names a marker a cut hides (with a move to the nearest kept moment) and a text a cut shortens", () => {
        let project = applyOp(wholeProject(source), { op: "text", from: 1, to: 4, text: "Title" });
        project = applyOp(project, { op: "marker", at: 6.2, label: "Step two" });
        project = applyOp(project, { op: "cut", from: 2, to: 6.5 });
        const marker = project.markers?.[0]?.id ?? "";
        const text = project.texts?.[0]?.id ?? "";
        const facts = {
            hasTranscript: true,
            hasCursorTrack: true,
            musicFileExists: true,
            recordedMarkers: [
                { atMs: 5000, label: "Recorded" },
                { atMs: 8000, label: "Kept" },
            ],
        };
        const move = [
            { op: "unmarker" as const, id: marker },
            { op: "marker" as const, at: 6.5, label: "Step two" },
        ];

        expect(checkProject(project, facts)).toEqual([
            {
                severity: "fix",
                kind: "marker-in-cut",
                item: `marker ${marker}`,
                message: 'The marker "Step two" at 6.2 s never plays: that time is cut, so it is no chapter',
                fix: `movie.apply([{"op":"unmarker","id":"${marker}"},{"op":"marker","at":6.5,"label":"Step two"}])`,
                at: 6.2,
                target: { list: "markers", id: marker },
                action: { label: "Move", ops: move },
            },
            {
                severity: "check",
                kind: "cut-shortens-text",
                item: `text ${text}`,
                message: 'The text "Title" (1 to 4 s) loses 2 s of its 3 s to a cut and plays for 1 s',
                at: 1,
                target: { list: "texts", id: text },
                fix: `movie.retime({ id: "${text}", to: 7 })`,
                action: { label: "Lengthen", ops: [{ op: "retime", id: text, to: 7 }] },
            },
            {
                severity: "check",
                kind: "marker-in-cut",
                item: 'recorded marker "Recorded"',
                message: 'The recorded marker "Recorded" at 5 s never plays: that time is cut, so it is no chapter',
                fix: 'movie.marker(6.5, "Recorded")',
                at: 5,
            },
        ]);

        // A recorded marker the movie never had (a recording.json written by hand) is named as outside, not as cut.
        const outside = checkProject(project, { ...facts, recordedMarkers: [{ atMs: 99_000, label: "Late" }] });
        expect(outside.at(-1)?.message).toBe(
            'The recorded marker "Late" at 99 s never plays: that time is outside the 10 s movie, so it is no chapter'
        );

        // fix() moves the edit marker onto the kept movie once and lengthens the text to play 1.5 s; the recorded
        // marker has no fix it could make twice.
        const fixed = fixOps(project, facts).ops.reduce((next, op) => applyOp(next, op), project);
        expect(fixed.markers?.map((one) => [one.atUs, one.label])).toEqual([[6_500_000, "Step two"]]);
        expect(fixed.texts?.map((one) => [one.startUs, one.endUs])).toEqual([[1_000_000, 7_000_000]]);
        expect(checkProject(fixed, facts).map((issue) => issue.item)).toEqual(['recorded marker "Recorded"']);
        // An edit marker of the same name stands in for the recorded one.
        const stood = applyOp(fixed, { op: "marker", at: 7, label: "Recorded" });
        expect(checkProject(stood, facts).map((issue) => issue.item)).toEqual([]);
    });

    test("replace words fixes every line with the word, whole words, any case, over earlier fixes", () => {
        const segments = [
            { text: "Open genesis tolls now.", start: 1 },
            { text: "Genesis Tolls has a menu.", start: 4.25 },
            { text: "Tollsbooth is not it.", start: 7 },
            { text: "A hidden genesis tolls line.", start: 9 },
        ];
        const fixes = { "4250": "Genesis Tolls has a menu bar.", "9000": "" };
        expect(replaceWordsInLines(segments, fixes, { find: "genesis tolls", replace: "GenesisTools" })).toEqual([
            { from: 1, text: "Open GenesisTools now.", was: "Open genesis tolls now." },
            { from: 4.25, text: "GenesisTools has a menu bar.", was: "Genesis Tolls has a menu bar." },
        ]);
        expect(replaceWordsInLines(segments, {}, { find: "tolls", replace: "x", matchCase: true })).toHaveLength(2);
        expect(replaceWordsInLines(segments, {}, { find: "Tolls", replace: "T", wholeWord: false })[2]?.text).toBe(
            "Tbooth is not it."
        );
        expect(
            replaceWordsInLines([{ text: "Žluťoučký kůň", start: 0 }], {}, { find: "kůň", replace: "pes" })[0]?.text
        ).toBe("Žluťoučký pes");
        expect(() => replaceWordsInLines(segments, {}, { find: " ", replace: "x" })).toThrow("find is empty");
    });

    test("annotate clicks marks each click once, a double click once, and a second run adds nothing", () => {
        const samples = [
            { ms: 1000, x: 0.2, y: 0.2, click: "left" },
            { ms: 1200, x: 0.201, y: 0.2, click: "left" },
            { ms: 4000, x: 0.8, y: 0.7, click: "right" },
            { ms: 5000, x: 0.5, y: 0.5 },
        ];
        const first = annotateClicks(wholeProject(source), samples);
        expect(first).toMatchObject({ added: 2, skipped: 0 });
        expect(first.project.shapes?.map((shape) => [shape.kind, shape.startUs, shape.endUs])).toEqual([
            ["circle", 1_000_000, 2_200_000],
            ["circle", 4_000_000, 5_200_000],
        ]);
        expect(annotateClicks(first.project, samples)).toMatchObject({ added: 0, skipped: 2 });
        const arrows = annotateClicks(wholeProject(source), samples, { kind: "arrow", fromUs: 3_000_000 });
        expect(arrows.project.shapes?.[0]).toMatchObject({ kind: "arrow", x2: 0.8, y2: 0.7 });
        expect(arrows.project.shapes?.[0]?.x1).toBeLessThan(0.8);
        expect(() => annotateClicks(wholeProject(source), samples, { fromUs: 6_000_000 })).toThrow("no clicks between");
        expect(() => annotateClicks(wholeProject(source), [])).toThrow("no cursor track");
    });

    test("idle stretches are still and silent at once, shortened at both ends", () => {
        const frames = Array.from({ length: 41 }, (_, index) => index * 100_000);
        const base = { frameTimesUs: frames, durationUs: 12_000_000, minUs: 2_000_000, keepUs: 300_000 };

        // No frames after 4 s and no audio: everything from 4 s on is idle.
        expect(idleRanges(base)).toEqual([[4_300_000, 11_700_000]]);
        // A frozen picture counts as still, and sound keeps its part of the still stretch.
        expect(
            idleRanges({
                ...base,
                frameTimesUs: [0, 12_000_000],
                frozenUs: [[4_000_000, 9_000_000]],
                silentUs: [[0, 6_000_000]],
            })
        ).toEqual([[300_000, 5_700_000]]);
        expect(idleRanges({ ...base, silentUs: [] })).toEqual([]);
    });

    describe("idle stretches keep what the drawn pointer does", () => {
        test("idleRanges leaves out the busy ranges of a still, silent stretch", () => {
            const frames = Array.from({ length: 301 }, (_, index) => index * 33_000);
            expect(
                idleRanges({
                    frameTimesUs: frames,
                    frozenUs: [[0, 10_000_000]],
                    silentUs: [[0, 10_000_000]],
                    busyUs: [[4_000_000, 5_000_000]],
                    durationUs: 10_000_000,
                    minUs: 2_000_000,
                    keepUs: 300_000,
                })
            ).toEqual([
                [300_000, 3_700_000],
                [5_300_000, 9_700_000],
            ]);
        });

        test("pointerBusyRanges covers a move, a click and a shortcut press", () => {
            const busy = pointerBusyRanges([
                { ms: 1000, x: 0.1, y: 0.1 },
                { ms: 1100, x: 0.2, y: 0.1 },
                { ms: 3000, x: 0.2, y: 0.1, key: "⌘C" },
                { ms: 7500, x: 0.2, y: 0.1, click: "left" },
            ]);
            expect(busy).toEqual([
                [1_000_000, 1_250_000],
                [2_500_000, 3_500_000],
                [7_000_000, 8_000_000],
            ]);
        });
    });

    describe("frozen stretches on the editor clock", () => {
        /** A metadata print as ffmpeg writes it: each frame's header with its filter time, then the tags it carries. */
        function metadataPrint(frames: Array<{ at: number; tags?: string[] }>): string {
            return frames
                .map((frame, index) =>
                    [
                        `frame:${index}    pts:${Math.round(frame.at * 600)}    pts_time:${frame.at}`,
                        ...(frame.tags ?? []),
                        "gt.f=1",
                    ].join("\n")
                )
                .join("\n");
        }

        const behind = metadataPrint([
            { at: 0 },
            { at: 1.0 },
            { at: 1.05 },
            { at: 2.05 },
            { at: 3.05, tags: ["lavfi.freezedetect.freeze_start=1.05"] },
            { at: 4.05, tags: ["lavfi.freezedetect.freeze_duration=3", "lavfi.freezedetect.freeze_end=4.05"] },
        ]);

        test("frozen stretches land on the editor clock when ffmpeg's filter clock runs behind the packet times", () => {
            // The simulator case: from frame 2 on, the packet times run 1.95 s ahead of ffmpeg's filter clock.
            expect(editorFrozenRanges(behind, [0, 1_000_000, 3_000_000, 4_000_000, 5_000_000, 6_000_000])).toEqual([
                [3_000_000, 6_000_000],
            ]);
            // When the two clocks agree, the stretch is the filter's own.
            expect(editorFrozenRanges(behind, [0, 1_000_000, 1_050_000, 2_050_000, 3_050_000, 4_050_000])).toEqual([
                [1_050_000, 4_050_000],
            ]);
        });

        test("a freeze still open at the end lasts to the end of the movie, and a print read in pieces reads the same", () => {
            const open = metadataPrint([
                { at: 0 },
                { at: 0.5 },
                { at: 1.5 },
                { at: 2.5, tags: ["lavfi.freezedetect.freeze_start=0.5"] },
            ]);
            expect(editorFrozenRanges(open, [0, 2_000_000, 3_000_000, 4_000_000])).toEqual([
                [2_000_000, Number.POSITIVE_INFINITY],
            ]);

            const bytes = new TextEncoder().encode(behind);
            const print = new FreezePrint();

            for (let at = 0; at < bytes.length; at += 7) {
                print.write(bytes.subarray(at, at + 7));
            }

            expect(print.rangesUs([0, 1_000_000, 3_000_000, 4_000_000, 5_000_000, 6_000_000])).toEqual([
                [3_000_000, 6_000_000],
            ]);
        });

        test("a print with another frame count than the container keeps ffmpeg's own times", () => {
            expect(editorFrozenRanges(behind, [0, 1_000_000, 3_000_000])).toEqual([[1_050_000, 4_050_000]]);
        });
    });

    test("removeIdle cuts the probed stretches and refuses to run without them", () => {
        const project = wholeProject(source);
        const op = parseEditOps({ op: "removeIdle" })[0];
        expect(op).toEqual({ op: "removeIdle", minSeconds: 2, keepSeconds: 0.3 });
        expect(() => applyOp(project, op)).toThrow("needs the movie's idle stretches");
        const cut = applyOp(project, op, { idleUs: [[4_300_000, 8_700_000]] });
        expect(cut.clips.map((clip) => [clip.fromUs, clip.toUs])).toEqual([
            [0, 4_300_000],
            [8_700_000, 10_000_000],
        ]);
    });

    test("the silence removeIdle hears is every audio track the export plays, mixed, and none when it plays none", () => {
        const filterOf = (tracks: number[]) => {
            const args = silenceDetectArgs({ video: "in.mp4", minUs: 2_000_000, tracks });
            expect(args.slice(-5)).toEqual(["-map", "[out]", "-f", "null", "-"]);
            return args[args.indexOf("-filter_complex") + 1];
        };

        expect(audibleTracks(2, { include: true, mutedTracks: [] })).toEqual([0, 1]);
        expect(filterOf(audibleTracks(2, { include: true, mutedTracks: [] }))).toStartWith(
            "[0:a:0][0:a:1]amix=inputs=2:normalize=0,silencedetect=n=-45dB:d=2,"
        );
        expect(filterOf(audibleTracks(2, { include: true, mutedTracks: [0] }))).toStartWith("[0:a:1]silencedetect=");
        expect(audibleTracks(2)).toEqual([0, 1]);
        expect(audibleTracks(2, { include: false, mutedTracks: [] })).toEqual([]);
        expect(audibleTracks(2, { include: true, mutedTracks: [0, 1] })).toEqual([]);
    });

    test("the transcript hears every track the export plays and refuses when none plays", () => {
        expect(transcribedTracks(2, {})).toEqual([0, 1]);
        expect(transcribedTracks(2, { mutedTracks: [0] })).toEqual([1]);
        expect(() => transcribedTracks(2, { mutedTracks: [0, 1] })).toThrow(/every audio track is muted or left out/);
        expect(() => transcribedTracks(2, { include: false })).toThrow(/nothing to transcribe/);
    });

    describe.skipIf(skip.integration)("removeIdle on a movie with two audio tracks", () => {
        test("findIdle hears every audio track the export plays, not only the first", async () => {
            const movie = join(workspace(), "system-then-mic.mp4");
            // A still picture; track 0 is silent (the system sound), track 1 plays a tone all along (the mic).
            await runVideoCommand({
                command: [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=gray:s=160x120:r=10:d=4",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=48000:cl=mono",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=f=440:r=48000:d=4",
                    "-map",
                    "0:v",
                    "-map",
                    "1:a",
                    "-map",
                    "2:a",
                    "-t",
                    "4",
                    "-c:v",
                    "libx264",
                    "-c:a",
                    "aac",
                    movie,
                ],
            });
            const base = { video: movie, durationUs: 4_000_000, minUs: 1_000_000, keepUs: 200_000 };

            expect(await findIdle({ ...base, audio: { include: true, mutedTracks: [] } })).toEqual([]);
            expect(await findIdle({ ...base, audio: { include: true, mutedTracks: [1] } })).toEqual([
                [200_000, 3_800_000],
            ]);
            expect(await findIdle({ ...base, audio: { include: false, mutedTracks: [] } })).toEqual([
                [200_000, 3_800_000],
            ]);
        });
    });

    test("clicks and frame are optional looks with defaults, merged on change and removable", () => {
        const project = wholeProject(withClickTrack(source));
        expect(project.clicks).toBeUndefined();
        expect(project.frame).toBeUndefined();

        const clicked = applyOp(project, { op: "clicks", radius: 0.05 });
        expect(clicked.clicks).toEqual({ highlight: true, color: "#FFD60A", radius: 0.05, durationMs: 450 });
        expect(applyOp(clicked, { op: "clicks", highlight: false }).clicks?.radius).toBe(0.05);

        const framed = applyOp(project, {
            op: "frame",
            padding: 0.1,
            background: { kind: "color", colors: ["#101010"] },
        });
        expect(framed.frame).toEqual({
            background: { kind: "color", colors: ["#101010"] },
            padding: 0.1,
            cornerRadius: 0.012,
            shadow: true,
        });
        expect(applyOp(framed, { op: "frame", enabled: false }).frame).toBeUndefined();

        // The export format is absent (mp4) until set, and kept by later export changes.
        expect(project.export.format).toBeUndefined();
        const gif = applyOp(project, { op: "exportSettings", format: "gif" });
        expect(applyOp(gif, { op: "exportSettings", maxHeight: 720 }).export).toMatchObject({
            format: "gif",
            maxHeight: 720,
        });
        expect(() => parseEditOps({ op: "clicks", color: "yellow" })).toThrow("a color is #RRGGBB");
    });

    test("normalize sets the volume that lifts the measured loudness to the target, up to 200 %", () => {
        const project = wholeProject(source);
        expect(applyOp(project, { op: "normalize", targetLufs: -16 }, { loudnessLufs: -22 }).audio.volume).toBe(2);
        expect(applyOp(project, { op: "normalize", targetLufs: -16 }, { loudnessLufs: -19 }).audio.volume).toBe(1.41);
        expect(applyOp(project, { op: "normalize", targetLufs: -16 }, { loudnessLufs: -10 }).audio.volume).toBe(0.5);
        expect(() => applyOp(project, { op: "normalize", targetLufs: -16 }, { loudnessLufs: null })).toThrow(
            "no unmuted audio"
        );
        expect(() => applyOp(project, { op: "normalize", targetLufs: -16 })).toThrow("needs the movie's loudness");
    });

    test("a part of the edit keeps what plays between two OUTPUT times, cuts and speeds inside it included", () => {
        let project = wholeProject(source);
        project = applyOp(project, { op: "cut", from: 2, to: 3 });
        project = applyOp(project, { op: "speed", from: 6, to: 8, factor: 2 });
        // Output: 0–2 → source 0–2, 2–5 → source 3–6, 5–6 → source 6–8 (2×), 6–8 → source 8–10.
        expect(sourceTimeOf(project, 2_500_000)).toBe(3_500_000);
        expect(sourceTimeOf(project, 5_500_000)).toBe(7_000_000);
        const part = partOf(project, 1_000_000, 5_500_000);
        expect(outputDurationUs(part)).toBe(4_500_000);
        expect(part.clips.map((clip) => [clip.fromUs, clip.toUs, clip.speed])).toEqual([
            [1_000_000, 2_000_000, 1],
            [3_000_000, 6_000_000, 1],
            [6_000_000, 7_000_000, 2],
        ]);
        expect(() => partOf(project, 9_000_000, 9_500_000)).toThrow("inside the 8 s edit");
    });

    // Regression test: unified review 2026-11-08 ED-cut-drops-whole-clip.
    test("a cut that ends within a frame after a clip's start keeps the rest of that clip", () => {
        const clipsOf = (project: projectOps.EditProject) => project.clips.map((clip) => [clip.fromUs, clip.toUs]);
        const whole = wholeProject(source);
        expect(clipsOf(projectOps.cutRange(whole, 5_000_000, 5_010_000))).toEqual([
            [0, 5_000_000],
            [5_010_000, 10_000_000],
        ]);
        const twoClips = projectOps.cutRange(whole, 4_000_000, 5_000_000);
        expect(clipsOf(projectOps.cutRange(twoClips, 4_995_000, 5_010_000))).toEqual([
            [0, 4_000_000],
            [5_010_000, 10_000_000],
        ]);
        const threeClips = projectOps.cutRange(twoClips, 7_000_000, 8_000_000);
        expect(clipsOf(partOf(threeClips, 4_010_000, 7_000_000))).toEqual([
            [5_010_000, 7_000_000],
            [8_000_000, 9_000_000],
        ]);
    });

    // Regression test: unified review 2026-11-08 ED-partof-source-range.
    test("a part over clips that play the same source twice keeps each clip's own overlap", () => {
        const project = editProjectSchema.parse({
            ...wholeProject(source),
            source: { ...source, durationUs: 30_000_000 },
            clips: [
                { id: "c1", fromUs: 0, toUs: 10_000_000 },
                { id: "c2", fromUs: 8_000_000, toUs: 30_000_000 },
            ],
        });
        const part = partOf(project, 9_000_000, 11_000_000);
        expect(part.clips.map((clip) => [clip.id, clip.fromUs, clip.toUs])).toEqual([
            ["c1", 9_000_000, 10_000_000],
            ["c2", 8_000_000, 9_000_000],
        ]);
        expect(outputDurationUs(part)).toBe(2_000_000);
    });

    // Regression test: review of PR 748, round 1. The shortest clip was measured in OUTPUT time, so a whole 0.1 s
    // clip at 16x (6.25 ms played) was dropped from a part, and a part of only such clips threw "nothing plays".
    test("a part keeps a whole short clip at a high speed; the shortest piece is measured in source time", () => {
        const project = editProjectSchema.parse({
            ...wholeProject(source),
            clips: [
                { id: "fast", fromUs: 1_000_000, toUs: 1_100_000, speed: 16 },
                { id: "slow", fromUs: 2_000_000, toUs: 4_000_000 },
            ],
        });
        expect(partOf(project, 0, 6_250).clips.map((clip) => [clip.id, clip.fromUs, clip.toUs])).toEqual([
            ["fast", 1_000_000, 1_100_000],
        ]);
        // 2 ms of output at 16x is 32 ms of source: a frame and more, so it stays too.
        expect(partOf(project, 4_250, 1_000_000).clips.map((clip) => [clip.id, clip.fromUs])).toEqual([
            ["fast", 1_068_000],
            ["slow", 2_000_000],
        ]);
    });

    test("a picture background needs a file that exists and sets the kind by itself", () => {
        const dir = workspace();
        const picture = join(dir, "wall.png");
        writeFileSync(picture, "not decoded here");
        const project = wholeProject(source);
        const framed = applyOp(project, { op: "frame", background: { image: picture, blur: 0.2 } });
        expect(framed.frame?.background).toMatchObject({ kind: "image", image: picture, blur: 0.2 });
        expect(() => applyOp(project, { op: "frame", background: { image: join(dir, "gone.png") } })).toThrow(
            "does not exist"
        );
        expect(() => applyOp(project, { op: "frame", background: { kind: "image" } })).toThrow(
            "needs background.image"
        );
        expect(applyOp(framed, { op: "frame", background: { kind: "gradient" } }).frame?.background.kind).toBe(
            "gradient"
        );
    });

    describe("the intro card's logo types", () => {
        // The editor's logo picker (CardsSection.logoTypes) offers exactly these; the Swift side checks the same
        // fixture (RecorderHuntLogoPictureTypesTests).
        test("a logo takes every type the editor's picker offers, and a song, an SVG or a PSD is refused", () => {
            expect(PICTURE_EXTENSIONS).toEqual(logoPictureTypes.extensions);
            const dir = workspace();
            const project = wholeProject(source);

            for (const extension of [...logoPictureTypes.extensions, "TIF"]) {
                const logo = join(dir, `logo.${extension}`);
                writeFileSync(logo, "not decoded here");
                expect(applyOp(project, { op: "introCard", title: "T", logo }).cards?.intro?.logo).toBe(logo);
            }

            for (const extension of logoPictureTypes.refused) {
                const file = join(dir, `file.${extension}`);
                writeFileSync(file, "");
                expect(() => applyOp(project, { op: "introCard", title: "T", logo: file })).toThrow(
                    "a logo is a picture"
                );
            }
        });
    });

    test("a redaction hides a rectangle inside the picture for a time and is removed by its id", () => {
        const project = wholeProject(source);
        const hidden = applyOp(project, {
            op: "redact",
            from: 1,
            to: 3,
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        });
        const [redaction] = hidden.redactions ?? [];
        expect(redaction).toMatchObject({ startUs: 1_000_000, endUs: 3_000_000, x: 0.1, width: 0.3, style: "blur" });
        // The editor window's rule: the part of the rectangle inside the picture, refused only under 1 % of it.
        const clipped = applyOp(project, {
            op: "redact",
            from: 1,
            to: 3,
            rect: { x: 0.8, y: 0, width: 0.3, height: 0.1 },
        });
        expect(clipped.redactions?.[0]?.x).toBe(0.8);
        expect(clipped.redactions?.[0]?.width).toBeCloseTo(0.2, 9);
        expect(() =>
            applyOp(project, { op: "redact", from: 1, to: 3, rect: { x: 0.995, y: 0, width: 0.3, height: 0.1 } })
        ).toThrow("at least 0.01 by 0.01");
        // Like untext and unshape: the last one gone removes the key.
        expect(applyOp(hidden, { op: "unredact", id: redaction?.id ?? "" }).redactions).toBeUndefined();
        expect(() => applyOp(hidden, { op: "unredact", id: "nope" })).toThrow(`redactions: ${redaction?.id}`);
        // Music: a file once, then changes merge; a missing file is refused; enabled: false removes it.
        const song = join(mkdtempSync(join(tmpdir(), "gt-music-")), "song.m4a");
        writeFileSync(song, "");
        expect(() => applyOp(project, { op: "music", volume: 0.5 })).toThrow("needs a file");
        expect(() => applyOp(project, { op: "music", file: `${song}.gone` })).toThrow("does not exist");
        const scored = applyOp(applyOp(project, { op: "music", file: song }), { op: "music", duck: 0 });
        expect(scored.audio.music).toEqual({ file: song, volume: 0.25, duck: 0, fadeMs: 1500 });
        expect(applyOp(scored, { op: "music", enabled: false }).audio.music).toBeUndefined();
        expect(applyOp(scored, { op: "music", startMs: 12_000, loop: false }).audio.music).toMatchObject({
            startMs: 12_000,
            loop: false,
            duck: 0,
        });
        // R4 voiceover clips: added at a source time with the measured length, kept in source order; an id changes
        // that clip; unvoiceover removes it and the last one removes the key. A file that is not a sound is refused.
        const voice = join(dirname(song), "voice.mp3");
        writeFileSync(voice, "");
        expect(() => applyOp(project, { op: "voiceover", at: 2, file: voice })).toThrow("was not measured");
        expect(() => applyOp(project, { op: "voiceover", at: 2, file: song.replace(".m4a", ".txt") })).toThrow(
            "does not exist"
        );
        expect(() => applyOp(project, { op: "voiceover", file: voice }, { voiceoverDurationUs: 1 })).toThrow(
            "needs `at`"
        );
        const voiced = applyOp(
            applyOp(
                project,
                { op: "voiceover", at: 4, file: voice, label: "Second" },
                { voiceoverDurationUs: 1_500_000 }
            ),
            { op: "voiceover", at: "0:01", file: voice, volume: 1.5 },
            { voiceoverDurationUs: 2_000_000 }
        );
        const clips = voiced.audio.voiceovers ?? [];
        expect(clips.map((clip) => [clip.atUs, clip.durationUs, clip.volume])).toEqual([
            [1_000_000, 2_000_000, 1.5],
            [4_000_000, 1_500_000, 1],
        ]);
        expect(clips[0]?.id).toMatch(/^v/);
        const moved = applyOp(voiced, { op: "voiceover", id: clips[1]?.id, at: 0.5, volume: 0.5 });
        expect(moved.audio.voiceovers?.map((clip) => [clip.label, clip.atUs, clip.volume])).toEqual([
            ["Second", 500_000, 0.5],
            [undefined, 1_000_000, 1.5],
        ]);
        expect(() => applyOp(voiced, { op: "unvoiceover", id: "v0" })).toThrow("voiceovers: ");
        const once = applyOp(voiced, { op: "unvoiceover", id: clips[0]?.id ?? "" });
        expect(applyOp(once, { op: "unvoiceover", id: clips[1]?.id ?? "" }).audio.voiceovers).toBeUndefined();
        expect(describeProject(voiced, "/x/edit.json").voiceovers[0]).toMatchObject({ at: 1, seconds: 2, plays: 1 });
        // R5 7: with an intro card the export plays the movie later; the export's own time is in the answer.
        const exportCarded = {
            ...voiced,
            cards: { intro: { title: "Demo", seconds: 3 }, end: { text: "Bye", qr: false, seconds: 2 } },
        };
        const described = describeProject(exportCarded, "/x/edit.json");
        expect(described.voiceovers[0]).toMatchObject({ plays: 1, exportPlays: 4 });
        expect(described.exportTime).toEqual({
            introSeconds: 3,
            endSeconds: 2,
            exportSeconds: described.outputSeconds + 5,
        });
        expect(describeProject(voiced, "/x/edit.json").exportTime).toEqual({
            introSeconds: 0,
            endSeconds: 0,
            exportSeconds: describeProject(voiced, "/x/edit.json").outputSeconds,
        });
        // R4 8 music ducking: the dB object with its defaults, merged by later ops, removed by enabled: false.
        const ducked = applyOp(project, { op: "ducking", voiceovers: false });
        expect(ducked.audio.ducking).toEqual({ db: 12, fadeMs: 300, transcript: true, voiceovers: false });
        expect(applyOp(ducked, { op: "ducking", db: 18 }).audio.ducking).toMatchObject({ db: 18, voiceovers: false });
        expect(applyOp(ducked, { op: "ducking", enabled: false }).audio.ducking).toBeUndefined();
        // R4 6 animated captions and texts: karaoke by default once set; a text's animate with its default length;
        // "fade" with no length is the default and leaves no key; setText changes it.
        const karaoke = applyOp(project, { op: "captionsStyle" });
        expect(karaoke.captionsStyle).toEqual({ kind: "karaoke", color: "#FFD60A" });
        expect(applyOp(karaoke, { op: "captionsStyle", enabled: false }).captionsStyle).toBeUndefined();
        const typed = applyOp(project, { op: "text", from: 1, to: 3, text: "Hi", animate: { kind: "typewriter" } });
        const typedNote = typed.texts?.[0];
        expect(typedNote?.animate).toEqual({ kind: "typewriter", ms: 600 });
        const faded = applyOp(typed, { op: "setText", id: typedNote?.id ?? "", animate: { kind: "fade" } });
        expect(faded.texts?.[0] && "animate" in faded.texts[0]).toBe(false);
        expect(
            applyOp(typed, { op: "setText", id: typedNote?.id ?? "", animate: { kind: "slideUp", ms: 900 } }).texts?.[0]
                ?.animate
        ).toEqual({ kind: "slideUp", ms: 900 });
        // R4 10 progress bar: the defaults, merged by later ops, removed by enabled: false.
        const barred = applyOp(project, { op: "progress", color: "#FF375F" });
        expect(barred.progress).toEqual({
            show: true,
            color: "#FF375F",
            height: 0.008,
            chapters: true,
            chapterMs: 2000,
        });
        expect(applyOp(barred, { op: "progress", show: false }).progress?.color).toBe("#FF375F");
        expect(applyOp(barred, { op: "progress", enabled: false }).progress).toBeUndefined();
        expect(() => applyOp(project, { op: "progress", color: "red" })).toThrow();
        // R6 8: the chapter label's place; absent is "auto" (the frame's free area).
        expect(applyOp(barred, { op: "progress", chapterPlace: "topRight" }).progress?.chapterPlace).toBe("topRight");
        // R4 9 intro and end cards: a title (or text) the first time, then changes merge; a logo must be a picture
        // that exists; a QR code needs a link; the last card gone removes the key.
        expect(() => applyOp(project, { op: "introCard", subtitle: "x" })).toThrow("needs a title");
        expect(() => applyOp(project, { op: "introCard", title: "T", logo: `${song}.png` })).toThrow("does not exist");
        expect(() => applyOp(project, { op: "introCard", title: "T", logo: song })).toThrow("a logo is a picture");
        expect(() => applyOp(project, { op: "endCard", text: "Bye", qr: true })).toThrow("needs a link");
        const carded = applyOp(applyOp(project, { op: "introCard", title: "Demo" }), {
            op: "endCard",
            text: "Bye",
            link: "https://example.com",
            qr: true,
        });
        expect(carded.cards).toEqual({
            intro: { title: "Demo", seconds: 3 },
            end: { text: "Bye", link: "https://example.com", qr: true, seconds: 3 },
        });
        expect(applyOp(carded, { op: "introCard", subtitle: "Tour" }).cards?.intro).toEqual({
            title: "Demo",
            subtitle: "Tour",
            seconds: 3,
        });
        const noIntro = applyOp(carded, { op: "introCard", enabled: false });
        expect(noIntro.cards).toEqual({ end: carded.cards?.end });
        expect(applyOp(noIntro, { op: "endCard", enabled: false }).cards).toBeUndefined();
        // Shapes: an arrow in source space with its defaults, a point-sized one refused, unshape removes it.
        const pointed = applyOp(project, {
            op: "shape",
            from: 1,
            to: 3,
            kind: "arrow",
            start: { x: 0.2, y: 0.2 },
            end: { x: 0.6, y: 0.4 },
            color: "#00ff00",
        });
        const [arrow] = pointed.shapes ?? [];
        expect(arrow).toMatchObject({ kind: "arrow", x1: 0.2, y2: 0.4, color: "#00FF00", width: 0.006 });
        expect(describeProject(pointed, "/p/edit.json").shapes[0]).toMatchObject({
            from: 1,
            end: { x: 0.6, y: 0.4 },
            appear: "draw",
        });
        expect(arrow?.appear).toBeUndefined();
        const still = applyOp(project, {
            op: "shape",
            from: 1,
            to: 3,
            kind: "box",
            start: { x: 0.2, y: 0.2 },
            end: { x: 0.4, y: 0.4 },
            appear: "none",
        });
        expect(still.shapes?.[0]?.appear).toBe("none");
        expect(() =>
            applyOp(project, {
                op: "shape",
                from: 1,
                to: 3,
                kind: "box",
                start: { x: 0.5, y: 0.5 },
                end: { x: 0.5, y: 0.5 },
            })
        ).toThrow("same point");
        expect(applyOp(pointed, { op: "unshape", id: arrow?.id ?? "" }).shapes).toBeUndefined();
        // follow is kept only when asked for.
        const following = applyOp(project, {
            op: "redact",
            from: 1,
            to: 3,
            rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
            style: "spotlight",
            follow: true,
        });
        expect(following.redactions?.[0]).toMatchObject({ style: "spotlight", follow: true });
        expect(describeProject(following, "/p/edit.json").redactions[0]).toMatchObject({ follow: true });
        const lit = applyOp(project, {
            op: "spotlight",
            from: 1,
            to: 3,
            rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
        });
        expect(lit.redactions?.[0]?.style).toBe("spotlight");
        // R8 11: the default dim is 0.5 (0.7 greyed the whole screen), and dimAround gives it a soft edge.
        expect(describeProject(lit, "/p/edit.json").redactions[0]).toMatchObject({ dim: 0.5, cutout: "rounded" });
        const soft = applyOp(project, {
            op: "spotlight",
            from: 1,
            to: 3,
            rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
            dimAround: 0.1,
        });
        expect(soft.redactions?.[0]).toMatchObject({ dimAround: 0.1 });
        expect(describeProject(soft, "/p/edit.json").redactions[0]).toMatchObject({ dimAround: 0.1 });
        const softId = soft.redactions?.[0]?.id ?? "";
        expect(applyOp(soft, { op: "setRedaction", id: softId, dimAround: 0.2 }).redactions?.[0]?.dimAround).toBe(0.2);
        expect(applyOp(soft, { op: "setRedaction", id: softId, dimAround: 0 }).redactions?.[0]).not.toHaveProperty(
            "dimAround"
        );
        const circle = applyOp(project, {
            op: "spotlight",
            from: 1,
            to: 3,
            rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
            dim: 0.5,
            cutout: "circle",
        });
        expect(circle.redactions?.[0]).toMatchObject({ dim: 0.5, cutout: "circle" });
        expect(redaction).not.toHaveProperty("follow");
        // A cut keeps it in source time.
        expect(applyOp(hidden, { op: "cut", from: 0, to: 0.5 }).redactions?.[0]?.startUs).toBe(1_000_000);
        // Motion blur is 0.5 until set, and an op merges into what is there.
        expect(describeProject(project, "/p/edit.json").motion).toEqual({ blur: 0.5 });
        expect(applyOp(project, { op: "motion", blur: 0 }).motion).toEqual({ blur: 0 });
        expect(applyOp(wholeProject(withClickTrack(source)), { op: "clicks", sound: true }).clicks).toMatchObject({
            highlight: true,
            sound: true,
        });
        expect(() => applyOp(project, { op: "motion", blur: 2 })).toThrow();
        // A text sits in the canvas with its defaults, follows source time, and goes with untext.
        const titled = applyOp(project, { op: "text", from: 1, to: 2.5, text: "  Step 1: sign in " });
        const [note] = titled.texts ?? [];
        expect(note).toMatchObject({
            startUs: 1_000_000,
            endUs: 2_500_000,
            text: "Step 1: sign in",
            x: 0.5,
            y: 0.12,
            style: "plate",
        });
        expect(describeProject(titled, "/p/edit.json").texts[0]).toMatchObject({
            from: 1,
            to: 2.5,
            at: { x: 0.5, y: 0.12 },
        });
        expect(() => applyOp(project, { op: "text", from: 1, to: 2, text: " " })).toThrow();
        expect(applyOp(titled, { op: "untext", id: note?.id ?? "" }).texts).toBeUndefined();
        expect(() => applyOp(titled, { op: "untext", id: "nope" })).toThrow(`texts: ${note?.id}`);
        // retime moves a text with its length kept, held inside the movie, or sets a new end.
        const later = applyOp(titled, { op: "retime", id: note?.id ?? "", by: 2 });
        expect(later.texts?.[0]).toMatchObject({ startUs: 3_000_000, endUs: 4_500_000 });
        const pastEnd = applyOp(titled, { op: "retime", id: note?.id ?? "", by: 1000 });
        expect(pastEnd.texts?.[0]?.endUs).toBe(project.source.durationUs);
        expect(applyOp(titled, { op: "retime", id: note?.id ?? "", to: 4 }).texts?.[0]).toMatchObject({
            startUs: 1_000_000,
            endUs: 4_000_000,
        });
        // The editor window's rule: an edge on the other one leaves the item 0.1 s long instead of refusing.
        expect(applyOp(titled, { op: "retime", id: note?.id ?? "", from: 2, to: 2 }).texts?.[0]).toMatchObject({
            startUs: 2_000_000,
            endUs: 2_100_000,
        });
        expect(() => applyOp(titled, { op: "retime", id: note?.id ?? "", by: 1, to: 3 })).toThrow("not both");
        expect(applyOp(titled, { op: "retime", id: note?.id ?? "", at: 6 }).texts?.[0]).toMatchObject({
            startUs: 6_000_000,
            endUs: 7_500_000,
        });
        expect(() => applyOp(titled, { op: "retime", id: note?.id ?? "", at: 2, by: 1 })).toThrow("not both");
        expect(() => applyOp(titled, { op: "retime", id: "nope", by: 1 })).toThrow(`ids: ${note?.id}`);
        // A name is trimmed and kept; a blank one is left out.
        const named = applyOp(project, {
            op: "redact",
            from: 1,
            to: 3,
            rect: { x: 0, y: 0, width: 0.2, height: 0.1 },
            label: " API token ",
        });
        expect(named.redactions?.[0]?.label).toBe("API token");
        const blank = applyOp(project, {
            op: "redact",
            from: 1,
            to: 3,
            rect: { x: 0, y: 0, width: 0.2, height: 0.1 },
            label: " ",
        });
        expect(blank.redactions?.[0] && "label" in blank.redactions[0]).toBe(false);
    });

    test("the keys overlay needs a track that kept shortcuts", () => {
        const dir = workspace();
        const plain = join(dir, "plain.jsonl");
        const keyed = join(dir, "keyed.jsonl");
        writeFileSync(plain, '{"t":0.1,"x":0.5,"y":0.5}\n');
        writeFileSync(keyed, '{"t":0.1,"x":0.5,"y":0.5}\n{"t":801.8,"x":0.5,"y":0.5,"key":"⌃F13"}\n');
        expect(() => applyOp(wholeProject({ ...source, cursor: plain }), { op: "keys" })).toThrow("kept no shortcuts");
        const keyedProject = wholeProject({ ...source, cursor: keyed });
        expect(shortcutsOf(keyedProject)).toEqual([{ at: 0.802, plays: 0.802, key: "⌃F13" }]);
        expect(shortcutsOf(applyOp(keyedProject, { op: "cut", from: 0.5, to: 1 }))[0]?.plays).toBeNull();
        expect(applyOp(wholeProject({ ...source, cursor: keyed }), { op: "keys", position: "top" }).keys).toEqual({
            show: true,
            size: 0.05,
            position: "top",
            durationMs: 1200,
        });
    });

    test("captions need the movie's cached transcript and merge on change", () => {
        const dir = workspace();
        const video = join(dir, "screen.mp4");
        const project = wholeProject({ ...source, video });
        expect(() => applyOp(project, { op: "captions" })).toThrow("no transcript yet");

        writeFileSync(join(dir, "screen.transcript.json"), '{"text":"","segments":[]}');
        const on = applyOp(project, { op: "captions", position: "top" });
        expect(on.captions).toEqual({ show: true, size: 0.038, position: "top" });
        expect(applyOp(on, { op: "captions", show: false }).captions?.position).toBe("top");
    });

    test("the drawn cursor changes only for a movie recorded without the system cursor, with its pictures", () => {
        const dir = workspace();
        const system = join(dir, "system.jsonl");
        const drawn = join(dir, "drawn.jsonl");
        writeFileSync(system, '{"t":0.1,"x":0.5,"y":0.5}\n');
        writeFileSync(drawn, '{"t":0.1,"x":0.5,"y":0.5,"shape":"57a1d610df3e","pw":1440.0}\n');

        const withSystem = wholeProject({ ...source, cursor: system });
        expect(() => applyOp(withSystem, { op: "cursor", size: 2 })).toThrow("system cursor in its picture");

        // The window draws the cursor only with its pictures beside the track; without them TS says the same.
        const withDrawn = wholeProject({ ...source, cursor: drawn });
        expect(trackDrawsCursor(drawn)).toBe(false);
        expect(describeProject(withDrawn, join(dir, "screen.edit.json")).cursor).toBeNull();
        expect(() => applyOp(withDrawn, { op: "cursor", size: 2 })).toThrow("cursor pictures are missing");
        mkdirSync(join(dir, "cursor-shapes"));
        writeFileSync(join(dir, "cursor-shapes", "57a1d610df3e.png"), "png");
        writeFileSync(join(dir, "cursor-shapes", "57a1d610df3e.json"), '{"hotX":0,"hotY":0,"width":16,"height":16}');
        expect(trackDrawsCursor(drawn)).toBe(true);
        const bigger = applyOp(withDrawn, { op: "cursor", size: 2 });
        expect(bigger.cursor).toEqual({ show: true, size: 2, smoothing: 0.5, hideAfterMs: 0 });
        expect(applyOp(bigger, { op: "cursor", show: false }).cursor?.size).toBe(2);
        expect(() => parseEditOps({ op: "cursor", size: 9 })).toThrow();
    });

    test("transcript lines carry where they play in the edit, and search ignores case and accents", () => {
        const raw = {
            text: "",
            segments: [
                { text: " Dobrý den. ", start: 0, end: 1.5 },
                { text: "Tohle vystřihni.", start: 2, end: 3 },
                { text: "Konec.", start: 5, end: 6 },
            ],
        };
        const edited = applyOp(wholeProject(source), { op: "cut", from: 1.8, to: 3.2 });
        const lines = transcriptLines(raw, edited);

        expect(lines.map((line) => [line.text, line.plays])).toEqual([
            ["Dobrý den.", 0],
            ["Tohle vystřihni.", null],
            ["Konec.", 3.6],
        ]);
        expect(findInTranscript(lines, "VYSTRIHNI").map((line) => line.from)).toEqual([2]);
        expect(() => transcriptLines({ segments: "no" }, edited)).toThrow("no segments");

        // A fix replaces a line's words by its start; "" hides it; unfixLine drops the fix.
        const fixed = applyOp(applyOp(edited, { op: "fixLine", from: 0, text: " Dobrý večer. " }), {
            op: "fixLine",
            from: 5,
            text: "",
        });
        expect(transcriptLines(raw, fixed).map((line) => line.text)).toEqual(["Dobrý večer.", "Tohle vystřihni."]);
        expect(findInTranscript(transcriptLines(raw, fixed), "vecer").map((line) => line.from)).toEqual([0]);
        const back = applyOp(fixed, { op: "unfixLine", from: 5 });
        expect(transcriptLines(raw, back).map((line) => line.text)).toContain("Konec.");
        expect(() => applyOp(back, { op: "unfixLine", from: 9 })).toThrow("fixed lines start at: 0 s");

        // Subtitles: the cut line is left out, the last one moves up by the cut, a part starts at 0.
        const cues = subtitleCues(lines, edited);
        expect(cues.map((cue) => [cue.text, cue.fromUs, cue.toUs])).toEqual([
            ["Dobrý den.", 0, 1_500_000],
            ["Konec.", 3_600_000, 4_600_000],
        ]);
        expect(formatSubtitles(cues, "srt")).toBe(
            "1\n00:00:00,000 --> 00:00:01,500\nDobrý den.\n\n2\n00:00:03,600 --> 00:00:04,600\nKonec.\n"
        );
        expect(formatSubtitles(cues, "vtt").startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n")).toBe(true);
        const part = subtitleCues(lines, edited, { fromUs: 1_000_000, toUs: 4_000_000 });
        expect(part.map((cue) => [cue.text, cue.fromUs, cue.toUs])).toEqual([
            ["Dobrý den.", 0, 500_000],
            ["Konec.", 2_600_000, 3_000_000],
        ]);
        // At 2x a line shows for half its spoken time.
        const fast = applyOp(wholeProject(source), { op: "speed", from: 0, to: 10, factor: 2 });
        expect(subtitleCues(transcriptLines(raw, fast), fast)[0]).toMatchObject({ fromUs: 0, toUs: 750_000 });
    });

    describe("subtitles follow the burned-in captions", () => {
        test("subtitles keep a line whose start or middle is cut, as the burned-in caption shows it", () => {
            const raw = {
                text: "",
                segments: [
                    { text: "First.", start: 1, end: 3.8 },
                    { text: "Um, then we pick the newest mail.", start: 4, end: 7.5 },
                    { text: "Gone.", start: 9, end: 9.5 },
                ],
            };
            const cuesOf = (cut: { from: number; to: number }) => {
                const project = applyOp(wholeProject(source), { op: "cut", ...cut });
                const lines = transcriptLines(raw, project);
                return {
                    plays: lines.map((line) => line.plays),
                    cues: subtitleCues(lines, project).map((cue) => [cue.text, cue.fromUs, cue.toUs]),
                };
            };

            // The start is cut: the line shows from the cut on, where the burned-in caption shows it.
            expect(cuesOf({ from: 3.9, to: 4.4 })).toEqual({
                plays: [1, 3.9, 8.5],
                cues: [
                    ["First.", 1_000_000, 3_800_000],
                    ["Um, then we pick the newest mail.", 3_900_000, 7_000_000],
                    ["Gone.", 8_500_000, 9_000_000],
                ],
            });
            // The middle is cut: the two kept pieces touch in the output, so the line is one cue.
            expect(cuesOf({ from: 5.5, to: 6 })).toEqual({
                plays: [1, 4, 8.5],
                cues: [
                    ["First.", 1_000_000, 3_800_000],
                    ["Um, then we pick the newest mail.", 4_000_000, 7_000_000],
                    ["Gone.", 8_500_000, 9_000_000],
                ],
            });
            // The end is cut: the cue ends at the cut, as the caption does, and does not run on into the next part.
            expect(cuesOf({ from: 7, to: 8 }).cues[1]).toEqual([
                "Um, then we pick the newest mail.",
                4_000_000,
                7_000_000,
            ]);
            // The whole line is cut: no cue, and plays is null.
            expect(cuesOf({ from: 3.9, to: 7.6 })).toEqual({
                plays: [1, null, 5.3],
                cues: [
                    ["First.", 1_000_000, 3_800_000],
                    ["Gone.", 5_300_000, 5_800_000],
                ],
            });
            // A line that starts on the edge of a cut has no kept moment before it: it starts where the cut is.
            expect(cuesOf({ from: 3.8, to: 4 })).toEqual({
                plays: [1, 3.8, 8.8],
                cues: [
                    ["First.", 1_000_000, 3_800_000],
                    ["Um, then we pick the newest mail.", 3_800_000, 7_300_000],
                    ["Gone.", 8_800_000, 9_300_000],
                ],
            });
        });
    });

    test("writes every field the Swift decoder needs and refuses a newer version", () => {
        const dir = mkdtempSync(join(tmpdir(), "edit-project-"));
        const path = join(dir, "edit.json");
        const saved = writeProject(path, wholeProject(source));
        const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        expect(saved.revision).toBe(1);
        expect(Object.keys(editProjectSchema.parse(raw)).sort()).toEqual(
            ["audio", "clips", "export", "revision", "source", "updatedBy", "version", "zooms"].sort()
        );
        expect(raw).toMatchObject({ audio: { include: true, volume: 1, mutedTracks: [] }, export: { codec: "h264" } });
        writeFileSync(path, SafeJSON.stringify({ ...saved, version: 9 }));
        expect(() => readProject(path)).toThrow("version 9");
    });
});

describe("a redact op's style options", () => {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
    const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };

    test("a redact op of style spotlight keeps its dim and cutout, as the spotlight op does", () => {
        const project = wholeProject(source);
        const [redact] = parseEditOps({
            op: "redact",
            from: 1,
            to: 3,
            rect,
            style: "spotlight",
            dim: 0.85,
            cutout: "circle",
        });
        const [spotlight] = parseEditOps({ op: "spotlight", from: 1, to: 3, rect, dim: 0.85, cutout: "circle" });
        const viaRedact = applyOp(project, redact);
        const viaSpotlight = applyOp(project, spotlight);

        expect(viaRedact.redactions?.[0]).toMatchObject({ style: "spotlight", dim: 0.85, cutout: "circle" });
        expect(describeProject(viaRedact, "/p/edit.json").redactions[0]).toMatchObject({ dim: 0.85, cutout: "circle" });
        const { id: _redactId, ...redactPart } = viaRedact.redactions?.[0] ?? { id: "" };
        const { id: _spotId, ...spotPart } = viaSpotlight.redactions?.[0] ?? { id: "" };
        expect(redactPart).toEqual(spotPart);
        // A part with keys keeps them too.
        const [tracked] = parseEditOps({
            op: "redact",
            from: 1,
            to: 3,
            rect,
            style: "spotlight",
            dim: 0.3,
            cutout: "rect",
            track: [
                { at: 1, ...rect },
                { at: 3, ...rect, x: 0.5 },
            ],
        });
        expect(applyOp(project, tracked).redactions?.[0]).toMatchObject({ dim: 0.3, cutout: "rect" });
        // The default lit shape is not written, as the spotlight op leaves it out.
        const [rounded] = parseEditOps({ op: "redact", from: 1, to: 3, rect, style: "spotlight", cutout: "rounded" });
        expect(applyOp(project, rounded).redactions?.[0]).not.toHaveProperty("cutout");
    });

    test("a redact op refuses dim or cutout without style spotlight, and cell without style pixelate", () => {
        const project = wholeProject(source);
        const apply = (raw: Record<string, unknown>) => {
            const [op] = parseEditOps({ op: "redact", from: 1, to: 3, rect, ...raw });
            return applyOp(project, op);
        };

        expect(() => apply({ style: "blur", dim: 0.85 })).toThrow('dim is for style "spotlight" only');
        // An absent style is blur.
        expect(() => apply({ cutout: "circle" })).toThrow('cutout is for style "spotlight" only');
        expect(() => apply({ style: "spotlight", cell: 24 })).toThrow('cell is for style "pixelate" only');
        // The options of the right style still apply.
        expect(apply({ style: "pixelate", cell: 24 }).redactions?.[0]).toMatchObject({ cell: 24 });
        expect(apply({ style: "spotlight", dim: 0.6 }).redactions?.[0]).toMatchObject({ dim: 0.6 });
    });
});

describe("camera({ x }) without y", () => {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };

    test("keeps the other axis where the corner bubble is drawn", () => {
        const project = applyOp(wholeProject(source), { op: "camera", file: "camera.mov" });
        const canvas = canvasShape(project);
        if (!project.camera) {
            throw new Error("the camera op made no bubble");
        }

        const drawn = bubbleRect(project.camera, canvas);
        const moved = applyOp(project, { op: "camera", x: 0.2 });
        expect(moved.camera?.corner).toBe("custom");
        expect(moved.camera?.x).toBe(0.2);
        expect(moved.camera?.y).toBeCloseTo(drawn.y / canvas.height, 9);
        expect(moved.camera?.y).not.toBe(0.82);
    });

    test("a custom bubble keeps its stored axis", () => {
        const placed = applyOp(wholeProject(source), { op: "camera", file: "camera.mov", x: 0.5, y: 0.3 });
        expect(applyOp(placed, { op: "camera", x: 0.2 }).camera).toMatchObject({ corner: "custom", x: 0.2, y: 0.3 });
    });
});

describe("the effects sheet on source time", () => {
    test("bakes the export's cut snap into the hidden parts and leaves the export-clock tilt and progress bar out", () => {
        const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
        let project = applyOp(wholeProject(source), { op: "cut", from: 5, to: 6 });
        project = applyOp(project, {
            op: "redact",
            from: 2,
            to: 4.8,
            rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        });
        project = editProjectSchema.parse({ ...project, tilt: {}, progress: {} });
        expect(project.tilt).toBeDefined();
        const sheet = effectsOnSourceTime(project);
        expect(sheet.redactions?.map((part) => [part.startUs, part.endUs])).toEqual([[2_000_000, 5_000_000]]);
        expect(sheet.tilt).toBeUndefined();
        expect(sheet.progress).toBeUndefined();
        expect(sheet.clips).toEqual([{ id: "c00000000", fromUs: 0, toUs: 10_000_000, speed: 1 }]);
    });
});

describe("a cursor track with a torn line", () => {
    test("skips the line that does not parse and keeps the rows around it", () => {
        const path = join(workspace(), "cursor.jsonl");
        writeFileSync(path, '{"t":0,"x":1,"y":2}\n{"t": 12, "x"\n{"t":40,"x":3,"y":4,"click":"left"}\n');
        expect(readCursorTrack(path)).toEqual([
            { ms: 0, x: 1, y: 2 },
            { ms: 40, x: 3, y: 4, click: "left" },
        ]);
    });
});

describe("the editor window's item ops", () => {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
    const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };

    /** A cursor track with clicks at 2 s (0.7, 0.3) and 6 s (0.2, 0.8). */
    function withCursor(): ReturnType<typeof wholeProject> {
        const path = join(workspace(), "cursor.jsonl");
        const rows = [
            { t: 0, x: 0.5, y: 0.5 },
            { t: 2000, x: 0.7, y: 0.3, click: "left" },
            { t: 6000, x: 0.2, y: 0.8, click: "left" },
        ];
        writeFileSync(path, rows.map((row) => SafeJSON.stringify(row)).join("\n"));
        return wholeProject({ ...source, cursor: path });
    }

    test("setZoom changes the fields it names, holds them in range, and a placed focus makes the zoom manual", () => {
        let project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 3, follow: true });
        const id = project.zooms[0].id;
        project = applyOp(project, { op: "setZoom", id, scale: 9, easeInMs: 300 });
        expect(project.zooms[0]).toMatchObject({ scale: 4, easeInMs: 300, mode: "follow" });
        project = applyOp(project, { op: "setZoom", id, focus: { x: 1.4, y: -0.2 } });
        expect(project.zooms[0]).toMatchObject({ focusX: 1, focusY: 0, mode: "manual" });
        expect(() => applyOp(project, { op: "setZoom", id: "nope", scale: 2 })).toThrow("no zoom nope");
    });

    test("setRedaction keeps the rectangle inside the picture, and the default dim and an empty label are not written", () => {
        let project = applyOp(wholeProject(source), { op: "spotlight", from: 1, to: 3, rect });
        const id = project.redactions?.[0]?.id ?? "";
        project = applyOp(project, { op: "setRedaction", id, rect: { x: 0.95, y: -1, width: 0.3, height: 0.001 } });
        expect(project.redactions?.[0]).toMatchObject({ x: 0.7, y: 0, width: 0.3, height: 0.01 });
        project = applyOp(project, {
            op: "setRedaction",
            id,
            label: "token",
            dim: 0.6,
            cutout: "circle",
            follow: true,
        });
        expect(project.redactions?.[0]).toMatchObject({ label: "token", dim: 0.6, cutout: "circle", follow: true });
        project = applyOp(project, { op: "setRedaction", id, label: " ", dim: 0.502, follow: false });
        expect(project.redactions?.[0]).not.toHaveProperty("label");
        expect(project.redactions?.[0]).not.toHaveProperty("dim");
        expect(project.redactions?.[0]).not.toHaveProperty("follow");
    });

    test("setText and setShape change words, place, size and points, held inside their ranges", () => {
        let project = applyOp(wholeProject(source), { op: "text", from: 1, to: 3, text: "Title" });
        const text = project.texts?.[0]?.id ?? "";
        project = applyOp(project, { op: "setText", id: text, text: "  Step two ", x: 2, size: 0.5, style: "plain" });
        expect(project.texts?.[0]).toMatchObject({ text: "Step two", x: 1, size: 0.15, style: "plain" });
        expect(() => applyOp(project, { op: "setText", id: text, text: "  " })).toThrow("needs words");
        project = applyOp(project, {
            op: "shape",
            from: 1,
            to: 3,
            kind: "box",
            start: { x: 0.1, y: 0.1 },
            end: { x: 0.3, y: 0.3 },
        });
        const shape = project.shapes?.[0]?.id ?? "";
        project = applyOp(project, {
            op: "setShape",
            id: shape,
            end: { x: 1.2, y: 0.5 },
            width: 1,
            color: "#00ff00",
            appear: "fade",
        });
        expect(project.shapes?.[0]).toMatchObject({ x2: 1, y2: 0.5, width: 0.03, color: "#00FF00", appear: "fade" });
        project = applyOp(project, { op: "setShape", id: shape, appear: "draw" });
        expect(project.shapes?.[0]).not.toHaveProperty("appear");
    });

    test("a shape without points goes round the pointer at its start, or the point it is given, as the window places it", () => {
        const points = (shape: { x1: number; y1: number; x2: number; y2: number } | undefined) =>
            [shape?.x1, shape?.y1, shape?.x2, shape?.y2].map((value) => Math.round((value ?? -1) * 1000) / 1000);
        let project = applyOp(withCursor(), { op: "shape", from: 2, to: 4, kind: "circle" });
        expect(points(project.shapes?.[0])).toEqual([0.666, 0.24, 0.734, 0.36]);
        project = applyOp(project, { op: "shape", from: 2, to: 4, kind: "arrow", at: { x: 0.2, y: 0.8 } });
        expect(points(project.shapes?.[1])).toEqual([0.29, 0.71, 0.2, 0.8]);
        const middle = applyOp(wholeProject(source), { op: "shape", from: 2, to: 4, kind: "box" });
        expect(points(middle.shapes?.[0])).toEqual([0.42, 0.44, 0.58, 0.56]);
        expect(() =>
            applyOp(wholeProject(source), { op: "shape", from: 2, to: 4, kind: "box", start: { x: 0.1, y: 0.1 } })
        ).toThrow("both start and end");
    });

    test("trim moves a clip's edges inside the movie, deleteClip keeps the last clip, clipSpeed holds 0.25 to 16", () => {
        let project = applyOp(wholeProject(source), { op: "split", at: 5 });
        const [left, right] = project.clips;
        project = applyOp(project, { op: "trim", clip: left.id, from: -2, to: 4 });
        expect(project.clips[0]).toMatchObject({ fromUs: 0, toUs: 4_000_000 });
        project = applyOp(project, { op: "trim", clip: right.id, from: 9.999_999 });
        expect(project.clips[1].toUs - project.clips[1].fromUs).toBe(16_667);
        project = applyOp(project, { op: "clipSpeed", clip: right.id, factor: 40 });
        expect(project.clips[1].speed).toBe(16);
        project = applyOp(project, { op: "deleteClip", clip: left.id });
        expect(project.clips.map((clip) => clip.id)).toEqual([right.id]);
        expect(() => applyOp(project, { op: "deleteClip", clip: right.id })).toThrow("last clip");
    });

    test("duplicate copies a zoom after any zoom it meets and other items right after themselves", () => {
        let project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 2, scale: 2.5 });
        project = applyOp(project, { op: "zoom", from: 2.2, to: 3 });
        const first = project.zooms[0];
        project = applyOp(project, { op: "setZoom", id: first.id, easeInMs: 150 });
        project = applyOp(project, { op: "duplicate", id: first.id });
        const copy = project.zooms.find((zoom) => zoom.id !== first.id && zoom.startUs >= 3_000_000);
        expect(copy).toMatchObject({ startUs: 3_000_000, scale: 2.5, easeInMs: 150 });
        project = applyOp(project, { op: "text", from: 9, to: 9.5, text: "End" });
        const text = project.texts?.[0]?.id ?? "";
        project = applyOp(project, { op: "duplicate", id: text });
        expect(project.texts?.[1]).toMatchObject({ text: "End", startUs: 9_500_000, endUs: 10_000_000 });
        expect(project.texts?.[1]?.id).not.toBe(text);
    });

    test("removeClickCircles takes out the circles at recorded clicks and keeps the rest", () => {
        let project = applyOp(withCursor(), { op: "annotateClicks" });
        project = applyOp(project, { op: "shape", from: 4, to: 5, kind: "circle" });
        expect(project.shapes).toHaveLength(3);
        project = applyOp(project, { op: "removeClickCircles" });
        expect(project.shapes?.map((shape) => shape.startUs)).toEqual([4_000_000]);
        expect(() => applyOp(project, { op: "removeClickCircles" })).toThrow("no click circle");
    });

    test("renameLane names a lane and an empty name gives the default back; cameraShow deletes a part by id", () => {
        let project = applyOp(wholeProject(source), { op: "addLane", kinds: ["text"] });
        const lane = project.lanes?.at(-1)?.id ?? "";
        project = applyOp(project, { op: "renameLane", id: lane, name: `  ${"x".repeat(50)}  ` });
        expect(project.lanes?.at(-1)?.name).toBe("x".repeat(40));
        project = applyOp(project, { op: "renameLane", id: lane, name: "" });
        expect(project.lanes?.at(-1)).not.toHaveProperty("name");
        project = applyOp(project, { op: "camera", file: "camera.mov" });
        project = applyOp(project, { op: "cameraHide", from: 1, to: 2 });
        project = applyOp(project, { op: "cameraHide", from: 5, to: 6 });
        const [part] = project.camera?.hidden ?? [];
        project = applyOp(project, { op: "cameraShow", id: part.id });
        expect(project.camera?.hidden.map((item) => item.startUs)).toEqual([5_000_000]);
        expect(() => applyOp(project, { op: "cameraShow", id: part.id, from: 1, to: 2 })).toThrow("not both");
    });

    // Regression test: deep test 2026-11-06 RE6 — fixLine at a time inside a line saved a fix no line starts at.
    test("fixLine at any time inside a line fixes that line, and a time between lines is refused", () => {
        const transcript = [
            { text: "Hello.", start: 0.4, end: 2.0 },
            { text: "What are you doing?", start: 2.281, end: 4.6 },
        ];
        const fixed = applyOp(
            wholeProject(source),
            { op: "fixLine", from: 2.5, text: "What are you doing now?" },
            { transcript }
        );

        expect(fixed.transcript?.fixes).toEqual({ "2281": "What are you doing now?" });
        expect(() => applyOp(wholeProject(source), { op: "fixLine", from: 9, text: "x" }, { transcript })).toThrow(
            "no line is spoken at 9 s, nothing was saved; the nearest lines start at 2.281, 0.4 s"
        );
    });

    // Regression test: deep test 2026-11-06 NR36 — denoise on a movie with no sound saved, and every export then failed.
    test("denoise refuses a movie with no audio track, as normalize does, and turning it off still works", () => {
        const project = wholeProject(source);

        expect(() => applyOp(project, { op: "denoise" }, { audioTracks: 0 })).toThrow("no sound to clean");
        expect(applyOp(project, { op: "denoise" }, { audioTracks: 1 }).audio.denoise?.method).toBe("afftdn");
        expect(applyOp(project, { op: "denoise", enabled: false }, { audioTracks: 0 }).audio.denoise).toBeUndefined();
    });

    // The Audio tab's rules, which the window kept in EditorDenoise.swift before the service owned them.
    test("denoise per track: a track in or out, no track left is off, every track is no list, a base strength is not written", () => {
        let project = wholeProject(source);
        project = { ...project, audio: { ...project.audio, include: false } };
        const on = applyOp(project, { op: "denoise" });
        expect(on.audio.denoise).toEqual({ method: "afftdn", reductionDb: 12 });
        expect(on.audio.include).toBe(true);
        expect(applyOp(on, { op: "denoise", enabled: false }).audio.denoise).toBeUndefined();

        const secondOnly = applyOp(on, { op: "denoise", track: 0, on: false, trackCount: 2 });
        expect(secondOnly.audio.denoise?.tracks).toEqual([1]);
        expect(
            applyOp(secondOnly, { op: "denoise", track: 0, on: true, trackCount: 2 }).audio.denoise
        ).not.toHaveProperty("tracks");
        expect(
            applyOp(secondOnly, { op: "denoise", track: 1, on: false, trackCount: 2 }).audio.denoise
        ).toBeUndefined();

        const stronger = applyOp(on, { op: "denoise", track: 1, reductionDb: 20.4, trackCount: 2 });
        expect(stronger.audio.denoise?.trackReductionDb).toEqual({ "1": 20 });
        const back = applyOp(stronger, { op: "denoise", track: 1, reductionDb: 12, trackCount: 2 });
        expect(back.audio.denoise).not.toHaveProperty("trackReductionDb");
        expect(applyOp(on, { op: "denoise", track: 0, reductionDb: 8, trackCount: 1 }).audio.denoise?.reductionDb).toBe(
            8
        );
        expect(() => applyOp(on, { op: "denoise", track: 0, trackCount: 2 })).toThrow("needs on or reductionDb");
    });

    describe("a track index is one of the movie's audio tracks", () => {
        test("mute refuses a track the movie does not have, and unmute of any track still clears a stale entry", () => {
            const project = wholeProject(source);

            expect(() => applyOp(project, { op: "mute", track: 1 }, { audioTracks: 1 })).toThrow(
                "this movie has 1 audio track (0); track 1 is not one of them"
            );
            expect(() => applyOp(project, { op: "mute", track: 5 }, { audioTracks: 2 })).toThrow("2 audio tracks");
            expect(applyOp(project, { op: "mute", track: 1 }, { audioTracks: 2 }).audio.mutedTracks).toEqual([1]);
            const stale = { ...project, audio: { ...project.audio, mutedTracks: [5] } };
            expect(
                applyOp(stale, { op: "mute", track: 5, muted: false }, { audioTracks: 1 }).audio.mutedTracks
            ).toEqual([]);
            expect(applyOp(project, { op: "mute", track: 5 }).audio.mutedTracks).toEqual([5]);
        });

        test("denoise refuses tracks, a strength or one track the movie does not have", () => {
            const project = wholeProject(source);

            expect(() => applyOp(project, { op: "denoise", tracks: [5] }, { audioTracks: 2 })).toThrow(
                "track 5 is not one of them"
            );
            expect(() =>
                applyOp(project, { op: "denoise", trackReductionDb: { "2": 20 } }, { audioTracks: 2 })
            ).toThrow("track 2 is not one of them");
            expect(() => applyOp(project, { op: "denoise", track: 1, on: true }, { audioTracks: 1 })).toThrow(
                "track 1 is not one of them"
            );
            expect(applyOp(project, { op: "denoise", reductionDb: 20, tracks: [1] }).audio.denoise?.tracks).toEqual([
                1,
            ]);
        });

        test("one denoise track takes the measured track count, so it needs no trackCount", () => {
            const on = applyOp(wholeProject(source), { op: "denoise" }, { audioTracks: 2 });
            const two = { audioTracks: 2 };

            expect(applyOp(on, { op: "denoise", track: 1, on: false }, two).audio.denoise?.tracks).toEqual([0]);
            expect(applyOp(on, { op: "denoise", track: 0, on: false }, two).audio.denoise?.tracks).toEqual([1]);
            expect(applyOp(on, { op: "denoise", track: 1, reductionDb: 30 }, two).audio.denoise).toEqual({
                method: "afftdn",
                reductionDb: 12,
                trackReductionDb: { "1": 30 },
            });
            expect(
                applyOp(on, { op: "denoise", track: 1, on: false, trackCount: 1 }, two).audio.denoise?.tracks
            ).toEqual([0]);
            expect(() => applyOp(on, { op: "denoise", track: 1, on: false })).toThrow("needs the movie's track count");
        });
    });

    test("the range popover keeps only what plays between the times", () => {
        let project = applyOp(wholeProject(source), { op: "cut", from: 1, to: 2 });
        project = applyOp(project, { op: "range", from: 2, to: 4, action: "keep" });
        expect(project.clips.map((clip) => [clip.fromUs, clip.toUs])).toEqual([[3_000_000, 5_000_000]]);
    });

    // Where the two languages disagreed, the window's behaviour is the rule now (each test names the window's).
    test("a zoom that meets another goes after it, lasts 0.5 s at least, takes the last zoom's scale and says it moved", () => {
        let project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 3, scale: 2.5 });
        const before = project;
        project = applyOp(project, { op: "zoom", from: 2, to: 4 });
        expect(project.zooms.map((zoom) => [zoom.startUs, zoom.endUs, zoom.scale])).toEqual([
            [1_000_000, 3_000_000, 2.5],
            [3_000_000, 5_000_000, 2.5],
        ]);
        expect(opPlacementWarnings({ op: "zoom", from: 2, to: 4 }, before, project)).toEqual([
            "zoom: 2 s met another zoom, so it went to 3–5 s (zooms cannot overlap)",
        ]);
        const short = applyOp(project, { op: "zoom", from: 7, to: 7.1 });
        expect(short.zooms.at(-1)).toMatchObject({ startUs: 7_000_000, endUs: 7_500_000 });
        expect(opPlacementWarnings({ op: "zoom", from: 7, to: 7.1 }, project, short)).toEqual([]);
    });

    test("a zoom moved or stretched into a neighbour stops at it, and a dragged edge keeps 0.1 s instead of refusing", () => {
        let project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 2 });
        project = applyOp(project, { op: "zoom", from: 4, to: 6 });
        const [first, second] = project.zooms;
        const spans = (next: ReturnType<typeof wholeProject>) => next.zooms.map((zoom) => [zoom.startUs, zoom.endUs]);
        expect(spans(applyOp(project, { op: "retime", id: first.id, to: 5 }))).toEqual([
            [1_000_000, 4_000_000],
            [4_000_000, 6_000_000],
        ]);
        expect(spans(applyOp(project, { op: "retime", id: second.id, by: -3.5 }))).toEqual([
            // Moved 3.5 s back from 4-6 s onto the first zoom, it goes past it with its length kept.
            [1_000_000, 2_000_000],
            [2_000_000, 4_000_000],
        ]);

        let texted = applyOp(wholeProject(source), { op: "text", from: 1, to: 3, text: "Hi" });
        const text = texted.texts?.[0]?.id ?? "";
        texted = applyOp(texted, { op: "retime", id: text, to: 0.5 });
        expect(texted.texts?.[0]).toMatchObject({ startUs: 1_000_000, endUs: 1_100_000 });
        texted = applyOp(texted, { op: "retime", id: text, from: 4 });
        expect(texted.texts?.[0]).toMatchObject({ startUs: 4_000_000, endUs: 4_100_000 });
    });

    describe("a zoom meets only zooms of its own target, and retime at or by keeps its length", () => {
        const longer = { ...source, durationUs: 20_000_000 };
        const spanOf = (project: ReturnType<typeof wholeProject>, id: string) => {
            const zoom = project.zooms.find((item) => item.id === id);
            return [zoom?.startUs, zoom?.endUs];
        };

        test("retime moves or stretches a zoom over a zoom of the other target, and a drag still stops at its own target", () => {
            let project = applyOp(wholeProject(longer), { op: "zoom", from: 2, to: 4, target: "canvas" });
            project = applyOp(project, { op: "zoom", from: 5, to: 7 });
            const canvas = project.zooms.find((zoom) => zoom.target === "canvas")?.id ?? "";
            const picture = project.zooms.find((zoom) => !zoom.target)?.id ?? "";
            expect(spanOf(applyOp(project, { op: "retime", id: canvas, to: 8 }), canvas)).toEqual([
                2_000_000, 8_000_000,
            ]);
            // The editor's drag sends both edges.
            expect(spanOf(applyOp(project, { op: "retime", id: canvas, from: 6, to: 8 }), canvas)).toEqual([
                6_000_000, 8_000_000,
            ]);
            expect(spanOf(applyOp(project, { op: "retime", id: canvas, at: 6 }), canvas)).toEqual([
                6_000_000, 8_000_000,
            ]);
            expect(spanOf(applyOp(project, { op: "retime", id: picture, at: 2 }), picture)).toEqual([
                2_000_000, 4_000_000,
            ]);

            let same = applyOp(wholeProject(longer), { op: "zoom", from: 2, to: 4 });
            same = applyOp(same, { op: "zoom", from: 5, to: 7 });
            const first = same.zooms[0]?.id ?? "";
            expect(spanOf(applyOp(same, { op: "retime", id: first, from: 6, to: 8 }), first)).toEqual([
                4_800_000, 5_000_000,
            ]);
        });

        test("retime at or by keeps a zoom's length: it reaches free space past a zoom, goes past a zoom it meets with a warning, and no room is refused", () => {
            let project = applyOp(wholeProject(longer), { op: "zoom", from: 1, to: 3 });
            project = applyOp(project, { op: "zoom", from: 7, to: 9 });
            const [first, second] = project.zooms.map((zoom) => zoom.id);
            const met = { op: "retime", id: first ?? "", at: 6.5 } as const;
            const moved = applyOp(project, met);
            expect(spanOf(moved, first ?? "")).toEqual([9_000_000, 11_000_000]);
            expect(opPlacementWarnings(met, project, moved)).toEqual([
                `retime: ${first} met another zoom at 6.5 s, so it went to 9-11 s (two zooms of one target cannot overlap)`,
            ]);
            const free = { op: "retime", id: first ?? "", at: 12 } as const;
            const clear = applyOp(project, free);
            expect(spanOf(clear, first ?? "")).toEqual([12_000_000, 14_000_000]);
            expect(opPlacementWarnings(free, project, clear)).toEqual([]);
            expect(spanOf(applyOp(project, { op: "retime", id: second ?? "", by: -5.5 }), second ?? "")).toEqual([
                3_000_000, 5_000_000,
            ]);

            let full = applyOp(wholeProject(longer), { op: "zoom", from: 1, to: 3 });
            full = applyOp(full, { op: "zoom", from: 7, to: 19.5 });
            expect(() => applyOp(full, { op: "retime", id: full.zooms[0]?.id ?? "", at: 18 })).toThrow("no room");
        });
    });

    test("auto zoom takes the first zoom's scale, and a range spotlight follows a recorded cursor", () => {
        const project = applyOp(withCursor(), { op: "zoom", from: 8, to: 9, scale: 2.2 });
        const zoomed = applyOp(project, { op: "autoZoom" });
        expect(zoomed.zooms.filter((zoom) => zoom.mode === "follow").map((zoom) => zoom.scale)).toEqual([2.2, 2.2]);
        expect(applyOp(withCursor(), { op: "autoZoom" }).zooms.map((zoom) => zoom.scale)).toEqual([1.6, 1.6]);

        const range = { op: "range", from: 1, to: 3, action: "spotlight" } as const;
        expect(applyOp(withCursor(), range).redactions?.[0]?.follow).toBe(true);
        expect(applyOp(wholeProject(source), range).redactions?.[0]).not.toHaveProperty("follow");
    });

    test("the window's defaults are written as absent: the source canvas, the whole movie, no click sound, a looped music start", () => {
        const framed = applyOp(wholeProject(source), { op: "frame", aspect: "16:9", fit: "cover" });
        expect(framed.frame).toMatchObject({ aspect: "16:9", fit: "cover" });
        const back = applyOp(framed, { op: "frame", aspect: "source", fit: "contain" });
        expect(back.frame).not.toHaveProperty("aspect");
        expect(back.frame).not.toHaveProperty("fit");

        const clicks = applyOp(wholeProject(withClickTrack(source)), { op: "clicks", highlight: true, sound: false });
        expect(clicks.clicks).not.toHaveProperty("sound");

        const file = join(workspace(), "music.mp3");
        writeFileSync(file, "not really music");
        const music = applyOp(wholeProject(source), { op: "music", file, startMs: 0, loop: true }).audio.music;
        expect(music).not.toHaveProperty("startMs");
        expect(music).not.toHaveProperty("loop");
    });
});

// Regression test: hunt 2026-11-09 circle-shape-aspect, the circles were ovals on every picture shape but one.
describe("a music duck while ducking() is set", () => {
    const base = wholeProject({ video: "/movie/screen.mp4", durationUs: 10_000_000, width: 100, height: 100 });
    const withAudio = (ducking: boolean, duck: number) =>
        editProjectSchema.parse({
            ...base,
            audio: {
                ...base.audio,
                music: { file: "/movie/song.mp3", duck },
                ...(ducking ? { ducking: { db: 12 } } : {}),
            },
        });

    test("warns that the duck share does nothing while ducking's dB decides the drop", () => {
        const before = withAudio(true, 0.6);
        expect(opPlacementWarnings({ op: "music", duck: 0.3 }, before, withAudio(true, 0.3))).toEqual([
            "music: duck 0.3 does nothing while ducking() is set; the music drops 12 dB under speech. Change it with ducking({ db }), or ducking({ enabled: false }) to go back to the duck share",
        ]);
    });

    test("says nothing for the saved duck sent again, or without ducking", () => {
        expect(opPlacementWarnings({ op: "music", duck: 0.6 }, withAudio(true, 0.6), withAudio(true, 0.6))).toEqual([]);
        expect(opPlacementWarnings({ op: "music", duck: 0.3 }, withAudio(false, 0.6), withAudio(false, 0.3))).toEqual(
            []
        );
    });
});

describe("a circle placed at a point or a click", () => {
    const pictures = [
        { width: 1920, height: 1080 },
        { width: 780, height: 1688 },
    ];
    const ofSize = ({ width, height }: { width: number; height: number }) =>
        wholeProject({ video: "/movies/screen.mp4", durationUs: 10_000_000, width, height });
    const pixels = (
        shape: { x1: number; y1: number; x2: number; y2: number } | undefined,
        { width, height }: { width: number; height: number }
    ) => ({
        wide: ((shape?.x2 ?? 0) - (shape?.x1 ?? 0)) * width,
        tall: ((shape?.y2 ?? 0) - (shape?.y1 ?? 0)) * height,
    });
    const inPicture = (shape: { x1: number; y1: number; x2: number; y2: number } | undefined) =>
        [shape?.x1, shape?.y1, shape?.x2, shape?.y2].every((value) => value !== undefined && value >= 0 && value <= 1);

    test("is round in pixels on a landscape and a portrait picture", () => {
        for (const picture of pictures) {
            const click = annotateClicks(ofSize(picture), [{ ms: 1000, x: 0.5, y: 0.5, click: "left" }]).project;
            const ring = pixels(click.shapes?.[0], picture);
            expect(Math.abs(ring.wide - ring.tall)).toBeLessThan(1);
            const placed = applyOp(ofSize(picture), {
                op: "shape",
                from: 2,
                to: 4,
                kind: "circle",
                at: { x: 0.5, y: 0.5 },
            });
            const circle = pixels(placed.shapes?.[0], picture);
            expect(Math.abs(circle.wide - circle.tall)).toBeLessThan(1);
        }
    });

    test("near an edge moves inward and stays round inside the picture", () => {
        for (const picture of pictures) {
            for (const at of [
                { x: 0.99, y: 0.5 },
                { x: 0.01, y: 0.99 },
            ]) {
                const click = annotateClicks(ofSize(picture), [{ ms: 1000, ...at, click: "left" }]).project.shapes?.[0];
                const placed = applyOp(ofSize(picture), { op: "shape", from: 2, to: 4, kind: "circle", at })
                    .shapes?.[0];

                for (const shape of [click, placed]) {
                    const size = pixels(shape, picture);
                    expect(inPicture(shape)).toBe(true);
                    expect(Math.abs(size.wide - size.tall)).toBeLessThan(1);
                }
            }
        }
    });

    test("a circle every click is 97 px on 1920x1080 and 70 px on 780x1688, a placed circle 130 px and 94 px", () => {
        const sizes = pictures.map((picture) => {
            const click = annotateClicks(ofSize(picture), [{ ms: 1000, x: 0.5, y: 0.5, click: "left" }]).project;
            const placed = applyOp(ofSize(picture), {
                op: "shape",
                from: 2,
                to: 4,
                kind: "circle",
                at: { x: 0.5, y: 0.5 },
            });
            return [pixels(click.shapes?.[0], picture).wide, pixels(placed.shapes?.[0], picture).wide].map(Math.round);
        });
        expect(sizes).toEqual([
            [97, 130],
            [70, 94],
        ]);
    });
});

describe("a move or resize of a hidden part with keyframes", () => {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
    // The case RecorderHuntTrackedPartMoveTests pins in Swift: keys at 1 s and 3 s, the stored rect on the first key.
    const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
    function tracked() {
        const project = applyOp(wholeProject(source), {
            op: "redact",
            from: 1,
            to: 3,
            style: "black",
            rect: box,
            track: [
                { at: 1, ...box },
                { at: 3, ...box, y: 0.5 },
            ],
        });
        return { project, id: project.redactions?.[0]?.id ?? "" };
    }

    test("setRedaction rect moves every keyframe by the same amount, so the renderer draws the part where it was put", () => {
        const { project, id } = tracked();
        const moved = applyOp(project, { op: "setRedaction", id, rect: { ...box, x: 0.2 } });
        const part = moved.redactions?.[0];
        expect(part?.track?.map((key) => [key.atUs, key.x, key.y])).toEqual([
            [1_000_000, expect.closeTo(0.2, 6), expect.closeTo(0.1, 6)],
            [3_000_000, expect.closeTo(0.2, 6), expect.closeTo(0.5, 6)],
        ]);
        expect(part && redactionBoxAt(part, 2_000_000)).toEqual({
            x: expect.closeTo(0.2, 6),
            y: expect.closeTo(0.3, 6),
            width: expect.closeTo(0.2, 6),
            height: expect.closeTo(0.05, 6),
        });
        expect(part).toMatchObject({ x: 0.2, y: 0.1, width: 0.2, height: 0.05 });
    });

    test("setRedaction rect scales every keyframe's size by the same ratio (the case the Swift test pins)", () => {
        const { project, id } = tracked();
        const moved = applyOp(project, { op: "setRedaction", id, rect: { x: 0.2, y: 0.15, width: 0.3, height: 0.1 } });
        const keys = moved.redactions?.[0]?.track?.map((key) => [key.atUs, key.x, key.y, key.width, key.height]);
        expect(keys).toEqual([
            [
                1_000_000,
                expect.closeTo(0.2, 6),
                expect.closeTo(0.15, 6),
                expect.closeTo(0.3, 6),
                expect.closeTo(0.1, 6),
            ],
            [
                3_000_000,
                expect.closeTo(0.2, 6),
                expect.closeTo(0.55, 6),
                expect.closeTo(0.3, 6),
                expect.closeTo(0.1, 6),
            ],
        ]);
    });

    test("a move past the picture's edge keeps every keyframe inside it", () => {
        const { project, id } = tracked();
        const moved = applyOp(project, { op: "setRedaction", id, rect: { ...box, x: 0.75, y: 0.6 } });
        for (const key of moved.redactions?.[0]?.track ?? []) {
            expect(key.x + key.width).toBeLessThanOrEqual(1 + 1e-9);
            expect(key.y + key.height).toBeLessThanOrEqual(1 + 1e-9);
        }

        expect(moved.redactions?.[0]?.track?.map((key) => key.x)).toEqual([0.75, 0.75]);
        expect(moved.redactions?.[0]?.track?.[1]?.y).toBeCloseTo(0.95, 6);
    });

    test("setRedaction track replaces the keyframes as given (inside the picture), and [] makes the part fixed", () => {
        const { project, id } = tracked();
        const op = editOpSchema.parse({
            op: "setRedaction",
            id,
            rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
            track: [
                { at: 3, x: 0.9, y: 0.2, width: 0.2, height: 0.05 },
                { at: 1, x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
            ],
        });
        const replaced = applyOp(project, op).redactions?.[0];
        expect(replaced?.track?.map((key) => [key.atUs, key.x, key.y])).toEqual([
            [1_000_000, 0.4, 0.4],
            [3_000_000, 0.8, 0.2],
        ]);
        expect(replaced).toMatchObject({ x: 0.4, y: 0.4 });
        const fixed = applyOp(project, editOpSchema.parse({ op: "setRedaction", id, track: [] })).redactions?.[0];
        expect(fixed).not.toHaveProperty("track");
        expect(fixed && redactionBoxAt(fixed, 2_000_000)).toEqual(box);
    });

    test("follow on a part with keyframes is refused, because the part follows its text", () => {
        const { project, id } = tracked();
        expect(() => applyOp(project, { op: "setRedaction", id, follow: true })).toThrow("follows its text");
        const fixed = applyOp(project, editOpSchema.parse({ op: "setRedaction", id, follow: true, track: [] }));
        expect(fixed.redactions?.[0]).toMatchObject({ follow: true });
        expect(fixed.redactions?.[0]).not.toHaveProperty("track");
        expect(() =>
            applyOp(wholeProject(source), {
                op: "redact",
                from: 1,
                to: 3,
                rect: box,
                follow: true,
                track: [
                    { at: 1, ...box },
                    { at: 3, ...box, y: 0.5 },
                ],
            })
        ).toThrow("follows its text");
    });
});

describe("noise reduction on export", () => {
    const source = { video: "/rec/screen.mp4", durationUs: 10_000_000, width: 100, height: 100 };

    test("the op sets and merges the settings, turns the sound on, and enabled false takes them away", () => {
        const muted = { ...wholeProject(source), audio: { include: false, volume: 1, mutedTracks: [] } };
        const once = applyOp(muted, { op: "denoise" });
        const stronger = applyOp(once, { op: "denoise", reductionDb: 20, tracks: [1] });

        expect(once.audio).toMatchObject({ include: true, denoise: { method: "afftdn", reductionDb: 12 } });
        expect(stronger.audio.denoise).toEqual({ method: "afftdn", reductionDb: 20, tracks: [1] });
        expect(applyOp(stronger, { op: "denoise", enabled: false }).audio).not.toHaveProperty("denoise");
    });

    test("the cleaned copy filters the chosen tracks, copies the others and the picture", () => {
        const argv = denoisedSourceArgv({
            source: "/rec/screen.mp4",
            output: "/rec/.denoise/screen-x.mp4",
            audioTracks: 2,
            settings: denoiseSchema.parse({ tracks: [1] }),
        });

        expect(argv.join(" ")).toContain(
            "-c:v copy -c:a:0 copy -filter:a:1 afftdn=nr=12:nf=-50:tn=1 -c:a:1 aac -b:a:1 192k"
        );
        expect(argv.at(-1)).toBe("/rec/.denoise/screen-x.mp4");
    });

    test("a track can have its own strength: the op merges it and the copy filters that track at it", () => {
        let project = applyOp(wholeProject(source), { op: "denoise", reductionDb: 10, trackReductionDb: { "1": 20 } });
        project = applyOp(project, { op: "denoise", trackReductionDb: { "0": 6 } });
        expect(project.audio.denoise?.trackReductionDb).toEqual({ "0": 6, "1": 20 });
        const argv = denoisedSourceArgv({
            source: "/rec/screen.mp4",
            output: "/rec/.denoise/screen-x.mp4",
            audioTracks: 3,
            settings: denoiseSchema.parse({ ...project.audio.denoise, tracks: [0, 2] }),
        }).join(" ");
        expect(argv).toContain("-filter:a:0 afftdn=nr=6:nf=-50:tn=1");
        expect(argv).toContain("-c:a:1 copy");
        expect(argv).toContain("-filter:a:2 afftdn=nr=10:nf=-50:tn=1");
        expect(() => applyOp(project, { op: "denoise", trackReductionDb: { "0": 60 } })).toThrow();
    });

    test("the copy's name changes with the settings and the source, so a stale copy is never reused", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-denoise-"));
        const movie = join(dir, "screen.mp4");
        writeFileSync(movie, "a");
        const first = denoisedSourcePath(movie, denoiseSchema.parse({}));

        expect(first).toStartWith(join(dir, ".denoise", "screen-"));
        expect(denoisedSourcePath(movie, denoiseSchema.parse({}))).toBe(first);
        expect(denoisedSourcePath(movie, denoiseSchema.parse({ reductionDb: 20 }))).not.toBe(first);
        writeFileSync(movie, "ab");
        expect(denoisedSourcePath(movie, denoiseSchema.parse({}))).not.toBe(first);
    });
});

describe("the transcript beside a cleaned copy", () => {
    // Round 1 hunt (denoise-render-sidecars): the transcript beside the cleaned movie was copied only once, so after
    // a new transcription a denoised export burned in the old captions while the subtitle file had the new ones.
    test("the transcript beside the cleaned copy follows the source's on every export, and goes when the source's goes", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-denoise-"));
        mkdirSync(join(dir, ".denoise"));
        const transcript = transcriptCachePath(join(dir, "screen.mp4"));
        const copy = transcriptCachePath(join(dir, ".denoise", "screen-x.mp4"));

        writeFileSync(transcript, '{"segments":[{"start":0,"end":1,"text":"OLD"}]}');
        syncDenoisedTranscript({ transcript, copy });
        expect(readFileSync(copy, "utf8")).toContain("OLD");

        writeFileSync(transcript, '{"segments":[{"start":0,"end":1,"text":"NEW"}]}');
        syncDenoisedTranscript({ transcript, copy });
        expect(readFileSync(copy, "utf8")).toContain("NEW");

        unlinkSync(transcript);
        syncDenoisedTranscript({ transcript, copy });
        expect(existsSync(copy)).toBe(false);
        expect(() => syncDenoisedTranscript({ transcript, copy })).not.toThrow();
    });
});

describe("cutting by the transcript", () => {
    const segments = [
        { text: "Hello, ehm, my name is Ann", start: 10, end: 13 },
        { text: "Hmm, hmm. We start jako now", start: 20, end: 22 },
        {
            text: "you know it",
            start: 30,
            end: 32,
            words: [
                { word: "you", start: 30, end: 30.2 },
                { word: "know", start: 30.3, end: 30.6 },
                { word: "it", start: 31.5, end: 31.8 },
            ],
        },
    ];

    test("a word's time is estimated from its letters, and the provider's word times win when present", () => {
        expect(wordSpans(segments[0])[1]).toEqual({
            word: "ehm,",
            start: 10 + (3 * 7) / 26,
            end: 10 + (3 * 11) / 26,
            estimated: true,
        });
        expect(wordCuts({ segments, atSec: 31, words: "you know", padMs: 0 })).toEqual([
            { text: "you know", fromUs: 30_000_000, toUs: 30_600_000, line: 30, estimated: false },
        ]);
        expect(() => wordCuts({ segments, atSec: 25, words: "x" })).toThrow("nobody speaks at 25 s");
        expect(() => wordCuts({ segments, atSec: 11, words: "goodbye" })).toThrow('does not say "goodbye"');
    });

    test("fillers: sounds by default, the filler words only with level all, a run of fillers as one cut", () => {
        const sounds = fillerCuts({ segments, fillers: fillerList({ language: "cs" }), padMs: 0 });
        expect(sounds.map((cut) => cut.text)).toEqual(["ehm,", "Hmm, hmm."]);
        const all = fillerCuts({ segments, fillers: fillerList({ language: "cs", level: "all" }), padMs: 0 });
        expect(all.map((cut) => cut.text)).toEqual(["ehm,", "Hmm, hmm.", "jako"]);
        expect(fillerList({ words: ["Ehm!"] })).toEqual(["ehm"]);
        const lists = { cs: { sounds: ["ach"], words: ["tedy"] }, de: { sounds: ["äh"], words: [] } };
        expect(fillerList({ language: "cs", lists })).toEqual(["ach"]);
        expect(fillerList({ language: "cs", level: "all", lists })).toEqual(["ach", "tedy"]);
        expect(fillerList({ lists })).toEqual(["ach", "äh"]);
        expect(() => fillerList({ language: "en", lists })).toThrow("known: cs, de");
        expect(() => fillerList({ language: "xx" })).toThrow('no filler list for "xx"');
    });

    test("touching cuts join, and the op cuts the movie where the words were", () => {
        expect(
            cutRanges([
                { text: "a", fromUs: 5, toUs: 10, line: 0, estimated: true },
                { text: "b", fromUs: 9, toUs: 12, line: 0, estimated: true },
                { text: "c", fromUs: 20, toUs: 25, line: 0, estimated: true },
            ])
        ).toEqual([
            { fromUs: 20, toUs: 25 },
            { fromUs: 5, toUs: 12 },
        ]);
        const project = wholeProject({ video: "/rec/screen.mp4", durationUs: 40_000_000, width: 100, height: 100 });
        const cut = applyOp(project, { op: "cutFillers", language: "cs", padMs: 0 }, { transcript: segments });

        const removed = cutRanges(fillerCuts({ segments, fillers: fillerList({ language: "cs" }), padMs: 0 })).reduce(
            (sum, range) => sum + range.toUs - range.fromUs,
            0
        );

        expect(Math.abs(removed - (461_538 + 666_667))).toBeLessThanOrEqual(1);
        expect(outputDurationUs(cut)).toBe(40_000_000 - removed);
        expect(() => applyOp(project, { op: "cutFillers" })).toThrow("needs the transcript");
    });

    // The editor window sends these ops through tools recorder apply; the cases pin what each one cuts.
    for (const item of transcriptCuts.cases) {
        test(`transcript cut case: ${item.name}`, () => {
            const project = wholeProject({
                video: "/rec/screen.mp4",
                durationUs: transcriptCuts.durationUs,
                width: 1920,
                height: 1080,
            });
            const clips = "clips" in item ? item.clips : undefined;

            if (clips) {
                project.clips = clips.map(([fromUs, toUs, speed], index) => ({ id: `c${index}`, fromUs, toUs, speed }));
            }

            const run = () =>
                applyOp(project, editOpSchema.parse(item.op), {
                    transcript: transcriptSegmentSchema.array().parse(transcriptCuts.segments),
                });

            if ("throws" in item) {
                expect(run).toThrow(item.throws);
                return;
            }

            expect(run().clips.map((clip) => [clip.fromUs, clip.toUs, clip.speed])).toEqual(item.after);
        });
    }

    // Regression test: 2026-11-05 review of the editor gaps, R1.2. The window named a picked word by its place in the
    // line only, so a transcript that gained an earlier "go" cut that one instead of the word the picker showed.
    test("a word pick sent with its times cuts those words after the transcript changed, and refuses when they are gone", () => {
        const project = wholeProject({ video: "/rec/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 });
        // The window read the line as "go go" and picked the second word, 5 s to 6 s; now the line has an earlier "go".
        const now = transcriptSegmentSchema.array().parse([
            {
                start: 3,
                end: 7,
                text: "go go go",
                words: [
                    { word: "go", start: 3, end: 4 },
                    { word: "go", start: 4, end: 5 },
                    { word: "go", start: 5, end: 6 },
                ],
            },
        ]);
        const pick = { op: "cutWords", at: 4, words: "go", occurrence: 2, from: 5, to: 6 };
        const cut = applyOp(project, editOpSchema.parse(pick), { transcript: now });
        expect(cut.clips.map((clip) => [clip.fromUs, clip.toUs])).toEqual([
            [0, 4_960_000],
            [6_040_000, 10_000_000],
        ]);
        expect(() => applyOp(project, editOpSchema.parse({ ...pick, from: 7.5, to: 8 }), { transcript: now })).toThrow(
            "the transcript changed since the words were picked"
        );
    });

    test("a word pick with only one of its times is refused, so a half-sent place never falls back to the count", () => {
        const project = wholeProject({ video: "/rec/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 });
        const now = transcriptSegmentSchema.array().parse([{ start: 3, end: 7, text: "go go", words: [] }]);
        const half = editOpSchema.parse({ op: "cutWords", at: 4, words: "go", occurrence: 2, from: 5 });
        expect(() => applyOp(project, half, { transcript: now })).toThrow("cutWords takes from and to together");
    });
});

describe("camera bubble", () => {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };

    test("a camera op places the bubble; x or y makes the corner custom; enabled false removes it", () => {
        let project = applyOp(wholeProject(source), { op: "camera", file: "camera.mov" });
        expect(project.camera).toMatchObject({
            file: "camera.mov",
            corner: "bottomRight",
            shape: "circle",
            show: true,
        });
        project = applyOp(project, { op: "camera", x: 0.2, y: 0.3, size: 0.3, shape: "rounded" });
        expect(project.camera).toMatchObject({ corner: "custom", x: 0.2, y: 0.3, size: 0.3, shape: "rounded" });
        expect(editProjectSchema.parse(SafeJSON.parse(SafeJSON.stringify(project))).camera).toEqual(project.camera);
        expect(applyOp(project, { op: "camera", enabled: false }).camera).toBeUndefined();
        expect(() => applyOp(wholeProject(source), { op: "camera", show: false })).toThrow("has no camera yet");
    });

    // The Swift editor's drag and Style controls apply the same cases (CameraBubbleTests.swift), so edit.json matches.
    for (const item of cameraOps.cases) {
        test(`shared camera op case: ${item.name}`, () => {
            const before = item.before ? cameraBubbleSchema.parse(item.before) : undefined;
            const project = applyOp({ ...wholeProject(source), camera: before }, cameraOpSchema.parse(item.op));
            expect<unknown>(project.camera ?? null).toEqual(item.after);
        });
    }

    test("an overlapping hide is a part of its own, a show splits them, and they decide where the bubble draws", () => {
        let project = applyOp(wholeProject(source), { op: "camera", file: "camera.mov" });
        project = applyOp(project, { op: "cameraHide", from: 1, to: 3 });
        const first = project.camera?.hidden[0]?.id;
        project = applyOp(project, { op: "cameraHide", from: 2, to: 5 });
        // The editor window's rule: never merged, so the new part keeps its id (selectable, movable).
        const second = project.camera?.hidden[1]?.id;
        expect(project.camera?.hidden).toEqual([
            { id: first ?? "", startUs: 1_000_000, endUs: 3_000_000 },
            { id: second ?? "", startUs: 2_000_000, endUs: 5_000_000 },
        ]);
        expect(second).not.toBe(first);
        project = applyOp(project, { op: "cameraShow", from: 2, to: 3 });
        expect(project.camera?.hidden).toMatchObject([
            { id: first, startUs: 1_000_000, endUs: 2_000_000 },
            { id: second, startUs: 3_000_000, endUs: 5_000_000 },
        ]);
        const camera = project.camera;

        if (!camera) {
            throw new Error("no camera");
        }

        expect(bubbleShowsAt(camera, 1_500_000)).toBe(false);
        expect(bubbleShowsAt(camera, 2_500_000)).toBe(true);
        expect(bubbleShowsAt({ ...camera, show: false }, 2_500_000)).toBe(false);
        expect(() => applyOp(wholeProject(source), { op: "cameraHide", from: 1, to: 2 })).toThrow("needs a camera");
    });

    test("hidden parts are cameraHide items on an effect lane: their own lane, a lane op, retime", () => {
        let project = applyOp(wholeProject(source), { op: "camera", file: "camera.mov" });
        project = applyOp(project, { op: "cameraHide", from: 1, to: 2 });
        const id = project.camera?.hidden[0]?.id ?? "";
        expect(laneItems(project).find((item) => item.id === id)).toMatchObject({
            kind: "cameraHide",
            startUs: 1_000_000,
        });
        // No saved lane holds camera parts, so they get an automatic lane of their own after the zoom lane.
        expect(resolveLanes(project).map((entry) => entry.lane.id)).toEqual(["zooms", "auto-cameraHide"]);
        project = applyOp(project, { op: "addLane", kinds: ["cameraHide"], name: "Camera" });
        const laneId = resolveLanes(project).find((entry) => entry.lane.name === "Camera")?.lane.id ?? "";
        project = applyOp(project, { op: "cameraHide", from: 6, to: 7, lane: laneId });
        expect(project.camera?.hidden.at(-1)).toMatchObject({ startUs: 6_000_000, lane: laneId });
        expect(() => applyOp(project, { op: "cameraHide", from: 8, to: 9, lane: "zooms" })).toThrow("not cameraHide");
        project = applyOp(project, { op: "retime", id, at: 3 });
        expect(project.camera?.hidden.find((item) => item.id === id)).toMatchObject({
            startUs: 3_000_000,
            endUs: 4_000_000,
        });
    });

    test("an edit saved before the lanes reads its hidden parts with an id from their start", () => {
        const old = editProjectSchema.parse({
            ...wholeProject(source),
            camera: { file: "camera.mov", hidden: [{ startUs: 1_000_000, endUs: 2_000_000 }] },
        });
        expect(old.camera?.hidden).toEqual([
            { id: `k${(1_000_000).toString(36)}`, startUs: 1_000_000, endUs: 2_000_000 },
        ]);
    });

    test("a corner keeps the margin from two edges; a custom centre stays inside the canvas", () => {
        const camera = applyOp(wholeProject(source), { op: "camera", file: "camera.mov", size: 0.2 }).camera;

        if (!camera) {
            throw new Error("no camera");
        }

        const canvas = { width: 1920, height: 1080 };
        const corner = bubbleRect(camera, canvas);
        expect(corner.side).toBeCloseTo(216);
        expect(corner.x).toBeCloseTo(1920 - 0.035 * 1080 - 108);
        expect(corner.y).toBeCloseTo(1080 - 0.035 * 1080 - 108);
        const custom = bubbleRect({ ...camera, corner: "custom", x: 1, y: 0 }, canvas);
        expect([custom.x, custom.y]).toEqual([1920 - 108, 108]);
    });

    test("a new edit takes the camera from camera.json: its place and the start difference", () => {
        const folder = mkdtempSync(join(tmpdir(), "camera-sidecar-"));
        const video = join(folder, "screen.mp4");
        writeFileSync(
            join(folder, CAMERA_SIDECAR),
            SafeJSON.stringify({
                version: 1,
                file: "camera.mov",
                startedAt: "2026-11-05T10:00:01.250Z",
                screenStartedAt: "2026-11-05T10:00:01.000Z",
                placement: { x: 0.1, y: 0.9, size: 0.3, shape: "square" },
            })
        );
        const sidecar = readCameraSidecar(video);
        expect(sidecar?.file).toBe("camera.mov");

        if (!sidecar) {
            throw new Error("no sidecar");
        }

        expect(bubbleFromSidecar(sidecar)).toMatchObject({
            offsetMs: 250,
            corner: "custom",
            x: 0.1,
            y: 0.9,
            size: 0.3,
            shape: "square",
        });
        writeFileSync(join(folder, CAMERA_SIDECAR), '{ "version": 2 }');
        expect(readCameraSidecar(video)).toBeUndefined();
    });
});

describe("the camera on the screen's clock", () => {
    const T0 = Date.parse("2026-11-09T10:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();

    function folderWith(sidecar: Record<string, unknown>): string {
        const folder = mkdtempSync(join(tmpdir(), "camera-align-"));
        writeFileSync(join(folder, CAMERA_SIDECAR), SafeJSON.stringify({ version: 1, file: "camera.mov", ...sidecar }));
        writeFileSync(join(folder, "camera.mov"), "raw camera movie");
        return folder;
    }

    test("each screen span is the camera's stretch of the same wall time; a span before the camera is its first frame", () => {
        const spans = [
            { sourceStartMs: 0, firstFrameEpochMs: 11_370, lengthMs: 5000 },
            { sourceStartMs: 5000, firstFrameEpochMs: 17_100, lengthMs: 3000 },
        ];
        expect(cameraTrimPlan({ cameraStartedAt: 10_000, spans })).toEqual({
            padHeadMs: 0,
            ranges: [
                { startMs: 1370, endMs: 6370 },
                { startMs: 7100, endMs: 10_100 },
            ],
        });
        // The camera's first frame came 630 ms after the screen's: that head is the camera's first frame held.
        expect(cameraTrimPlan({ cameraStartedAt: 12_000, spans })).toEqual({
            padHeadMs: 630,
            ranges: [
                { startMs: 0, endMs: 4370 },
                { startMs: 5100, endMs: 8100 },
            ],
        });
    });

    test("one span is cut too, so the camera's footage of a pause before the stop leaves camera.mov", async () => {
        const folder = folderWith({
            startedAt: iso(T0 + 250),
            screenStartedAt: iso(T0),
            clock: "wall",
        });
        const commands: string[][] = [];
        const result = await alignCameraMovie({
            folder,
            spans: [{ sourceStartMs: 0, firstFrameEpochMs: T0 + 1400, lengthMs: 8000 }],
            runCommand: async (command) => {
                commands.push(command);
                writeFileSync(command.at(-1) ?? "", "cut camera movie");
            },
        });
        expect(result).toEqual({ result: "trimmed" });
        expect(commands).toHaveLength(1);
        // Only the span's 8 s from 1.15 s of camera time stay: the paused tail after it is cut away.
        expect(commands[0]?.join(" ")).toContain("select='gte(t,1.150000)*lt(t,9.150000)'");
        expect(readFileSync(join(folder, "camera.mov"), "utf8")).toBe("cut camera movie");
        const sidecar = readCameraSidecar(join(folder, "screen.mp4"));
        expect(sidecar).toMatchObject({ screenStartedAt: iso(T0 + 1400), clock: "screen" });
        expect(sidecar && bubbleFromSidecar(sidecar).offsetMs).toBe(0);
    });

    test("a face that left out the paused time it saw is not cut: only its offset moves to the first frame", async () => {
        const folder = folderWith({ startedAt: iso(T0 + 250), screenStartedAt: iso(T0) });
        const before = statSync(join(folder, "camera.mov")).size;
        const result = await alignCameraMovie({
            folder,
            spans: [
                { sourceStartMs: 0, firstFrameEpochMs: T0 + 1400, lengthMs: 2000 },
                { sourceStartMs: 2000, firstFrameEpochMs: T0 + 9000, lengthMs: 2000 },
            ],
            runCommand: async () => {
                throw new Error("an old face's movie is never cut");
            },
        });
        expect(result).toEqual({ result: "offset" });
        expect(statSync(join(folder, "camera.mov")).size).toBe(before);
        expect(readCameraSidecar(join(folder, "screen.mp4"))?.screenStartedAt).toBe(iso(T0 + 1400));
    });

    test("a cut that fails keeps the movie, still counts from the first frame, and says so", async () => {
        const folder = folderWith({ startedAt: iso(T0 + 250), screenStartedAt: iso(T0), clock: "wall" });
        const result = await alignCameraMovie({
            folder,
            spans: [
                { sourceStartMs: 0, firstFrameEpochMs: T0 + 1400, lengthMs: 2000 },
                { sourceStartMs: 2000, firstFrameEpochMs: T0 + 9000, lengthMs: 2000 },
            ],
            runCommand: async () => {
                throw new Error("ffmpeg exited 1");
            },
        });
        expect(result.result).toBe("offset");
        expect(result.warning).toContain("ffmpeg exited 1");
        expect(readFileSync(join(folder, "camera.mov"), "utf8")).toBe("raw camera movie");
        const sidecar = readCameraSidecar(join(folder, "screen.mp4"));
        expect(sidecar?.screenStartedAt).toBe(iso(T0 + 1400));
        expect(sidecar?.clock).toBe("wall");
    });

    test.skipIf(skip.integration)(
        "a wall-clock camera movie is cut to the screen's spans, so a source moment shows the camera at that wall time",
        async () => {
            const folder = mkdtempSync(join(tmpdir(), "camera-align-real-"));
            const movie = join(folder, "camera.mov");
            // Brightness 16 + 20 per second of camera time: a frame says when the camera filmed it.
            await runVideoCommand({
                command: [
                    "ffmpeg",
                    "-nostdin",
                    "-y",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=64x64:r=30:d=10,format=yuv420p,geq=lum='16+20*T':cb=128:cr=128",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-preset",
                    "ultrafast",
                    "-qp",
                    "0",
                    movie,
                ],
            });
            writeFileSync(
                join(folder, CAMERA_SIDECAR),
                SafeJSON.stringify({
                    version: 1,
                    file: "camera.mov",
                    startedAt: iso(T0),
                    screenStartedAt: iso(T0 - 600),
                    clock: "wall",
                })
            );
            const result = await alignCameraMovie({
                folder,
                spans: [
                    { sourceStartMs: 0, firstFrameEpochMs: T0 + 1500, lengthMs: 2000 },
                    { sourceStartMs: 2000, firstFrameEpochMs: T0 + 6000, lengthMs: 2000 },
                ],
            });
            expect(result).toEqual({ result: "trimmed" });
            const sidecar = readCameraSidecar(join(folder, "screen.mp4"));
            expect(sidecar).toMatchObject({
                startedAt: iso(T0 + 1500),
                screenStartedAt: iso(T0 + 1500),
                clock: "screen",
            });
            expect(sidecar && bubbleFromSidecar(sidecar).offsetMs).toBe(0);

            const filmedAt = async (atSeconds: number) => {
                const printed = await runVideoCommand({
                    command: [
                        "ffmpeg",
                        "-nostdin",
                        "-v",
                        "error",
                        "-ss",
                        String(atSeconds),
                        "-i",
                        movie,
                        "-frames:v",
                        "1",
                        "-vf",
                        "signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-",
                        "-f",
                        "null",
                        "-",
                    ],
                });
                return (Number(/YAVG=([\d.]+)/.exec(printed)?.[1]) - 16) / 20;
            };
            // Source 1.0 s is camera 2.5 s; source 3.0 s (the second span, after a 2.5 s gap) is camera 7.0 s.
            expect(Math.abs((await filmedAt(1)) - 2.5)).toBeLessThan(0.1);
            expect(Math.abs((await filmedAt(3)) - 7)).toBeLessThan(0.1);
            const probe = await runVideoCommand({
                command: ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", movie],
            });
            expect(Number(probe.trim())).toBeCloseTo(4, 1);
        },
        60_000
    );
});

test("editor commands replace guarded outputs and force the requested container", () => {
    expect(trimArgv({ input: "in.mp4", output: "out.mp4", fromUs: 0, toUs: 1000000 })).toContain("-y");
    expect(speedArgv({ input: "in.mp4", output: "out.mp4", factor: 2, audio: true })).toContain("-y");
    // A sped-up segment keeps every audio track (system sound and mic), as a trim does.
    expect(speedArgv({ input: "in.mp4", output: "out.mp4", factor: 2, audio: true })).toContain("0:a");
    expect(speedArgv({ input: "in.mp4", output: "out.mp4", factor: 2, audio: true })).not.toContain("0:a:0");

    for (const format of ["mp4", "webm", "gif"] as const) {
        const args = exportVideoArgv({ input: "in.mp4", output: "out.wrong", format, audioTracks: 1 });
        expect(args).toContain("-y");
        expect(args[args.lastIndexOf("-f") + 1]).toBe(format);
    }
});

// Regression test: deep test 2026-11-06 RE8 — a 20 s WebM took 121 s: libvpx ran one row at a time at its slowest
// speed. Measured on 10 s of 1440p60: these flags cost a third less CPU at an SSIM no lower (0.99911 against 0.99900).
test("a WebM encodes rows in parallel at speed 3, with the CRF that keeps its quality", () => {
    const args = exportVideoArgv({ input: "in.mp4", output: "out.webm", format: "webm", audioTracks: 1 }).join(" ");

    expect(args).toContain("-c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 -deadline good -cpu-used 3");
});

// Regression test: hunt r2-repl-export-all-tracks. Without a map ffmpeg kept one audio track, so an export of a
// recording of system sound and mic lost the mic; the Swift export mixes every track into one.
describe("exportVideoArgv plays every audio track", () => {
    test("two tracks are mixed into one with no level change, the picture mapped beside them", () => {
        const args = exportVideoArgv({ input: "in.mp4", output: "out.mp4", format: "mp4", audioTracks: 2 });
        const joined = args.join(" ");

        expect(joined).toContain("amix=inputs=2:normalize=0");
        expect(joined).toContain("-map [a]");
        expect(joined).toContain("-map 0:v:0");
    });

    test("one track maps it, none drops audio, and a GIF never maps audio", () => {
        expect(
            exportVideoArgv({ input: "in.mp4", output: "o.mp4", format: "mp4", audioTracks: 1 }).join(" ")
        ).toContain("-map 0:a:0");
        expect(exportVideoArgv({ input: "in.mp4", output: "o.webm", format: "webm", audioTracks: 0 })).toContain("-an");
        const gif = exportVideoArgv({ input: "in.mp4", output: "o.gif", format: "gif", audioTracks: 2 }).join(" ");
        expect(gif).not.toContain("amix");
        expect(gif).toContain("-an");
    });
});

test("manifest duration preserves static recordings and the unchanged tail", async () => {
    for (const staticScreen of [true, false]) {
        const source = recordingFolder();
        const manifestFile = join(source, RECORDING_MANIFEST);
        const manifest = readRecordingManifest(source)!;
        if (staticScreen) {
            manifest.frames = [{ file: "frames/d1-0.png", atMs: 0, displayId: 1, changePercent: 0, reason: "first" }];
        }
        manifest.endedAt = "2026-11-03T20:00:12.000Z";
        writeFileSync(manifestFile, SafeJSON.stringify(manifest));
        const result = await new RecordingEditor().run({
            source: { file: source },
            steps: [{ kind: "frames", fps: 2, displays: [1] }],
        }).done;
        expect(result.frames).toHaveLength(24);
        expect(result.frames.at(-1)).toMatchObject({ requestedUs: 11500000, actualUs: staticScreen ? 0 : 4000000 });
    }
});

test("sampling a window retains the frame already on screen at its start", async () => {
    const source = recordingFolder();
    const result = await new RecordingEditor().run({
        source: { file: source },
        steps: [
            { kind: "range", from: 0.5, to: 0.8 },
            { kind: "frames", fps: 2 },
        ],
    }).done;
    expect(result.frames).toHaveLength(2);
    expect(result.frames.every((frame) => frame.actualUs === 0 && frame.requestedUs === 500000)).toBe(true);
});

test("movie export refuses interleaved displays", async () => {
    const source = recordingFolder();
    writeFileSync(join(source, "frames/d2-0.png"), createCanvas(40, 64).toBuffer("image/png"));
    await expect(
        new RecordingEditor().run({ source: { file: source }, steps: [{ kind: "export", format: "mp4" }] }).done
    ).rejects.toThrow("one display");
});

test("video evidence rejects directories before hashing", async () => {
    await expect(
        prepareVideoEvidence({
            input: workspace(),
            outputRoot: workspace(),
            settings: { fps: 1, framesPerImage: 1, minimumDifferencePct: 0 },
        })
    ).rejects.toThrow("Choose a local video file up to 1 GiB");
});

test("an empty or unfinished movie is named as such, not as a file over the size limit", async () => {
    const folder = workspace();
    const empty = join(folder, "empty.mp4");
    writeFileSync(empty, "");
    await expect(probeVideo({ input: empty })).rejects.toThrow("is empty (0 bytes)");
    // The first bytes of an MP4 whose recorder died before it wrote the index.
    const unfinished = join(folder, "unfinished.mp4");
    writeFileSync(
        unfinished,
        Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(4096, 7)])
    );
    const error = await probeVideo({ input: unfinished }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("is not a movie ffprobe can read");
    expect(String(error).split("\n")).toHaveLength(1);
});

test("a still trim keeps the image already on screen for each display", async () => {
    const result = await new RecordingEditor().run({
        source: { file: recordingFolder() },
        steps: [{ kind: "trim", from: 0.25, to: 0.75 }, { kind: "frames" }],
    }).done;
    expect(result.stills).toHaveLength(2);
    expect(result.stills?.map((frame) => frame.atUs)).toEqual([0, 0]);
    expect(result.frames).toHaveLength(2);
});

test("a grid refuses frames invalidated by a transformation", async () => {
    for (const transform of [
        { kind: "trim", from: 1, to: 3 },
        { kind: "speed", factor: 2 },
    ] as const) {
        await expect(
            new RecordingEditor().run({
                source: { file: recordingFolder() },
                steps: [{ kind: "frames" }, transform, { kind: "grid", perImage: 4 }],
            }).done
        ).rejects.toThrow("A grid needs current frames");
    }
});

test.skipIf(skip.integration)("sampled still exports preserve duplicate samples and the range endpoint", async () => {
    const result = await new RecordingEditor().run({
        source: { file: recordingFolder() },
        steps: [
            { kind: "range", from: 0, to: 4 },
            { kind: "frames", fps: 2, displays: [1] },
            { kind: "export", format: "mp4" },
        ],
    }).done;
    const list = readFileSync(join(dirname(result.exports[0].path), "export-mp4.ffconcat"), "utf8");
    const durations = list
        .split("\n")
        .filter((line) => line.startsWith("duration "))
        .map((line) => Number(line.slice(9)));
    expect(durations).toEqual(Array(8).fill(0.5));
});
test("track denoise starts from no cleaned tracks when noise reduction is off", () => {
    const project = projectOps.wholeProject({
        video: "/tmp/fixture.mp4",
        durationUs: 5_000_000,
        width: 640,
        height: 480,
    });
    expect(
        projectOps.applyOp(project, { op: "denoise", track: 1, trackCount: 2, on: true }).audio.denoise?.tracks
    ).toEqual([1]);
    expect(
        projectOps.applyOp(project, { op: "denoise", track: 1, trackCount: 2, on: false }).audio.denoise
    ).toBeUndefined();
});

test("disabling track denoise preserves excluded audio", () => {
    const project = projectOps.wholeProject({
        video: "/tmp/fixture.mp4",
        durationUs: 5_000_000,
        width: 640,
        height: 480,
    });
    project.audio.include = false;
    for (const denoise of [undefined, { method: "afftdn" as const, reductionDb: 12, tracks: [1] }]) {
        const muted = { ...project, audio: { ...project.audio, denoise } };
        const disabled = projectOps.applyOp(muted, { op: "denoise", track: 1, trackCount: 2, on: false });
        expect(disabled.audio.include).toBe(false);
        expect(disabled.audio.denoise).toBeUndefined();
        expect(projectOps.applyOp(muted, { op: "denoise", track: 1, trackCount: 2, on: true }).audio.include).toBe(
            true
        );
    }
});

describe.skipIf(skip.integration)("normalize measures what the export plays", () => {
    const makeTone = async (out: string, seconds: number, volume: string) => {
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                `color=c=black:s=64x64:d=${seconds}`,
                "-f",
                "lavfi",
                "-i",
                `sine=f=440:r=48000:d=${seconds},volume='${volume}':eval=frame`,
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                out,
            ],
            timeoutMs: 60_000,
        });
    };

    test("only the kept clips count, at their played speed, so a cut loud part does not lower the gain", async () => {
        const dir = workspace();
        const movie = join(dir, "loud-then-quiet.mp4");
        const quiet = join(dir, "quiet.mp4");
        await makeTone(movie, 4, "if(lt(t,2),1,0.25)");
        await makeTone(quiet, 2, "0.25");

        const alone = await integratedLoudness({ video: quiet });
        const kept = await integratedLoudness({
            video: movie,
            clips: [{ fromUs: 2_000_000, toUs: 4_000_000, speed: 1 }],
        });
        expect(alone).toBeDefined();
        expect(Math.abs((kept ?? 0) - (alone ?? 0))).toBeLessThan(1);

        const sped = await integratedLoudness({
            video: movie,
            clips: [
                { fromUs: 0, toUs: 400_000, speed: 2 },
                { fromUs: 2_000_000, toUs: 4_000_000, speed: 1 },
            ],
        });
        expect(Number.isFinite(sped)).toBe(true);
    });
});

interface ExportSizeCases {
    cases: Array<{
        name: string;
        source: { width: number; height: number };
        export: { codec: "h264" | "hevc"; maxHeight: number; size?: { width?: number; height?: number } };
        aspect?: "16:9" | "4:3" | "1:1" | "9:16";
        nominalFps: number;
        fps: number;
        canvas: { width: number; height: number };
    }>;
}
