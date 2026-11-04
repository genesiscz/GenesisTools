import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { DENOISE_METHODS, denoiseSchema } from "./denoise";
import {
    addedItemIds,
    addLane,
    EFFECT_KINDS,
    effectLaneSchema,
    laneItems,
    moveLane,
    moveToLane,
    removeLane,
    resolveLanes,
    setLanes,
    withLane,
} from "./lanes";
import { timeSchema, timeToUs } from "./plan";
import { cutRanges, FILLER_LEVELS, fillerCuts, fillerList, type TranscriptSegment, wordCuts } from "./transcript-cuts";

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
    /** The effect lane it sits on (lanes.ts); absent is the first lane that holds its kind. */
    lane: z.string().optional(),
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
    /** A soft tick at each recorded click in the sound; absent is off. */
    sound: z.boolean().optional(),
});

/**
 * The canvas a framed movie sits on. Its short side is the movie's height, so a 1080p export is 1920 × 1080 at 16:9,
 * 1080 × 1080 at 1:1 and 1080 × 1920 at 9:16. Absent is the movie's own shape.
 */
export const CANVAS_ASPECTS = ["source", "16:9", "4:3", "1:1", "9:16"] as const;

export const BACKGROUND_KINDS = ["none", "color", "gradient", "image"] as const;

/** The movie on a background, scaled in by `padding`, with rounded corners and a shadow. Absent is the plain movie. */
export const frameSchema = z.object({
    aspect: z.enum(CANVAS_ASPECTS).optional(),
    /** On a canvas of another shape: `contain` shows the whole movie, `cover` crops it to fill, following the cursor. */
    fit: z.enum(["contain", "cover"]).optional(),
    background: z
        .object({
            kind: z.enum(BACKGROUND_KINDS).default("gradient"),
            colors: z.array(hexColor).min(1).max(2).default(["#4F46E5", "#DB2777"]),
            /** kind "image": the picture, absolute, scaled to cover the canvas; `blur` softens it (0 to 1). */
            image: z.string().optional(),
            blur: z.number().min(0).max(1).optional(),
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
    /** Fades the cursor out after it stood still this long; 0 keeps it on screen. */
    hideAfterMs: z.number().int().min(0).max(30_000).default(0),
});

/** The movie's spoken lines drawn over the picture, from its cached transcript. Absent is off. */
export const captionsSchema = z.object({
    show: z.boolean().default(true),
    /** The text height, as a fraction of the output's short side. */
    size: z.number().min(0.02).max(0.1).default(0.038),
    position: z.enum(["bottom", "top"]).default("bottom"),
});

/** How a rectangle is drawn: hidden by a blur, big pixels or black, or shown by a spotlight that dims the rest. */
export const REDACTION_STYLES = ["blur", "pixelate", "black", "spotlight"] as const;
/** A spotlight's lit shape: "rounded" (absent means this), "rect" or "circle" (an ellipse in its rectangle). */
export const SPOTLIGHT_CUTOUTS = ["rounded", "rect", "circle"] as const;

/** A part of the SOURCE picture hidden for a time: an address, a token, a notification. It moves with a zoom. */
export const redactionSchema = z.object({
    id: z.string(),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    /** The rectangle, 0...1 of the source picture from its top left. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.005).max(1),
    height: z.number().min(0.005).max(1),
    style: z.enum(REDACTION_STYLES).default("blur"),
    /** What it hides ("API token"), for the editor's lists; absent shows the style. */
    label: z.string().max(60).optional(),
    /** The rectangle keeps its size and moves with the drawn cursor (centred on it, inside the picture). */
    follow: z.boolean().optional(),
    /** A spotlight's dim around it, 0.2 to 0.95 black; absent is 0.7. */
    dim: z.number().min(0.2).max(0.95).optional(),
    cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
    /** The effect lane it sits on (lanes.ts); absent is the first lane that holds its kind. */
    lane: z.string().optional(),
});
export type EditRedaction = z.infer<typeof redactionSchema>;

/**
 * Corrections to the cached transcript, kept in the edit so a new transcription does not lose them: the fixed text
 * of a line by its start in source milliseconds; an empty text hides the line. Captions, `transcript()`, `find()`
 * and the library search read the fixed words.
 */
export const transcriptSettingsSchema = z.object({
    fixes: z.record(z.string().regex(/^\d+$/), z.string().max(300)).default({}),
});

/**
 * The lines in which `find` occurs, with `replace` put in: each line's text as it shows now (its fix, else what was
 * said), and where it starts (source seconds, for a fixLine op). Case is ignored unless `matchCase`; a whole word only
 * unless `wholeWord` is false, where a letter or digit of any language next to it makes it part of a longer word. A
 * hidden line (fixed to "") is left out.
 */
export function replaceWordsInLines(
    segments: ReadonlyArray<{ text: string; start: number }>,
    fixes: Readonly<Record<string, string>>,
    options: { find: string; replace: string; matchCase?: boolean; wholeWord?: boolean }
): Array<{ from: number; text: string; was: string }> {
    const find = options.find.trim();

    if (!find) {
        throw new RangeError("find is empty; give the words to replace");
    }

    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const source = options.wholeWord === false ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
    const pattern = new RegExp(source, options.matchCase ? "gu" : "giu");
    return segments.flatMap((segment) => {
        const fixed = fixes[String(Math.round(segment.start * 1000))];
        const was = fixed ?? segment.text.trim();

        if (fixed === "" || !pattern.test(was)) {
            return [];
        }

        pattern.lastIndex = 0;
        const text = was.replace(pattern, () => options.replace).trim();
        return text === was ? [] : [{ from: segment.start, text, was }];
    });
}

export const TEXT_STYLES = ["plate", "plain"] as const;

/**
 * A line of text over the picture for a time (a title, a step's name, a note), in the CANVAS: it stays where it is
 * through a zoom. `x`/`y` are its centre, 0...1 of the canvas from the top left; it fades in and out over 0.2 s.
 */
export const textNoteSchema = z.object({
    id: z.string(),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    text: z.string().min(1).max(200),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.12),
    /** The text height, as a fraction of the canvas's short side. */
    size: z.number().min(0.02).max(0.15).default(0.055),
    /** `plate`: white on a dark rounded plate; `plain`: white with a soft shadow. */
    style: z.enum(TEXT_STYLES).default("plate"),
    /** The effect lane it sits on (lanes.ts); absent is the first lane that holds its kind. */
    lane: z.string().optional(),
});
export type EditTextNote = z.infer<typeof textNoteSchema>;

export const SHAPE_KINDS = ["arrow", "box", "circle"] as const;
/** How a shape comes in: "draw" draws itself on over 0.3 s (absent means this), "fade" fades in, "none" is there at once. */
export const SHAPE_APPEARS = ["draw", "fade", "none"] as const;

/**
 * An arrow, a box or a circle over the SOURCE picture (so it moves with a zoom, like a hidden part) from `startUs` to
 * `endUs`. An arrow runs from (x1, y1) to its head at (x2, y2); a box or circle fills the rectangle between the two
 * points. `width` is the line's thickness as a fraction of the picture's short side. It draws itself on over 0.3 s
 * and fades out over 0.2 s.
 */
export const shapeSchema = z.object({
    id: z.string(),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    kind: z.enum(SHAPE_KINDS),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1),
    y2: z.number().min(0).max(1),
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#FF3B30"),
    width: z.number().min(0.002).max(0.03).default(0.006),
    appear: z.enum(SHAPE_APPEARS).optional(),
    /** The effect lane it sits on (lanes.ts); absent is the first lane that holds its kind. */
    lane: z.string().optional(),
});
export type EditShape = z.infer<typeof shapeSchema>;

