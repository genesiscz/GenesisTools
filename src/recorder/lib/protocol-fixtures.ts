import {
    applyOp,
    type EditProject,
    editOpSchema,
    editProjectSchema,
    wholeProject,
} from "@genesiscz/utils/recording-editor/project";
import { z } from "zod";
import { type ScreenHitWithOps, screenHitsWithOps } from "./screen-ops";
import type { ScreenHit } from "./screen-search";
import {
    HOST_METHODS,
    hostApi,
    NOTIFICATION_SCHEMAS,
    SERVICE_PROTOCOL,
    serviceApi,
    subscribeParamsSchema,
} from "./service-protocol";
import { moviesApi } from "./toolset";

/**
 * The recorder protocol's schemas as JSON Schema, for the Swift tests: `__fixtures__/service-protocol.schemas.json`.
 * The Swift side checks the answers and notifications its host writes against them, so a field the TypeScript side
 * renames or makes required fails there. `scripts/recorder/write-protocol-fixtures.ts` writes the file and
 * `service.test.ts` fails when it is not what this function makes.
 */

type JsonSchema = Record<string, unknown>;

/**
 * One object schema with a property per name, so a schema several methods share (the edit project, the ops) is
 * written once under `$defs` and named by `$ref`.
 */
function document(schemas: Record<string, z.ZodType>, io: "input" | "output"): JsonSchema {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(z.object(schemas), {
        io,
        unrepresentable: "any",
        reused: "ref",
    });
    return rest;
}

export interface ProtocolSchemas {
    about: string;
    protocol: number;
    /** `properties.<method>`: the params a caller may send (a default makes a field optional). */
    params: JsonSchema;
    /** `properties.<method>`: the result the answering side writes. */
    results: JsonSchema;
    /** `properties.<notification>`: its params. */
    notifications: JsonSchema;
}

export function protocolJsonSchemas(): ProtocolSchemas {
    const params: Record<string, z.ZodType> = { subscribe: subscribeParamsSchema };
    const results: Record<string, z.ZodType> = { subscribe: z.object({ events: z.array(z.string()) }) };

    for (const method of [...serviceApi.methods, ...hostApi.methods]) {
        params[method.name] = method.params;
        results[method.name] = method.result;
    }

    return {
        about: "JSON Schema of every recorder service method (params as sent, result as answered) and notification, made from the zod schemas in src/recorder/lib/service-protocol.ts by scripts/recorder/write-protocol-fixtures.ts. The Swift tests check the host's answers against it.",
        protocol: SERVICE_PROTOCOL,
        params: document(params, "input"),
        results: document(results, "output"),
        notifications: document({ ...NOTIFICATION_SCHEMAS }, "output"),
    };
}

/**
 * One example of every edit op, as the zod schema reads it (defaults filled in). A new op tag without an example
 * fails service.test.ts, so the Swift side always gets a case to decode.
 */
