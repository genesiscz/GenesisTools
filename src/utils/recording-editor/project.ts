import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
        })
        .default({ codec: "h264", maxHeight: 0, output: "" }),
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
    if (!(fromUs >= 0 && toUs > fromUs && fromUs < project.source.durationUs)) {
        throw new RangeError(
            `the range ${fromUs / 1e6}–${toUs / 1e6} s is not inside the ${project.source.durationUs / 1e6} s movie`
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
 * the first to 1.6 s after the last, following the cursor. Replaces the existing zooms.
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

    const zooms = groups.map((group) =>
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
    return { ...project, zooms };
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
        })
        .strict(),
    z.object({ op: z.literal("reset") }).strict(),
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

/** Applies one op; throws a RangeError a caller can show as it is. */
export function applyOp(project: EditProject, op: EditOp): EditProject {
    switch (op.op) {
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
                },
            };
        case "reset":
            return { ...wholeProject(project.source), revision: project.revision };
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
    };
}
