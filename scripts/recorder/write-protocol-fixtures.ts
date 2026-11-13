#!/usr/bin/env bun
/**
 * Writes the recorder protocol fixtures the Swift tests read, from the TypeScript source of truth:
 * `src/recorder/lib/__fixtures__/service-protocol.schemas.json` (protocolJsonSchemas) and
 * `src/recorder/lib/__fixtures__/editor-golden.json` (editorGolden: example ops, edits, op tags, hello's methods) and
 * `src/recorder/lib/__fixtures__/screen-hit-ops.json` (screenHitOpsFixture: screen hits with their edit ops).
 * `src/recorder/lib/service.test.ts` fails when a committed file differs from what this writes.
 *
 * It also writes `src/utils/recording-editor/__fixtures__/frame-rules.json` (frameRules below): cases of the four frame
 * rules that the TypeScript side and the Swift renderer both compute (output and source time, join detection, the zoom
 * clamp, the hidden-part snap), each an input with the value the TypeScript function returns. `recording-editor.test.ts`
 * computes every case again and fails when a rule changed and this was not run; Tests/RecorderFrameRulesTests.swift
 * replays the file against the Swift twins.
 *
 * Run: bun scripts/recorder/write-protocol-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorGolden, protocolJsonSchemas, screenHitOpsFixture } from "@app/recorder/lib/protocol-fixtures";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { zoomView } from "@genesiscz/utils/recording-editor/check";
import { transitionJoins } from "@genesiscz/utils/recording-editor/fx";
import {
    type EditProject,
    editProjectSchema,
    outputTimeOf,
    snappedRedactionSpans,
    sourceTimeOf,
} from "@genesiscz/utils/recording-editor/project";

const ROOT = join(import.meta.dir, "..", "..");
const RECORDER_FIXTURES = join(ROOT, "src", "recorder", "lib", "__fixtures__");
const EDITOR_FIXTURES = join(ROOT, "src", "utils", "recording-editor", "__fixtures__");

type Clip = { id: string; fromUs: number; toUs: number; speed?: number };

/** A 10 s source edit with these clips and extra fields, as the TypeScript side reads it (defaults filled in). */
function edit(clips: Clip[], extra: Record<string, unknown> = {}): EditProject {
    return editProjectSchema.parse({
        version: 1,
        source: { video: "/rec/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 },
        clips,
        ...extra,
    });
}

function part(id: string, startUs: number, endUs: number, style = "blur") {
    return { id, startUs, endUs, x: 0.1, y: 0.1, width: 0.2, height: 0.1, style };
}

const CUT = [
    { id: "c1", fromUs: 0, toUs: 4_000_000 },
    { id: "c2", fromUs: 6_000_000, toUs: 10_000_000 },
];

const TIME_CASES: Array<{ name: string; edit: EditProject; sourceUs: number[]; outUs: number[] }> = [
    {
        name: "one clip at speed 1",
        edit: edit([{ id: "c1", fromUs: 0, toUs: 10_000_000 }]),
        sourceUs: [0, 2_500_000, 10_000_000],
        outUs: [0, 2_500_000, 10_000_000],
    },
    {
        name: "a cut between two clips: a cut moment plays nowhere",
        edit: edit(CUT),
        sourceUs: [0, 3_999_999, 4_000_000, 5_000_000, 6_000_000, 7_500_000, 10_000_000],
        outUs: [0, 3_999_999, 4_000_000, 5_500_000, 8_000_000],
    },
    {
        name: "a sped-up, a slowed and a 3x clip round to whole microseconds",
        edit: edit([
            { id: "c1", fromUs: 0, toUs: 3_000_000, speed: 2 },
            { id: "c2", fromUs: 5_000_000, toUs: 8_000_000, speed: 0.5 },
            { id: "c3", fromUs: 8_000_000, toUs: 10_000_000, speed: 3 },
        ]),
        sourceUs: [1_000_001, 3_000_000, 4_000_000, 5_000_003, 8_000_000, 8_000_001, 9_999_999],
        outUs: [1, 1_499_999, 1_500_000, 4_333_333, 7_499_999, 7_500_000, 8_166_666, 8_166_667],
    },
    {
        name: "clips out of source order",
        edit: edit([
            { id: "c2", fromUs: 6_000_000, toUs: 8_000_000 },
            { id: "c1", fromUs: 1_000_000, toUs: 3_000_000 },
        ]),
        sourceUs: [7_000_000, 2_000_000, 4_000_000, 500_000],
        outUs: [1_000_000, 2_000_000, 3_000_000, 4_000_000],
    },
    {
        name: "a split with no cut: the shared moment belongs to the first clip",
        edit: edit([
            { id: "c1", fromUs: 0, toUs: 5_000_000 },
            { id: "c2", fromUs: 5_000_000, toUs: 10_000_000, speed: 1.5 },
        ]),
        sourceUs: [5_000_000, 7_000_000],
        outUs: [5_000_000, 6_000_000, 8_333_333],
    },
];

const JOIN_CASES: Array<{ name: string; edit: EditProject }> = [
    { name: "no transitions block: every join is a hard cut", edit: edit(CUT) },
    {
        name: "a default crossfade at a cut; a split alone joins nothing",
        edit: edit(
            [
                { id: "c1", fromUs: 0, toUs: 4_000_000 },
                { id: "c2", fromUs: 4_000_000, toUs: 6_000_000 },
                { id: "c3", fromUs: 8_000_000, toUs: 10_000_000 },
            ],
            { transitions: { default: { kind: "crossfade", ms: 600 } } }
        ),
    },
    {
        name: "an own join beats the default, and the half is held inside half of a short clip",
        edit: edit(
            [
                { id: "c1", fromUs: 0, toUs: 1_000_000 },
                { id: "c2", fromUs: 3_000_000, toUs: 3_400_000 },
                { id: "c3", fromUs: 6_000_000, toUs: 10_000_000 },
            ],
            { transitions: { default: { kind: "zoom", ms: 1000 }, joins: { c3: { kind: "blur", ms: 2000 } } } }
        ),
    },
    {
        name: "a join set to none among crossfades",
        edit: edit(
            [
                { id: "c1", fromUs: 0, toUs: 2_000_000 },
                { id: "c2", fromUs: 3_000_000, toUs: 5_000_000 },
                { id: "c3", fromUs: 6_000_000, toUs: 9_000_000 },
            ],
            { transitions: { default: { kind: "crossfade", ms: 400 }, joins: { c2: { kind: "none", ms: 300 } } } }
        ),
    },
    {
        name: "sped-up neighbours hold the half by their played length",
        edit: edit(
            [
                { id: "c1", fromUs: 0, toUs: 2_000_000, speed: 4 },
                { id: "c2", fromUs: 5_000_000, toUs: 9_000_000, speed: 2 },
            ],
            { transitions: { default: { kind: "crossfade", ms: 600 } } }
        ),
    },
    {
        name: "a clip of no length joins nothing and is skipped",
        edit: edit(
            [
                { id: "c1", fromUs: 0, toUs: 2_000_000 },
                { id: "c0", fromUs: 2_000_000, toUs: 2_000_000 },
                { id: "c2", fromUs: 4_000_000, toUs: 6_000_000 },
            ],
            { transitions: { default: { kind: "crossfade", ms: 300 } } }
        ),
    },
];

const ZOOM_CASES: Array<{ name: string; zoom: { scale: number; focusX: number; focusY: number } }> = [
    { name: "a centred focus", zoom: { scale: 2, focusX: 0.5, focusY: 0.5 } },
    { name: "a focus in the top left corner is held inside the picture", zoom: { scale: 2, focusX: 0, focusY: 0 } },
    { name: "a focus on the right edge", zoom: { scale: 1.5, focusX: 1, focusY: 0.3 } },
    { name: "scale 1 shows the whole picture wherever the focus is", zoom: { scale: 1, focusX: 0.9, focusY: 0.1 } },
    { name: "scale 4 near the bottom left", zoom: { scale: 4, focusX: 0.1, focusY: 0.95 } },
    { name: "a focus far enough inside is kept", zoom: { scale: 3, focusX: 0.4, focusY: 0.6 } },
];

const SNAP_CASES: Array<{ name: string; edit: EditProject }> = [
    { name: "no hidden parts", edit: edit(CUT) },
    {
        name: "a blur that ends 200 ms before a cut runs to the cut",
        edit: edit(CUT, { redactions: [part("r1", 1_000_000, 3_800_000)] }),
    },
    {
        name: "a pixelate that starts 150 ms after a cut starts at it",
        edit: edit(CUT, { redactions: [part("r1", 6_150_000, 7_000_000, "pixelate")] }),
    },
    {
        name: "a part 300 ms before a cut keeps its end",
        edit: edit(CUT, { redactions: [part("r1", 1_000_000, 3_700_000)] }),
    },
    {
        name: "two hiding parts 100 ms apart meet; a spotlight keeps its own times",
        edit: edit(CUT, {
            redactions: [
                part("r1", 6_500_000, 7_000_000),
                part("r2", 7_100_000, 8_000_000, "black"),
                part("s1", 1_000_000, 3_900_000, "spotlight"),
            ],
        }),
    },
    {
        name: "short gaps close one after another",
        edit: edit(CUT, {
            redactions: [
                part("r1", 2_000_000, 2_500_000),
                part("r2", 2_600_000, 3_000_000),
                part("r3", 3_100_000, 3_400_000),
            ],
        }),
    },
    {
        name: "snapMs 0 draws every part as placed",
        edit: edit(CUT, { redactions: [part("r1", 1_000_000, 3_800_000)], redactionJoins: { snapMs: 0 } }),
    },
    {
        name: "snapMs 500 reaches a cut and the movie's end 400 ms away",
        edit: edit(CUT, {
            redactions: [part("r1", 1_000_000, 3_600_000), part("r2", 8_600_000, 9_600_000, "black")],
            redactionJoins: { snapMs: 500 },
        }),
    },
];

/** `__fixtures__/frame-rules.json`: each case's input with the value TypeScript computes for it. */
export function frameRules() {
    return {
        about: "Made from the TypeScript source by scripts/recorder/write-protocol-fixtures.ts: cases of the four frame rules that the TypeScript side (check, info, items-at, the agents) and the Swift renderer both compute. recording-editor.test.ts computes every value again; Tests/RecorderFrameRulesTests.swift replays the cases against the Swift twins. Times are microseconds.",
        time: {
            about: "outputTimeOf (project.ts) for each sourceUs, null where that moment was cut, and sourceTimeOf for each outUs. Swift: TimelineMap.outputTime(ofSource:) and sourceTime(atOutput:).",
            cases: TIME_CASES.map((item) => ({
                name: item.name,
                input: { edit: item.edit, sourceUs: item.sourceUs, outUs: item.outUs },
                value: {
                    outputUs: item.sourceUs.map((us) => outputTimeOf(item.edit, us) ?? null),
                    sourceUs: item.outUs.map((us) => sourceTimeOf(item.edit, us)),
                },
            })),
        },
        joins: {
            about: "transitionJoins (fx.ts): every join, with kind none and halfUs 0 where nothing plays. Swift: TransitionLook.joins (RenderFx.swift), which leaves out the joins whose halfUs is 0.",
            cases: JOIN_CASES.map((item) => ({
                name: item.name,
                input: { edit: item.edit },
                value: transitionJoins(item.edit),
            })),
        },
        zoomClamp: {
            about: "zoomView (check.ts): a picture zoom's view at full scale, fractions of the picture from its top left. Swift: ZoomCurve.view (TimelineMap.swift) in the middle of a manual zoom, its rect.",
            cases: ZOOM_CASES.map((item) => ({ name: item.name, input: item.zoom, value: zoomView(item.zoom) })),
        },
        hiddenSnap: {
            about: "snappedRedactionSpans (project.ts): each hidden part's id, style and the source times the export draws it. Swift: RedactionEdges.effective without the movie's frame times.",
            cases: SNAP_CASES.map((item) => ({
                name: item.name,
                input: { edit: item.edit },
                value: snappedRedactionSpans(item.edit).map(({ id, style, startUs, endUs }) => ({
                    id,
                    style,
                    startUs,
                    endUs,
                })),
            })),
        },
    };
}

if (import.meta.main) {
    const files: Array<[string, unknown]> = [
        [join(RECORDER_FIXTURES, "service-protocol.schemas.json"), protocolJsonSchemas()],
        [join(RECORDER_FIXTURES, "editor-golden.json"), editorGolden()],
        [join(RECORDER_FIXTURES, "screen-hit-ops.json"), screenHitOpsFixture()],
        [join(EDITOR_FIXTURES, "frame-rules.json"), frameRules()],
    ];

    for (const [path, content] of files) {
        writeFileSync(path, `${SafeJSON.stringify(content, null, 2)}\n`);
        out.println(`wrote ${path}`);
    }
}