const EXAMPLE_OPS: readonly unknown[] = [
    { op: "split", at: 2 },
    { op: "cut", from: 1, to: 2 },
    { op: "keep", from: 1, to: 8 },
    { op: "speed", from: 2, to: 4, factor: 2 },
    { op: "zoom", from: 1, to: 3, scale: 2, focus: { x: 0.3, y: 0.4 }, follow: false, lane: "zooms" },
    { op: "unzoom", id: "z1" },
    {
        op: "redact",
        from: 1,
        to: 3,
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        style: "pixelate",
        label: "API token",
        follow: false,
        lane: "lane2",
    },
    { op: "spotlight", from: 4, to: 5, rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, dim: 0.6, cutout: "circle" },
    { op: "unredact", id: "r1" },
    { op: "text", from: 5, to: 7, text: "Hello", x: 0.5, y: 0.1, size: 0.05, style: "plain", lane: "lane3" },
    { op: "untext", id: "t1" },
    { op: "marker", at: 2, label: "Login" },
    { op: "unmarker", id: "m1" },
    { op: "retime", id: "t1", from: 1.5, to: 2.5 },
    { op: "retime", id: "z1", by: -0.25 },
    {
        op: "shape",
        from: 6,
        to: 8,
        kind: "arrow",
        start: { x: 0.2, y: 0.2 },
        end: { x: 0.5, y: 0.5 },
        color: "#FF3B30",
        width: 0.01,
        appear: "fade",
    },
    { op: "shape", from: 6, to: 8, kind: "circle", at: { x: 0.7, y: 0.3 } },
    { op: "unshape", id: "s1" },
    { op: "fixLine", from: 4.2, text: "The fixed words" },
    { op: "unfixLine", from: 4.2 },
    { op: "autoZoom", scale: 1.8 },
    { op: "annotateClicks", from: 0, to: 5, kind: "box", seconds: 2, color: "#FFCC00", appear: "none" },
    { op: "volume", volume: 0.8 },
    { op: "mute", track: 1, muted: true },
    { op: "audio", include: false },
    { op: "music", file: "/music/bed.mp3", volume: 0.2, duck: 0.5, fadeMs: 1000, startMs: 500, loop: false },
    { op: "music", enabled: false },
    {
        op: "exportSettings",
        codec: "hevc",
        maxHeight: 1080,
        output: "/exports/demo.mp4",
        format: "gif",
        subtitles: "srt",
        chapters: false,
    },
    { op: "reset" },
    { op: "clicks", highlight: true, color: "#FFCC00", radius: 0.03, durationMs: 600, sound: true },
    { op: "keys", show: true, size: 0.05, position: "top", durationMs: 1500 },
    { op: "captions", show: true, size: 0.05, position: "bottom" },
    { op: "motion", blur: 0.4 },
    { op: "cursor", show: true, size: 1.5, smoothing: 0.6, hideAfterMs: 3000 },
    {
        op: "frame",
        enabled: true,
        aspect: "9:16",
        fit: "cover",
        background: { kind: "gradient", colors: ["#4F46E5", "#DB2777"], blur: 0.2 },
        padding: 0.08,
        cornerRadius: 0.02,
        shadow: false,
    },
    {
        op: "camera",
        file: "camera.mov",
        show: true,
        corner: "topLeft",
        size: 0.3,
        shape: "rounded",
        mirror: false,
        offsetMs: 120,
    },
    { op: "camera", x: 0.25, y: 0.75 },
    { op: "cameraHide", from: 1, to: 2, lane: "lane4" },
    { op: "cameraShow", id: "k1" },
    { op: "cameraShow", from: 1.5, to: 2 },
    { op: "removeIdle", speed: 4 },
    { op: "cutWords", at: 3, words: "ehm", occurrence: 1, from: 3.2, to: 3.5, padMs: 40 },
    { op: "cutFillers", language: "cs", level: "all", words: ["ehm"], padMs: 30 },
    { op: "denoise", enabled: true, method: "afftdn", reductionDb: 12, tracks: [0, 1], trackReductionDb: { "1": 18 } },
    { op: "denoise", track: 1, on: false, trackCount: 2 },
    { op: "normalize" },
    {
        op: "lanes",
        lanes: [
            { id: "zooms", kinds: ["zoom"] },
            { id: "lane2", kinds: ["hide", "spotlight"], name: "Secrets" },
        ],
    },
    { op: "addLane", kinds: ["text"], name: "Titles", id: "lane3" },
    { op: "removeLane", id: "lane2" },
    { op: "moveLane", id: "lane2", to: 0 },
    { op: "moveToLane", id: "t1", lane: "lane2" },
    { op: "setZoom", id: "z1", scale: 2.5, mode: "manual", focus: { x: 0.4, y: 0.6 }, easeInMs: 300, easeOutMs: 500 },
    {
        op: "setRedaction",
        id: "r1",
        rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 },
        style: "black",
        label: "key",
        follow: true,
        dim: 0.5,
        cutout: "rect",
    },
    { op: "setText", id: "t1", text: "Hi", x: 0.4, y: 0.2, size: 0.06, style: "plate" },
    {
        op: "setShape",
        id: "s1",
        kind: "box",
        start: { x: 0.1, y: 0.1 },
        end: { x: 0.3, y: 0.2 },
        color: "#00FF00",
        width: 0.005,
        appear: "draw",
    },
    { op: "trim", clip: "c1", from: 1, to: 9 },
    { op: "deleteClip", clip: "c2" },
    { op: "clipSpeed", clip: "c1", factor: 1.5 },
    { op: "duplicate", id: "z1" },
    { op: "removeClickCircles" },
    { op: "renameLane", id: "lane2", name: "Hidden" },
    { op: "range", from: 1, to: 3, action: "spotlight" },
    { op: "range", from: 2, to: 4, action: "speed", factor: 2 },
    { op: "range", from: 2, to: 3, action: "text", text: "Step 1", lane: "lane3" },
];