const rectSchema = z
    .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0.005).max(1),
        height: z.number().min(0.005).max(1),
    })
    .strict();

/** The ⌘/⌃ shortcuts the recording kept (`"key"` rows of the cursor track), drawn as they were pressed. Absent is off. */
export const keysSchema = z.object({
    show: z.boolean().default(true),
    /** The text height, as a fraction of the output's short side. */
    size: z.number().min(0.02).max(0.12).default(0.05),
    position: z.enum(["bottom", "top"]).default("bottom"),
    /** How long a shortcut stays after its press. */
    durationMs: z.number().int().min(300).max(5000).default(1200),
});

/** Whether the cursor track kept any shortcut (`"key"` rows, `tools recorder start` without --no-shortcuts). */
export function trackHasShortcuts(path: string | undefined): boolean {
    return Boolean(path && existsSync(path) && readFileSync(path, "utf8").includes('"key":'));
}

/** `<movie stem>.transcript.json` beside the movie: the raw transcription the REPL and the window share. */
export function transcriptCachePath(video: string): string {
    return join(dirname(video), `${basename(video, extname(video))}.transcript.json`);
}

/**
 * Music under the movie: `file` loops to the movie's length and fades in and out over `fadeMs`; while a transcript
 * line plays it drops by `duck` (0.6 = to 40 %), so speech stays clear. Without a transcript nothing ducks.
 */
export const musicSchema = z.object({
    file: z.string().min(1),
    volume: z.number().min(0).max(1).default(0.25),
    duck: z.number().min(0).max(1).default(0.6),
    fadeMs: z.number().int().min(0).max(10_000).default(1500),
    /** Where in the file the music starts, in ms; absent is its beginning. */
    startMs: z.number().int().min(0).optional(),
    /** false plays the file once (from startMs) and then stops; absent loops it to the movie's length. */
    loop: z.boolean().optional(),
});

/** The look of the zoom's moves: `blur` 0 (sharp) to 1 smears the picture along a pan or a zoom, 0.5 by default. */
export const motionSchema = z.object({
    blur: z.number().min(0).max(1).default(0.5),
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
            /** A sound file under the movie (looped to its length); absent is none. */
            music: musicSchema.optional(),
            /** Noise reduction of the sound on export (`denoise.ts`); absent is none. */
            denoise: denoiseSchema.optional(),
        })
        .default({ include: true, volume: 1, mutedTracks: [] }),
    export: z
        .object({
            codec: z.enum(["h264", "hevc"]).default("h264"),
            maxHeight: z.number().int().nonnegative().default(0),
            output: z.string().default(""),
            /** Absent is mp4, as before the field existed. */
            format: z.enum(EXPORT_FORMATS).optional(),
            /** A subtitle file written beside every export from the cached transcript; absent is none. */
            subtitles: z.enum(["srt", "vtt"]).optional(),
            /** The recording's markers as chapters inside an MP4; absent is on. */
            chapters: z.boolean().optional(),
        })
        .default({ codec: "h264", maxHeight: 0, output: "" }),
    clicks: clicksSchema.optional(),
    frame: frameSchema.optional(),
    cursor: cursorSchema.optional(),
    captions: captionsSchema.optional(),
    keys: keysSchema.optional(),
    /** Absent is none; written only once a redaction exists, so an older reader keeps its files. */
    redactions: z.array(redactionSchema).optional(),
    /** Absent is none; written only once a text exists. */
    texts: z.array(textNoteSchema).optional(),
    /** Arrows, boxes and circles over the picture; absent is none. */
    shapes: z.array(shapeSchema).optional(),
    /** Absent is no corrections. */
    transcript: transcriptSettingsSchema.optional(),
    /** How the picture moves through a zoom; absent is the defaults (motionSchema). */
    motion: motionSchema.optional(),
    /** The timeline's effect lanes in order (lanes.ts); absent is the default lanes. */
    lanes: z.array(effectLaneSchema).optional(),
    revision: z.number().int().nonnegative().default(0),
    updatedBy: z.string().optional(),
});

export type EditProject = z.infer<typeof editProjectSchema>;
export type EditClip = EditProject["clips"][number];
export type EditZoom = EditProject["zooms"][number];

