import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { timeSchema, timeToUs } from "./plan";

const { log } = logger.scoped("recording-editor-project");

/**
 * The recorder window's edit document (`edit.json`), the same shape the Swift editor reads and writes
 * (src/macos/GenesisTools/Sources/Parts/Recorder/Project/EditProject.swift). Every time is in microseconds of the
 * SOURCE movie, so a cut never moves a zoom. The window watches the file and takes an agent's save as it lands.
 */
export const EDIT_PROJECT_VERSION = 1;
/** The shortest clip a split or a cut leaves: one frame at 60 fps (TimelineMap.minimumClipUs). */
export const MINIMUM_CLIP_US = 16_667;
const MINIMUM_ZOOM_US = 200_000;

const clipSchema = z.object({
    id: z.string(),
    fromUs: z.number().int().nonnegative(),
    toUs: z.number().int().nonnegative(),
    speed: z.number().min(0.25).max(16).default(1),
});

const zoomSchema = z.object({
    id: z.string(),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().nonnegative(),
    scale: z.number().min(1).max(4).default(1.5),
    mode: z.enum(["manual", "follow"]).default("manual"),
    focusX: z.number().min(0).max(1).default(0.5),
    focusY: z.number().min(0).max(1).default(0.5),
    easeInMs: z.number().int().nonnegative().default(450),
    easeOutMs: z.number().int().nonnegative().default(450),
});

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a color is #RRGGBB");