/** Every method a live service's `hello` lists, in its order (the list service.ts builds; service.test.ts checks it). */
export function helloMethods(): string[] {
    const movie = moviesApi.handles.find((handle) => handle.name === "Movie")?.methods ?? [];
    return [
        ...serviceApi.methods.map((method) => method.name),
        "subscribe",
        ...HOST_METHODS,
        ...movie.map((method) => `movie.${method.name}`),
        ...moviesApi.methods
            .filter((method) => ["list", "search"].includes(method.name))
            .map((method) => `movies.${method.name}`),
    ];
}

/** The tag of every edit op the zod schema reads. */
export function editOpTags(): string[] {
    return editOpSchema.options.map((option) => option.shape.op.value);
}

/** Ids by kind and order of appearance (`z1`, `r2`), so a golden edit is the same file on every run. */
function stableIds(project: EditProject): EditProject {
    const renumber = <T extends { id: string }>(items: readonly T[] | undefined, prefix: string): T[] | undefined =>
        items?.map((item, index) => ({ ...item, id: `${prefix}${index + 1}` }));
    const camera = project.camera
        ? { ...project.camera, hidden: renumber(project.camera.hidden, "k") ?? [] }
        : undefined;
    return {
        ...project,
        clips: renumber(project.clips, "c") ?? [],
        zooms: renumber(project.zooms, "z") ?? [],
        ...(project.redactions ? { redactions: renumber(project.redactions, "r") } : {}),
        ...(project.texts ? { texts: renumber(project.texts, "t") } : {}),
        ...(project.shapes ? { shapes: renumber(project.shapes, "s") } : {}),
        ...(project.markers ? { markers: renumber(project.markers, "m") } : {}),
        ...(camera ? { camera } : {}),
    };
}

