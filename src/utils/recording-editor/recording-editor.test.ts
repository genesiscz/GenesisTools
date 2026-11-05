import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { OverwriteInputError } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import { RECORDING_MANIFEST, readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { skip } from "@genesiscz/utils/test/skip";
import { prepareVideoEvidence } from "@genesiscz/utils/video/evidence";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { createCanvas } from "@napi-rs/canvas";
import { ZodError } from "zod";
import legacyEvidence from "./__fixtures__/legacy-evidence.json";
import { RecordingEditor, sampleTimes } from "./editor";
import { atempoChain, concatList, exportVideoArgv, speedArgv, trimArgv } from "./ffmpeg";
import { parseEditPlan, timeToUs } from "./plan";
import { locateSource } from "./source";

function workspace(): string {
    return mkdtempSync(join(tmpdir(), "gt-editor-"));
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
        const { probeVideo } = await import("@genesiscz/utils/video/probe");
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

test("editor commands replace guarded outputs and force the requested container", () => {
    expect(trimArgv({ input: "in.mp4", output: "out.mp4", fromUs: 0, toUs: 1000000 })).toContain("-y");
    expect(speedArgv({ input: "in.mp4", output: "out.mp4", factor: 2, audio: true })).toContain("-y");
    for (const format of ["mp4", "webm", "gif"] as const) {
        const args = exportVideoArgv({ input: "in.mp4", output: "out.wrong", format });
        expect(args).toContain("-y");
        expect(args[args.lastIndexOf("-f") + 1]).toBe(format);
    }
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

test("sampling refuses a timestamp array beyond its allocation budget", () => {
    expect(() => sampleTimes({ fromUs: 0, toUs: 100_000_000_000_000, fps: 30 })).toThrow("timestamp budget");
    expect(sampleTimes({ fromUs: 0, toUs: 1_000_000, fps: 2 })).toEqual([0, 500_000]);
});

test("rows-only grids derive their columns", async () => {
    const result = await new RecordingEditor().run({
        source: { file: recordingFolder() },
        output: join(workspace(), "rows"),
        steps: [{ kind: "frames" }, { kind: "grid", rows: 1, perImage: 3 }],
    }).done;
    expect(result.sheets[0]).toMatchObject({ rows: 1, columns: 3 });
});