/** What an export writes: the editor's movie, or a GIF or WebM ffmpeg makes from it. */
export const EXPORT_FORMATS = ["mp4", "gif", "webm"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Clicks drawn from the cursor track: a soft disc that grows and fades after each click. Absent is off. */
export const clicksSchema = z.object({
    highlight: z.boolean().default(true),
    color: hexColor.default("#FFD60A"),
    /** The disc's largest radius, as a fraction of the output height. */
    radius: z.number().min(0.005).max(0.2).default(0.03),
    durationMs: z.number().int().min(100).max(3000).default(450),
});

/** The movie on a background, scaled in by `padding`, with rounded corners and a shadow. Absent is the plain movie. */
export const frameSchema = z.object({
    background: z
        .object({
            kind: z.enum(["none", "color", "gradient"]).default("gradient"),
            colors: z.array(hexColor).min(1).max(2).default(["#4F46E5", "#DB2777"]),
        })
        .default({ kind: "gradient", colors: ["#4F46E5", "#DB2777"] }),
    /** The margin on every side, as a fraction of the output height. */
    padding: z.number().min(0).max(0.3).default(0.06),
    /** As a fraction of the output height. */
    cornerRadius: z.number().min(0).max(0.1).default(0.012),
    shadow: z.boolean().default(true),
});

/**
 * The cursor the editor draws for a movie recorded without the system cursor (`tools recorder start` does that by
 * default). Absent is the defaults: shown, at its recorded size, smoothed by half.
 */
export const cursorSchema = z.object({
    show: z.boolean().default(true),
    /** Times the recorded size. */
    size: z.number().min(0.5).max(3).default(1),
    /** 0 is the raw path; 1 averages it over ±120 ms. The cursor still sits on every click. */
    smoothing: z.number().min(0).max(1).default(0.5),
});

export const editProjectSchema = z.object({
    version: z.number().int().default(EDIT_PROJECT_VERSION),
    source: z.object({
        video: z.string(),
        cursor: z.string().optional(),
        recording: z.string().optional(),
        durationUs: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
    }),
    clips: z.array(clipSchema).min(1),
    zooms: z.array(zoomSchema).default([]),
    audio: z
        .object({
            include: z.boolean().default(true),
            volume: z.number().min(0).max(2).default(1),
            mutedTracks: z.array(z.number().int().nonnegative()).default([]),
        })
        .default({ include: true, volume: 1, mutedTracks: [] }),
    export: z
        .object({
            codec: z.enum(["h264", "hevc"]).default("h264"),
            maxHeight: z.number().int().nonnegative().default(0),
            output: z.string().default(""),
            /** Absent is mp4, as before the field existed. */
            format: z.enum(EXPORT_FORMATS).optional(),
        })
        .default({ codec: "h264", maxHeight: 0, output: "" }),
    clicks: clicksSchema.optional(),
    frame: frameSchema.optional(),
    cursor: cursorSchema.optional(),
    revision: z.number().int().nonnegative().default(0),
    updatedBy: z.string().optional(),
});

export type EditProject = z.infer<typeof editProjectSchema>;
export type EditClip = EditProject["clips"][number];
export type EditZoom = EditProject["zooms"][number];

export function newId(prefix: "c" | "z"): string {
    return `${prefix}${randomUUID().slice(0, 8)}`;
}

/** `<folder>/edit.json` for a recording folder's movie, `<name>.edit.json` beside any other movie. */
export function projectPathFor(video: string): string {
    const folder = dirname(video);

    if (existsSync(join(folder, "recording.json"))) {
        return join(folder, "edit.json");
    }

    return join(folder, `${basename(video, extname(video))}.edit.json`);
}

/** A project that keeps the whole movie, as a new edit starts. */
export function wholeProject(source: EditProject["source"]): EditProject {
    return editProjectSchema.parse({ source, clips: [{ id: newId("c"), fromUs: 0, toUs: source.durationUs }] });
}

/** Reads an edit file; refuses a newer version instead of reading it wrongly. */
export function readProject(path: string): EditProject {
    const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    const version = typeof raw === "object" && raw !== null ? Reflect.get(raw, "version") : undefined;

    if (typeof version === "number" && version > EDIT_PROJECT_VERSION) {
        throw new Error(`${path} has version ${version}; this build reads up to ${EDIT_PROJECT_VERSION}`);
    }

    const parsed = editProjectSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error(
            `${path} is not an edit project: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
        );
    }

    return parsed.data;
}

/** Writes atomically with the next revision, so the open window reloads it and knows who changed it. */
export function writeProject(path: string, project: EditProject, by = "agent"): EditProject {
    const saved = { ...project, version: EDIT_PROJECT_VERSION, revision: project.revision + 1, updatedBy: by };
    atomicWriteFileSync(path, `${SafeJSON.stringify(saved, null, 2)}\n`);
    log.debug({ path, revision: saved.revision, clips: saved.clips.length, zooms: saved.zooms.length }, "edit saved");
    return saved;
}

export function clipOutputUs(clip: EditClip): number {
    return Math.round(Math.max(0, clip.toUs - clip.fromUs) / clip.speed);
}

export function outputDurationUs(project: EditProject): number {
    return project.clips.reduce((sum, clip) => sum + clipOutputUs(clip), 0);
}

/** The output time of a source time, or undefined when that moment was cut. */
export function outputTimeOf(project: EditProject, sourceUs: number): number | undefined {
    let start = 0;

    for (const clip of project.clips) {
        if (sourceUs >= clip.fromUs && sourceUs <= clip.toUs) {
            return start + Math.round((sourceUs - clip.fromUs) / clip.speed);
        }

        start += clipOutputUs(clip);
    }

    return undefined;
}

function checkRange(project: EditProject, fromUs: number, toUs: number): void {
    const seconds = (us: number) => Math.round(us / 1000) / 1000;

    if (toUs <= fromUs) {
        throw new RangeError(`from (${seconds(fromUs)} s) must be before to (${seconds(toUs)} s)`);
    }

    if (fromUs >= project.source.durationUs) {
        throw new RangeError(
            `from (${seconds(fromUs)} s) is past the end of the ${seconds(project.source.durationUs)} s movie`
        );
    }
}

/** Splits every clip that holds `sourceUs` strictly inside it; a point near a clip edge changes nothing. */
export function splitAt(project: EditProject, sourceUs: number): EditProject {
    const clips = project.clips.flatMap((clip) =>
        sourceUs - clip.fromUs >= MINIMUM_CLIP_US && clip.toUs - sourceUs >= MINIMUM_CLIP_US
            ? [
                  { ...clip, toUs: sourceUs },
                  { ...clip, id: newId("c"), fromUs: sourceUs },
              ]
            : [clip]
    );
    return { ...project, clips };
}

/** Removes a source range from the movie: the clips around it are split and the parts inside it dropped. */
export function cutRange(project: EditProject, fromUs: number, toUs: number): EditProject {
    checkRange(project, fromUs, toUs);
    const split = splitAt(splitAt(project, fromUs), toUs);
    const clips = split.clips.filter((clip) => clip.toUs <= fromUs || clip.fromUs >= toUs);

    if (clips.length === 0) {
        throw new RangeError("that cut removes the whole movie; keep at least one part");
    }

    return { ...split, clips };
}

/** Keeps only a source range (a trim of both ends). */
export function keepRange(project: EditProject, fromUs: number, toUs: number): EditProject {
    checkRange(project, fromUs, toUs);
    let next = project;

    if (fromUs > 0) {
        next = cutRange(next, 0, fromUs);
    }

    if (toUs < project.source.durationUs) {
        next = cutRange(next, toUs, project.source.durationUs);
    }

    return next;
}

/** Plays a source range at `speed` (0.25 to 16); the clips are split at its edges. */
export function speedRange(project: EditProject, fromUs: number, toUs: number, speed: number): EditProject {
    checkRange(project, fromUs, toUs);

    if (!(speed >= 0.25 && speed <= 16)) {
        throw new RangeError(`speed takes 0.25 to 16 (got ${speed})`);
    }

    const split = splitAt(splitAt(project, fromUs), toUs);
    return {
        ...split,
        clips: split.clips.map((clip) => (clip.fromUs >= fromUs && clip.toUs <= toUs ? { ...clip, speed } : clip)),
    };
}

export interface ZoomOptions {
    scale?: number;
    /** The centre of the zoomed view, 0..1 from the top left; omitted with `follow` true. */
    focus?: { x: number; y: number };
    /** The view follows the recorded cursor. */
    follow?: boolean;
    easeInMs?: number;
    easeOutMs?: number;
}

/** Adds a zoom over a source range; one that overlaps another zoom is refused with the zoom it meets. */
export function addZoom(
    project: EditProject,
    fromUs: number,
    toUs: number,
    options: ZoomOptions = {}
): { project: EditProject; zoom: EditZoom } {
    checkRange(project, fromUs, toUs);
    const endUs = Math.min(project.source.durationUs, toUs);

    if (endUs - fromUs < MINIMUM_ZOOM_US) {
        throw new RangeError(`a zoom lasts at least ${MINIMUM_ZOOM_US / 1e6} s`);
    }

    const overlap = project.zooms.find((zoom) => fromUs < zoom.endUs && endUs > zoom.startUs);

    if (overlap) {
        throw new RangeError(
            `that zoom overlaps zoom ${overlap.id} (${overlap.startUs / 1e6}–${overlap.endUs / 1e6} s); remove or move it first`
        );
    }

    const zoom = zoomSchema.parse({
        id: newId("z"),
        startUs: Math.round(fromUs),
        endUs: Math.round(endUs),
        scale: options.scale,
        mode: options.follow ? "follow" : "manual",
        focusX: options.focus?.x,
        focusY: options.focus?.y,
        easeInMs: options.easeInMs,
        easeOutMs: options.easeOutMs,
    });
    const zooms = [...project.zooms, zoom].sort((a, b) => a.startUs - b.startUs);
    return { project: { ...project, zooms }, zoom };
}

export function removeZoom(project: EditProject, id: string): EditProject {
    if (!project.zooms.some((zoom) => zoom.id === id)) {
        throw new Error(`no zoom ${id}; zooms: ${project.zooms.map((zoom) => zoom.id).join(", ") || "none"}`);
    }

    return { ...project, zooms: project.zooms.filter((zoom) => zoom.id !== id) };
}

export interface CursorSample {
    ms: number;
    x: number;
    y: number;
    click?: string;
}

const cursorRowSchema = z.object({ t: z.number(), x: z.number(), y: z.number(), click: z.string().optional() });

/**
 * Whether the movie was recorded without the system cursor, so the editor draws it: the track's first row then names
 * the cursor's image (`"shape"`). Reads only the start of the file.
 */
export function trackDrawsCursor(path: string | undefined): boolean {
    if (!path || !existsSync(path)) {
        return false;
    }

    const fd = openSync(path, "r");
    try {
        const buffer = Buffer.alloc(512);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
        return first.includes('"shape":');
    } finally {
        closeSync(fd);
    }
}

/** The recorder's `cursor.jsonl`: one `{t, x, y, click?}` row per change; an unreadable row is skipped. */
export function readCursorTrack(path: string | undefined): CursorSample[] {
    if (!path || !existsSync(path)) {
        return [];
    }

    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
            const row = cursorRowSchema.safeParse(SafeJSON.parse(line, { strict: true }));
            return row.success
                ? [
                      {
                          ms: row.data.t,
                          x: row.data.x,
                          y: row.data.y,
                          ...(row.data.click ? { click: row.data.click } : {}),
                      },
                  ]
                : [];
        });
}

/**
 * Zooms on the recorded clicks, as the window's Auto zoom does: clicks under 3 s apart are one zoom from 0.6 s before
 * the first to 1.6 s after the last, following the cursor. It replaces the zooms an earlier auto zoom made (mode
 * `follow`) and keeps the manual ones; a group that would overlap a manual zoom is left out. No clicks is an error,
 * and nothing changes.
 */
export function autoZoom(project: EditProject, samples: readonly CursorSample[], scale = 1.6): EditProject {
    const groups: CursorSample[][] = [];

    for (const click of samples.filter((sample) => sample.click)) {
        const group = groups.at(-1);

        if (group && click.ms - (group.at(-1)?.ms ?? 0) < 3000) {
            group.push(click);
        } else {
            groups.push([click]);
        }
    }

    if (groups.length === 0) {
        throw new RangeError(
            samples.length === 0
                ? "this movie has no cursor track, so there are no clicks to zoom on; the zooms are unchanged"
                : "the cursor track has no clicks to zoom on; the zooms are unchanged"
        );
    }

    const manual = project.zooms.filter((zoom) => zoom.mode === "manual");
    const added = groups.map((group) =>
        zoomSchema.parse({
            id: newId("z"),
            startUs: Math.max(0, group[0].ms - 600) * 1000,
            endUs: Math.min(project.source.durationUs, ((group.at(-1)?.ms ?? 0) + 1600) * 1000),
            scale,
            mode: "follow",
            focusX: group.reduce((sum, sample) => sum + sample.x, 0) / group.length,
            focusY: group.reduce((sum, sample) => sum + sample.y, 0) / group.length,
        })
    );
    const free = added.filter(
        (zoom) => !manual.some((other) => zoom.startUs < other.endUs && zoom.endUs > other.startUs)
    );
    return { ...project, zooms: [...manual, ...free].sort((a, b) => a.startUs - b.startUs) };
}

const focusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const rangeFields = { from: timeSchema, to: timeSchema };

/** One edit an agent or the CLI asks for; times are SOURCE times, seconds or "mm:ss". */
export const editOpSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("split"), at: timeSchema }).strict(),
    z.object({ op: z.literal("cut"), ...rangeFields }).strict(),
    z.object({ op: z.literal("keep"), ...rangeFields }).strict(),
    z.object({ op: z.literal("speed"), ...rangeFields, factor: z.number().min(0.25).max(16) }).strict(),
    z
        .object({
            op: z.literal("zoom"),
            ...rangeFields,
            scale: z.number().min(1).max(4).optional(),
            focus: focusSchema.optional(),
            follow: z.boolean().optional(),
        })
        .strict(),
    z.object({ op: z.literal("unzoom"), id: z.string() }).strict(),
    z.object({ op: z.literal("autoZoom"), scale: z.number().min(1).max(4).optional() }).strict(),
    z.object({ op: z.literal("volume"), volume: z.number().min(0).max(2) }).strict(),
    z.object({ op: z.literal("mute"), track: z.number().int().nonnegative(), muted: z.boolean().optional() }).strict(),
    z.object({ op: z.literal("audio"), include: z.boolean() }).strict(),
    z
        .object({
            op: z.literal("exportSettings"),
            codec: z.enum(["h264", "hevc"]).optional(),
            maxHeight: z.number().int().nonnegative().optional(),
            output: z.string().optional(),
            format: z.enum(EXPORT_FORMATS).optional(),
        })
        .strict(),
    z.object({ op: z.literal("reset") }).strict(),
    z
        .object({
            op: z.literal("clicks"),
            highlight: z.boolean().optional(),
            color: hexColor.optional(),
            radius: z.number().min(0.005).max(0.2).optional(),
            durationMs: z.number().int().min(100).max(3000).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("cursor"),
            show: z.boolean().optional(),
            size: z.number().min(0.5).max(3).optional(),
            smoothing: z.number().min(0).max(1).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("frame"),
            /** false removes the frame: the plain movie again. */
            enabled: z.boolean().optional(),
            background: z
                .object({
                    kind: z.enum(["none", "color", "gradient"]).optional(),
                    colors: z.array(hexColor).min(1).max(2).optional(),
                })
                .strict()
                .optional(),
            padding: z.number().min(0).max(0.3).optional(),
            cornerRadius: z.number().min(0).max(0.1).optional(),
            shadow: z.boolean().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("removeIdle"),
            /** The shortest still and silent stretch that is cut, in seconds. */
            minSeconds: z.number().min(0.5).max(600).default(2),
            /** Kept at each end of a cut, so the change before and after it still plays. */
            keepSeconds: z.number().min(0).max(5).default(0.3),
        })
        .strict(),
]);
export type EditOp = z.infer<typeof editOpSchema>;

export const EDIT_OP_NAMES = editOpSchema.options.map((option) => option.shape.op.value);

/** One op or a list of them from untrusted JSON, with one readable line per problem. */
export function parseEditOps(raw: unknown): EditOp[] {
    const list = Array.isArray(raw) ? raw : [raw];
    const problems: string[] = [];
    const ops = list.flatMap((item, index) => {
        const name = typeof item === "object" && item !== null ? Reflect.get(item, "op") : undefined;
        const where = list.length > 1 ? `op ${index + 1}` : "op";

        if (typeof name !== "string" || !EDIT_OP_NAMES.includes(name as EditOp["op"])) {
            problems.push(
                `${where}: "op" must be one of ${EDIT_OP_NAMES.join(", ")} (got ${SafeJSON.stringify(name ?? null)})`
            );
            return [];
        }

        const parsed = editOpSchema.safeParse(item);

        if (!parsed.success) {
            problems.push(
                ...parsed.error.issues.map((issue) => {
                    const field = issue.path.join(".") || "fields";
                    const missing = issue.path.length === 1 && Reflect.get(item, issue.path[0]) === undefined;
                    return `${where} (${name}) ${field}: ${missing ? "is required" : issue.message}`;
                })
            );
            return [];
        }

        return [parsed.data];
    });

    if (list.length === 0) {
        problems.push("no ops given");
    }

    if (problems.length > 0) {
        throw new Error(`invalid ops:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
    }

    return ops;
}

/** What an op needs from the movie itself, probed by the caller (`removeIdle`: the still and silent stretches). */
export interface OpFacts {
    idleUs?: ReadonlyArray<readonly [number, number]>;
}

/** Applies one op; throws a RangeError a caller can show as it is. */
export function applyOp(project: EditProject, op: EditOp, facts: OpFacts = {}): EditProject {
    switch (op.op) {
        case "removeIdle": {
            if (!facts.idleUs) {
                throw new Error("removeIdle needs the movie's idle stretches; run it through editProject or the CLI");
            }

            let next = project;

            for (const [from, to] of facts.idleUs) {
                if (to - from >= MINIMUM_CLIP_US) {
                    next = cutRange(next, from, to);
                }
            }

            return next;
        }
        case "split":
            return splitAt(project, timeToUs(op.at));
        case "cut":
            return cutRange(project, timeToUs(op.from), timeToUs(op.to));
        case "keep":
            return keepRange(project, timeToUs(op.from), timeToUs(op.to));
        case "speed":
            return speedRange(project, timeToUs(op.from), timeToUs(op.to), op.factor);
        case "zoom":
            return addZoom(project, timeToUs(op.from), timeToUs(op.to), {
                scale: op.scale,
                focus: op.focus,
                follow: op.follow,
            }).project;
        case "unzoom":
            return removeZoom(project, op.id);
        case "autoZoom":
            return autoZoom(project, readCursorTrack(project.source.cursor), op.scale);
        case "volume":
            return { ...project, audio: { ...project.audio, volume: op.volume } };
        case "mute": {
            const others = project.audio.mutedTracks.filter((track) => track !== op.track);
            const mutedTracks = op.muted === false ? others : [...others, op.track].sort((a, b) => a - b);
            return { ...project, audio: { ...project.audio, mutedTracks } };
        }
        case "audio":
            return { ...project, audio: { ...project.audio, include: op.include } };
        case "exportSettings":
            return {
                ...project,
                export: {
                    codec: op.codec ?? project.export.codec,
                    maxHeight: op.maxHeight ?? project.export.maxHeight,
                    output: op.output ?? project.export.output,
                    ...((op.format ?? project.export.format) ? { format: op.format ?? project.export.format } : {}),
                },
            };
        case "reset":
            return { ...wholeProject(project.source), revision: project.revision };
        case "clicks": {
            const { op: _op, ...change } = op;
            return { ...project, clicks: clicksSchema.parse({ ...project.clicks, ...change }) };
        }
        case "cursor": {
            if (!trackDrawsCursor(project.source.cursor)) {
                throw new Error(
                    "this movie has the system cursor in its picture, so the editor cannot change it; record without --system-cursor to get a drawn cursor"
                );
            }

            const { op: _op, ...change } = op;
            return { ...project, cursor: cursorSchema.parse({ ...project.cursor, ...change }) };
        }
        case "frame": {
            if (op.enabled === false) {
                const { frame: _frame, ...rest } = project;
                return rest;
            }

            const current = project.frame ?? frameSchema.parse({});
            return {
                ...project,
                frame: frameSchema.parse({
                    ...current,
                    ...(op.padding === undefined ? {} : { padding: op.padding }),
                    ...(op.cornerRadius === undefined ? {} : { cornerRadius: op.cornerRadius }),
                    ...(op.shadow === undefined ? {} : { shadow: op.shadow }),
                    background: { ...current.background, ...op.background },
                }),
            };
        }
    }
}

/** What an agent reads back after an edit: seconds, not microseconds. */
export function describeProject(project: EditProject, path: string) {
    const seconds = (us: number) => Math.round(us / 1000) / 1000;
    return {
        path,
        revision: project.revision,
        updatedBy: project.updatedBy,
        video: project.source.video,
        sourceSeconds: seconds(project.source.durationUs),
        outputSeconds: seconds(outputDurationUs(project)),
        clips: project.clips.map((clip) => ({
            id: clip.id,
            from: seconds(clip.fromUs),
            to: seconds(clip.toUs),
            speed: clip.speed,
        })),
        zooms: project.zooms.map((zoom) => ({
            id: zoom.id,
            from: seconds(zoom.startUs),
            to: seconds(zoom.endUs),
            scale: zoom.scale,
            mode: zoom.mode,
            focus: { x: zoom.focusX, y: zoom.focusY },
        })),
        audio: project.audio,
        export: project.export,
        clicks: project.clicks ?? null,
        frame: project.frame ?? null,
        /** null: the system cursor is in the picture, so there is nothing to change. */
        cursor: trackDrawsCursor(project.source.cursor) ? cursorSchema.parse(project.cursor ?? {}) : null,
    };
}

/** One spoken line of the movie: its source times, where it plays in the edit now, and its words. */
export interface TranscriptLine {
    from: number;
    to: number;
    /** Output seconds where the line starts in the current edit; null when its middle was cut. */
    plays: number | null;
    text: string;
}

const transcriptSchema = z.object({
    text: z.string().default(""),
    segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).default([]),
});

