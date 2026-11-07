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
    // R4 voiceover clips
    { op: "voiceover", at: 2.5, file: "/voice/intro.mp3", volume: 1.2, label: "Intro" },
    { op: "voiceover", id: "v1", at: 3 },
    { op: "unvoiceover", id: "v1" },
    // R4 8 music ducking
    { op: "ducking", db: 12, fadeMs: 300, transcript: true, voiceovers: false },
    { op: "ducking", enabled: false },
    // R4 6 animated captions and texts
    { op: "captionsStyle", kind: "karaoke", color: "#FF9F0A" },
    { op: "captionsStyle", enabled: false },
    { op: "text", from: 1, to: 3, text: "Typed", animate: { kind: "typewriter", ms: 800 } },
    { op: "setText", id: "t1", animate: { kind: "slideUp" } },
    // R4 10 progress bar and chapter strip
    { op: "progress", show: true, color: "#FF375F", height: 0.01, chapters: true, chapterMs: 2500 },
    { op: "progress", enabled: false },
    // R4 9 intro and end cards
    {
        op: "introCard",
        title: "Demo",
        subtitle: "A short tour",
        logo: "/pictures/logo.png",
        date: "7 November 2026",
        seconds: 2.5,
    },
    { op: "introCard", enabled: false },
    { op: "endCard", text: "Thanks for watching", link: "https://example.com/demo", qr: true, seconds: 4 },
    { op: "endCard", enabled: false },
    // Round 4 fx-render: transitions, lens, tilt.
    { op: "transition", kind: "crossfade", ms: 400 },
    { op: "transition", clip: "c2", kind: "blur" },
    { op: "transition", clip: "c2", kind: "default" },
    {
        op: "lens",
        from: 1,
        to: 3,
        radius: 0.15,
        magnification: 2.5,
        follow: false,
        at: { x: 0.3, y: 0.6 },
        ring: "#FFCC00",
    },
    {
        op: "setLens",
        id: "l1",
        from: 1.5,
        to: 4,
        radius: 0.1,
        magnification: 3,
        follow: true,
        at: { x: 0.5, y: 0.5 },
        ring: "#FFFFFF",
    },
    { op: "unlens", id: "l1" },
    { op: "tilt", enabled: true, strength: 0.6, drift: false, tiltIn: true, tiltOut: false, inMs: 900, outMs: 1500 },
    // fx B (round 4)
    { op: "hidePrivate", ids: ["p1a2b3c4d"], kinds: ["email", "token"], style: "pixelate" },
    {
        op: "hidePrivate",
        names: ["Alice Example"],
        exclude: [{ x: 0.4, y: 0.8, width: 0.2, height: 0.08 }],
        excludeFixed: true,
    },
    {
        op: "hideText",
        text: "alice@example.com",
        from: 2,
        to: 9,
        style: "black",
        exclude: [{ x: 0.4, y: 0.8, width: 0.2, height: 0.08 }],
        excludeFixed: true,
        label: "Contact",
    },
    { op: "hideText", pattern: "sk-[a-z0-9]+" },
    { op: "cursorSmooth", strength: 0.8, jitterPx: 4, idleFadeSeconds: 2.5 },
    { op: "cursorSmooth", enabled: false },
    { op: "speedUpWaits", ids: ["w1a2b3c4d"], minSeconds: 5, maxArea: 0.08, speed: 6 },
    { op: "autoSpeed", badge: true, position: "bottom-left" },
    // R5 5 redaction edges
    { op: "redact", from: 1, to: 2, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, style: "pixelate", cell: 24 },
    { op: "spotlight", from: 2, to: 3, rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, fadeMs: 0 },
    { op: "setRedaction", id: "r1", fadeMs: -1, cell: 12 },
    { op: "redactionJoins", snapMs: 120 },
    // R5 4 frame layouts and canvas zoom
    { op: "frame", preset: "phone-left", layout: { scale: 1.1 } },
    { op: "frame", layout: { align: "right", scale: 1 } },
    { op: "zoom", from: 1, to: 3, scale: 2, focus: { x: 0.2, y: 0.5 }, target: "canvas" },
    // R5 10 multi-line texts
    { op: "text", from: 1, to: 3, text: "Step 1\nOpen the inbox", x: 0.62, block: { width: 0.35, align: "left" } },
    { op: "setText", id: "t1", block: { align: "right" } },
    // R6 2 a match's whole OCR line
    { op: "hideText", text: "Orla Fictive", unit: "line" },
    // R6 3 several texts and patterns in one scan
    { op: "hideText", texts: ["Orla Fictive", "Bram Sample"], patterns: ["\\d{3} \\d{3} \\d{3}"] },
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
        // Round 4 fx-render.
        ...(project.lens ? { lens: { items: renumber(project.lens.items, "l") ?? [] } } : {}),
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
    // Round 4 fx-render: a cut with a default and an own transition, a placed lens, and a tilt.
    const fx = apply([
        { op: "frame", padding: 0.08 },
        { op: "cut", from: 4, to: 5 },
        { op: "transition", kind: "crossfade" },
        { op: "lens", from: 1, to: 3, magnification: 2.5, at: { x: 0.3, y: 0.6 } },
        { op: "tilt", strength: 0.6 },
    ]);
    const fxJoin = fx.clips[1]?.id ?? "";
    const fxWithJoin = apply([{ op: "transition", clip: fxJoin, kind: "zoom", ms: 500 }], fx);
    return [
        { name: "every item, a split and a speed-up", project: items },
        { name: "transitions, a lens and a tilt", project: fxWithJoin },
        { name: "the looks, the export and the sound", project: looks },
        { name: "the looks a recorded track turns on, and music", project: stableIds(tracked) },
        { name: "a camera with two hidden parts and lanes", project: camera },
        // R4 voiceover clips, 8 music ducking
        {
            name: "voiceover clips and music ducking",
            project: editProjectSchema.parse({
                ...wholeProject(source),
                audio: {
                    include: true,
                    volume: 1,
                    mutedTracks: [],
                    music: { file: "/music/bed.mp3", volume: 0.3 },
                    voiceovers: [
                        { id: "v1", atUs: 1_000_000, file: "/voice/intro.mp3", durationUs: 2_500_000, label: "Intro" },
                        { id: "v2", atUs: 6_000_000, file: "/voice/outro.wav", durationUs: 1_200_000, volume: 1.4 },
                    ],
                    ducking: { db: 15, fadeMs: 250, transcript: false },
                },
            }),
        },
        // R4 6 animated captions and texts
        {
            name: "karaoke captions and animated texts",
            project: stableIds(
                apply(
                    [
                        { op: "text", from: 1, to: 3, text: "Typed", animate: { kind: "typewriter", ms: 900 } },
                        { op: "text", from: 4, to: 6, text: "Risen", animate: { kind: "slideUp" } },
                        { op: "captionsStyle", kind: "karaoke" },
                        // R4 10 progress bar and chapter strip
                        { op: "marker", at: 4, label: "Second step" },
                        { op: "progress", color: "#0A84FF", chapterMs: 1500 },
                        // R4 9 intro and end cards
                        { op: "introCard", title: "Demo", subtitle: "A short tour", date: "7 November 2026" },
                        { op: "endCard", text: "Thanks for watching", link: "https://example.com/demo", qr: true },
                    ],
                    editProjectSchema.parse({ ...wholeProject(source), captions: { show: true } })
                )
            ),
        },
        // fx B (round 4): the three objects as the ops write them.
        {
            name: "private data hidden, a smooth cursor and a speed badge",
            project: editProjectSchema.parse({
                ...items,
                privacy: { applied: ["p1a2b3c4d"] },
                redactions: [
                    ...(items.redactions ?? []),
                    {
                        id: "r9",
                        startUs: 3_500_000,
                        endUs: 7_400_000,
                        x: 0.16,
                        y: 0.9,
                        width: 0.3,
                        height: 0.05,
                        style: "blur",
                        label: "Text (auto)",
                        track: [
                            { atUs: 3_600_000, x: 0.16, y: 0.9, width: 0.3, height: 0.05 },
                            { atUs: 7_200_000, x: 0.16, y: 0.02, width: 0.3, height: 0.05 },
                        ],
                        exclude: [{ x: 0.38, y: 0.79, width: 0.08, height: 0.08 }],
                    },
                ],
                cursorSmooth: { strength: 0.8, jitterPx: 4, idleFadeSeconds: 2.5 },
                autoSpeed: { badge: true, position: "bottom-left" },
            }),
        },
        // R5 5 redaction edges: a pixelate cell, a hard spotlight and the join setting.
        {
            name: "redaction edges",
            project: editProjectSchema.parse({
                ...items,
                redactions: [
                    ...(items.redactions ?? []),
                    {
                        id: "r10",
                        startUs: 1_000_000,
                        endUs: 2_000_000,
                        x: 0.1,
                        y: 0.1,
                        width: 0.2,
                        height: 0.1,
                        style: "pixelate",
                        cell: 24,
                    },
                    {
                        id: "r11",
                        startUs: 2_000_000,
                        endUs: 3_000_000,
                        x: 0.3,
                        y: 0.3,
                        width: 0.2,
                        height: 0.2,
                        style: "spotlight",
                        fadeMs: 0,
                    },
                ],
                redactionJoins: { snapMs: 120 },
            }),
        },
        // R5 4 frame layouts and canvas zoom: a phone on the left of a 16:9 frame, zoomed into by a canvas zoom.
        {
            name: "a phone frame with a canvas zoom",
            project: apply([
                { op: "frame", preset: "phone-left", layout: { scale: 1.1 } },
                { op: "zoom", from: 1, to: 3, scale: 2, focus: { x: 0.2, y: 0.5 }, target: "canvas" },
            ]),
        },
        // R6 1 and 7: a part that follows a scrolled text, and the band where it could not, with the request.
        {
            name: "moving text hidden, with an uncertain band",
            project: editProjectSchema.parse({
                ...items,
                privacy: { applied: ["p5e6f7a8b"] },
                redactions: [
                    ...(items.redactions ?? []),
                    {
                        id: "r12",
                        startUs: 1_000_000,
                        endUs: 3_000_000,
                        x: 0.3,
                        y: 0.8,
                        width: 0.2,
                        height: 0.05,
                        style: "blur",
                        label: "Text (auto)",
                        track: [
                            { atUs: 1_000_000, x: 0.3, y: 0.8, width: 0.2, height: 0.05 },
                            { atUs: 1_500_000, x: 0.3, y: 0.4, width: 0.2, height: 0.05 },
                        ],
                        hide: {
                            by: "hideText",
                            hit: "p5e6f7a8b",
                            movingSeconds: 0.6,
                            keysPerSecond: 30,
                            request: { texts: ["Orla Fictive"], unit: "line" },
                        },
                    },
                    {
                        id: "r13",
                        startUs: 1_100_000,
                        endUs: 1_400_000,
                        x: 0.29,
                        y: 0,
                        width: 0.22,
                        height: 0.86,
                        style: "blur",
                        label: "Text (auto) (uncertain)",
                        hide: { by: "hideText", hit: "p5e6f7a8b", uncertain: true, request: { text: "Orla Fictive" } },
                    },
                ],
            }),
        },
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
