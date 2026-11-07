import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { CAMERA_CORNERS, CAMERA_SHAPES, cameraBubbleSchema, hideCamera, showCamera } from "./camera";
import { cursorSmoothSchema } from "./cursor-smooth";
import { DENOISE_METHODS, denoiseSchema } from "./denoise";
import { applyFxOp, describeFx, fxOpSchemas, lensSchema, tiltSchema, transitionsSchema } from "./fx";
import { recordingItemId, withItemIds } from "./item-ids";
import {
    clipSpeed,
    cursorPointAt,
    deleteClip,
    denoiseTrack,
    duplicateItem,
    placedShape,
    removeCameraHidden,
    removeClickCircles,
    setRedaction,
    setShape,
    setText,
    setZoom,
    trimClip,
} from "./item-ops";
import {
    addedItemIds,
    addLane,
    EFFECT_KINDS,
    effectLaneSchema,
    laneItems,
    moveLane,
    moveToLane,
    removeLane,
    renameLane,
    resolveLanes,
    setLanes,
    withLane,
} from "./lanes";
import {
    applyCaptionsStyle,
    applyCard,
    applyProgress,
    CAPTION_KINDS,
    CHAPTER_PLACES,
    captionsStyleSchema,
    cardsLeadUs,
    cardsSchema,
    progressSchema,
    TEXT_ANIMATIONS,
    textAnimateOf,
    textAnimateSchema,
} from "./overlays";
import { outputTimeSchema, sourceTimeSchema, timeSchema, timeToUs } from "./plan";
import { PRIVATE_KINDS, PRIVATE_STYLES, type PrivateHit, privacySchema } from "./private-data";
import {
    cutRanges,
    FILLER_LEVELS,
    type FillerLists,
    fillerCuts,
    fillerList,
    type TranscriptSegment,
    wordCuts,
} from "./transcript-cuts";
import { applyDucking, applyVoiceover, duckingSchema, removeVoiceover, voiceoverSchema } from "./voiceovers";
import { autoSpeedSchema, SPEED_BADGE_POSITIONS, type WaitStretch } from "./waits";

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
    // R5 4 canvas zoom
    /**
     * What it zooms: "picture" (absent) zooms inside the movie, the frame and its background staying still; "canvas"
     * zooms the whole framed export (picture, frame, background), so a phone placed in a 16:9 frame can fill it.
     * Its focus is then 0...1 of the canvas. A canvas zoom may overlap a picture zoom; two of one kind may not.
     */
    target: z.enum(["picture", "canvas"]).optional(),
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

// R5 4 frame layouts
/** Where a framed picture sits on its canvas. */
export const FRAME_ALIGNS = ["center", "left", "right", "top", "bottom"] as const;

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
    // R5 4 frame layouts
    /** Where the picture sits on the canvas and how big; absent is centred at its fitted size. */
    layout: z
        .object({
            /**
             * "center", or against one edge (inside the padding): "left" or "right" leaves the other side of a wide
             * canvas free for texts beside a phone; "top" or "bottom" does the same on a tall canvas.
             */
            align: z.enum(FRAME_ALIGNS).default("center"),
            /**
             * Times the fitted size (0.5 to 3): above 1 the picture grows past the padding and the canvas cuts what
             * does not fit, so a phone fills more of the height (its top and bottom are cut first).
             */
            scale: z.number().min(0.5).max(3).default(1),
        })
        .optional(),
});

// R5 4 frame layouts
/**
 * Ready frames for a phone recording: "phone-left" and "phone-right" put the phone against one side of a 16:9 canvas
 * with the other side (about three quarters of it) free for texts, and layout.scale above 1 makes the phone bigger;
 * "phone-portrait" fills a 9:16 canvas (Shorts, Reels) from the top and leaves its bottom eighth for captions. Each
 * sets the aspect, padding, corner radius and layout; the op's own fields still win.
 */
export const FRAME_PRESETS = ["phone-left", "phone-right", "phone-portrait"] as const;
export type FramePreset = (typeof FRAME_PRESETS)[number];

export const FRAME_PRESET_VALUES: Record<
    FramePreset,
    {
        aspect: (typeof CANVAS_ASPECTS)[number];
        padding: number;
        cornerRadius: number;
        layout: { align: (typeof FRAME_ALIGNS)[number]; scale: number };
    }
> = {
    "phone-left": { aspect: "16:9", padding: 0.04, cornerRadius: 0.035, layout: { align: "left", scale: 1 } },
    "phone-right": { aspect: "16:9", padding: 0.04, cornerRadius: 0.035, layout: { align: "right", scale: 1 } },
    "phone-portrait": { aspect: "9:16", padding: 0.04, cornerRadius: 0.03, layout: { align: "top", scale: 0.88 } },
};

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

// fx B (round 4): a rectangle as fractions of the picture, and one keyframe of a tracked hidden part.
const boxSchema = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
});
const trackKeySchema = boxSchema.extend({ atUs: z.number().int().nonnegative() });

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
    // fx B (round 4): a hidden part that follows its text, and the areas it leaves visible.
    /**
     * Keyframes of the rectangle at SOURCE microseconds, in time order: between two the rectangle moves straight from
     * one to the next, before the first and after the last it holds. Absent is the fixed x, y, width, height.
     */
    track: z.array(trackKeySchema).optional(),
    /** Areas of the picture (fractions from its top left) the part leaves visible: a toast, a tab bar over the text. */
    exclude: z.array(boxSchema).optional(),
    // R5 5 redaction edges
    /**
     * A spotlight's dim fades in and out over this many ms (at most a third of its length); 0 is a hard cut, absent is
     * 200. The hiding styles never fade: they cover fully from their first frame to their last.
     */
    fadeMs: z.number().int().min(0).max(2000).optional(),
    /** A pixelate block's side in source pixels (2 to 256); absent is 1.8 % of the picture's height, at least 8. */
    cell: z.number().min(2).max(256).optional(),
});
export type EditRedaction = z.infer<typeof redactionSchema>;

// R5 5 redaction edges
/**
 * How the export closes small holes around the hiding parts (blur, pixelate, black; not spotlights): one that ends
 * up to snapMs before a cut is drawn to the cut, one that starts up to snapMs after a cut is drawn from it, and two
 * with a gap up to snapMs meet. 0 draws every part exactly as placed. The export also keeps a part on while a frame
 * from its time stays on screen (a screen recording writes no frame while nothing moves), whatever snapMs says.
 */
export const redactionJoinsSchema = z.object({ snapMs: z.number().int().min(0).max(2000).default(250) });
export const REDACTION_SNAP_MS = 250;

// R5 3 export size
export const exportSizeSchema = z.object({
    width: z.number().int().min(16).max(8192).optional(),
    height: z.number().int().min(16).max(8192).optional(),
});

/** `{ size }` when it names a side, else nothing (an empty size is "follow maxHeight"). */
function exportSizeOf(size: z.infer<typeof exportSizeSchema> | undefined) {
    return size && (size.width !== undefined || size.height !== undefined) ? { size } : {};
}

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

/**
 * A moment marked while editing (the range popover's Add Marker, the `marker` op), at SOURCE microseconds. The
 * recording's own markers, set while it recorded, stay in its recording.json; `markersOf` lists both, and the chapters
 * and the editor's marks lane show both.
 */
export const editMarkerSchema = z.object({
    id: z.string(),
    atUs: z.number().int().nonnegative(),
    label: z.string().trim().min(1).max(80),
});
export type EditMarker = z.infer<typeof editMarkerSchema>;

export const TEXT_STYLES = ["plate", "plain"] as const;

/**
 * A line of text over the picture for a time (a title, a step's name, a note), in the CANVAS: it stays where it is
 * through a zoom. `x`/`y` are its centre, 0...1 of the canvas from the top left; it fades in and out over 0.2 s.
 */
// R5 10 multi-line texts
/** A text's length limit; "\n" starts a new line, and a long line wraps at the block's width. */
export const TEXT_MAX_CHARS = 500;
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
/** The box a text wraps in: its width as a share of the canvas's width, and how its lines align. */
export const textBlockSchema = z.object({
    width: z.number().min(0.15).max(0.95).optional(),
    align: z.enum(TEXT_ALIGNS).optional(),
});

