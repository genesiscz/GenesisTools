import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverwriteInputError } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    bubbleFromSidecar,
    bubbleRect,
    bubbleShowsAt,
    CAMERA_SIDECAR,
    cameraBubbleSchema,
    readCameraSidecar,
} from "@genesiscz/utils/recording-editor/camera";
import { checkProject, fixOps } from "@genesiscz/utils/recording-editor/check";
import {
    addComment,
    commentsPathFor,
    readComments,
    removeComment,
    updateComment,
} from "@genesiscz/utils/recording-editor/comments";
import { idleRanges } from "@genesiscz/utils/recording-editor/idle";
import { laneItems, resolveLanes } from "@genesiscz/utils/recording-editor/lanes";
import {
    annotateClicks,
    applyOp,
    autoZoom,
    cameraOpSchema,
    describeProject,
    editProjectSchema,
    findInTranscript,
    outputDurationUs,
    outputTimeOf,
    parseEditOps,
    partOf,
    readProject,
    replaceWordsInLines,
    shortcutsOf,
    sourceTimeOf,
    transcriptLines,
    wholeProject,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { RECORDING_MANIFEST } from "@genesiscz/utils/screen-recorder/library";
import { skip } from "@genesiscz/utils/test/skip";
import { prepareVideoEvidence } from "@genesiscz/utils/video/evidence";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { createCanvas } from "@napi-rs/canvas";
import { ZodError } from "zod";
import cameraOps from "./__fixtures__/camera-ops.json";
import legacyEvidence from "./__fixtures__/legacy-evidence.json";
import { denoisedSourceArgv, denoisedSourcePath, denoiseSchema } from "./denoise";
import { RecordingEditor } from "./editor";
import { atempoChain, concatList, exportVideoArgv, speedArgv, trimArgv } from "./ffmpeg";
import { parseEditPlan, timeToUs } from "./plan";
import { locateSource } from "./source";
import { formatSubtitles, subtitleCues } from "./subtitles";
import { cutRanges, fillerCuts, fillerList, wordCuts, wordSpans } from "./transcript-cuts";

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

describe.skipIf(skip.integration)("the editor on a video, and the frame review over it", () => {
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
    });

    test("refuses a cut of everything and an overlapping zoom, naming why", () => {
        const project = applyOp(wholeProject(source), { op: "zoom", from: 1, to: 3 });
        expect(() => applyOp(project, { op: "cut", from: 0, to: 10 })).toThrow("whole movie");
        expect(() => applyOp(project, { op: "zoom", from: 2, to: 4 })).toThrow("overlaps zoom");
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

    test("clicks and frame are optional looks with defaults, merged on change and removable", () => {
        const project = wholeProject(source);
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
        expect(() =>
            applyOp(project, { op: "redact", from: 1, to: 3, rect: { x: 0.8, y: 0, width: 0.3, height: 0.1 } })
        ).toThrow("leaves the picture");
        expect(applyOp(hidden, { op: "unredact", id: redaction?.id ?? "" }).redactions).toEqual([]);
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
        expect(describeProject(lit, "/p/edit.json").redactions[0]).toMatchObject({ dim: 0.7, cutout: "rounded" });
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
        expect(applyOp(project, { op: "clicks", sound: true }).clicks).toMatchObject({ highlight: true, sound: true });
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
        expect(() => applyOp(titled, { op: "retime", id: note?.id ?? "", from: 2, to: 2 })).toThrow("at least 0.1 s");
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

    test("the drawn cursor changes only for a movie recorded without the system cursor", () => {
        const dir = workspace();
        const system = join(dir, "system.jsonl");
        const drawn = join(dir, "drawn.jsonl");
        writeFileSync(system, '{"t":0.1,"x":0.5,"y":0.5}\n');
        writeFileSync(drawn, '{"t":0.1,"x":0.5,"y":0.5,"shape":"57a1d610df3e","pw":1440.0}\n');

        const withSystem = wholeProject({ ...source, cursor: system });
        expect(() => applyOp(withSystem, { op: "cursor", size: 2 })).toThrow("system cursor in its picture");

        const withDrawn = wholeProject({ ...source, cursor: drawn });
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

    test("hidden ranges join, split on a show, and decide where the bubble draws", () => {
        let project = applyOp(wholeProject(source), { op: "camera", file: "camera.mov" });
        project = applyOp(project, { op: "cameraHide", from: 1, to: 3 });
        const first = project.camera?.hidden[0]?.id;
        project = applyOp(project, { op: "cameraHide", from: 2, to: 5 });
        expect(project.camera?.hidden).toEqual([{ id: first ?? "", startUs: 1_000_000, endUs: 5_000_000 }]);
        project = applyOp(project, { op: "cameraShow", from: 2, to: 3 });
        expect(project.camera?.hidden).toMatchObject([
            { id: first, startUs: 1_000_000, endUs: 2_000_000 },
            { startUs: 3_000_000, endUs: 5_000_000 },
        ]);
        expect(project.camera?.hidden[1]?.id).not.toBe(first);
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

test("editor commands replace guarded outputs and force the requested container", () => {
    expect(trimArgv({ input: "in.mp4", output: "out.mp4", fromUs: 0, toUs: 1000000 })).toContain("-y");
    expect(speedArgv({ input: "in.mp4", output: "out.mp4", factor: 2, audio: true })).toContain("-y");

    for (const format of ["mp4", "webm", "gif"] as const) {
        const args = exportVideoArgv({ input: "in.mp4", output: "out.wrong", format });
        expect(args).toContain("-y");
        expect(args[args.lastIndexOf("-f") + 1]).toBe(format);
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