/**
 * A transcription result (`tools transcribe --format json`) as lines in source seconds with their place in the edit,
 * so an agent can cut "the part where I say X" with `cut(line.from, line.to)`.
 */
export function transcriptLines(raw: unknown, project: EditProject): TranscriptLine[] {
    const parsed = transcriptSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error("the transcription result has no segments to read");
    }

    const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
    return parsed.data.segments
        .filter((segment) => segment.text.trim())
        .map((segment) => {
            // A line whose middle was cut is cut: its start alone sat on the edge of the clip before the cut.
            const middle = outputTimeOf(project, Math.round(((segment.start + segment.end) / 2) * 1_000_000));
            const plays =
                middle === undefined ? undefined : outputTimeOf(project, Math.round(segment.start * 1_000_000));
            return {
                from: round(segment.start),
                to: round(segment.end),
                plays: plays === undefined ? null : round(plays / 1_000_000),
                text: segment.text.trim(),
            };
        });
}

/** The lines whose text holds `query`, case and accents ignored. */
export function findInTranscript(lines: readonly TranscriptLine[], query: string): TranscriptLine[] {
    const fold = (text: string) =>
        text
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase();
    const needle = fold(query.trim());
    return needle ? lines.filter((line) => fold(line.text).includes(needle)) : [];
}