export const textNoteSchema = z.object({
    id: z.string(),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    text: z.string().min(1).max(TEXT_MAX_CHARS),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.12),
    /** The text height, as a fraction of the canvas's short side. */
    size: z.number().min(0.02).max(0.15).default(0.055),
    /** `plate`: white on a dark rounded plate; `plain`: white with a soft shadow. */
    style: z.enum(TEXT_STYLES).default("plate"),
    /** The effect lane it sits on (lanes.ts); absent is the first lane that holds its kind. */
    lane: z.string().optional(),
    // R4 6 animated texts
    /** How it comes in (overlays.ts); absent is the 0.2 s fade. */
    animate: textAnimateSchema.optional(),
    // R5 10 multi-line texts
    /** Where its lines wrap (width, 0.8 of the canvas) and how they align ("center"); absent is both defaults. */
    block: textBlockSchema.optional(),
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
            // R4 voiceover clips
            /** Extra sound files played from source times (voiceovers.ts); absent is none. */
            voiceovers: z.array(voiceoverSchema).optional(),
            // R4 8 music ducking
            /** How far the music drops under speech (voiceovers.ts); absent keeps `music.duck`. */
            ducking: duckingSchema.optional(),
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
            // R5 3 export size
            /**
             * The exported picture's exact pixels: one side (the other follows the canvas's shape) or both in that
             * shape. It wins over maxHeight and the H.264 frame-rate budget; absent follows maxHeight.
             */
            size: exportSizeSchema.optional(),
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
    /** The camera recorded beside the screen, drawn as a bubble; absent is none (camera.ts). */
    camera: cameraBubbleSchema.optional(),
    /** Moments marked while editing, in source order; absent is none (the recording's own are in recording.json). */
    markers: z.array(editMarkerSchema).optional(),
    /** Round 4 fx-render: transitions at the joins of two clips (fx.ts); absent is a hard cut everywhere. */
    transitions: transitionsSchema.optional(),
    /** Round 4 fx-render: magnifier lenses over source ranges (fx.ts); absent is none. */
    lens: lensSchema.optional(),
    /** Round 4 fx-render: the 3D tilt of the framed picture (fx.ts); absent is flat. */
    tilt: tiltSchema.optional(),
    // fx B (round 4): private data, smooth cursor, typing and waiting speed-ups. Absent is off.
    /** The private data hidden from the screen text scan (private-data.ts); absent is none. */
    privacy: privacySchema.optional(),
    /** The smooth cursor (cursor-smooth.ts); absent keeps the cursor's own smoothing. */
    cursorSmooth: cursorSmoothSchema.optional(),
    /** The speed badge over sped-up parts (waits.ts); absent is no badge. */
    autoSpeed: autoSpeedSchema.optional(),
    revision: z.number().int().nonnegative().default(0),
    updatedBy: z.string().optional(),
    // R4 6 animated captions
    /** How the captions animate (overlays.ts); absent shows each line at once. */
    captionsStyle: captionsStyleSchema.optional(),
    // R4 10 progress bar and chapter strip
    /** A bar along the bottom showing the share played, divided at the markers (overlays.ts); absent is none. */
    progress: progressSchema.optional(),
    // R4 9 intro and end cards
    /** A title card before the movie and an end card after it, in the export only (overlays.ts); absent is none. */
    cards: cardsSchema.optional(),
    // R5 5 redaction edges
    /** How the hiding parts close small holes at cuts and between each other; absent is snapMs 250. */
    redactionJoins: redactionJoinsSchema.optional(),
    // R5 11 clamps visible in check()
    /**
     * What edit calls did that check() keeps naming: `clamped` holds the warnings of ops whose time lay past the end
     * of the source (the newest 20). An undo takes a note back with its edit; a reset clears them.
     */
    notes: z.object({ clamped: z.array(z.string()).max(20).optional() }).optional(),
});

export type EditProject = z.infer<typeof editProjectSchema>;
export type EditClip = EditProject["clips"][number];
export type EditZoom = EditProject["zooms"][number];

export function newId(prefix: "c" | "z" | "r" | "t" | "s" | "m" | "v"): string {
    return recordingItemId(prefix);
}

/** `<folder>/edit.json` for a recording folder's movie, `<name>.edit.json` beside any other movie. */
export function projectPathFor(video: string): string {
    const folder = dirname(video);

    if (existsSync(join(folder, "recording.json"))) {
        return join(folder, "edit.json");
    }

    return join(folder, `${basename(video, extname(video))}.edit.json`);
}

/**
 * The id of a new edit's one clip. It is the same in every process (here and the editor's EditProject.whole), so a
 * clip id that `tools recorder project` printed for an edit not saved yet still names that clip in the next command;
 * a random one changed on every call ("clipSpeed refused: no clip c1…; clips: c2…"). Later clips get random ids.
 */
export const WHOLE_CLIP_ID = "c00000000";

/** A project that keeps the whole movie, as a new edit starts. */
export function wholeProject(source: EditProject["source"]): EditProject {
    return editProjectSchema.parse({ source, clips: [{ id: WHOLE_CLIP_ID, fromUs: 0, toUs: source.durationUs }] });
}

/** Reads an edit file; refuses a newer version instead of reading it wrongly. */
export function readProject(path: string): EditProject {
    return parseProject(readFileSync(path, "utf8"), path);
}

/** An edit file's text as a project; `path` names it in the errors. */
export function parseProject(text: string, path: string): EditProject {
    const raw: unknown = SafeJSON.parse(text, { strict: true });
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
    atomicWriteFileSync(path, projectFileText(saved));
    log.debug({ path, revision: saved.revision, clips: saved.clips.length, zooms: saved.zooms.length }, "edit saved");
    return saved;
}

/** The exact text `writeProject` puts in the file for a saved project. */
export function projectFileText(saved: EditProject): string {
    return `${SafeJSON.stringify(saved, null, 2)}\n`;
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
    // R5 4 canvas zoom
    /** "canvas" zooms the whole framed export; absent zooms inside the picture. */
    target?: "picture" | "canvas";
}

/** Adds a zoom over a source range; one that overlaps another zoom is refused with the zoom it meets. */
/**
 * Where a zoom asked for from `fromUs` to `toUs` goes (the editor window's rule): at least 0.5 s long, moved past
 * every zoom it would meet, cut at the end of the source; undefined when less than 0.2 s fits there.
 */
export function placeZoom(
    project: EditProject,
    fromUs: number,
    toUs: number,
    // R5 4 canvas zoom: a zoom only moves past zooms of its own target.
    target: "picture" | "canvas" = "picture"
): { startUs: number; endUs: number } | undefined {
    const length = Math.max(toUs - fromUs, 500_000);
    let startUs = Math.max(0, fromUs);
    const same = project.zooms.filter((zoom) => (zoom.target ?? "picture") === target);

    for (const zoom of [...same].sort((a, b) => a.startUs - b.startUs)) {
        if (startUs < zoom.endUs && startUs + length > zoom.startUs) {
            startUs = zoom.endUs;
        }
    }

    const endUs = Math.min(project.source.durationUs, startUs + length);
    const meets = same.some((zoom) => startUs < zoom.endUs && endUs > zoom.startUs);
    return endUs - startUs >= MINIMUM_ZOOM_US && !meets ? { startUs, endUs } : undefined;
}