/** Edits made by the TypeScript ops (and, for looks whose op needs a recorded track, the zod schema's own parse). */
function goldenProjects(): Array<{ name: string; project: EditProject }> {
    const source = { video: "/movies/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080 };
    const apply = (ops: readonly unknown[], start = wholeProject(source)) =>
        stableIds(ops.reduce<EditProject>((project, op) => applyOp(project, editOpSchema.parse(op)), start));
    const items = apply([
        { op: "zoom", from: 1, to: 3, scale: 2, focus: { x: 0.3, y: 0.4 } },
        { op: "redact", from: 2, to: 4, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, label: "API token" },
        {
            op: "spotlight",
            from: 4,
            to: 5,
            rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
            dim: 0.6,
            cutout: "circle",
        },
        { op: "text", from: 5, to: 7, text: "Hello", style: "plain" },
        {
            op: "shape",
            from: 6,
            to: 8,
            kind: "arrow",
            start: { x: 0.2, y: 0.2 },
            end: { x: 0.5, y: 0.5 },
            appear: "fade",
        },
        { op: "marker", at: 2, label: "Login" },
        { op: "split", at: 6 },
        { op: "speed", from: 7, to: 9, factor: 2 },
        { op: "fixLine", from: 4.2, text: "The fixed words" },
    ]);
    const looks = apply([
        { op: "frame", aspect: "16:9", fit: "cover", padding: 0.08 },
        { op: "clicks", highlight: true, sound: true },
        { op: "motion", blur: 0.4 },
        { op: "exportSettings", codec: "hevc", maxHeight: 1080, format: "mp4", subtitles: "vtt", chapters: false },
        { op: "volume", volume: 0.8 },
        { op: "mute", track: 1, muted: true },
        { op: "denoise", enabled: true, reductionDb: 12, tracks: [0], trackReductionDb: { "0": 18 } },
    ]);
    const tracked = editProjectSchema.parse({
        ...looks,
        cursor: { show: true, size: 1.5, smoothing: 0.6, hideAfterMs: 3000 },
        captions: { show: true, size: 0.05, position: "top" },
        keys: { show: true, position: "bottom", durationMs: 1500 },
        audio: { ...looks.audio, music: { file: "/music/bed.mp3", volume: 0.2, startMs: 500, loop: false } },
    });
    const withCamera = editProjectSchema.parse({
        ...wholeProject(source),
        camera: { file: "camera.mov", corner: "custom", x: 0.25, y: 0.75, size: 0.3, shape: "rounded" },
    });
    const camera = apply(
        [
            { op: "cameraHide", from: 1, to: 2 },
            { op: "cameraHide", from: 1.5, to: 3 },
            { op: "addLane", kinds: ["hide", "spotlight"], name: "Secrets" },
            { op: "redact", from: 2, to: 4, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
            { op: "addLane", kinds: ["cameraHide"] },
        ],
        withCamera
    );
    return [
        { name: "every item, a split and a speed-up", project: items },
        { name: "the looks, the export and the sound", project: looks },
        { name: "the looks a recorded track turns on, and music", project: stableIds(tracked) },
        { name: "a camera with two hidden parts and lanes", project: camera },
    ];
}

export interface EditorGolden {
    about: string;
    /** What a live service's `hello` lists: every method the window may call must be one of them. */
    methods: string[];
    /** The zod op tags, which the Swift `EditOp` enum must name one for one. */
    opTags: string[];
    ops: unknown[];
    projects: Array<{ name: string; project: EditProject }>;
}

/**
 * Three hits of a meeting's screen search (a shown line, a display the movie does not show, a line in the letterboxed
 * display), as screen-search.json held them on 2026-11-05; kept here so this fixture does not move with that one.
 */
const SCREEN_HITS: ScreenHit[] = [
    {
        sec: 0,
        untilSec: 9,
        displayId: 1,
        file: "frames/0001.jpg",
        lines: ["API token: sk-123"],
        shown: true,
        boxes: [{ text: "API token: sk-123", x: 0.1, y: 0.35, width: 0.4, height: 0.05 }],
    },
    {
        sec: 4,
        untilSec: 12.5,
        displayId: 4,
        file: "frames/0002.jpg",
        lines: ["Token rotation"],
        shown: false,
        boxes: [],
    },
    {
        sec: 12.5,
        untilSec: 14.5,
        displayId: 4,
        file: "frames/0004.jpg",
        lines: ["Tokén list"],
        shown: true,
        boxes: [{ text: "Tokén list", x: 0.2, y: 0.725, width: 0.25, height: 0.045 }],
    },
];

export interface ScreenHitOpsFixture {
    about: string;
    /** The movie's source length the ops are kept inside. */
    durationSec: number;
    hits: ScreenHitWithOps[];
}

/** `__fixtures__/screen-hit-ops.json`: screen hits as the REPL's findOnScreen and `find-screen --json` answer them. */
export function screenHitOpsFixture(): ScreenHitOpsFixture {
    return {
        about: "Made from the TypeScript source by scripts/recorder/write-protocol-fixtures.ts (src/recorder/lib/screen-ops.ts): screen hits with the edit ops that hide, mark or cut each one, as find-screen --json and the REPL's findOnScreen answer. The editor's Find tab decodes them and sends the ops as they are (Tests/RecorderEditTests.swift).",
        durationSec: 15,
        hits: screenHitsWithOps(SCREEN_HITS, 15),
    };
}

/** `__fixtures__/editor-golden.json`: what the TypeScript side writes, for the Swift side to read back unchanged. */
export function editorGolden(): EditorGolden {
    return {
        about: "Made from the TypeScript source by scripts/recorder/write-protocol-fixtures.ts. The Swift tests decode every op with EditOp and every project with EditProject, write them back, and compare; the op tags must match EditOp's cases, and every method the editor window calls must be in methods (the service's hello).",
        methods: helloMethods(),
        opTags: editOpTags(),
        ops: EXAMPLE_OPS.map((op) => editOpSchema.parse(op)),
        projects: goldenProjects(),
    };
}