export function newId(prefix: "c" | "z" | "r" | "t" | "s"): string {
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

/** The source time that plays at an output time; the end of the edit maps to the last clip's end. */
export function sourceTimeOf(project: EditProject, outUs: number): number {
    let start = 0;

    for (const clip of project.clips) {
        const length = Math.round((clip.toUs - clip.fromUs) / clip.speed);

        if (outUs < start + length) {
            return clip.fromUs + Math.round(Math.max(0, outUs - start) * clip.speed);
        }

        start += length;
    }

    return project.clips.at(-1)?.toUs ?? 0;
}

/**
 * The edit cut down to what plays from `fromOutUs` to `toOutUs` (OUTPUT microseconds), for exporting a part. Cuts and
 * speeds inside the part stay; the edit on disk is not changed.
 */
export function partOf(project: EditProject, fromOutUs: number, toOutUs: number): EditProject {
    const length = outputDurationUs(project);
    const seconds = (us: number) => Math.round(us / 1000) / 1000;

    if (!(toOutUs > fromOutUs) || fromOutUs < 0 || fromOutUs >= length) {
        throw new RangeError(
            `the part ${seconds(fromOutUs)}–${seconds(toOutUs)} s must start before it ends and inside the ${seconds(length)} s edit (OUTPUT seconds)`
        );
    }

    return keepRange(project, sourceTimeOf(project, fromOutUs), sourceTimeOf(project, Math.min(length, toOutUs)));
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

/** Hides a rectangle of the source picture from `fromUs` to `toUs`; the rectangle must lie inside the picture. */
export function addRedaction(
    project: EditProject,
    options: {
        fromUs: number;
        toUs: number;
        rect: z.infer<typeof rectSchema>;
        style: EditRedaction["style"];
        label?: string;
        follow?: boolean;
        dim?: number;
        cutout?: EditRedaction["cutout"];
    }
): EditProject {
    checkRange(project, options.fromUs, options.toUs);
    const { x, y, width, height } = options.rect;

    if (x + width > 1.0001 || y + height > 1.0001) {
        throw new RangeError(
            `the rectangle leaves the picture: x + width is ${Math.round((x + width) * 1000) / 1000} and y + height is ${Math.round((y + height) * 1000) / 1000}; both must be at most 1`
        );
    }

    const redaction: EditRedaction = {
        id: newId("r"),
        startUs: options.fromUs,
        endUs: Math.min(project.source.durationUs, options.toUs),
        x,
        y,
        width,
        height,
        style: options.style,
        ...(options.label?.trim() ? { label: options.label.trim() } : {}),
        ...(options.follow ? { follow: true } : {}),
        ...(options.style === "spotlight" && options.dim !== undefined ? { dim: options.dim } : {}),
        ...(options.style === "spotlight" && options.cutout && options.cutout !== "rounded"
            ? { cutout: options.cutout }
            : {}),
    };
    return { ...project, redactions: [...(project.redactions ?? []), redaction] };
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
    /** A ⌘/⌃ shortcut pressed at this sample. */
    key?: string;
}

/** The shortcuts a recording kept, in source seconds, with where each plays in the edit (null when cut). */
export function shortcutsOf(project: EditProject): Array<{ at: number; plays: number | null; key: string }> {
    const round = (us: number) => Math.round(us / 1000) / 1000;
    return readCursorTrack(project.source.cursor).flatMap((sample) => {
        if (!sample.key) {
            return [];
        }

        const sourceUs = Math.round(sample.ms * 1000);
        const plays = outputTimeOf(project, sourceUs);
        return [{ at: round(sourceUs), plays: plays === undefined ? null : round(plays), key: sample.key }];
    });
}

const cursorRowSchema = z.object({
    t: z.number(),
    x: z.number(),
    y: z.number(),
    click: z.string().optional(),
    key: z.string().optional(),
});

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
                          ...(row.data.key ? { key: row.data.key } : {}),
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

/**
 * Marks every recorded click from `fromUs` to `toUs` (source) with a shape for `seconds`: a circle round the point
 * (default), a box, or an arrow pointing at it from towards the middle. A double click is one mark (clicks under
 * 0.4 s apart and 2 % of the picture apart). A click that already has a shape of that kind starting within 0.1 s is
 * left alone, so a second run adds nothing. No clicks in the range is an error.
 */
export function annotateClicks(
    project: EditProject,
    samples: readonly CursorSample[],
    options: {
        fromUs?: number;
        toUs?: number;
        kind?: (typeof SHAPE_KINDS)[number];
        seconds?: number;
        color?: string;
        appear?: (typeof SHAPE_APPEARS)[number];
    } = {}
): { project: EditProject; added: number; skipped: number } {
    if (!samples.length) {
        throw new Error("the recording has no cursor track, so there are no clicks to mark");
    }

    const fromUs = options.fromUs ?? 0;
    const toUs = Math.min(options.toUs ?? project.source.durationUs, project.source.durationUs);
    const kind = options.kind ?? "circle";
    const lengthUs = Math.round((options.seconds ?? 1.2) * 1_000_000);
    const clicks: CursorSample[] = [];

    for (const sample of samples) {
        const us = sample.ms * 1000;

        if (!sample.click || us < fromUs || us > toUs) {
            continue;
        }

        const last = clicks.at(-1);

        if (last && sample.ms - last.ms < 400 && Math.hypot(sample.x - last.x, sample.y - last.y) < 0.02) {
            continue;
        }

        clicks.push(sample);
    }

    if (!clicks.length) {
        throw new RangeError(
            `no clicks between ${fromUs / 1_000_000} s and ${toUs / 1_000_000} s; the cursor track has no click there (autoZoom uses the same clicks)`
        );
    }

    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const existing = (project.shapes ?? []).filter((shape) => shape.kind === kind);
    const shapes = [...(project.shapes ?? [])];
    let skipped = 0;

    for (const click of clicks) {
        const startUs = Math.round(click.ms * 1000);

        if (existing.some((shape) => Math.abs(shape.startUs - startUs) <= 100_000)) {
            skipped += 1;
            continue;
        }

        const toward = { x: click.x > 0.5 ? -1 : 1, y: click.y > 0.5 ? -1 : 1 };
        const corners =
            kind === "arrow"
                ? {
                      x1: clamp(click.x + toward.x * 0.085),
                      y1: clamp(click.y + toward.y * 0.085),
                      x2: click.x,
                      y2: click.y,
                  }
                : {
                      x1: clamp(click.x - 0.03),
                      y1: clamp(click.y - 0.045),
                      x2: clamp(click.x + 0.03),
                      y2: clamp(click.y + 0.045),
                  };
        shapes.push(
            shapeSchema.parse({
                id: newId("s"),
                startUs,
                endUs: Math.min(project.source.durationUs, startUs + lengthUs),
                kind,
                ...corners,
                ...(options.color ? { color: options.color.toUpperCase() } : {}),
                ...(options.appear && options.appear !== "draw" ? { appear: options.appear } : {}),
            })
        );
    }

    return { project: { ...project, shapes }, added: clicks.length - skipped, skipped };
}

const focusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const rangeFields = { from: timeSchema, to: timeSchema };

/** One edit an agent or the CLI asks for; times are SOURCE times, seconds or "mm:ss". */
/** The range popover's actions that edit (its "Export This Part" is export({ from, to })). */
export const RANGE_ACTIONS = ["cut", "speed", "zoom", "hide", "spotlight", "text"] as const;

/** The middle of the picture a range's hidden part or spotlight starts with (the window's defaults). */
const RANGE_RECTS = {
    hide: { x: 0.35, y: 0.42, width: 0.3, height: 0.16 },
    spotlight: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
} as const;

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
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
        })
        .strict(),
    z.object({ op: z.literal("unzoom"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("redact"),
            from: timeSchema,
            to: timeSchema,
            /** 0...1 of the source picture from its top left; x + width and y + height stay inside it. */
            rect: rectSchema,
            style: z.enum(REDACTION_STYLES).optional(),
            /** What it hides ("API token"), shown in the editor's lists. */
            label: z.string().max(60).optional(),
            /** Moves with the drawn cursor, centred on it; rect gives its size. */
            follow: z.boolean().optional(),
            /** Style "spotlight" only: the dim around it (0.7) and its lit shape ("rounded"). */
            dim: z.number().min(0.2).max(0.95).optional(),
            cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("spotlight"),
            from: timeSchema,
            to: timeSchema,
            /** Stays as it is while the rest of the picture dims; with follow, its size around the cursor. */
            rect: rectSchema,
            label: z.string().max(60).optional(),
            follow: z.boolean().optional(),
            /** How dark the rest gets, 0.2 to 0.95 black (0.7). */
            dim: z.number().min(0.2).max(0.95).optional(),
            /** The lit shape: "rounded" (default), "rect" or "circle". */
            cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
        })
        .strict(),
    z.object({ op: z.literal("unredact"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("text"),
            from: timeSchema,
            to: timeSchema,
            text: z.string().trim().min(1).max(200),
            /** The centre, 0...1 of the canvas from the top left; 0.5, 0.12 (top middle) by default. */
            x: z.number().min(0).max(1).optional(),
            y: z.number().min(0).max(1).optional(),
            size: z.number().min(0.02).max(0.15).optional(),
            style: z.enum(TEXT_STYLES).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
        })
        .strict(),
    z.object({ op: z.literal("untext"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("retime"),
            id: z.string(),
            at: timeSchema.optional(),
            from: timeSchema.optional(),
            to: timeSchema.optional(),
            by: z.number().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("shape"),
            from: timeSchema,
            to: timeSchema,
            kind: z.enum(SHAPE_KINDS),
            /** An arrow's tail, or a box's or circle's corner, 0...1 of the source picture from its top left. */
            start: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
            /** An arrow's head (where it points), or the opposite corner. */
            end: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
            color: z
                .string()
                .regex(/^#[0-9a-fA-F]{6}$/)
                .optional(),
            width: z.number().min(0.002).max(0.03).optional(),
            appear: z.enum(SHAPE_APPEARS).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
        })
        .strict(),
    z.object({ op: z.literal("unshape"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("fixLine"),
            /** The line's `from` as transcript() gives it (source seconds). */
            from: timeSchema,
            /** The corrected words; "" hides the line. */
            text: z.string().max(300),
        })
        .strict(),
    z.object({ op: z.literal("unfixLine"), from: timeSchema }).strict(),
    z.object({ op: z.literal("autoZoom"), scale: z.number().min(1).max(4).optional() }).strict(),
    z
        .object({
            op: z.literal("annotateClicks"),
            /** Source seconds; the whole recording by default. */
            from: timeSchema.optional(),
            to: timeSchema.optional(),
            kind: z.enum(SHAPE_KINDS).optional(),
            /** How long each mark shows (1.2). */
            seconds: z.number().min(0.3).max(10).optional(),
            color: z
                .string()
                .regex(/^#[0-9a-fA-F]{6}$/)
                .optional(),
            appear: z.enum(SHAPE_APPEARS).optional(),
        })
        .strict(),
    z.object({ op: z.literal("volume"), volume: z.number().min(0).max(2) }).strict(),
    z.object({ op: z.literal("mute"), track: z.number().int().nonnegative(), muted: z.boolean().optional() }).strict(),
    z.object({ op: z.literal("audio"), include: z.boolean() }).strict(),
    z
        .object({
            op: z.literal("music"),
            /** A sound file (mp3, m4a, wav, aiff…); the first music op needs it. */
            file: z.string().optional(),
            volume: z.number().min(0).max(1).optional(),
            duck: z.number().min(0).max(1).optional(),
            fadeMs: z.number().int().min(0).max(10_000).optional(),
            /** Where in the file it starts, in ms (0). */
            startMs: z.number().int().min(0).optional(),
            /** false plays the file once; true (default) loops it. */
            loop: z.boolean().optional(),
            /** false removes the music. */
            enabled: z.boolean().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("exportSettings"),
            codec: z.enum(["h264", "hevc"]).optional(),
            maxHeight: z.number().int().nonnegative().optional(),
            output: z.string().optional(),
            format: z.enum(EXPORT_FORMATS).optional(),
            /** A subtitle file beside every export ("srt" or "vtt"); "none" stops it. */
            subtitles: z.enum(["srt", "vtt", "none"]).optional(),
            /** The markers as chapters inside an MP4 (on unless set to false). */
            chapters: z.boolean().optional(),
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
            /** A soft tick at each click in the sound (off). */
            sound: z.boolean().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("keys"),
            show: z.boolean().optional(),
            size: z.number().min(0.02).max(0.12).optional(),
            position: z.enum(["bottom", "top"]).optional(),
            durationMs: z.number().int().min(300).max(5000).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("captions"),
            show: z.boolean().optional(),
            size: z.number().min(0.02).max(0.1).optional(),
            position: z.enum(["bottom", "top"]).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("motion"),
            /** 0 keeps every frame of a pan or a zoom sharp; 1 is a full-frame shutter. */
            blur: z.number().min(0).max(1).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("cursor"),
            show: z.boolean().optional(),
            size: z.number().min(0.5).max(3).optional(),
            smoothing: z.number().min(0).max(1).optional(),
            hideAfterMs: z.number().int().min(0).max(30_000).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("frame"),
            /** false removes the frame: the plain movie again. */
            enabled: z.boolean().optional(),
            aspect: z.enum(CANVAS_ASPECTS).optional(),
            fit: z.enum(["contain", "cover"]).optional(),
            background: z
                .object({
                    kind: z.enum(BACKGROUND_KINDS).optional(),
                    colors: z.array(hexColor).min(1).max(2).optional(),
                    image: z.string().min(1).optional(),
                    blur: z.number().min(0).max(1).optional(),
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
            /** Plays the still parts this many times faster instead of cutting them, so time is seen to pass. */
            speed: z.number().min(2).max(16).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("cutWords"),
            /** Any source time inside the line (a line's from, from transcript() or find()). */
            at: timeSchema,
            /** The word or words (in order) to cut out of that line; every place the line says them. */
            words: z.string().min(1),
            /** Kept off the words' edges, so the next word is not clipped. Default 40. */
            padMs: z.number().int().min(0).max(500).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("cutFillers"),
            /** A FILLER_WORDS list (cs, sk, en); absent is all of them. */
            language: z.string().min(2).max(8).optional(),
            /** "sounds" (default: ehm, hm, um) or "all" (also the filler words that are real words: jako, like). */
            level: z.enum(FILLER_LEVELS).optional(),
            /** Your own list instead of the language's. */
            words: z.array(z.string().min(1)).optional(),
            padMs: z.number().int().min(0).max(500).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("denoise"),
            /** False takes the noise reduction away. */
            enabled: z.boolean().optional(),
            method: z.enum(DENOISE_METHODS).optional(),
            reductionDb: z.number().min(1).max(40).optional(),
            tracks: z.array(z.number().int().nonnegative()).optional(),
            /** A strength per track ("1": 20), merged into the ones set before. */
            trackReductionDb: z.record(z.string().regex(/^\d+$/), z.number().min(1).max(40)).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("normalize"),
            /** The integrated loudness the export should reach (EBU R128); -16 suits speech on the web, -14 music. */
            targetLufs: z.number().min(-30).max(-8).default(-16),
        })
        .strict(),
    /** The whole lane list at once, in order; an item whose lane is gone moves to the first lane that holds it. */
    z.object({ op: z.literal("lanes"), lanes: z.array(effectLaneSchema).min(1) }).strict(),
    z
        .object({
            op: z.literal("addLane"),
            /** What it holds; absent holds every kind. */
            kinds: z.array(z.enum(EFFECT_KINDS)).min(1).optional(),
            name: z.string().max(40).optional(),
            id: z.string().min(1).max(40).optional(),
        })
        .strict(),
    z.object({ op: z.literal("removeLane"), id: z.string() }).strict(),
    /** `to`: the lane's new place, 0 is the top. */
    z.object({ op: z.literal("moveLane"), id: z.string(), to: z.number().int().min(0) }).strict(),
    /** Puts a zoom, hidden part, spotlight, text or shape (by id) on a lane that holds its kind. */
    z.object({ op: z.literal("moveToLane"), id: z.string(), lane: z.string() }).strict(),
    /**
     * What the editor's range popover does to a range dragged on the frames lane, over OUTPUT times (what plays, as
     * the ruler shows them): cut it, play it at `factor` (2), zoom over it (`scale`), hide or spotlight the middle of
     * the picture, or put `text` ("Title") over it. Export a part with export({ from, to }).
     */
    z
        .object({
            op: z.literal("range"),
            from: timeSchema,
            to: timeSchema,
            action: z.enum(RANGE_ACTIONS),
            factor: z.number().min(0.25).max(16).optional(),
            scale: z.number().min(1).max(4).optional(),
            text: z.string().trim().min(1).max(200).optional(),
            lane: z.string().optional(),
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
    /** The cached transcript's lines (`cutWords`, `cutFillers`). */
    transcript?: readonly TranscriptSegment[];
    /** The movie's integrated loudness at volume 1; null when it has no unmuted audio. */
    loudnessLufs?: number | null;
}

/** The loudest a volume may lift: 200 %, +6 dB. */
const MAX_VOLUME = 2;

/**
 * The times of an op (`from`, `to`, `at`, source seconds) that lie past the end of the source movie, as sentences a
 * caller can return: such a time is clamped to the end, which a reader of the result would otherwise not notice.
 */
export function opTimeWarnings(op: EditOp, sourceDurationUs: number): string[] {
    const warnings: string[] = [];
    const seconds = (us: number) => Math.round(us / 1000) / 1000;

    for (const key of ["from", "to", "at"] as const) {
        const value = Object.entries(op).find(([name]) => name === key)?.[1];
        const parsed = timeSchema.safeParse(value);

        if (value === undefined || !parsed.success) {
            continue;
        }

        const us = timeToUs(parsed.data);

        if (us > sourceDurationUs) {
            warnings.push(
                `${op.op}: ${key} ${seconds(us)} s is past the end of the source (${seconds(sourceDurationUs)} s), so it was clamped to the end`
            );
        }
    }

    return warnings;
}

/** Applies one op; throws a RangeError a caller can show as it is. */
/**
 * Moves or trims the zoom, hidden part, text or shape with this id: `at` (a new start) or `by` seconds moves it with
 * its length kept; `from` and `to` set its start and end, so `from` alone makes it longer or shorter (source time).
 * Held inside the recording; a zoom may not meet another zoom.
 */
function retimeItem(project: EditProject, op: Extract<EditOp, { op: "retime" }>): EditProject {
    const moves = [op.at, op.by].filter((value) => value !== undefined).length;

    if (moves > 1 || (moves === 1 && (op.from !== undefined || op.to !== undefined))) {
        throw new Error(
            "retime takes one of: `at` (a new start, length kept), `by` (seconds to move, length kept), or `from`/`to` (a new start or end, which changes the length), not both"
        );
    }

    if (moves === 0 && op.from === undefined && op.to === undefined) {
        throw new Error(
            "retime needs `at` (a new start, length kept), `by` (seconds to move, negative is earlier) or `from` and/or `to`"
        );
    }

    const durationUs = project.source.durationUs;
    const place = (startUs: number, endUs: number): { startUs: number; endUs: number } => {
        if (op.at !== undefined || op.by !== undefined) {
            const length = endUs - startUs;
            const wanted = op.at !== undefined ? timeToUs(op.at) : startUs + Math.round((op.by ?? 0) * 1e6);
            const moved = Math.min(Math.max(0, wanted), Math.max(0, durationUs - length));
            return { startUs: moved, endUs: moved + length };
        }

        const nextStart = op.from === undefined ? startUs : Math.max(0, timeToUs(op.from));
        const nextEnd = op.to === undefined ? endUs : Math.min(durationUs, timeToUs(op.to));

        if (nextEnd - nextStart < 100_000) {
            throw new Error(
                `retime would leave ${op.id} ${(nextStart / 1e6).toFixed(2)}–${(nextEnd / 1e6).toFixed(2)} s; it must last at least 0.1 s`
            );
        }

        return { startUs: nextStart, endUs: nextEnd };
    };

    const zoom = project.zooms.find((item) => item.id === op.id);

    if (zoom) {
        const span = place(zoom.startUs, zoom.endUs);
        const meets = project.zooms.find(
            (other) => other.id !== op.id && span.startUs < other.endUs && span.endUs > other.startUs
        );

        if (meets) {
            throw new Error(
                `zoom ${op.id} would overlap zoom ${meets.id} (${meets.startUs / 1e6}–${meets.endUs / 1e6} s); zooms cannot overlap`
            );
        }

        return { ...project, zooms: project.zooms.map((item) => (item.id === op.id ? { ...item, ...span } : item)) };
    }

    if (project.redactions?.some((item) => item.id === op.id)) {
        return {
            ...project,
            redactions: project.redactions.map((item) =>
                item.id === op.id ? { ...item, ...place(item.startUs, item.endUs) } : item
            ),
        };
    }

    if (project.texts?.some((item) => item.id === op.id)) {
        return {
            ...project,
            texts: project.texts.map((item) =>
                item.id === op.id ? { ...item, ...place(item.startUs, item.endUs) } : item
            ),
        };
    }

    if (project.shapes?.some((item) => item.id === op.id)) {
        return {
            ...project,
            shapes: project.shapes.map((item) =>
                item.id === op.id ? { ...item, ...place(item.startUs, item.endUs) } : item
            ),
        };
    }

    const ids = [
        ...project.zooms.map((item) => item.id),
        ...(project.redactions ?? []).map((item) => item.id),
        ...(project.texts ?? []).map((item) => item.id),
        ...(project.shapes ?? []).map((item) => item.id),
    ];
    throw new Error(`no zoom, hidden part, text or shape ${op.id}; ids: ${ids.join(", ") || "none"}`);
}

export function applyOp(project: EditProject, op: EditOp, facts: OpFacts = {}): EditProject {
    const next = applyOpItself(project, op, facts);

    if ("lane" in op && op.op !== "moveToLane" && op.lane) {
        const lanes = resolveLanes(next).map((entry) => entry.lane.id);

        if (!lanes.includes(op.lane)) {
            throw new Error(`no lane ${op.lane}; lanes: ${lanes.join(", ")}`);
        }

        const added = addedItemIds(project, next);
        const placed = withLane(next, added, op.lane);
        const lane = resolveLanes(placed).find((entry) => entry.lane.id === op.lane);
        const misplaced = laneItems(placed).filter(
            (item) => added.has(item.id) && !lane?.items.some((entry) => entry.id === item.id)
        );

        if (misplaced.length > 0) {
            throw new Error(
                `lane ${op.lane} holds ${lane?.lane.kinds?.join(", ") ?? "any kind"}, not ${misplaced[0].kind}`
            );
        }

        return placed;
    }

    return next;
}

function applyOpItself(project: EditProject, op: EditOp, facts: OpFacts): EditProject {
    switch (op.op) {
        case "lanes":
            return setLanes(project, op.lanes);
        case "addLane":
            return addLane(project, { id: op.id, kinds: op.kinds, name: op.name });
        case "removeLane":
            return removeLane(project, op.id);
        case "moveLane":
            return moveLane(project, op.id, op.to);
        case "moveToLane":
            return moveToLane(project, op.id, op.lane);
        case "range":
            return applyRange(project, op);
        case "removeIdle": {
            if (!facts.idleUs) {
                throw new Error("removeIdle needs the movie's idle stretches; run it through editProject or the CLI");
            }

            let next = project;

            for (const [from, to] of facts.idleUs) {
                if (to - from >= MINIMUM_CLIP_US) {
                    next = op.speed ? speedRange(next, from, to, op.speed) : cutRange(next, from, to);
                }
            }

            return next;
        }
        case "normalize": {
            if (facts.loudnessLufs === undefined) {
                throw new Error("normalize needs the movie's loudness; run it through editProject or the CLI");
            }

            if (facts.loudnessLufs === null || facts.loudnessLufs < -70) {
                throw new Error("this movie has no unmuted audio to normalize (it is silent or every track is muted)");
            }

            const gain = 10 ** ((op.targetLufs - facts.loudnessLufs) / 20);
            const volume = Math.round(Math.min(MAX_VOLUME, gain) * 100) / 100;
            return { ...project, audio: { ...project.audio, include: true, volume } };
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
        case "redact":
            return addRedaction(project, {
                fromUs: timeToUs(op.from),
                toUs: timeToUs(op.to),
                rect: op.rect,
                style: op.style ?? "blur",
                label: op.label,
                follow: op.follow,
            });
        case "spotlight":
            return addRedaction(project, {
                fromUs: timeToUs(op.from),
                toUs: timeToUs(op.to),
                rect: op.rect,
                style: "spotlight",
                label: op.label,
                follow: op.follow,
                dim: op.dim,
                cutout: op.cutout,
            });
        case "unredact": {
            const list = project.redactions ?? [];

            if (!list.some((redaction) => redaction.id === op.id)) {
                throw new Error(
                    `no redaction ${op.id}; redactions: ${list.map((redaction) => redaction.id).join(", ") || "none"}`
                );
            }

            return { ...project, redactions: list.filter((redaction) => redaction.id !== op.id) };
        }
        case "text": {
            const fromUs = timeToUs(op.from);
            const toUs = timeToUs(op.to);
            checkRange(project, fromUs, toUs);
            const note = textNoteSchema.parse({
                id: newId("t"),
                startUs: fromUs,
                endUs: Math.min(project.source.durationUs, toUs),
                // applyOp also takes an op that was never parsed, so the trim happens here too.
                text: op.text.trim(),
                ...(op.x === undefined ? {} : { x: op.x }),
                ...(op.y === undefined ? {} : { y: op.y }),
                ...(op.size === undefined ? {} : { size: op.size }),
                ...(op.style === undefined ? {} : { style: op.style }),
            });
            return { ...project, texts: [...(project.texts ?? []), note] };
        }
        case "shape": {
            const fromUs = timeToUs(op.from);
            const toUs = timeToUs(op.to);
            checkRange(project, fromUs, toUs);

            if (Math.hypot(op.end.x - op.start.x, op.end.y - op.start.y) < 0.01) {
                throw new RangeError("the shape's start and end are the same point; move end away from start");
            }

            const shape = shapeSchema.parse({
                id: newId("s"),
                startUs: fromUs,
                endUs: Math.min(project.source.durationUs, toUs),
                kind: op.kind,
                x1: op.start.x,
                y1: op.start.y,
                x2: op.end.x,
                y2: op.end.y,
                ...(op.color === undefined ? {} : { color: op.color.toUpperCase() }),
                ...(op.width === undefined ? {} : { width: op.width }),
                ...(op.appear === undefined || op.appear === "draw" ? {} : { appear: op.appear }),
            });
            return { ...project, shapes: [...(project.shapes ?? []), shape] };
        }
        case "unshape": {
            const list = project.shapes ?? [];

            if (!list.some((shape) => shape.id === op.id)) {
                throw new Error(`no shape ${op.id}; shapes: ${list.map((shape) => shape.id).join(", ") || "none"}`);
            }

            const rest = list.filter((shape) => shape.id !== op.id);
            const { shapes: _shapes, ...without } = project;
            return rest.length ? { ...project, shapes: rest } : without;
        }
        case "fixLine": {
            const key = String(Math.round(timeToUs(op.from) / 1000));
            const fixes = { ...(project.transcript?.fixes ?? {}), [key]: op.text.trim() };
            return { ...project, transcript: { fixes } };
        }
        case "unfixLine": {
            const key = String(Math.round(timeToUs(op.from) / 1000));
            const { [key]: removed, ...rest } = project.transcript?.fixes ?? {};

            if (removed === undefined) {
                const known = Object.keys(project.transcript?.fixes ?? {}).map((ms) => Number(ms) / 1000);
                throw new Error(
                    `no fix for the line at ${key} ms; fixed lines start at: ${known.join(", ") || "none"} s`
                );
            }

            return { ...project, transcript: Object.keys(rest).length ? { fixes: rest } : undefined };
        }
        case "retime":
            return retimeItem(project, op);
        case "untext": {
            const list = project.texts ?? [];

            if (!list.some((note) => note.id === op.id)) {
                throw new Error(`no text ${op.id}; texts: ${list.map((note) => note.id).join(", ") || "none"}`);
            }

            const rest = list.filter((note) => note.id !== op.id);
            return { ...project, texts: rest.length ? rest : undefined };
        }
        case "autoZoom":
            return autoZoom(project, readCursorTrack(project.source.cursor), op.scale);
        case "annotateClicks":
            return annotateClicks(project, readCursorTrack(project.source.cursor), {
                fromUs: op.from === undefined ? undefined : timeToUs(op.from),
                toUs: op.to === undefined ? undefined : timeToUs(op.to),
                kind: op.kind,
                seconds: op.seconds,
                color: op.color,
                appear: op.appear,
            }).project;
        case "volume":
            return { ...project, audio: { ...project.audio, volume: op.volume } };
        case "mute": {
            const others = project.audio.mutedTracks.filter((track) => track !== op.track);
            const mutedTracks = op.muted === false ? others : [...others, op.track].sort((a, b) => a - b);
            return { ...project, audio: { ...project.audio, mutedTracks } };
        }
        case "audio":
            return { ...project, audio: { ...project.audio, include: op.include } };
        case "cutWords":
        case "cutFillers": {
            if (!facts.transcript) {
                throw new Error(
                    `${op.op} needs the transcript; run transcript() first, then edit through editProject or the CLI`
                );
            }

            const cuts =
                op.op === "cutWords"
                    ? wordCuts({
                          segments: facts.transcript,
                          atSec: timeToUs(op.at) / 1_000_000,
                          words: op.words,
                          ...(op.padMs !== undefined ? { padMs: op.padMs } : {}),
                      })
                    : fillerCuts({
                          segments: facts.transcript,
                          fillers: fillerList({ language: op.language, words: op.words, level: op.level }),
                          ...(op.padMs !== undefined ? { padMs: op.padMs } : {}),
                      });
            return cutRanges(cuts).reduce((next, cut) => cutRange(next, cut.fromUs, cut.toUs), project);
        }
        case "denoise": {
            if (op.enabled === false) {
                const { denoise: _denoise, ...audio } = project.audio;
                return { ...project, audio };
            }

            const denoise = denoiseSchema.parse({
                ...project.audio.denoise,
                ...(op.method === undefined ? {} : { method: op.method }),
                ...(op.reductionDb === undefined ? {} : { reductionDb: op.reductionDb }),
                ...(op.tracks === undefined ? {} : { tracks: op.tracks }),
                ...(op.trackReductionDb === undefined
                    ? {}
                    : { trackReductionDb: { ...project.audio.denoise?.trackReductionDb, ...op.trackReductionDb } }),
            });
            return { ...project, audio: { ...project.audio, include: true, denoise } };
        }
        case "music": {
            if (op.enabled === false) {
                const { music: _music, ...audio } = project.audio;
                return { ...project, audio };
            }

            const { op: _op, enabled: _enabled, ...change } = op;
            const merged = { ...project.audio.music, ...change };

            if (!merged.file) {
                throw new Error("music needs a file the first time: a sound file such as an mp3, m4a or wav");
            }

            const file = resolve(merged.file);

            if (!existsSync(file)) {
                throw new Error(`the music file ${file} does not exist`);
            }

            return { ...project, audio: { ...project.audio, music: musicSchema.parse({ ...merged, file }) } };
        }
        case "exportSettings":
            return {
                ...project,
                export: {
                    codec: op.codec ?? project.export.codec,
                    maxHeight: op.maxHeight ?? project.export.maxHeight,
                    output: op.output ?? project.export.output,
                    ...((op.format ?? project.export.format) ? { format: op.format ?? project.export.format } : {}),
                    ...((op.chapters ?? project.export.chapters) === undefined
                        ? {}
                        : { chapters: op.chapters ?? project.export.chapters }),
                    ...(op.subtitles === "none"
                        ? {}
                        : (op.subtitles ?? project.export.subtitles)
                          ? { subtitles: op.subtitles ?? project.export.subtitles }
                          : {}),
                },
            };
        case "reset":
            return { ...wholeProject(project.source), revision: project.revision };
        case "clicks": {
            const { op: _op, ...change } = op;
            return { ...project, clicks: clicksSchema.parse({ ...project.clicks, ...change }) };
        }
        case "keys": {
            if (!trackHasShortcuts(project.source.cursor)) {
                throw new Error(
                    "this recording kept no shortcuts (none was pressed with ⌘ or ⌃, or it was made with --no-shortcuts or before shortcuts were kept)"
                );
            }

            const { op: _op, ...change } = op;
            return { ...project, keys: keysSchema.parse({ ...project.keys, ...change }) };
        }
        case "captions": {
            if (!existsSync(transcriptCachePath(project.source.video))) {
                throw new Error(
                    "this movie has no transcript yet; run movie.transcript() (or the Style tab's Transcribe) first, then turn captions on"
                );
            }

            const { op: _op, ...change } = op;
            return { ...project, captions: captionsSchema.parse({ ...project.captions, ...change }) };
        }
        case "motion": {
            const { op: _op, ...change } = op;
            return { ...project, motion: motionSchema.parse({ ...project.motion, ...change }) };
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
            const background = { ...current.background, ...op.background };

            if (op.background?.image) {
                background.image = resolve(op.background.image.replace(/^~(?=[/\\])/, homedir()));
                background.kind = op.background.kind ?? "image";
            }

            if (background.kind === "image" && (!background.image || !existsSync(background.image))) {
                throw new Error(
                    background.image
                        ? `the background image ${background.image} does not exist`
                        : 'a background of kind "image" needs background.image, a picture file'
                );
            }

            return {
                ...project,
                frame: frameSchema.parse({
                    ...current,
                    ...(op.aspect === undefined ? {} : { aspect: op.aspect }),
                    ...(op.fit === undefined ? {} : { fit: op.fit }),
                    ...(op.padding === undefined ? {} : { padding: op.padding }),
                    ...(op.cornerRadius === undefined ? {} : { cornerRadius: op.cornerRadius }),
                    ...(op.shadow === undefined ? {} : { shadow: op.shadow }),
                    background,
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
        audio: project.audio.music
            ? {
                  ...project.audio,
                  // Ducking reads the transcript's lines; without a cached transcript the music plays level.
                  music: {
                      ...project.audio.music,
                      ducks: project.audio.music.duck > 0 && existsSync(transcriptCachePath(project.source.video)),
                  },
              }
            : project.audio,
        export: project.export,
        clicks: project.clicks ?? null,
        frame: project.frame ?? null,
        redactions: (project.redactions ?? []).map((redaction) => ({
            id: redaction.id,
            from: seconds(redaction.startUs),
            to: seconds(redaction.endUs),
            rect: { x: redaction.x, y: redaction.y, width: redaction.width, height: redaction.height },
            style: redaction.style,
            ...(redaction.label ? { label: redaction.label } : {}),
            ...(redaction.follow ? { follow: true } : {}),
            ...(redaction.style === "spotlight"
                ? { dim: redaction.dim ?? 0.7, cutout: redaction.cutout ?? "rounded" }
                : {}),
        })),
        /** null: the system cursor is in the picture, so there is nothing to change. */
        cursor: trackDrawsCursor(project.source.cursor) ? cursorSchema.parse(project.cursor ?? {}) : null,
        captions: project.captions ?? null,
        keys: project.keys ?? null,
        transcriptFixes: Object.keys(project.transcript?.fixes ?? {}).length,
        motion: motionSchema.parse(project.motion ?? {}),
        shapes: (project.shapes ?? []).map((shape) => ({
            id: shape.id,
            kind: shape.kind,
            from: seconds(shape.startUs),
            to: seconds(shape.endUs),
            start: { x: shape.x1, y: shape.y1 },
            end: { x: shape.x2, y: shape.y2 },
            color: shape.color,
            appear: shape.appear ?? "draw",
        })),
        texts: (project.texts ?? []).map((note) => ({
            id: note.id,
            from: seconds(note.startUs),
            to: seconds(note.endUs),
            text: note.text,
            at: { x: note.x, y: note.y },
            size: note.size,
            style: note.style,
        })),
        /** The timeline's effect lanes top to bottom, each with the ids of the items on it. */
        lanes: resolveLanes(project).map(({ lane, items, automatic }) => ({
            id: lane.id,
            kinds: lane.kinds ?? "any",
            ...(lane.name ? { name: lane.name } : {}),
            ...(automatic ? { automatic: true } : {}),
            items: items.map((item) => item.id),
        })),
    };
}

/** The `range` op: the OUTPUT range mapped to the source, then the op that does the action there. */
function applyRange(project: EditProject, op: Extract<EditOp, { op: "range" }>): EditProject {
    const fromOut = timeToUs(op.from);
    const toOut = timeToUs(op.to);

    if (!(toOut > fromOut)) {
        throw new RangeError(`the range ends (${toOut / 1e6} s) before it starts (${fromOut / 1e6} s)`);
    }

    const fromUs = sourceTimeOf(project, fromOut);
    const toUs = sourceTimeOf(project, Math.min(toOut, outputDurationUs(project)));
    const seconds = { from: fromUs / 1e6, to: toUs / 1e6 };

    switch (op.action) {
        case "cut":
            return cutRange(project, fromUs, toUs);
        case "speed":
            return speedRange(project, fromUs, toUs, op.factor ?? 2);
        case "zoom":
            return addZoom(project, fromUs, toUs, { scale: op.scale }).project;
        case "hide":
            return addRedaction(project, { fromUs, toUs, rect: RANGE_RECTS.hide, style: "blur" });
        case "spotlight":
            return addRedaction(project, { fromUs, toUs, rect: RANGE_RECTS.spotlight, style: "spotlight" });
        case "text":
            return applyOpItself(project, { op: "text", ...seconds, text: op.text ?? "Title" }, {});
    }
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
    const fixes = project.transcript?.fixes ?? {};
    return parsed.data.segments
        .map((segment) => {
            const fix = fixes[String(Math.round(segment.start * 1000))];
            return fix === undefined ? segment : { ...segment, text: fix };
        })
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