export function addZoom(
    project: EditProject,
    fromUs: number,
    toUs: number,
    options: ZoomOptions = {}
): { project: EditProject; zoom: EditZoom } {
    checkRange(project, fromUs, toUs);
    const span = placeZoom(project, fromUs, toUs, options.target);

    if (!span) {
        throw new RangeError("no room for a zoom here; zooms cannot overlap");
    }

    const zoom = zoomSchema.parse({
        id: newId("z"),
        startUs: Math.round(span.startUs),
        endUs: Math.round(span.endUs),
        // The editor window's rule: a new zoom takes the scale of the last one.
        scale: options.scale ?? project.zooms.at(-1)?.scale,
        mode: options.follow ? "follow" : "manual",
        focusX: options.focus?.x,
        focusY: options.focus?.y,
        easeInMs: options.easeInMs,
        easeOutMs: options.easeOutMs,
        ...(options.target === "canvas" ? { target: "canvas" } : {}),
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
        // R5 5 redaction edges
        fadeMs?: number;
        cell?: number;
    }
): EditProject {
    checkRange(project, options.fromUs, options.toUs);
    // The editor window's rule: the part of the rectangle inside the picture, refused only when under 1 % of it.
    const { x, y } = options.rect;
    const width = Math.min(options.rect.width, 1 - x);
    const height = Math.min(options.rect.height, 1 - y);

    if (width < 0.01 || height < 0.01) {
        throw new RangeError(
            `the rectangle is ${Math.round(width * 1000) / 1000} by ${Math.round(height * 1000) / 1000} of the picture inside it; it needs at least 0.01 by 0.01`
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
        ...(options.style === "spotlight" && options.fadeMs !== undefined ? { fadeMs: options.fadeMs } : {}),
        ...(options.style === "pixelate" && options.cell !== undefined ? { cell: options.cell } : {}),
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

/** Clicks closer than this are one group: one auto zoom, one row of a movie's clickGroups(). */
export const CLICK_GROUP_GAP_MS = 3000;

/** The recorded clicks in time order, in groups: a click less than `gapMs` after the one before joins its group. */
export function groupClicks(samples: readonly CursorSample[], gapMs = CLICK_GROUP_GAP_MS): CursorSample[][] {
    const groups: CursorSample[][] = [];

    for (const click of samples.filter((sample) => sample.click)) {
        const group = groups.at(-1);

        if (group && click.ms - (group.at(-1)?.ms ?? 0) < gapMs) {
            group.push(click);
        } else {
            groups.push([click]);
        }
    }

    return groups;
}

/**
 * Zooms on the recorded clicks, as the window's Auto zoom does: clicks under 3 s apart are one zoom from 0.6 s before
 * the first to 1.6 s after the last, following the cursor. It replaces the zooms an earlier auto zoom made (mode
 * `follow`) and keeps the manual ones; a group that would overlap a manual zoom is left out. No clicks is an error,
 * and nothing changes.
 */
export function autoZoom(project: EditProject, samples: readonly CursorSample[], scale = 1.6): EditProject {
    const groups = groupClicks(samples);

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
/** A point a drag sends: any numbers, which the op holds inside the picture. */
const loosePoint = z.object({ x: z.number(), y: z.number() }).strict();
const rangeFields = { from: sourceTimeSchema, to: sourceTimeSchema };

/** Places or changes the camera bubble (camera.ts); the Movie handle's camera() takes the same fields. */
export const cameraOpSchema = z
    .object({
        op: z.literal("camera"),
        /** The camera's movie; the first camera op of an edit without one needs it (or camera.json beside). */
        file: z.string().min(1).optional(),
        show: z.boolean().optional(),
        corner: z.enum(CAMERA_CORNERS).optional(),
        /** The centre as fractions of the canvas; setting either makes the corner custom. */
        x: z.number().min(0).max(1).optional(),
        y: z.number().min(0).max(1).optional(),
        size: z.number().min(0.08).max(0.6).optional(),
        shape: z.enum(CAMERA_SHAPES).optional(),
        mirror: z.boolean().optional(),
        offsetMs: z.number().int().min(-600_000).max(600_000).optional(),
        /** false removes the bubble from the edit (the camera movie stays). */
        enabled: z.boolean().optional(),
    })
    .strict();

/** One edit an agent or the CLI asks for; times are SOURCE times, seconds or "mm:ss". */
/** The range popover's actions that edit (its "Export This Part" is export({ from, to })). */
export const RANGE_ACTIONS = ["cut", "keep", "speed", "zoom", "hide", "spotlight", "text", "marker"] as const;

/** The middle of the picture a range's hidden part or spotlight starts with (the window's defaults). */
const RANGE_RECTS = {
    hide: { x: 0.35, y: 0.42, width: 0.3, height: 0.16 },
    spotlight: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
} as const;

export const editOpSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("split"), at: sourceTimeSchema }).strict(),
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
            // R5 4 canvas zoom
            /** "canvas" zooms the whole framed export (focus is 0...1 of the canvas); absent zooms the picture. */
            target: z.enum(["picture", "canvas"]).optional(),
        })
        .strict(),
    z.object({ op: z.literal("unzoom"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("redact"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
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
            // R5 5 redaction edges
            /** Style "pixelate" only: a block's side in source pixels (2 to 256); absent is 1.8 % of the height. */
            cell: z.number().min(2).max(256).optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("spotlight"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
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
            // R5 5 redaction edges
            /** The dim's fade in and out in ms (200; at most a third of its length); 0 is a hard cut. */
            fadeMs: z.number().int().min(0).max(2000).optional(),
        })
        .strict(),
    z.object({ op: z.literal("unredact"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("text"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
            /** "\n" starts a new line; a long line wraps at block.width. */
            text: z.string().trim().min(1).max(TEXT_MAX_CHARS),
            /** The centre, 0...1 of the canvas from the top left; 0.5, 0.12 (top middle) by default. */
            x: z.number().min(0).max(1).optional(),
            y: z.number().min(0).max(1).optional(),
            size: z.number().min(0.02).max(0.15).optional(),
            style: z.enum(TEXT_STYLES).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
            // R4 6 animated texts
            /** How it comes in: "fade" (default), "typewriter" or "slideUp", over ms (600). */
            animate: z
                .object({ kind: z.enum(TEXT_ANIMATIONS), ms: z.number().int().min(100).max(5000).optional() })
                .strict()
                .optional(),
            // R5 10 multi-line texts
            /** Where its lines wrap (width 0.15 to 0.95 of the canvas, 0.8) and how they align ("center"). */
            block: textBlockSchema.strict().optional(),
        })
        .strict(),
    z.object({ op: z.literal("untext"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("marker"),
            /** Source time of the moment. */
            at: sourceTimeSchema,
            /** Its name in the marks lane and as a chapter; absent is "Marker <n>". */
            label: z.string().trim().min(1).max(80).optional(),
        })
        .strict(),
    z.object({ op: z.literal("unmarker"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("retime"),
            id: z.string(),
            at: sourceTimeSchema.optional(),
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
            by: z.number().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("shape"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
            kind: z.enum(SHAPE_KINDS),
            /** An arrow's tail, or a box's or circle's corner, 0...1 of the source picture from its top left. */
            start: z
                .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                .strict()
                .optional(),
            /** An arrow's head (where it points), or the opposite corner. */
            end: z
                .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                .strict()
                .optional(),
            /**
             * Without start and end: the point it marks (an arrow points at it, a box or circle goes round it); absent
             * is where the pointer is at `from` (the cursor track), else the middle of the picture.
             */
            at: z
                .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                .strict()
                .optional(),
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
            from: sourceTimeSchema,
            /** The corrected words; "" hides the line. */
            text: z.string().max(300),
        })
        .strict(),
    z.object({ op: z.literal("unfixLine"), from: sourceTimeSchema }).strict(),
    z.object({ op: z.literal("autoZoom"), scale: z.number().min(1).max(4).optional() }).strict(),
    z
        .object({
            op: z.literal("annotateClicks"),
            /** Source seconds; the whole recording by default. */
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
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
            // R5 3 export size
            /** The picture's exact pixels, one side or both in the canvas's shape; {} goes back to maxHeight. */
            size: exportSizeSchema.optional(),
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
            // R5 4 frame layouts
            /** Where the picture sits ("center", "left", "right", "top", "bottom") and its size (0.5 to 3 times fitted). */
            layout: z
                .object({ align: z.enum(FRAME_ALIGNS).optional(), scale: z.number().min(0.5).max(3).optional() })
                .strict()
                .optional(),
            /** A ready frame for a phone recording ("phone-left", "phone-right", "phone-portrait"); fields here win. */
            preset: z.enum(FRAME_PRESETS).optional(),
        })
        .strict(),
    cameraOpSchema,
    z
        .object({
            op: z.literal("cameraHide"),
            ...rangeFields,
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds camera parts. */
            lane: z.string().optional(),
        })
        .strict(),
    /** Shows the camera again over a source range, or deletes one camera-hidden part by its `id`. */
    z
        .object({
            op: z.literal("cameraShow"),
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
            id: z.string().optional(),
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
            at: sourceTimeSchema,
            /** The word or words (in order) to cut out of that line; every place the line says them. */
            words: z.string().min(1),
            /** Only this place of the words in the line (1 is the first); absent cuts every place. */
            occurrence: z.number().int().min(1).optional(),
            /**
             * Where the picked words start and end (source seconds, as `tools recorder words` timed them): this place,
             * whatever its count is now; refused when the line no longer says the words there. Give both or neither.
             */
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
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
            /**
             * One track, as the editor's Audio tab changes it: with `on` it goes in or out of the cleaned tracks (no
             * track left takes the noise reduction away); with `reductionDb` it gets its own strength. Both need
             * `trackCount`, the movie's sound tracks: every track is written as no list, and a strength equal to the
             * base is not written.
             */
            track: z.number().int().nonnegative().optional(),
            on: z.boolean().optional(),
            trackCount: z.number().int().positive().optional(),
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
    /** Changes a zoom that exists; a focus placed by hand makes a following zoom manual (unless `mode` says). */
    z
        .object({
            op: z.literal("setZoom"),
            id: z.string(),
            scale: z.number().optional(),
            mode: z.enum(["manual", "follow"]).optional(),
            focus: loosePoint.optional(),
            easeInMs: z.number().optional(),
            easeOutMs: z.number().optional(),
        })
        .strict(),
    /** Changes a hidden part or spotlight that exists; the rectangle stays inside the picture, at least 1 % wide. */
    z
        .object({
            op: z.literal("setRedaction"),
            id: z.string(),
            rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict().optional(),
            style: z.enum(REDACTION_STYLES).optional(),
            /** "" takes the label away. */
            label: z.string().max(60).optional(),
            follow: z.boolean().optional(),
            dim: z.number().optional(),
            cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
            // R5 5 redaction edges
            /** A spotlight's fade in ms (0 is a hard cut); -1 goes back to the default 200. */
            fadeMs: z.number().int().min(-1).max(2000).optional(),
            /** A pixelate block's side in source pixels (2 to 256); 0 goes back to the default. */
            cell: z.number().min(0).max(256).optional(),
        })
        .strict(),
    /** Changes a text that exists: its words, its centre (0...1 of the canvas), its size and its style. */
    z
        .object({
            op: z.literal("setText"),
            id: z.string(),
            // R5 10: the length is checked when it is set, with a message, instead of cut without a word.
            text: z.string().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            size: z.number().optional(),
            style: z.enum(TEXT_STYLES).optional(),
            // R4 6 animated texts
            animate: z
                .object({ kind: z.enum(TEXT_ANIMATIONS), ms: z.number().int().min(100).max(5000).optional() })
                .strict()
                .optional(),
            // R5 10 multi-line texts: merged into the text's block; {} keeps it.
            block: textBlockSchema.strict().optional(),
        })
        .strict(),
    /** Changes a shape that exists: its kind, its two points (held inside the picture), colour, width, appearance. */
    z
        .object({
            op: z.literal("setShape"),
            id: z.string(),
            kind: z.enum(SHAPE_KINDS).optional(),
            start: loosePoint.optional(),
            end: loosePoint.optional(),
            color: hexColor.optional(),
            width: z.number().optional(),
            appear: z.enum(SHAPE_APPEARS).optional(),
        })
        .strict(),
    /** Moves a clip's start or end (SOURCE seconds), held inside the movie and at least a frame long. */
    z
        .object({ op: z.literal("trim"), clip: z.string(), from: z.number().optional(), to: z.number().optional() })
        .strict(),
    /** Deletes a clip by its id (its part of the source); the last clip stays. */
    z.object({ op: z.literal("deleteClip"), clip: z.string() }).strict(),
    /** Plays one clip at `factor` (0.25 to 16). */
    z.object({ op: z.literal("clipSpeed"), clip: z.string(), factor: z.number() }).strict(),
    /** A copy of a zoom, hidden part, text, shape or camera part right after it. */
    z.object({ op: z.literal("duplicate"), id: z.string() }).strict(),
    /** Deletes the circles that start at a recorded click (what annotateClicks made); other shapes stay. */
    z.object({ op: z.literal("removeClickCircles") }).strict(),
    /** Names a lane; "" gives it its default title back. */
    z.object({ op: z.literal("renameLane"), id: z.string(), name: z.string().max(200) }).strict(),
    // R4 voiceover clips
    /** Adds a sound file that plays from source time `at`; with `id` it changes that clip instead. */
    z
        .object({
            op: z.literal("voiceover"),
            id: z.string().optional(),
            at: sourceTimeSchema.optional(),
            file: z.string().min(1).optional(),
            volume: z.number().min(0).max(2).optional(),
            label: z.string().max(200).optional(),
        })
        .strict(),
    z.object({ op: z.literal("unvoiceover"), id: z.string() }).strict(),
    // R4 8 music ducking
    z
        .object({
            op: z.literal("ducking"),
            db: z.number().min(0).max(40).optional(),
            fadeMs: z.number().int().min(0).max(5000).optional(),
            transcript: z.boolean().optional(),
            voiceovers: z.boolean().optional(),
            /** false removes it: the music's older `duck` share applies again. */
            enabled: z.boolean().optional(),
        })
        .strict(),
    // R4 6 animated captions
    z
        .object({
            op: z.literal("captionsStyle"),
            kind: z.enum(CAPTION_KINDS).optional(),
            color: hexColor.optional(),
            /** false removes it: each line shows at once again. */
            enabled: z.boolean().optional(),
        })
        .strict(),
    // R4 10 progress bar and chapter strip
    z
        .object({
            op: z.literal("progress"),
            show: z.boolean().optional(),
            color: hexColor.optional(),
            height: z.number().min(0.002).max(0.03).optional(),
            chapters: z.boolean().optional(),
            chapterMs: z.number().int().min(500).max(10_000).optional(),
            // R6 8 chapter label place
            chapterPlace: z.enum(CHAPTER_PLACES).optional(),
            /** false removes it. */
            enabled: z.boolean().optional(),
        })
        .strict(),
    // R4 9 intro and end cards
    z
        .object({
            op: z.literal("introCard"),
            title: z.string().trim().min(1).max(120).optional(),
            subtitle: z.string().max(200).optional(),
            /** A picture file; "" removes the logo. */
            logo: z.string().optional(),
            date: z.string().max(60).optional(),
            seconds: z.number().min(0.5).max(15).optional(),
            /** false removes the card. */
            enabled: z.boolean().optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("endCard"),
            text: z.string().trim().min(1).max(200).optional(),
            link: z.string().max(300).optional(),
            qr: z.boolean().optional(),
            seconds: z.number().min(0.5).max(15).optional(),
            /** false removes the card. */
            enabled: z.boolean().optional(),
        })
        .strict(),
    /**
     * What the editor's range popover does to a range dragged on the frames lane, over OUTPUT times (what plays, as
     * the ruler shows them): cut it, play it at `factor` (2), zoom over it (`scale`), hide or spotlight the middle of
     * the picture, or put `text` ("Title") over it. Export a part with export({ from, to }).
     */
    z
        .object({
            op: z.literal("range"),
            from: outputTimeSchema,
            to: outputTimeSchema,
            action: z.enum(RANGE_ACTIONS),
            factor: z.number().min(0.25).max(16).optional(),
            scale: z.number().min(1).max(4).optional(),
            text: z.string().trim().min(1).max(200).optional(),
            lane: z.string().optional(),
        })
        .strict(),
    // Round 4 fx-render: transition, lens, setLens, unlens, tilt (fx.ts).
    ...fxOpSchemas,
    // fx B (round 4): private data, smooth cursor, typing and waiting speed-ups.
    /**
     * Hides the private data the screen text holds (emails, tokens and keys, phone numbers, IBANs, card numbers):
     * one hidden part per hit for as long as it shows. `ids` from privateData() picks hits (absent: all), `kinds`
     * picks kinds; a hit hidden before is skipped. The CLI and the REPL read the screen text (Vision OCR, local).
     */
    z
        .object({
            op: z.literal("hidePrivate"),
            ids: z.array(z.string()).optional(),
            kinds: z.array(z.enum([...PRIVATE_KINDS, "name"])).optional(),
            style: z.enum(PRIVATE_STYLES).optional(),
            /** People or company names to hide as well, matched without case. */
            names: z.array(z.string().trim().min(2).max(120)).max(50).optional(),
            /** Areas left visible and never searched: a toast, a tab bar over the content. */
            exclude: z.array(boxSchema).max(20).optional(),
            /** Leaves visible what stays still while the content under it scrolls (found from the picture). */
            excludeFixed: z.boolean().optional(),
        })
        .strict(),
    /**
     * Hides every place a text is on the screen (OCR, local): `text` (without case) or `pattern` (a regular
     * expression), between `from` and `to` (source seconds; absent: all), each as a hidden part that follows the text
     * while it scrolls and starts and ends when it shows. exclude and excludeFixed as for hidePrivate.
     */
    z
        .object({
            op: z.literal("hideText"),
            text: z.string().trim().min(1).max(200).optional(),
            pattern: z.string().min(1).max(200).optional(),
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
            style: z.enum(PRIVATE_STYLES).optional(),
            exclude: z.array(boxSchema).max(20).optional(),
            excludeFixed: z.boolean().optional(),
            label: z.string().max(60).optional(),
        })
        .strict(),
    /** The smooth cursor: strength (0.6), jitterPx (3), idleFadeSeconds (2); enabled: false turns it off. */
    z
        .object({
            op: z.literal("cursorSmooth"),
            enabled: z.boolean().optional(),
            strength: z.number().min(0).max(1).optional(),
            jitterPx: z.number().min(0).max(20).optional(),
            idleFadeSeconds: z.number().min(0).max(30).optional(),
        })
        .strict(),
    /**
     * Speeds up the typing and waiting stretches waits() lists (only a small part of the picture changes, or none,
     * for minSeconds): each at its proposed 4x to 8x, or at `speed`; `ids` picks stretches (absent: all). Turns the
     * speed badge on.
     */
    z
        .object({
            op: z.literal("speedUpWaits"),
            ids: z.array(z.string()).optional(),
            minSeconds: z.number().min(1).max(600).optional(),
            maxArea: z.number().min(0).max(0.5).optional(),
            speed: z.number().min(1.5).max(16).optional(),
        })
        .strict(),
    /** The "⏩ 6x" badge over sped-up parts: badge on or off, position (top-right). */
    z
        .object({
            op: z.literal("autoSpeed"),
            badge: z.boolean().optional(),
            position: z.enum(SPEED_BADGE_POSITIONS).optional(),
        })
        .strict(),
    // R5 5 redaction edges
    /**
     * How the export closes small holes around the hiding parts: snapMs (250) draws a part that ends that close before
     * a cut up to the cut, one that starts that close after a cut from it, and two parts with a gap that short meet.
     * 0 draws every part exactly as placed.
     */
    z.object({ op: z.literal("redactionJoins"), snapMs: z.number().int().min(0).max(2000) }).strict(),
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
    /** Runtime replay data, never saved in the project: IDs already returned to the caller. */
    generatedIds?: string[];
    idleUs?: ReadonlyArray<readonly [number, number]>;
    /** The cached transcript's lines (`cutWords`, `cutFillers`). */
    transcript?: readonly TranscriptSegment[];
    /** The filler lists `cutFillers` picks from (the meetings config's); absent is the shipped `FILLER_WORDS`. */
    fillerLists?: FillerLists;
    /** The movie's integrated loudness at volume 1; null when it has no unmuted audio. */
    loudnessLufs?: number | null;
    /** The source movie's audio tracks (`denoise`); absent when nobody counted them. */
    audioTracks?: number;
    // R4 voiceover clips
    /** The length of a `voiceover` op's file, measured with ffprobe. */
    voiceoverDurationUs?: number;
    // fx B (round 4)
    /** The private data on the screen (`hidePrivate`), from the screen text scan. */
    privateHits?: readonly PrivateHit[];
    /** The places of a text on the screen (`hideText`), tracked over time. */
    textHits?: readonly PrivateHit[];
    /** The typing and waiting stretches (`speedUpWaits`), from the picture's change steps. */
    waits?: readonly WaitStretch[];
}

/** A `zoom` op whose zoom went past a zoom it met (`placeZoom`), as a sentence a caller can return. */
export function opPlacementWarnings(op: EditOp, before: EditProject, after: EditProject): string[] {
    if (op.op !== "zoom") {
        return [];
    }

    const had = new Set(before.zooms.map((zoom) => zoom.id));
    const added = after.zooms.find((zoom) => !had.has(zoom.id));

    if (!added || Math.abs(added.startUs - timeToUs(op.from)) < 1000) {
        return [];
    }

    const seconds = (us: number) => Math.round(us / 1000) / 1000;
    return [
        `zoom: ${seconds(timeToUs(op.from))} s met another zoom, so it went to ${seconds(added.startUs)}–${seconds(added.endUs)} s (zooms cannot overlap)`,
    ];
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
    const keepsLength = moves > 0;
    const wanted = (startUs: number, endUs: number): { startUs: number; endUs: number } => {
        if (keepsLength) {
            const length = endUs - startUs;
            const start = op.at !== undefined ? timeToUs(op.at) : startUs + Math.round((op.by ?? 0) * 1e6);
            const moved = Math.min(Math.max(0, start), Math.max(0, durationUs - length));
            return { startUs: moved, endUs: moved + length };
        }

        return {
            startUs: op.from === undefined ? startUs : Math.max(0, timeToUs(op.from)),
            endUs: op.to === undefined ? endUs : Math.min(durationUs, timeToUs(op.to)),
        };
    };
    // The editor window's rule: an edge dragged past the other one stops 0.1 s from it (the end moves on) instead of
    // refusing the drag half way.
    const place = (startUs: number, endUs: number): { startUs: number; endUs: number } => {
        const span = wanted(startUs, endUs);

        if (keepsLength) {
            return span;
        }

        const nextStart = Math.min(span.startUs, Math.max(0, durationUs - 100_000));
        return { startUs: nextStart, endUs: Math.max(span.endUs, nextStart + 100_000) };
    };

    const zoom = project.zooms.find((item) => item.id === op.id);

    if (zoom) {
        // The editor window's rule: a zoom moved or stretched into a neighbour stops at it, 0.2 s long at least.
        const others = project.zooms.filter((other) => other.id !== op.id);
        const lower = Math.max(0, ...others.filter((other) => other.endUs <= zoom.startUs).map((other) => other.endUs));
        const upper = Math.min(
            durationUs,
            ...others.filter((other) => other.startUs >= zoom.endUs).map((other) => other.startUs)
        );
        const target = wanted(zoom.startUs, zoom.endUs);
        const startUs = Math.max(lower, Math.min(target.startUs, upper - MINIMUM_ZOOM_US));
        const span = { startUs, endUs: Math.min(upper, Math.max(target.endUs, startUs + MINIMUM_ZOOM_US)) };
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

    if (project.camera?.hidden.some((item) => item.id === op.id)) {
        const hidden = project.camera.hidden.map((item) =>
            item.id === op.id ? { ...item, ...place(item.startUs, item.endUs) } : item
        );
        return { ...project, camera: { ...project.camera, hidden: hidden.sort((a, b) => a.startUs - b.startUs) } };
    }

    const ids = [
        ...project.zooms.map((item) => item.id),
        ...(project.redactions ?? []).map((item) => item.id),
        ...(project.texts ?? []).map((item) => item.id),
        ...(project.shapes ?? []).map((item) => item.id),
        ...(project.camera?.hidden ?? []).map((item) => item.id),
    ];
    throw new Error(`no zoom, hidden part, text, shape or camera part ${op.id}; ids: ${ids.join(", ") || "none"}`);
}

/** The start of the transcript line spoken at `atUs` (source time); a time between lines is refused. */
function lineStartUs(segments: readonly TranscriptSegment[], atUs: number): number {
    const seconds = atUs / 1_000_000;
    const line = segments.find((segment) => segment.start <= seconds + 0.0005 && seconds < segment.end);

    if (!line) {
        const near = segments
            .map((segment) => segment.start)
            .sort((a, b) => Math.abs(a - seconds) - Math.abs(b - seconds))
            .slice(0, 3);
        throw new Error(
            `no line is spoken at ${seconds} s, nothing was saved; the nearest lines start at ${near.join(", ")} s`
        );
    }

    return Math.round(line.start * 1_000_000);
}

export function applyOp(project: EditProject, op: EditOp, facts: OpFacts = {}): EditProject {
    facts.generatedIds ??= [];
    const next = withItemIds(facts.generatedIds, () => applyOpItself(project, op, facts));

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
        case "setZoom":
            return setZoom(project, op);
        case "setRedaction":
            return setRedaction(project, op);
        case "setText":
            return setText(project, op);
        case "setShape":
            return setShape(project, op);
        case "trim":
            return trimClip(project, {
                clip: op.clip,
                fromUs: op.from === undefined ? undefined : Math.round(op.from * 1e6),
                toUs: op.to === undefined ? undefined : Math.round(op.to * 1e6),
            });
        case "deleteClip":
            return deleteClip(project, op.clip);
        case "clipSpeed":
            return clipSpeed(project, op);
        case "duplicate":
            return duplicateItem(project, op.id);
        case "removeClickCircles":
            return removeClickCircles(project, readCursorTrack(project.source.cursor));
        case "renameLane":
            return renameLane(project, op.id, op.name);
        // R4 voiceover clips
        case "voiceover": {
            const { op: _op, at, ...rest } = op;
            return applyVoiceover(project, { ...rest, ...(at === undefined ? {} : { atUs: timeToUs(at) }) }, facts);
        }
        case "unvoiceover":
            return removeVoiceover(project, op.id);
        // R4 8 music ducking
        case "ducking": {
            const { op: _op, ...change } = op;
            return applyDucking(project, change);
        }
        // R4 6 animated captions
        case "captionsStyle": {
            const { op: _op, ...change } = op;
            return applyCaptionsStyle(project, change);
        }
        // R4 10 progress bar and chapter strip
        case "progress": {
            const { op: _op, ...change } = op;
            return applyProgress(project, change);
        }
        // R4 9 intro and end cards
        case "introCard":
        case "endCard": {
            const { op: kind, ...change } = op;
            return applyCard(project, kind === "introCard" ? "intro" : "end", change, { exists: existsSync, resolve });
        }
        // fx B (round 4)
        case "hidePrivate":
            return hidePrivate(project, op, facts.privateHits);
        case "hideText":
            return hideText(project, op, facts.textHits);
        case "cursorSmooth":
            return smoothCursor(project, op);
        case "speedUpWaits":
            return speedUpWaits(project, op, facts.waits);
        case "autoSpeed": {
            const { op: _op, ...change } = op;
            return { ...project, autoSpeed: autoSpeedSchema.parse({ ...project.autoSpeed, ...change }) };
        }
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
                target: op.target,
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
                cell: op.cell,
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
                fadeMs: op.fadeMs,
            });
        case "unredact": {
            const list = project.redactions ?? [];

            if (!list.some((redaction) => redaction.id === op.id)) {
                throw new Error(
                    `no redaction ${op.id}; redactions: ${list.map((redaction) => redaction.id).join(", ") || "none"}`
                );
            }

            // Like `untext` and `unshape` (and the editor window): the last one gone removes the key.
            const redactions = list.filter((redaction) => redaction.id !== op.id);

            if (redactions.length === 0) {
                const { redactions: _redactions, ...rest } = project;
                return rest;
            }

            return { ...project, redactions };
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
                // R4 6 animated texts
                ...(textAnimateOf(op.animate) ? { animate: textAnimateOf(op.animate) } : {}),
                // R5 10 multi-line texts
                ...(op.block && Object.keys(op.block).length > 0 ? { block: op.block } : {}),
            });
            return { ...project, texts: [...(project.texts ?? []), note] };
        }
        case "shape": {
            const fromUs = timeToUs(op.from);
            const toUs = timeToUs(op.to);
            checkRange(project, fromUs, toUs);

            if ((op.start === undefined) !== (op.end === undefined)) {
                throw new RangeError(
                    "a shape takes both start and end, or neither (then at, or the pointer, places it)"
                );
            }

            const points =
                op.start && op.end
                    ? { start: op.start, end: op.end }
                    : placedShape(
                          op.kind,
                          op.at ??
                              cursorPointAt(readCursorTrack(project.source.cursor), fromUs / 1000) ?? { x: 0.5, y: 0.5 }
                      );

            if (Math.hypot(points.end.x - points.start.x, points.end.y - points.start.y) < 0.01) {
                throw new RangeError("the shape's start and end are the same point; move end away from start");
            }

            const shape = shapeSchema.parse({
                id: newId("s"),
                startUs: fromUs,
                endUs: Math.min(project.source.durationUs, toUs),
                kind: op.kind,
                x1: points.start.x,
                y1: points.start.y,
                x2: points.end.x,
                y2: points.end.y,
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
            // A time copied from find() or the subtitles lies inside a line; a fix is keyed by the line's start.
            const fromUs = facts.transcript ? lineStartUs(facts.transcript, timeToUs(op.from)) : timeToUs(op.from);
            const key = String(Math.round(fromUs / 1000));
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
        case "marker":
            return addMarker(project, timeToUs(op.at), op.label);
        case "unmarker": {
            const list = project.markers ?? [];

            if (!list.some((marker) => marker.id === op.id)) {
                throw new Error(
                    `no marker ${op.id}; edit markers: ${list.map((marker) => marker.id).join(", ") || "none"}`
                );
            }

            const rest = list.filter((marker) => marker.id !== op.id);
            return { ...project, markers: rest.length ? rest : undefined };
        }
        case "untext": {
            const list = project.texts ?? [];

            if (!list.some((note) => note.id === op.id)) {
                throw new Error(`no text ${op.id}; texts: ${list.map((note) => note.id).join(", ") || "none"}`);
            }

            const rest = list.filter((note) => note.id !== op.id);
            return { ...project, texts: rest.length ? rest : undefined };
        }
        case "autoZoom":
            // The editor window's rule: without a scale the zooms take the first zoom's, else 1.6.
            return autoZoom(project, readCursorTrack(project.source.cursor), op.scale ?? project.zooms[0]?.scale);
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

            if (op.op === "cutWords" && (op.from === undefined) !== (op.to === undefined)) {
                throw new RangeError("cutWords takes from and to together: the picked words' start and end");
            }

            const cuts =
                op.op === "cutWords"
                    ? wordCuts({
                          segments: facts.transcript,
                          atSec: timeToUs(op.at) / 1_000_000,
                          words: op.words,
                          ...(op.occurrence !== undefined ? { occurrence: op.occurrence } : {}),
                          ...(op.from !== undefined && op.to !== undefined
                              ? { picked: { start: timeToUs(op.from) / 1_000_000, end: timeToUs(op.to) / 1_000_000 } }
                              : {}),
                          ...(op.padMs !== undefined ? { padMs: op.padMs } : {}),
                      })
                    : fillerCuts({
                          segments: facts.transcript,
                          fillers: fillerList({
                              language: op.language,
                              words: op.words,
                              level: op.level,
                              lists: facts.fillerLists,
                          }),
                          ...(op.padMs !== undefined ? { padMs: op.padMs } : {}),
                      });
            return cutRanges(cuts).reduce((next, cut) => cutRange(next, cut.fromUs, cut.toUs), project);
        }
        case "denoise": {
            if (op.enabled === false) {
                const { denoise: _denoise, ...audio } = project.audio;
                return { ...project, audio };
            }

            // Saved, it would make every export fail at the cleaning step.
            if (facts.audioTracks === 0) {
                throw new Error("this movie has no sound to clean (it has no audio track)");
            }

            if (op.track !== undefined) {
                return denoiseTrack(project, op);
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

            // The editor window's JSON: the file's beginning and a loop are the defaults, written as absent.
            const { startMs, loop, ...music } = musicSchema.parse({ ...merged, file });
            return {
                ...project,
                audio: {
                    ...project.audio,
                    music: { ...music, ...(startMs ? { startMs } : {}), ...(loop === false ? { loop } : {}) },
                },
            };
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
                    // R5 3 export size: an empty size goes back to maxHeight.
                    ...exportSizeOf(op.size ?? project.export.size),
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
            // The editor window's JSON: no click sound is written as absent.
            const { sound, ...clicks } = clicksSchema.parse({ ...project.clicks, ...change });
            return { ...project, clicks: { ...clicks, ...(sound ? { sound } : {}) } };
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
        case "camera": {
            const { op: _op, enabled, ...change } = op;

            if (enabled === false) {
                const { camera: _camera, ...rest } = project;
                return rest;
            }

            const file = change.file ?? project.camera?.file;

            if (!file) {
                throw new Error(
                    'this edit has no camera yet; give the camera movie with { op: "camera", file: "camera.mov" }'
                );
            }

            const custom = change.x !== undefined || change.y !== undefined ? { corner: "custom" as const } : {};
            return { ...project, camera: cameraBubbleSchema.parse({ ...project.camera, ...change, ...custom, file }) };
        }
        case "cameraHide":
        case "cameraShow": {
            if (!project.camera) {
                throw new Error(`${op.op} needs a camera bubble; this edit has none`);
            }

            if (op.op === "cameraShow" && op.id !== undefined) {
                if (op.from !== undefined || op.to !== undefined) {
                    throw new RangeError("cameraShow takes an id or a from and to range, not both");
                }

                return removeCameraHidden(project, op.id);
            }

            if (op.from === undefined || op.to === undefined) {
                throw new RangeError(`${op.op} needs from and to (source seconds)`);
            }

            const fromUs = timeToUs(op.from);
            const toUs = Math.min(project.source.durationUs, timeToUs(op.to));
            checkRange(project, fromUs, toUs);
            const camera =
                op.op === "cameraHide"
                    ? hideCamera(project.camera, fromUs, toUs)
                    : showCamera(project.camera, fromUs, toUs);
            return { ...project, camera };
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

            // R5 4 frame layouts: a preset first, then the op's own fields.
            const preset = op.preset ? FRAME_PRESET_VALUES[op.preset] : undefined;
            const layout =
                preset || op.layout ? { ...current.layout, ...preset?.layout, ...op.layout } : current.layout;
            const { aspect, fit, ...frame } = frameSchema.parse({
                ...current,
                ...(preset
                    ? { aspect: preset.aspect, padding: preset.padding, cornerRadius: preset.cornerRadius }
                    : {}),
                ...(layout ? { layout } : {}),
                ...(op.aspect === undefined ? {} : { aspect: op.aspect }),
                ...(op.fit === undefined ? {} : { fit: op.fit }),
                ...(op.padding === undefined ? {} : { padding: op.padding }),
                ...(op.cornerRadius === undefined ? {} : { cornerRadius: op.cornerRadius }),
                ...(op.shadow === undefined ? {} : { shadow: op.shadow }),
                background,
            });
            // The editor window's JSON: the source shape and the whole movie (`contain`) are written as absent, and
            // so is a centred picture at its fitted size.
            const { layout: placed, ...rest } = frame;
            return {
                ...project,
                frame: {
                    ...rest,
                    ...(placed && (placed.align !== "center" || placed.scale !== 1) ? { layout: placed } : {}),
                    ...(aspect && aspect !== "source" ? { aspect } : {}),
                    ...(fit === "cover" ? { fit } : {}),
                },
            };
        }
        // Round 4 fx-render (fx.ts).
        case "transition":
        case "lens":
        case "setLens":
        case "unlens":
        case "tilt":
            return applyFxOp(project, op);
        // R5 5 redaction edges
        case "redactionJoins":
            return { ...project, redactionJoins: { snapMs: op.snapMs } };
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
            // R5 4 canvas zoom
            ...(zoom.target === "canvas" ? { target: "canvas" as const } : {}),
        })),
        audio: project.audio.music
            ? {
                  ...project.audio,
                  // Ducking reads the transcript's lines; without a cached transcript the music plays level.
                  music: {
                      ...project.audio.music,
                      // R4 8 music ducking: the dB object decides the amount and what it ducks under.
                      ducks:
                          (project.audio.ducking ? project.audio.ducking.db > 0 : project.audio.music.duck > 0) &&
                          (((project.audio.ducking?.transcript ?? true) &&
                              existsSync(transcriptCachePath(project.source.video))) ||
                              ((project.audio.ducking?.voiceovers ?? true) &&
                                  (project.audio.voiceovers?.length ?? 0) > 0)),
                  },
              }
            : project.audio,
        // R4 voiceover clips: where each plays in the edit (null when its start is cut).
        voiceovers: (project.audio.voiceovers ?? []).map((clip) => {
            const plays = outputTimeOf(project, clip.atUs);
            return {
                id: clip.id,
                at: seconds(clip.atUs),
                seconds: seconds(clip.durationUs),
                plays: plays === undefined ? null : seconds(plays),
                // R5 7: where it plays in the exported file, after the intro card.
                exportPlays: plays === undefined ? null : seconds(plays + cardsLeadUs(project)),
                file: clip.file,
                volume: clip.volume,
                ...(clip.label ? { label: clip.label } : {}),
            };
        }),
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
            // fx B (round 4): how many keyframes it follows, and the areas it leaves visible.
            ...(redaction.track ? { keyframes: redaction.track.length } : {}),
            ...(redaction.exclude ? { exclude: redaction.exclude } : {}),
            // R5 5 redaction edges
            ...(redaction.style === "spotlight" ? { fadeMs: redaction.fadeMs ?? 200 } : {}),
            ...(redaction.cell !== undefined ? { cell: redaction.cell } : {}),
        })),
        /** null: the system cursor is in the picture, so there is nothing to change. */
        cursor: trackDrawsCursor(project.source.cursor) ? cursorSchema.parse(project.cursor ?? {}) : null,
        captions: project.captions ?? null,
        keys: project.keys ?? null,
        transcriptFixes: Object.keys(project.transcript?.fixes ?? {}).length,
        motion: motionSchema.parse(project.motion ?? {}),
        camera: project.camera ?? null,
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
            // R4 6 animated texts
            ...(note.animate ? { animate: note.animate } : {}),
            // R5 10 multi-line texts: the lines it was written with (a long one also wraps at the block's width).
            lines: note.text.split("\n").length,
            ...(note.block ? { block: note.block } : {}),
        })),
        // R4 6 animated captions
        captionsStyle: project.captionsStyle ?? null,
        // R4 10 progress bar and chapter strip
        progress: project.progress ?? null,
        // R4 9 intro and end cards: the export plays them around the movie; outputSeconds is the movie alone.
        cards: project.cards ?? null,
        /** The timeline's effect lanes top to bottom, each with the ids of the items on it. */
        lanes: resolveLanes(project).map(({ lane, items, automatic }) => ({
            id: lane.id,
            kinds: lane.kinds ?? "any",
            ...(lane.name ? { name: lane.name } : {}),
            ...(automatic ? { automatic: true } : {}),
            items: items.map((item) => item.id),
        })),
        // Round 4 fx-render: transitions (with every join), lenses, tilt.
        ...describeFx(project),
        // fx B (round 4)
        cursorSmooth: project.cursorSmooth ?? null,
        autoSpeed: project.autoSpeed ?? null,
        privateHidden: project.privacy?.applied.length ?? 0,
        // R5 5 redaction edges
        redactionJoins: { snapMs: project.redactionJoins?.snapMs ?? REDACTION_SNAP_MS },
        // R5 7 export time: the export plays the intro card before the movie and the end card after it, so a moment
        // at output time t is at t + introSeconds in the exported file; outputSeconds and plays are the movie alone.
        exportTime: {
            introSeconds: seconds(cardsLeadUs(project)),
            endSeconds: project.cards?.end?.seconds ?? 0,
            exportSeconds: seconds(
                outputDurationUs(project) + cardsLeadUs(project) + Math.round((project.cards?.end?.seconds ?? 0) * 1e6)
            ),
        },
    };
}

// fx B (round 4): the ops of private data, the smooth cursor and the typing and waiting speed-ups.

/** Picks the facts' items by `ids` (absent: all); an unknown id is refused with the ids there are. */
function pickById<T extends { id: string }>(
    items: readonly T[],
    ids: readonly string[] | undefined,
    what: string
): T[] {
    if (!ids) {
        return [...items];
    }

    const unknown = ids.filter((id) => !items.some((item) => item.id === id));

    if (unknown.length > 0) {
        const known = items.length ? `${what}s: ${items.map((item) => item.id).join(", ")}` : `there is no ${what}`;
        throw new Error(`no ${what} ${unknown.join(", ")}; ${known}`);
    }

    return items.filter((item) => ids.includes(item.id));
}

function hidePrivate(
    project: EditProject,
    op: Extract<EditOp, { op: "hidePrivate" }>,
    hits: readonly PrivateHit[] | undefined
): EditProject {
    if (!hits) {
        throw new Error("hidePrivate needs the screen text's private data; run it through editProject or the CLI");
    }

    const picked = pickById(hits, op.ids, "private hit").filter(
        (hit) => !op.kinds || (hit.kind !== "text" && op.kinds.includes(hit.kind))
    );
    return hideHits(project, picked, { style: op.style, exclude: op.exclude });
}

function hideText(
    project: EditProject,
    op: Extract<EditOp, { op: "hideText" }>,
    hits: readonly PrivateHit[] | undefined
): EditProject {
    if (!hits) {
        throw new Error("hideText needs the screen text's places of the text; run it through editProject or the CLI");
    }

    const fromUs = op.from === undefined ? 0 : timeToUs(op.from);
    const toUs = op.to === undefined ? project.source.durationUs : timeToUs(op.to);
    const picked = hits.filter((hit) => hit.toUs > fromUs && hit.fromUs < toUs);

    if (picked.length === 0) {
        throw new Error(
            `the screen does not show "${op.text ?? op.pattern}"${op.from === undefined && op.to === undefined ? "" : " in that range"}; nothing was hidden`
        );
    }

    return hideHits(project, picked, { style: op.style, exclude: op.exclude, label: op.label });
}

/**
 * One hidden part per hit for as long as it shows: a hit that moved keeps its keyframes (`track`), so the part follows
 * the text; the areas to leave visible are the op's and the hit's own. A hit hidden before is skipped.
 */
function hideHits(
    project: EditProject,
    hits: readonly PrivateHit[],
    options: { style?: EditRedaction["style"]; exclude?: ReadonlyArray<z.infer<typeof boxSchema>>; label?: string }
): EditProject {
    const applied = new Set(project.privacy?.applied ?? []);
    const picked = hits.filter((hit) => !applied.has(hit.id));
    let next = project;

    for (const hit of picked) {
        const fromUs = Math.max(0, Math.min(hit.fromUs, project.source.durationUs - MINIMUM_CLIP_US));
        const toUs = Math.min(project.source.durationUs, Math.max(hit.toUs, fromUs + MINIMUM_CLIP_US));
        const first = hit.keys[0] ?? hit.box;
        next = addRedaction(next, {
            fromUs,
            toUs,
            rect: { x: first.x, y: first.y, width: first.width, height: first.height },
            style: options.style ?? "blur",
            label: options.label ?? `${hit.label} (auto)`,
        });
        const exclude = [...(options.exclude ?? []), ...(hit.exclude ?? [])];
        const added = next.redactions?.at(-1);

        if (added && (hit.keys.length > 1 || exclude.length > 0)) {
            const tracked: EditRedaction = {
                ...added,
                ...(hit.keys.length > 1
                    ? { track: hit.keys.map((key) => ({ ...key, atUs: Math.round(key.atUs) })) }
                    : {}),
                ...(exclude.length > 0 ? { exclude } : {}),
            };
            next = { ...next, redactions: [...(next.redactions ?? []).slice(0, -1), tracked] };
        }

        applied.add(hit.id);
    }

    return picked.length === 0 ? project : { ...next, privacy: privacySchema.parse({ applied: [...applied] }) };
}

function smoothCursor(project: EditProject, op: Extract<EditOp, { op: "cursorSmooth" }>): EditProject {
    const { op: _op, enabled, ...change } = op;

    if (enabled === false) {
        const { cursorSmooth: _off, ...rest } = project;
        return rest;
    }

    if (!trackDrawsCursor(project.source.cursor)) {
        throw new Error(
            "this movie has the system cursor in its picture, so the editor cannot smooth it; record without --system-cursor to get a drawn cursor"
        );
    }

    return { ...project, cursorSmooth: cursorSmoothSchema.parse({ ...project.cursorSmooth, ...change }) };
}

function speedUpWaits(
    project: EditProject,
    op: Extract<EditOp, { op: "speedUpWaits" }>,
    waits: readonly WaitStretch[] | undefined
): EditProject {
    if (!waits) {
        throw new Error(
            "speedUpWaits needs the movie's typing and waiting stretches; run it through editProject or the CLI"
        );
    }

    let next = project;

    for (const wait of pickById(waits, op.ids, "stretch")) {
        const toUs = Math.min(wait.toUs, project.source.durationUs);

        if (toUs - wait.fromUs >= MINIMUM_CLIP_US) {
            next = speedRange(next, wait.fromUs, toUs, op.speed ?? wait.speed);
        }
    }

    return next === project ? project : { ...next, autoSpeed: autoSpeedSchema.parse(project.autoSpeed ?? {}) };
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
        case "keep":
            return partOf(project, fromOut, toOut);
        case "speed":
            return speedRange(project, fromUs, toUs, op.factor ?? 2);
        case "zoom":
            return addZoom(project, fromUs, toUs, { scale: op.scale }).project;
        case "hide":
            return addRedaction(project, { fromUs, toUs, rect: RANGE_RECTS.hide, style: "blur" });
        case "spotlight":
            // The editor window's rule: a recording with a cursor track gets a spotlight that follows the pointer.
            return addRedaction(project, {
                fromUs,
                toUs,
                rect: RANGE_RECTS.spotlight,
                style: "spotlight",
                follow: readCursorTrack(project.source.cursor).length > 0,
            });
        case "text":
            return applyOpItself(project, { op: "text", ...seconds, text: op.text ?? "Title" }, {});
        case "marker":
            return addMarker(project, fromUs, op.text);
    }
}

/**
 * A marker at a source time, named `label` or "Marker <n>" (n counts this edit's markers), kept in source order. The
 * range popover's Add Marker puts one at the range's start.
 */
export function addMarker(project: EditProject, atUs: number, label?: string): EditProject {
    if (atUs < 0 || atUs > project.source.durationUs) {
        throw new RangeError(`the marker (${atUs / 1e6} s) is outside the ${project.source.durationUs / 1e6} s movie`);
    }

    const list = project.markers ?? [];
    const marker = { id: newId("m"), atUs: Math.round(atUs), label: label?.trim() || `Marker ${list.length + 1}` };
    return { ...project, markers: [...list, marker].sort((a, b) => a.atUs - b.atUs) };
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
