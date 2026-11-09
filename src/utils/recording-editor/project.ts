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
import {
    applyFxOp,
    describeFx,
    fxOpSchemas,
    lensSchema,
    lensShowsAt,
    tiltSchema,
    transitionJoins,
    transitionPlayingAt,
    transitionsSchema,
} from "./fx";
import { recordingItemId, withItemIds } from "./item-ids";
import {
    circleAround,
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
import {
    describeTextQuery,
    type FractionBox,
    HIDE_UNITS,
    type LineMatcher,
    maskPrivate,
    PRIVATE_KINDS,
    PRIVATE_STYLES,
    type PrivateHit,
    privacySchema,
    redactionBoxAt,
} from "./private-data";
import {
    cutRanges,
    FILLER_LEVELS,
    type FillerLists,
    fillerCuts,
    fillerList,
    type TranscriptSegment,
    wordCuts,
} from "./transcript-cuts";
import {
    applyDucking,
    applyVoiceover,
    duckingSchema,
    musicDucking,
    removeVoiceover,
    VOICEOVER_CARDS,
    voiceoverSchema,
} from "./voiceovers";
import { autoSpeedSchema, SPEED_BADGE_POSITIONS, type WaitStretch } from "./waits";

const { log } = logger.scoped("recording-editor-project");

/**
 * The recorder window's edit document (`edit.json`), the same shape the Swift editor reads and writes
 * (src/macos/GenesisTools/Sources/Parts/Recorder/Project/EditProject.swift). Every time is in microseconds of the
 * SOURCE movie, so a cut never moves a zoom. The window watches the file and takes an agent's save as it lands.
 */
export const EDIT_PROJECT_VERSION = 1;
/**
 * Microseconds as an edit file keeps them: whole numbers. A fraction (a build before round 7 saved 39133333.333 for a
 * part the motion placed at 30 frames a second) is rounded when the file loads, instead of refusing the whole edit.
 */
function wholeUs<T extends z.ZodType<number>>(schema: T) {
    return z.preprocess(
        (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : value),
        schema
    );
}

/** The shortest clip a split or a cut leaves: one frame at 60 fps (TimelineMap.minimumClipUs). */
export const MINIMUM_CLIP_US = 16_667;
const MINIMUM_ZOOM_US = 200_000;

/**
 * Why a canvas zoom refuses follow: the renderer holds its focus (ZoomCurve.canvasView), because the cursor moves
 * inside the picture and not on the canvas. An edit saved with such a zoom still loads and renders at its focus.
 */
export const CANVAS_ZOOM_HOLDS_FOCUS =
    "a canvas zoom holds its focus (0...1 of the canvas) and does not follow the cursor; give focus {x, y}, or drop target for a picture zoom that follows";

const clipSchema = z.object({
    id: z.string(),
    fromUs: wholeUs(z.number().int().nonnegative()),
    toUs: wholeUs(z.number().int().nonnegative()),
    speed: z.number().min(0.25).max(16).default(1),
});

const zoomSchema = z.object({
    id: z.string(),
    startUs: wholeUs(z.number().int().nonnegative()),
    endUs: wholeUs(z.number().int().nonnegative()),
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
    /**
     * Who made it: "auto" is autoZoom, which replaces only its own zooms on a later run; absent is the user's. setZoom
     * and duplicate drop it, so an auto zoom the user tuned stays theirs.
     */
    origin: z.enum(["auto"]).optional(),
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
    /** How long a disc grows and fades, in the movie as it plays (a sped-up part does not shorten it); a cut ends it. */
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
             * Times the fitted size (0.5 to 3). Above 1 the picture grows inside the room within the padding and is
             * cropped to it (round 7: a phone grows wider, its free side shrinks, and `focus` picks the part in view).
             */
            scale: z.number().min(0.5).max(3).default(1),
            // R7 9 phone layouts
            /** The part of a grown picture that stays in view, 0..1 of the picture from its top left; absent: centre. */
            focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
        })
        .optional(),
});

// R5 4 frame layouts
/**
 * Ready frames for a phone recording: "phone-left" and "phone-right" put the phone against one side of a 16:9 canvas
 * with the other side (about three quarters of it) free for texts, and layout.scale above 1 makes the phone bigger;
 * "phone-portrait" fills a 9:16 canvas (Shorts, Reels) from the top and leaves its bottom eighth for captions. Each
 * sets the aspect, the fit (contain: the whole phone), padding, corner radius and layout; the op's own fields still win.
 */
export const FRAME_PRESETS = ["phone-left", "phone-right", "phone-portrait"] as const;
export type FramePreset = (typeof FRAME_PRESETS)[number];

export const FRAME_PRESET_VALUES: Record<
    FramePreset,
    {
        aspect: (typeof CANVAS_ASPECTS)[number];
        fit: "contain";
        padding: number;
        cornerRadius: number;
        layout: { align: (typeof FRAME_ALIGNS)[number]; scale: number };
    }
> = {
    "phone-left": {
        aspect: "16:9",
        fit: "contain",
        padding: 0.04,
        cornerRadius: 0.035,
        layout: { align: "left", scale: 1 },
    },
    "phone-right": {
        aspect: "16:9",
        fit: "contain",
        padding: 0.04,
        cornerRadius: 0.035,
        layout: { align: "right", scale: 1 },
    },
    "phone-portrait": {
        aspect: "9:16",
        fit: "contain",
        padding: 0.04,
        cornerRadius: 0.03,
        layout: { align: "top", scale: 0.88 },
    },
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
const trackKeySchema = boxSchema.extend({ atUs: wholeUs(z.number().int().nonnegative()) });

/** A part of the SOURCE picture hidden for a time: an address, a token, a notification. It moves with a zoom. */
export const redactionSchema = z.object({
    id: z.string(),
    startUs: wholeUs(z.number().int().nonnegative()),
    endUs: wholeUs(z.number().int().positive()),
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
    /** A spotlight's dim around it, 0.2 to 0.95 black; absent is 0.5 (R8 11; 0.7 before). */
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
     * A spotlight's dim fades in and out over this many ms of the movie as it plays (at most a third of the time it
     * plays); 0 is a hard cut, absent is 200. The hiding styles never fade: they cover fully from their first frame to
     * their last.
     */
    fadeMs: z.number().int().min(0).max(2000).optional(),
    /** A pixelate block's side in source pixels (2 to 256); absent is 1.8 % of the picture's height, at least 8. */
    cell: z.number().min(2).max(256).optional(),
    // R6 1 moving text
    /** A part hideText or hidePrivate made: the hit it hides and how sure its place is. Absent on a hand-made part. */
    hide: z
        .object({
            /** The op that made it. */
            by: z.enum(["hideText", "hidePrivate"]),
            /** The hit's id (findText, privateData). */
            hit: z.string(),
            /** The band a moving text may cross where it could not be followed, not the text's own place. */
            uncertain: z.boolean().optional(),
            /** Seconds it showed while the picture moved, and its places a second then (read or followed). */
            movingSeconds: z.number().nonnegative().optional(),
            keysPerSecond: z.number().nonnegative().optional(),
            // R6 7: the request that made it, so info() says why it is there and unhide() can take it back.
            request: z
                .object({
                    text: z.string().optional(),
                    pattern: z.string().optional(),
                    texts: z.array(z.string()).optional(),
                    patterns: z.array(z.string()).optional(),
                    unit: z.enum(HIDE_UNITS).optional(),
                    kinds: z.array(z.string()).optional(),
                    names: z.array(z.string()).optional(),
                })
                .optional(),
        })
        .optional(),
    // R8 11
    /** A spotlight's soft edge: the dim rises from none at the lit shape to full at this distance (a share of the picture's short side, 0 to 0.5); absent or 0 is a sharp edge. */
    dimAround: z.number().min(0).max(0.5).optional(),
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
    atUs: wholeUs(z.number().int().nonnegative()),
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
    startUs: wholeUs(z.number().int().nonnegative()),
    endUs: wholeUs(z.number().int().positive()),
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
 * and fades out over 0.2 s, in the movie as it plays: a sped-up part does not shorten them, and a shape whose start
 * was cut draws itself on from its first shown frame.
 */
export const shapeSchema = z.object({
    id: z.string(),
    startUs: wholeUs(z.number().int().nonnegative()),
    endUs: wholeUs(z.number().int().positive()),
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

/**
 * A rectangle drawn on the preview (redact, spotlight): on a framed preview it may start or end on the background
 * margin, so it may run past the picture on any side; addRedaction keeps the part inside the picture.
 */
const drawnRectSchema = z
    .object({
        x: z.number().min(-1).max(1),
        y: z.number().min(-1).max(1),
        width: z.number().min(0.005).max(2),
        height: z.number().min(0.005).max(2),
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
        durationUs: wholeUs(z.number().int().positive()),
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

// R6 10 effects sheet
/**
 * The edit with its effects and its clips replaced by the whole recording at speed 1, so an output second is the same
 * source second: a sheet of source times drawn through the edit's zooms, hidden parts, texts and frame. The whole clip
 * has no cuts, so the export's snap of a hidden part to a cut is baked into the parts first (snappedRedactionSpans).
 * The tilt and the progress bar run on the export's clock, which a source moment inside a cut does not have, so they
 * are left out; an output sheet shows them.
 */
export function effectsOnSourceTime(project: EditProject): EditProject {
    const { tilt: _tilt, progress: _progress, ...effects } = project;
    return {
        ...effects,
        ...(project.redactions ? { redactions: snappedRedactionSpans(project) } : {}),
        clips: [{ id: WHOLE_CLIP_ID, fromUs: 0, toUs: project.source.durationUs, speed: 1 }],
    };
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

/**
 * The output stretches that play the source range `fromUs`..`toUs`: one per kept clip it overlaps, at the clip's speed.
 * A range that was cut plays nowhere. The Swift twin is TimelineMap.outputSpans.
 */
export function outputSpansOf(
    project: EditProject,
    fromUs: number,
    toUs: number
): Array<{ fromUs: number; toUs: number }> {
    const spans: Array<{ fromUs: number; toUs: number }> = [];
    let start = 0;

    for (const clip of project.clips) {
        const from = Math.max(fromUs, clip.fromUs);
        const to = Math.min(toUs, clip.toUs);

        if (to > from) {
            spans.push({
                fromUs: start + Math.round((from - clip.fromUs) / clip.speed),
                toUs: start + Math.round((to - clip.fromUs) / clip.speed),
            });
        }

        start += clipOutputUs(clip);
    }

    return spans;
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

/** The output length of `startUs`..`endUs` (source): each kept piece at its clip's speed. */
export function playedUs(project: EditProject, startUs: number, endUs: number): number {
    return project.clips.reduce(
        (sum, clip) =>
            sum + Math.max(0, Math.min(clip.toUs, endUs) - Math.max(clip.fromUs, startUs)) / (clip.speed || 1),
        0
    );
}

/** The source time where `playUs` of output has played from `startUs` on, through the clips at their speeds. */
export function sourceAfterPlayed(project: EditProject, startUs: number, playUs: number): number {
    let leftUs = playUs;

    for (const clip of project.clips) {
        const fromUs = Math.max(clip.fromUs, startUs);
        const speed = clip.speed || 1;
        const availableUs = Math.max(0, clip.toUs - fromUs) / speed;

        if (availableUs >= leftUs) {
            return Math.min(project.source.durationUs, Math.round(fromUs + leftUs * speed));
        }

        leftUs -= availableUs;
    }

    return project.source.durationUs;
}

/**
 * The text ops of a step title at each marker that plays (`at` in source seconds, in order), as titleMarkers adds
 * them: "N. label" (or the label alone with numbered false), playing for `seconds` (2.5) of the finished movie, so a
 * cut or a sped-up stretch after the marker moves its end later in source time. A title ends at the source's end and
 * no later than the next marker's start, so it never covers the next step's title. A marker that already has a text
 * starting within 0.1 s keeps it, so a second run adds nothing.
 */
export function markerTitleOps(
    project: EditProject,
    marks: ReadonlyArray<{ at: number; label: string }>,
    options: {
        seconds?: number;
        numbered?: boolean;
        y?: number;
        animate?: { kind: (typeof TEXT_ANIMATIONS)[number]; ms?: number };
    } = {}
): EditOp[] {
    const lengthUs = Math.round((options.seconds ?? 2.5) * 1_000_000);
    const taken = (project.texts ?? []).map((note) => note.startUs);
    const starts = marks.map((mark) => Math.round(mark.at * 1_000_000));
    return marks.flatMap((mark, index): EditOp[] => {
        const startUs = starts[index];

        if (taken.some((us) => Math.abs(us - startUs) <= 100_000)) {
            return [];
        }

        const nextUs = starts.find((us) => us > startUs) ?? project.source.durationUs;
        const endUs = Math.min(sourceAfterPlayed(project, startUs, lengthUs), nextUs, project.source.durationUs);
        const text = options.numbered === false ? mark.label : `${index + 1}. ${mark.label}`;
        return [
            {
                op: "text",
                from: mark.at,
                to: Math.floor(endUs / 1000) / 1000,
                text: text.slice(0, 200),
                ...(options.y === undefined ? {} : { y: options.y }),
                ...(options.animate ? { animate: options.animate } : {}),
            },
        ];
    });
}

/**
 * The source times where a kept clip ends before a cut (or the movie's end), and where one starts after a cut. The
 * Swift twin is RedactionEdges.cutEdges.
 */
export function cutEdgesOf(project: EditProject): { ends: number[]; starts: number[] } {
    const clips = project.clips.filter((clip) => clip.toUs > clip.fromUs);
    const ends = clips.filter((clip, index) => clips[index + 1]?.fromUs !== clip.toUs).map((clip) => clip.toUs);
    const starts = clips
        .filter((clip, index) => clip.fromUs > 0 && clips[index - 1]?.toUs !== clip.fromUs)
        .map((clip) => clip.fromUs);
    return { ends: ends.sort((a, b) => a - b), starts: starts.sort((a, b) => a - b) };
}

/**
 * The hidden parts with the source times the export draws them, the rule of the window's renderer
 * (RedactionEdges.effective): with `redactionJoins.snapMs` (250 unless set), a hiding part (blur, pixelate, black) that
 * ends that close before a cut is drawn to the cut, one that starts that close after a cut is drawn from it, and one
 * that ends that close before the next hiding part starts stays on until it does. Spotlights keep their own times, and
 * nothing is ever shortened. The renderer also keeps a part on while a frame from its time stays on screen (a screen
 * recording writes no frame while nothing moves); that needs the movie's frame times, which this does not read.
 */
export function snappedRedactionSpans(project: EditProject): EditRedaction[] {
    const parts = (project.redactions ?? []).map((part) => ({ ...part }));
    const snapUs = Math.max(0, project.redactionJoins?.snapMs ?? REDACTION_SNAP_MS) * 1000;

    if (snapUs <= 0) {
        return parts;
    }

    const cuts = cutEdgesOf(project);
    const hiding = parts.filter((part) => part.style !== "spotlight");

    for (const part of hiding) {
        const end = cuts.ends.find((edge) => edge > part.endUs && edge - part.endUs <= snapUs);
        const start = cuts.starts.findLast((edge) => edge < part.startUs && part.startUs - edge <= snapUs);
        part.endUs = end ?? part.endUs;
        part.startUs = start ?? part.startUs;
    }

    for (const part of hiding) {
        const end = part.endUs;
        const following = hiding.map((other) => other.startUs).filter((start) => start > end && start - end <= snapUs);

        if (following.length > 0) {
            part.endUs = Math.min(...following);
        }
    }

    return parts;
}

/**
 * Where each voiceover plays in the exported file, in microseconds from its first frame (the intro card's), in that
 * order: a movie line from its output time after the intro, cut at the movie's end; a card line from its card's start
 * plus `atUs`, running on to the end of the file at most. A line whose start is cut, or whose card is gone, is left out.
 * The Swift export lays the clips at the same places (VoiceoverMix.exportPlacements).
 */
export function voiceoverExportSpans(project: EditProject): Array<{ id: string; startUs: number; playUs: number }> {
    const leadUs = cardsLeadUs(project);
    const movieUs = outputDurationUs(project);
    const tailUs = Math.round((project.cards?.end?.seconds ?? 0) * 1_000_000);
    const totalUs = leadUs + movieUs + tailUs;
    const spans: Array<{ id: string; startUs: number; playUs: number }> = [];

    for (const clip of project.audio.voiceovers ?? []) {
        if (clip.card !== undefined) {
            if (!project.cards?.[clip.card]) {
                continue;
            }

            const startUs = (clip.card === "intro" ? 0 : leadUs + movieUs) + clip.atUs;
            const playUs = Math.min(clip.durationUs, totalUs - startUs);

            if (playUs > 0) {
                spans.push({ id: clip.id, startUs, playUs });
            }

            continue;
        }

        const outUs = outputTimeOf(project, clip.atUs);

        if (outUs === undefined || outUs >= movieUs) {
            continue;
        }

        spans.push({ id: clip.id, startUs: leadUs + outUs, playUs: Math.min(clip.durationUs, movieUs - outUs) });
    }

    return spans.sort((a, b) => a.startUs - b.startUs);
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

/**
 * Removes a source range from the movie: each clip it touches keeps its part before `fromUs` and its part after `toUs`,
 * with no minimum on the cut itself. A kept part shorter than one frame is dropped. The first kept part keeps the
 * clip's id, so a join keyed by that clip (its own transition) stays on it when the cut takes the clip's head.
 */
export function cutRange(project: EditProject, fromUs: number, toUs: number): EditProject {
    checkRange(project, fromUs, toUs);
    const clips = project.clips.flatMap((clip) => {
        if (clip.toUs <= fromUs || clip.fromUs >= toUs) {
            return [clip];
        }

        const pieces = [
            { ...clip, toUs: Math.min(clip.toUs, fromUs) },
            { ...clip, fromUs: Math.max(clip.fromUs, toUs) },
        ].filter((piece) => piece.toUs - piece.fromUs >= MINIMUM_CLIP_US);
        return pieces.map((piece, index) => (index === 0 ? piece : { ...piece, id: newId("c") }));
    });

    if (clips.length === 0) {
        throw new RangeError("that cut removes the whole movie; keep at least one part");
    }

    return { ...project, clips };
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

// R6 5 export time
/** A moment of the export file as output microseconds (what plays, after the intro card); undefined inside a card. */
export function exportToOutputUs(project: EditProject, exportUs: number): number | undefined {
    const outUs = exportUs - cardsLeadUs(project);
    return outUs >= 0 && outUs <= outputDurationUs(project) ? outUs : undefined;
}

/**
 * The clocks a time of an edit can be on: SOURCE (the recording as recorded, what ops take), OUTPUT (the edited movie,
 * what the editor's timeline shows, without its cards) and EXPORT (the exported file, which plays the intro card first).
 */
export const EDIT_CLOCKS = ["source", "output", "export"] as const;
export type EditClock = (typeof EDIT_CLOCKS)[number];

/**
 * A moment of the export file as output microseconds, held on the movie: a moment on the intro card is output 0 and
 * one on the end card (or past the movie's end) is the output's end; `inCard` names the card it was on.
 */
export function exportToOutputClampedUs(
    project: EditProject,
    exportUs: number
): { outUs: number; inCard?: "intro" | "end" } {
    const outUs = exportUs - cardsLeadUs(project);
    const endUs = outputDurationUs(project);

    if (outUs < 0) {
        return { outUs: 0, inCard: "intro" };
    }

    if (outUs > endUs) {
        return { outUs: endUs, ...(project.cards?.end ? { inCard: "end" as const } : {}) };
    }

    return { outUs };
}

// R7 3 verifyHidden fixes
/**
 * True when the export shows the source picture as it is over the SOURCE range `fromUs`..`toUs` (a point when they are
 * equal), so a box read on the export is the same box in the source: no frame, no zoom of either target then, no tilt
 * (TiltLook tilts the whole picture over black whenever it is set), no lens then, and no transition playing at the
 * output moments that show it (`outUs` when the caller knows the one output moment). Any of those moves the picture.
 */
export function exportShowsSourceAsIs(
    project: EditProject,
    range: { fromUs: number; toUs: number; outUs?: number }
): boolean {
    if (project.frame || project.tilt) {
        return false;
    }

    if (project.zooms.some((zoom) => zoom.startUs <= range.toUs && zoom.endUs > range.fromUs)) {
        return false;
    }

    if (lensShowsAt(project, range.fromUs, range.toUs)) {
        return false;
    }

    const outputs =
        range.outUs !== undefined
            ? [{ fromUs: range.outUs, toUs: range.outUs }]
            : outputSpansOf(project, range.fromUs, range.toUs);
    return !outputs.some((span) => transitionPlayingAt(project, span.fromUs, span.toUs));
}

/**
 * Where a text verifyHidden read on the export sits in the SOURCE picture (fractions of the source movie's picture) from
 * `fromUs` to `toUs` (SOURCE microseconds): the source's own tracked hits of the same kind that show then (the same
 * masked value first), as one rectangle over their places in that time. With none, the export's box itself when the
 * export shows the source picture as it is then (exportShowsSourceAsIs); else null.
 */
export function leakSourceBox(
    project: EditProject,
    options: {
        fromUs: number;
        toUs: number;
        label: string;
        masked: string;
        /** The leak's box on the export frame (fractions of the export's picture). */
        canvasBox: { x: number; y: number; width: number; height: number };
        sourceHits: readonly PrivateHit[];
    }
): { x: number; y: number; width: number; height: number } | null {
    const slackUs = 300_000;
    const showing = options.sourceHits.filter(
        (hit) => hit.fromUs <= options.toUs + slackUs && hit.toUs >= options.fromUs - slackUs
    );
    // The same value first (a few characters of it at an edge carry its mask too), else any of the same kind.
    const same = showing.filter((hit) => hit.masked === options.masked);
    const chosen = same.length > 0 ? same : showing.filter((hit) => hit.label === options.label);

    if (chosen.length > 0) {
        const boxes = chosen.flatMap((hit) => {
            const keys = hit.keys.filter(
                (key) => key.atUs >= options.fromUs - slackUs && key.atUs <= options.toUs + slackUs
            );
            return keys.length > 0 ? keys : [hit.box];
        });
        const x = Math.min(...boxes.map((box) => box.x));
        const y = Math.min(...boxes.map((box) => box.y));
        const right = Math.max(...boxes.map((box) => box.x + box.width));
        const bottom = Math.max(...boxes.map((box) => box.y + box.height));
        return { x, y, width: right - x, height: bottom - y };
    }

    return exportShowsSourceAsIs(project, options) ? { ...options.canvasBox } : null;
}

/**
 * R8 4: a leak's place in the SOURCE picture at each export frame it was read (`keys`: EXPORT microseconds and boxes on
 * the export frame): the export's own box where the export shows the source picture as it is (exportShowsSourceAsIs),
 * else the place then of the source's own hit of the same value (the same masked value first, else the same label)
 * nearest to it. A frame inside a card, or with no such hit, has no key. Source seconds and fractions, in time order.
 */
export function leakSourceKeys(
    project: EditProject,
    options: {
        keys: ReadonlyArray<{ atUs: number; x: number; y: number; width: number; height: number }>;
        label: string;
        masked: string;
        sourceHits: readonly PrivateHit[];
    }
): Array<{ at: number; x: number; y: number; width: number; height: number }> {
    const slackUs = 300_000;
    const centre = (box: { x: number; y: number; width: number; height: number }) => ({
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
    });
    return options.keys.flatMap((key) => {
        const outUs = exportToOutputUs(project, key.atUs);

        if (outUs === undefined) {
            return [];
        }

        const sourceUs = sourceTimeOf(project, outUs);
        const at = Math.round(sourceUs / 1000) / 1000;
        const { atUs: _atUs, ...canvas } = key;
        if (exportShowsSourceAsIs(project, { fromUs: sourceUs, toUs: sourceUs, outUs })) {
            return [{ at, ...canvas }];
        }

        const showing = options.sourceHits.filter(
            (hit) => hit.fromUs <= sourceUs + slackUs && hit.toUs >= sourceUs - slackUs
        );
        const same = showing.filter((hit) => hit.masked === options.masked);
        const chosen = same.length > 0 ? same : showing.filter((hit) => hit.label === options.label);
        const read = centre(canvas);
        const nearest = chosen
            .map((hit) => redactionBoxAt({ ...hit.box, track: hit.keys }, sourceUs))
            .sort(
                (a, b) =>
                    Math.hypot(centre(a).x - read.x, centre(a).y - read.y) -
                    Math.hypot(centre(b).x - read.x, centre(b).y - read.y)
            )[0];
        return nearest ? [{ at, ...nearest }] : [];
    });
}

/** The edit's own overlay that draws a leak: a text (by its id) or the caption line (by its start, source seconds). */
export type LeakOverlay = { kind: "text"; id: string } | { kind: "caption"; at: number };

/**
 * The edit's own overlay that draws a text verifyHidden read on the export from `fromUs` to `toUs` (SOURCE
 * microseconds), so no redact op can hide it: the export draws texts and captions over the redacted picture. A text
 * whose time meets the leak's and whose words hold its value (the same masked value, by `matcher`, the one the export
 * was read with), else, with captions on, a caption line then that holds it (`captionLines`: the transcript's lines
 * with their fixes, as transcriptLines gives them). Undefined when no overlay draws it, and when the source picture
 * shows the same value then (a source hit of the same masked value), which a redact op does hide: where the export shows
 * the source as it is (exportShowsSourceAsIs), only a hit at the place it was read (`canvasBox`) counts.
 */
export function leakOverlay(
    project: EditProject,
    options: {
        fromUs: number;
        toUs: number;
        masked: string;
        matcher: LineMatcher;
        captionLines?: ReadonlyArray<Pick<TranscriptLine, "from" | "to" | "text">>;
        /** The leak's box on the export frame (fractions of the export's picture). */
        canvasBox?: FractionBox;
        sourceHits?: readonly PrivateHit[];
    }
): LeakOverlay | undefined {
    const meets = (startUs: number, endUs: number, slackUs = 100_000) =>
        startUs <= options.toUs + slackUs && endUs >= options.fromUs - slackUs;
    // OCR reads each line on its own; a name broken over two lines reads as one in the whole text.
    const draws = (text: string) =>
        [text.replace(/\s*\n\s*/g, " "), ...text.split("\n")].some((line) =>
            options.matcher(line).some((match) => maskPrivate(match.value) === options.masked)
        );
    const note = (project.texts ?? []).find((item) => meets(item.startUs, item.endUs) && draws(item.text));
    const line = project.captions?.show
        ? options.captionLines?.find(
              (item) => meets(Math.round(item.from * 1_000_000), Math.round(item.to * 1_000_000)) && draws(item.text)
          )
        : undefined;
    const overlay: LeakOverlay | undefined = note
        ? { kind: "text", id: note.id }
        : line
          ? { kind: "caption", at: line.from }
          : undefined;

    if (!overlay) {
        return undefined;
    }

    // The source's reads sit up to 300 ms off the export's, as leakSourceBox takes them.
    const hitSlackUs = 300_000;
    const asIs = exportShowsSourceAsIs(project, options);
    const at = options.canvasBox;
    const meetsBox = (box: FractionBox) =>
        !at ||
        (box.x < at.x + at.width && at.x < box.x + box.width && box.y < at.y + at.height && at.y < box.y + box.height);
    const pictureShows = (options.sourceHits ?? []).some((hit) => {
        if (hit.masked !== options.masked || !meets(hit.fromUs, hit.toUs, hitSlackUs)) {
            return false;
        }

        if (!asIs) {
            return true;
        }

        const keys = hit.keys.filter((key) => meets(key.atUs, key.atUs, hitSlackUs));
        return (keys.length > 0 ? keys : [hit.box]).some(meetsBox);
    });

    return pictureShows ? undefined : overlay;
}

/**
 * R8 4: the redact op that covers each leak in SOURCE time and space, one per leak: `sourceKeys` (its place in the source
 * picture at each frame it was read) as the op's track, each with half a line of margin (kept inside the picture), from
 * 0.1 s before its first read to 0.1 s after its last; one key is a still box. A leak with no source time (inside a
 * card) or no place in the source gets no op: verifyHidden notes it instead, never a box over the whole frame.
 */
export function leakFixOps(
    leaks: ReadonlyArray<{
        label: string;
        /** Source seconds. */
        source: { at: number; until: number } | null;
        /** Source seconds and source fractions, one per frame it was read. */
        sourceKeys?: ReadonlyArray<{ at: number; x: number; y: number; width: number; height: number }>;
        /** Source fractions. */
        sourceBox: { x: number; y: number; width: number; height: number } | null;
    }>
): EditOp[] {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const margin = (box: { x: number; y: number; width: number; height: number }) => {
        const pad = box.height / 3;
        const x = Math.max(0, box.x - pad);
        const y = Math.max(0, box.y - pad);
        return {
            x: round(x),
            y: round(y),
            width: round(Math.max(0.005, Math.min(1, box.x + box.width + pad) - x)),
            height: round(Math.max(0.005, Math.min(1, box.y + box.height + pad) - y)),
        };
    };
    return leaks.flatMap((leak) => {
        const keys =
            leak.sourceKeys ?? (leak.source && leak.sourceBox ? [{ at: leak.source.at, ...leak.sourceBox }] : []);

        if (!leak.source || keys.length === 0) {
            return [];
        }

        const first = keys[0];
        const last = keys[keys.length - 1];
        const from = round(Math.max(0, Math.min(first.at, leak.source.at) - 0.1));
        const to = round(Math.max(first.at + 0.05, last.at, leak.source.until) + 0.1);
        const placed = keys.map((key) => ({ at: round(key.at), ...margin(key) }));
        // A redact op holds its edge keys; a moving leak keeps moving through the margins, so its edges get keys
        // along the speed of the two nearest reads.
        const along = (a: (typeof placed)[number], b: (typeof placed)[number], at: number) => {
            const edge = at < a.at ? a : b;
            const f = b.at > a.at ? (at - a.at) / (b.at - a.at) : 0;
            const y = Math.min(1 - edge.height, Math.max(0, a.y + (b.y - a.y) * f));
            const x = Math.min(1 - edge.width, Math.max(0, a.x + (b.x - a.x) * f));
            return { ...edge, at, x: round(x), y: round(y) };
        };
        const track =
            placed.length > 1
                ? [
                      ...(from < placed[0].at ? [along(placed[0], placed[1], from)] : []),
                      ...placed,
                      ...(to > placed[placed.length - 1].at
                          ? [along(placed[placed.length - 2], placed[placed.length - 1], to)]
                          : []),
                  ]
                : undefined;
        return [
            editOpSchema.parse({
                op: "redact",
                from,
                to,
                rect: margin(first),
                label: `${leak.label} (verifyHidden)`.slice(0, 60),
                ...(track && new Set(track.map((key) => key.at)).size === track.length ? { track } : {}),
            }),
        ];
    });
}

// R7 4 verifyHidden sampling
/**
 * The stretches of the export (EXPORT microseconds, the intro card included) where verifyHidden reads every frame:
 * `aroundUs` (0.2 s) on each side of every cut, of every transition (the span that plays, `transitionJoins`' halfUs),
 * of the start and end of every zoom and hidden part that plays, and of every scene change in `sceneUs` (SOURCE
 * microseconds). Sorted and merged.
 */
export function boundaryWindows(
    project: EditProject,
    options: { aroundUs?: number; sceneUs?: readonly number[] } = {}
): Array<[number, number]> {
    const aroundUs = options.aroundUs ?? 200_000;
    const leadUs = cardsLeadUs(project);
    const endUs = leadUs + outputDurationUs(project);
    const windows: Array<[number, number]> = [];
    const add = (fromOutUs: number, toOutUs: number) => {
        const from = Math.max(0, leadUs + fromOutUs - aroundUs);
        const to = Math.min(endUs, leadUs + toOutUs + aroundUs);

        if (to > from) {
            windows.push([from, to]);
        }
    };
    for (const join of transitionJoins(project)) {
        add(join.atUs - join.halfUs, join.atUs + join.halfUs);
    }

    const sourcePoints = [
        ...project.zooms.flatMap((zoom) => [zoom.startUs, zoom.endUs]),
        ...(project.redactions ?? []).flatMap((part) => [part.startUs, part.endUs]),
        ...(options.sceneUs ?? []),
    ];

    for (const sourceUs of sourcePoints) {
        const outUs = outputTimeOf(project, sourceUs);

        if (outUs !== undefined) {
            add(outUs, outUs);
        }
    }

    windows.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];

    for (const window of windows) {
        const last = merged.at(-1);

        if (last && window[0] <= last[1]) {
            last[1] = Math.max(last[1], window[1]);
        } else {
            merged.push([...window]);
        }
    }

    return merged;
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
 * The edit cut down to what plays from `fromOutUs` to `toOutUs` (OUTPUT microseconds), for exporting a part: each
 * clip's own overlap with that output range, at its speed, with its id kept. Cuts and speeds inside the part stay; the
 * edit on disk is not changed. The Swift preview cuts a part the same way (TimelineMap.part).
 */
export function partOf(project: EditProject, fromOutUs: number, toOutUs: number): EditProject {
    const length = outputDurationUs(project);
    const seconds = (us: number) => Math.round(us / 1000) / 1000;

    if (!(toOutUs > fromOutUs) || fromOutUs < 0 || fromOutUs >= length) {
        throw new RangeError(
            `the part ${seconds(fromOutUs)}–${seconds(toOutUs)} s must start before it ends and inside the ${seconds(length)} s edit (OUTPUT seconds)`
        );
    }

    const clips: EditClip[] = [];
    let outStartUs = 0;

    for (const clip of project.clips) {
        const outEndUs = outStartUs + clipOutputUs(clip);
        const startUs = Math.max(fromOutUs, outStartUs);
        const endUs = Math.min(toOutUs, outEndUs);

        if (endUs - startUs >= MINIMUM_CLIP_US) {
            clips.push({
                ...clip,
                fromUs: clip.fromUs + Math.round((startUs - outStartUs) * clip.speed),
                toUs: Math.min(clip.toUs, clip.fromUs + Math.round((endUs - outStartUs) * clip.speed)),
            });
        }

        outStartUs = outEndUs;
    }

    if (clips.length === 0) {
        throw new RangeError(`nothing plays from ${seconds(fromOutUs)} to ${seconds(toOutUs)} s (OUTPUT seconds)`);
    }

    return { ...project, clips };
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
    /** "canvas" zooms the whole framed export; absent zooms inside the picture. A canvas zoom refuses `follow`. */
    target?: "picture" | "canvas";
}

/**
 * The zooms of one target (absent is "picture") but the one with `exceptId`: the only zooms a zoom of that target may
 * not meet, because a canvas zoom may overlap a picture zoom.
 */
function zoomsOfTarget(project: EditProject, target: "picture" | "canvas", exceptId?: string): EditZoom[] {
    return project.zooms.filter((zoom) => zoom.id !== exceptId && (zoom.target ?? "picture") === target);
}

/** `span` moved later with its length kept, past each of `zooms` it would meet (in start order). */
function pastZooms(
    zooms: readonly EditZoom[],
    span: { startUs: number; endUs: number }
): { startUs: number; endUs: number } {
    const length = span.endUs - span.startUs;
    let startUs = span.startUs;

    for (const zoom of [...zooms].sort((a, b) => a.startUs - b.startUs)) {
        if (startUs < zoom.endUs && startUs + length > zoom.startUs) {
            startUs = zoom.endUs;
        }
    }

    return { startUs, endUs: startUs + length };
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
    const same = zoomsOfTarget(project, target);
    const { startUs } = pastZooms(same, { startUs: Math.max(0, fromUs), endUs: Math.max(0, fromUs) + length });
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

    if (options.target === "canvas" && options.follow) {
        throw new RangeError(CANVAS_ZOOM_HOLDS_FOCUS);
    }

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

/** Hides a rectangle of the source picture from `fromUs` to `toUs`; the part outside the picture is cut off. */
export function addRedaction(
    project: EditProject,
    options: {
        fromUs: number;
        toUs: number;
        rect: z.infer<typeof drawnRectSchema>;
        style: EditRedaction["style"];
        label?: string;
        follow?: boolean;
        dim?: number;
        cutout?: EditRedaction["cutout"];
        // R5 5 redaction edges
        fadeMs?: number;
        cell?: number;
        // R8 11
        dimAround?: number;
    }
): EditProject {
    checkRange(project, options.fromUs, options.toUs);
    // The editor window's rule: the part of the rectangle inside the picture, on all four edges, refused only when
    // under 1 % of it.
    const x = Math.max(0, options.rect.x);
    const y = Math.max(0, options.rect.y);
    const width = Math.min(options.rect.width + Math.min(0, options.rect.x), 1 - x);
    const height = Math.min(options.rect.height + Math.min(0, options.rect.y), 1 - y);

    if (width < 0.01 || height < 0.01) {
        throw new RangeError(
            `the rectangle is ${Math.round(width * 1000) / 1000} by ${Math.round(height * 1000) / 1000} of the picture inside it; it needs at least 0.01 by 0.01`
        );
    }

    // R7 1: the one place a hidden part's times are written; the motion places parts on thirds of a millisecond.
    const redaction: EditRedaction = {
        id: newId("r"),
        startUs: Math.round(options.fromUs),
        endUs: Math.round(Math.min(project.source.durationUs, options.toUs)),
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
        ...(options.style === "spotlight" && options.dimAround ? { dimAround: options.dimAround } : {}),
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
            let raw: unknown;

            try {
                raw = SafeJSON.parse(line, { strict: true });
            } catch {
                // A line torn by a crash or a write still in progress is skipped, as CursorTrack.load skips it.
                log.debug({ path }, "cursor track: skipped a line that is not JSON");
                return [];
            }

            const row = cursorRowSchema.safeParse(raw);
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

/**
 * The recorded clicks in time order, in groups: a click less than `gapMs` after the one before joins its group. With
 * `playedMs` (a click's ms to the output ms it plays at, undefined when it was cut) the gap is the one the viewer sees
 * and a cut click is left out; without it, the gap is the recording's own.
 */
export function groupClicks(
    samples: readonly CursorSample[],
    options: { gapMs?: number; playedMs?: (ms: number) => number | undefined } = {}
): CursorSample[][] {
    const gapMs = options.gapMs ?? CLICK_GROUP_GAP_MS;
    const groups: CursorSample[][] = [];
    let lastMs = 0;

    for (const click of samples.filter((sample) => sample.click)) {
        const ms = options.playedMs ? options.playedMs(click.ms) : click.ms;

        if (ms === undefined) {
            continue;
        }

        const group = groups.at(-1);

        if (group && ms - lastMs < gapMs) {
            group.push(click);
        } else {
            groups.push([click]);
        }

        lastMs = ms;
    }

    return groups;
}

/**
 * Whether two zooms next to each other in play order are linked, the rule of the window's renderer (ZoomCurve.linked
 * in TimelineMap.swift): both zoom the picture or both the canvas, the second starts to play after the first, and less
 * time plays between the first one's last kept moment and the second one's first than one ease out and one ease in
 * take. The view then glides from one zoom to the other and never shows the whole frame between them, across a cut too.
 */
export function zoomsLinked(project: EditProject, first: EditZoom, second: EditZoom): boolean {
    if ((first.target === "canvas") !== (second.target === "canvas")) {
        return false;
    }

    const firstSpans = outputSpansOf(project, first.startUs, first.endUs);
    const firstStart = firstSpans[0]?.fromUs;
    const firstEnd = firstSpans.at(-1)?.toUs;
    const secondStart = outputSpansOf(project, second.startUs, second.endUs)[0]?.fromUs;

    if (firstStart === undefined || firstEnd === undefined || secondStart === undefined) {
        return false;
    }

    const later = secondStart > firstStart || (secondStart === firstStart && second.startUs > first.startUs);
    return later && secondStart - firstEnd < (first.easeOutMs + second.easeInMs) * 1000;
}

/** What one view (the picture's or the canvas's) shows at a moment: one zoom, or the glide between two linked zooms. */
export type ZoomShown = { zoom: EditZoom } | { glide: { from: EditZoom; to: EditZoom } };

/**
 * The zoom a view shows at a source moment that plays, the rule of the window's renderer (ZoomCurve.curve in
 * TimelineMap.swift): between two linked zooms of that target, from where the first starts to leave to where the
 * second has arrived (in output time), the glide from one to the other; elsewhere the zoom whose source range holds the
 * moment, or null. A canvas zoom and a picture zoom play together, so each target has its own answer.
 */
export function zoomShownAt(
    project: EditProject,
    sourceUs: number,
    target: NonNullable<EditZoom["target"]>
): ZoomShown | null {
    const outUs = outputTimeOf(project, sourceUs);

    if (outUs === undefined) {
        return null;
    }

    const ordered = project.zooms
        .filter((zoom) => (zoom.target === "canvas") === (target === "canvas"))
        .flatMap((zoom) => {
            const spans = outputSpansOf(project, zoom.startUs, zoom.endUs);
            const startOut = spans[0]?.fromUs;
            const endOut = spans.at(-1)?.toUs;
            return startOut === undefined || endOut === undefined ? [] : [{ zoom, startOut, endOut }];
        })
        .sort((a, b) => a.startOut - b.startOut || a.zoom.startUs - b.zoom.startUs);

    for (const [index, first] of ordered.entries()) {
        const second = ordered[index + 1];

        if (!second || !zoomsLinked(project, first.zoom, second.zoom)) {
            continue;
        }

        // A zoom shorter than its own ease would leave a gap: the glide starts no later than the first zoom's end and
        // ends no earlier than the second's start.
        const leaves = Math.max(
            first.startOut + first.zoom.easeInMs * 1000,
            first.endOut - first.zoom.easeOutMs * 1000
        );
        const arrives = Math.min(
            second.endOut - second.zoom.easeOutMs * 1000,
            second.startOut + second.zoom.easeInMs * 1000
        );
        const startUs = Math.min(first.endOut, leaves);
        const endUs = Math.max(second.startOut, arrives);

        if (endUs > startUs && outUs >= startUs && outUs < endUs) {
            return { glide: { from: first.zoom, to: second.zoom } };
        }
    }

    const live = ordered.findLast(({ zoom }) => zoom.startUs <= sourceUs && sourceUs < zoom.endUs);
    return live ? { zoom: live.zoom } : null;
}

/**
 * Zooms on the recorded clicks, as the window's Auto zoom does: clicks that play under 3 s apart (a cut between them
 * brings them closer) are one zoom from 0.6 s before the first to 1.6 s after the last, following the cursor, and a
 * click in a cut part gets none. Its zooms carry origin "auto": a later run replaces those and keeps every other zoom
 * (a hand-made follow zoom and a canvas zoom too); a group that would overlap a kept picture zoom is left out, while a
 * canvas zoom never blocks one. No clicks that play is an error, and nothing changes.
 */
export function autoZoom(project: EditProject, samples: readonly CursorSample[], scale = 1.6): EditProject {
    const groups = groupClicks(samples, {
        playedMs: (ms) => {
            const outUs = outputTimeOf(project, ms * 1000);
            return outUs === undefined ? undefined : outUs / 1000;
        },
    });

    if (groups.length === 0) {
        throw new RangeError(
            samples.length === 0
                ? "this movie has no cursor track, so there are no clicks to zoom on; the zooms are unchanged"
                : samples.some((sample) => sample.click)
                  ? "every click of the cursor track is in a cut part, so there is nothing to zoom on; the zooms are unchanged"
                  : "the cursor track has no clicks to zoom on; the zooms are unchanged"
        );
    }

    const kept = project.zooms.filter((zoom) => zoom.origin !== "auto");
    const pictures = kept.filter((zoom) => (zoom.target ?? "picture") === "picture");
    const added = groups.map((group) =>
        zoomSchema.parse({
            id: newId("z"),
            startUs: Math.max(0, group[0].ms - 600) * 1000,
            endUs: Math.min(project.source.durationUs, ((group.at(-1)?.ms ?? 0) + 1600) * 1000),
            scale,
            mode: "follow",
            origin: "auto",
            focusX: group.reduce((sum, sample) => sum + sample.x, 0) / group.length,
            focusY: group.reduce((sum, sample) => sum + sample.y, 0) / group.length,
        })
    );
    const free = added.filter(
        (zoom) => !pictures.some((other) => zoom.startUs < other.endUs && zoom.endUs > other.startUs)
    );
    return { ...project, zooms: [...kept, ...free].sort((a, b) => a.startUs - b.startUs) };
}

/**
 * Marks every recorded click from `fromUs` to `toUs` (source) with a shape for `seconds`: a circle round the point
 * (default), a box, or an arrow pointing at it from towards the middle. A circle or box is square in pixels, with a
 * half side of 4.5 % of the picture's short side (circleAround). A double click is one mark (clicks under
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
        const ring = circleAround(click, 0.045, project.source);
        const corners =
            kind === "arrow"
                ? {
                      x1: clamp(click.x + toward.x * 0.085),
                      y1: clamp(click.y + toward.y * 0.085),
                      x2: click.x,
                      y2: click.y,
                  }
                : { x1: ring.start.x, y1: ring.start.y, x2: ring.end.x, y2: ring.end.y };
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

/** The redact op's options that one style alone draws; addRedaction keeps each only on its style. */
const REDACT_STYLE_OPTIONS = [
    ["dim", "spotlight"],
    ["cutout", "spotlight"],
    ["cell", "pixelate"],
] as const satisfies ReadonlyArray<readonly [string, EditRedaction["style"]]>;

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
            /** How long it takes to grow and to shrink back (450 ms each when absent); a long ease in is a slow push. */
            easeInMs: z.number().int().nonnegative().optional(),
            easeOutMs: z.number().int().nonnegative().optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
            // R5 4 canvas zoom
            /**
             * "canvas" zooms the whole framed export (focus is 0...1 of the canvas); absent zooms the picture. A canvas
             * zoom holds its focus, so it refuses follow.
             */
            target: z.enum(["picture", "canvas"]).optional(),
        })
        .strict(),
    z.object({ op: z.literal("unzoom"), id: z.string() }).strict(),
    z
        .object({
            op: z.literal("redact"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
            /** 0...1 of the source picture from its top left; the part outside the picture is cut off. */
            rect: drawnRectSchema,
            style: z.enum(REDACTION_STYLES).optional(),
            /** What it hides ("API token"), shown in the editor's lists. */
            label: z.string().max(60).optional(),
            /** Moves with the drawn cursor, centred on it; rect gives its size. */
            follow: z.boolean().optional(),
            /** Style "spotlight" only: the dim around it (0.5) and its lit shape ("rounded"). */
            dim: z.number().min(0.2).max(0.95).optional(),
            cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
            // R5 5 redaction edges
            /** Style "pixelate" only: a block's side in source pixels (2 to 256); absent is 1.8 % of the height. */
            cell: z.number().min(2).max(256).optional(),
            // R8 4 fixOps: keyframes
            /**
             * Its place at source times (`at`, seconds), in order: between two keys it moves straight from one to the
             * next, before the first and after the last it holds (verifyHidden's fixOps follow a leak frame by frame).
             */
            track: z
                .array(
                    z
                        .object({
                            at: sourceTimeSchema,
                            x: z.number().min(0).max(1),
                            y: z.number().min(0).max(1),
                            width: z.number().positive().max(1),
                            height: z.number().positive().max(1),
                        })
                        .strict()
                )
                .min(2)
                .optional(),
        })
        .strict(),
    z
        .object({
            op: z.literal("spotlight"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
            /**
             * Stays as it is while the rest of the picture dims; with follow, its size around the cursor. The part
             * outside the picture is cut off.
             */
            rect: drawnRectSchema,
            label: z.string().max(60).optional(),
            follow: z.boolean().optional(),
            /** How dark the rest gets, 0.2 to 0.95 black (0.5). */
            dim: z.number().min(0.2).max(0.95).optional(),
            /** The lit shape: "rounded" (default), "rect" or "circle". */
            cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
            /** The effect lane to put it on (an id from info().lanes); absent is the first that holds it. */
            lane: z.string().optional(),
            // R5 5 redaction edges
            /** The dim's fade in and out in ms (200; at most a third of its length); 0 is a hard cut. */
            fadeMs: z.number().int().min(0).max(2000).optional(),
            // R8 11
            /** A spotlight's soft edge: the dim rises from none at the lit shape to full at this distance (a share of the picture's short side, 0 to 0.5); absent or 0 is a sharp edge. */
            dimAround: z.number().min(0).max(0.5).optional(),
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
                .object({
                    align: z.enum(FRAME_ALIGNS).optional(),
                    scale: z.number().min(0.5).max(3).optional(),
                    // R7 9 phone layouts
                    focus: z
                        .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                        .strict()
                        .optional(),
                })
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
             * track left takes the noise reduction away); with `reductionDb` it gets its own strength. Every track
             * is written as no list, and a strength equal to the base is not written. The service counts the movie's
             * sound tracks; `trackCount` is the count used only when the movie cannot be measured (no file), and a
             * track op with neither is refused.
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
    /**
     * Changes a zoom that exists; a focus placed by hand makes a following zoom manual (unless `mode` says). A canvas
     * zoom holds its focus, so mode "follow" is refused for it.
     */
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
    /**
     * Changes a hidden part or spotlight that exists; the rectangle stays inside the picture, at least 1 % wide. The
     * renderers place a part with keyframes (hideText, hidePrivate, verifyHidden's fixOps, redact with track) by its
     * keys alone, so on such a part a new rect moves every key by its change from the stored rect and scales every
     * key's size by the same ratio (each kept inside the picture), and `follow` is refused: the part follows its text.
     */
    z
        .object({
            op: z.literal("setRedaction"),
            id: z.string(),
            rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict().optional(),
            /**
             * New keyframes (`at`, source seconds) in place of the part's own, each kept inside the picture and taken as
             * given (no holds are added at the part's edges, unlike redact's track); a rect sent with them does not move
             * them again, and [] makes the part fixed at its rect.
             */
            track: z
                .array(
                    z
                        .object({
                            at: sourceTimeSchema,
                            x: z.number(),
                            y: z.number(),
                            width: z.number(),
                            height: z.number(),
                        })
                        .strict()
                )
                .optional(),
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
            // R8 11
            /** A spotlight's soft edge (0 to 0.5 of the picture's short side); 0 makes it sharp again. */
            dimAround: z.number().min(0).max(0.5).optional(),
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
            /** "intro" or "end": it plays over that card, and `at` counts from the card's first frame. */
            card: z.enum(VOICEOVER_CARDS).optional(),
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
            // R6 2: "line" hides the whole OCR line that holds a match (a name and the number beside it); absent is "match".
            unit: z.enum(HIDE_UNITS).optional(),
            // R6 3: several texts and patterns in one scan of the screen.
            texts: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
            patterns: z.array(z.string().min(1).max(200)).max(50).optional(),
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
    // R6 6 unhide
    /**
     * Takes back what hideText or hidePrivate hid, and forgets it, so the same hide runs again: the parts a request
     * with `text` or `pattern` (or `kinds` of private data) made, or `ids` (part ids or hit ids), or `all`.
     */
    z
        .object({
            op: z.literal("unhide"),
            text: z.string().trim().min(1).max(200).optional(),
            pattern: z.string().min(1).max(200).optional(),
            ids: z.array(z.string()).min(1).max(500).optional(),
            all: z.boolean().optional(),
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

/**
 * A `zoom` op whose zoom went past a zoom it met (`placeZoom`), or a `retime` with `at` or `by` whose zoom went past a
 * zoom of its target it met (`retimeItem`), as a sentence a caller can return.
 */
export function opPlacementWarnings(op: EditOp, before: EditProject, after: EditProject): string[] {
    const seconds = (us: number) => Math.round(us / 1000) / 1000;

    // R6 1: a hide that could not follow a moving text says where, so its ok is not a guess.
    if (op.op === "hideText" || op.op === "hidePrivate") {
        return hidingOf(before, after).uncertain.map(
            (stretch) =>
                `${op.op}: a moving text could not be followed from ${stretch.from} to ${stretch.to} s; the band it may cross is hidden there (uncertain in the result and in check())`
        );
    }

    // The renderer's rule (MusicMix.Duck.of): while ducking() is set its dB alone decides the drop. The editor sends the
    // saved duck again on every music change, so only a new value is named; it stays saved for ducking({ enabled: false }).
    if (op.op === "music") {
        const ducking = after.audio.ducking;

        if (!ducking || op.duck === undefined || op.duck === before.audio.music?.duck) {
            return [];
        }

        return [
            `music: duck ${op.duck} does nothing while ducking() is set; the music drops ${ducking.db} dB under speech. Change it with ducking({ db }), or ducking({ enabled: false }) to go back to the duck share`,
        ];
    }

    // R7 6
    if (op.op === "unhide" && op.all && !(before.redactions ?? []).some((part) => part.hide)) {
        return ["unhide: nothing hidden (no part was made by hideText or hidePrivate)"];
    }

    if (op.op === "retime") {
        const zoom = before.zooms.find((item) => item.id === op.id);
        const moved = after.zooms.find((item) => item.id === op.id);

        if (!zoom || !moved || (op.at === undefined && op.by === undefined)) {
            return [];
        }

        const asked = retimeMovedSpan({ op, item: zoom, durationUs: before.source.durationUs });

        if (Math.abs(moved.startUs - asked.startUs) < 1000) {
            return [];
        }

        return [
            `retime: ${op.id} met another zoom at ${seconds(asked.startUs)} s, so it went to ${seconds(moved.startUs)}-${seconds(moved.endUs)} s (two zooms of one target cannot overlap)`,
        ];
    }

    if (op.op !== "zoom") {
        return [];
    }

    const had = new Set(before.zooms.map((zoom) => zoom.id));
    const added = after.zooms.find((zoom) => !had.has(zoom.id));

    if (!added || Math.abs(added.startUs - timeToUs(op.from)) < 1000) {
        return [];
    }

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

/** Where a `retime` with `at` or `by` asks an item to go: its length kept, held inside the recording. */
function retimeMovedSpan({
    op,
    item,
    durationUs,
}: {
    op: Extract<EditOp, { op: "retime" }>;
    item: { startUs: number; endUs: number };
    durationUs: number;
}): { startUs: number; endUs: number } {
    const length = item.endUs - item.startUs;
    const start = op.at !== undefined ? timeToUs(op.at) : item.startUs + Math.round((op.by ?? 0) * 1e6);
    const moved = Math.min(Math.max(0, start), Math.max(0, durationUs - length));
    return { startUs: moved, endUs: moved + length };
}

/** Applies one op; throws a RangeError a caller can show as it is. */
/**
 * Moves or trims the zoom, hidden part, text or shape with this id: `at` (a new start) or `by` seconds moves it with
 * its length kept; `from` and `to` set its start and end, so `from` alone makes it longer or shorter (source time).
 * Held inside the recording. A zoom may not meet another zoom of its target (a canvas zoom may overlap a picture
 * zoom): moved with `at` or `by` onto one, it goes past it with its length kept, as a new zoom asked there would, and
 * is refused when no room is left after it; stretched or dragged with `from` and `to` into one, it stops at it.
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
            return retimeMovedSpan({ op, item: { startUs, endUs }, durationUs });
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
        const others = zoomsOfTarget(project, zoom.target ?? "picture", zoom.id);
        const asked = wanted(zoom.startUs, zoom.endUs);
        let span: { startUs: number; endUs: number };

        if (keepsLength) {
            span = pastZooms(others, asked);

            if (span.endUs > durationUs) {
                const seconds = (us: number) => Math.round(us / 1000) / 1000;
                throw new RangeError(
                    `no room for the ${seconds(asked.endUs - asked.startUs)} s zoom ${op.id} at ${seconds(asked.startUs)} s or later; two zooms of one target cannot overlap`
                );
            }
        } else {
            // The editor window's rule: a zoom dragged or stretched into a neighbour stops at it, 0.2 s long at least.
            const lower = Math.max(
                0,
                ...others.filter((other) => other.endUs <= zoom.startUs).map((other) => other.endUs)
            );
            const upper = Math.min(
                durationUs,
                ...others.filter((other) => other.startUs >= zoom.endUs).map((other) => other.startUs)
            );
            const startUs = Math.max(lower, Math.min(asked.startUs, upper - MINIMUM_ZOOM_US));
            span = { startUs, endUs: Math.min(upper, Math.max(asked.endUs, startUs + MINIMUM_ZOOM_US)) };
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

/**
 * Refuses an audio track the movie does not have: a muted or cleaned track past the end changes nothing in the export.
 * An unknown count (no movie file, a probe that failed) refuses nothing.
 */
function requireAudioTracks(audioTracks: number | undefined, tracks: readonly number[]): void {
    if (audioTracks === undefined) {
        return;
    }

    const missing = [...new Set(tracks.filter((track) => track >= audioTracks))].sort((a, b) => a - b);

    if (missing.length === 0) {
        return;
    }

    const has =
        audioTracks === 0
            ? "has no audio track"
            : `has ${audioTracks} audio track${audioTracks === 1 ? "" : "s"} (${[...Array(audioTracks).keys()].join(", ")})`;
    const which =
        missing.length === 1
            ? `track ${missing[0]} is not one of them`
            : `tracks ${missing.join(", ")} are not among them`;
    const frames = audioTracks === 1 ? ". A frames recording mixes the mic and the system sound into track 0" : "";
    throw new RangeError(`this movie ${has}; ${which}${frames}`);
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
                easeInMs: op.easeInMs,
                easeOutMs: op.easeOutMs,
                target: op.target,
            }).project;
        case "unzoom":
            return removeZoom(project, op.id);
        case "redact": {
            // The renderers place a part with keys by its keys alone, so a follow beside them would be ignored.
            if (op.follow && op.track) {
                throw new Error(
                    "a hidden part with a track follows its text, so it cannot follow the cursor too: give it follow or track, not both"
                );
            }

            // An option of another style was dropped without a word; it is refused, naming the style it needs. The
            // check lives here and not in a schema refinement, which would change the protocol's JSON Schema.
            const style = op.style ?? "blur";
            const misplaced = REDACT_STYLE_OPTIONS.filter(
                ([field, needs]) => op[field] !== undefined && style !== needs
            );

            if (misplaced.length > 0) {
                throw new Error(
                    misplaced
                        .map(
                            ([field, needs]) =>
                                `${field} is for style "${needs}" only, and this part's style is "${style}": give style "${needs}" or leave ${field} out`
                        )
                        .join("; ")
                );
            }

            const added = addRedaction(project, {
                fromUs: timeToUs(op.from),
                toUs: timeToUs(op.to),
                rect: op.rect,
                style,
                label: op.label,
                follow: op.follow,
                dim: op.dim,
                cutout: op.cutout,
                cell: op.cell,
            });
            const part = added.redactions?.at(-1);

            // R8 4: a part with keys follows them, as a hide's part does.
            if (!op.track || !part) {
                return added;
            }

            const keys = op.track
                .map(({ at, ...box }) => ({ atUs: timeToUs(at), ...box }))
                .sort((a, b) => a.atUs - b.atUs);
            // The op holds the first place before the first key and the last after the last one. Both renderers keep
            // the speed of the two edge keys beyond them (a hide's keys want that), so the holds are written as keys
            // at the part's own edges; without them a box over a scroll that came to rest slid off its text.
            const first = keys[0];
            const last = keys[keys.length - 1];
            const track = [
                ...(first.atUs > part.startUs ? [{ ...first, atUs: part.startUs }] : []),
                ...keys,
                ...(last.atUs < part.endUs ? [{ ...last, atUs: part.endUs }] : []),
            ];
            return { ...added, redactions: [...(added.redactions ?? []).slice(0, -1), { ...part, track }] };
        }
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
                dimAround: op.dimAround,
            });
        case "unredact": {
            const list = project.redactions ?? [];

            if (!list.some((redaction) => redaction.id === op.id)) {
                throw new Error(
                    `no redaction ${op.id}; redactions: ${list.map((redaction) => redaction.id).join(", ") || "none"}`
                );
            }

            // Like `untext` and `unshape` (and the editor window): the last one gone removes the key. R6 6: a part a
            // hide made is forgotten as hidden too, so hiding the same text again works.
            return withoutParts(project, new Set([op.id]));
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
                              cursorPointAt(readCursorTrack(project.source.cursor), fromUs / 1000) ?? {
                                  x: 0.5,
                                  y: 0.5,
                              },
                          project.source
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
            // The editor window's rule: without a scale the zooms take the first picture zoom's, else 1.6.
            return autoZoom(
                project,
                readCursorTrack(project.source.cursor),
                op.scale ?? project.zooms.find((zoom) => (zoom.target ?? "picture") === "picture")?.scale
            );
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
            // Unmuting any track stays allowed, so a stale entry can be cleared.
            if (op.muted !== false) {
                requireAudioTracks(facts.audioTracks, [op.track]);
            }

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

            // Taking a track out stays allowed, so a stale entry can be cleared.
            requireAudioTracks(facts.audioTracks, [
                ...(op.tracks ?? []),
                ...Object.keys(op.trackReductionDb ?? {}).map(Number),
                ...(op.track === undefined || op.on === false ? [] : [op.track]),
            ]);

            if (op.track !== undefined) {
                return denoiseTrack(project, op, { audioTracks: facts.audioTracks });
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
                    // Stored absolute: "~/" is the home folder, a relative path is against this process's cwd (the CLI
                    // resolves it against the caller's first, movie-client PATH_PARAMS); "" goes back to the default.
                    output: op.output
                        ? resolve(op.output.replace(/^~(?=[/\\]|$)/, homedir()))
                        : (op.output ?? project.export.output),
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
                    ? {
                          aspect: preset.aspect,
                          fit: preset.fit,
                          padding: preset.padding,
                          cornerRadius: preset.cornerRadius,
                      }
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
                    ...(placed && (placed.align !== "center" || placed.scale !== 1 || placed.focus)
                        ? { layout: placed }
                        : {}),
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
        // R6 6 unhide
        case "unhide":
            return unhide(project, op);
    }
}

// R6 6 unhide
/**
 * The edit without `removed` hidden parts, with every hit no part hides any more dropped from `privacy.applied`, so
 * the next hideText or hidePrivate hides it again instead of answering "nothing changed".
 */
function withoutParts(project: EditProject, removed: ReadonlySet<string>): EditProject {
    const redactions = (project.redactions ?? []).filter((part) => !removed.has(part.id));
    const kept = new Set(redactions.flatMap((part) => (part.hide ? [part.hide.hit] : [])));
    const gone = new Set(
        (project.redactions ?? []).flatMap((part) => (removed.has(part.id) && part.hide ? [part.hide.hit] : []))
    );
    const applied = (project.privacy?.applied ?? []).filter((hit) => kept.has(hit) || !gone.has(hit));
    const { redactions: _redactions, privacy: _privacy, ...rest } = project;
    return {
        ...rest,
        ...(redactions.length > 0 ? { redactions } : {}),
        ...(project.privacy ? { privacy: privacySchema.parse({ ...project.privacy, applied }) } : {}),
    };
}

function unhide(project: EditProject, op: Extract<EditOp, { op: "unhide" }>): EditProject {
    if (!op.text && !op.pattern && !op.ids && !op.all) {
        throw new Error("unhide needs text, pattern, ids (hidden part ids or hit ids) or all: true");
    }

    const fold = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const made = (project.redactions ?? []).filter((part) => part.hide);

    // R7 6: taking back everything when nothing is hidden is done already (the answer says "nothing hidden").
    if (op.all && made.length === 0) {
        return project;
    }
    const picked = made.filter((part) => {
        const request = part.hide?.request;

        if (op.all) {
            return true;
        }

        if (op.ids && (op.ids.includes(part.id) || (part.hide && op.ids.includes(part.hide.hit)))) {
            return true;
        }

        if (op.text) {
            const texts = [request?.text, ...(request?.texts ?? [])].filter((text): text is string => Boolean(text));
            return texts.some((text) => fold(text) === fold(op.text ?? ""));
        }

        if (op.pattern) {
            return [request?.pattern, ...(request?.patterns ?? [])].includes(op.pattern);
        }

        return false;
    });

    if (picked.length === 0) {
        const asked = op.ids ? `ids ${op.ids.join(", ")}` : op.text ? `"${op.text}"` : `/${op.pattern}/`;
        const requests = [
            ...new Set(
                made.map((part) => {
                    const request = part.hide?.request;
                    const said = [
                        request?.text,
                        ...(request?.texts ?? []),
                        request?.pattern,
                        ...(request?.patterns ?? []),
                    ]
                        .filter(Boolean)
                        .join(", ");
                    return `${part.hide?.by}${said ? ` ${said}` : ""}`;
                })
            ),
        ];
        throw new Error(
            `no hidden part was made for ${asked}; ${requests.length ? `hidden by: ${requests.join("; ")}` : "no part was made by hideText or hidePrivate"}`
        );
    }

    return withoutParts(project, new Set(picked.map((part) => part.id)));
}

/** What an agent reads back after an edit: seconds, not microseconds. */
export function describeProject(project: EditProject, path: string) {
    const seconds = (us: number) => Math.round(us / 1000) / 1000;
    const duck = musicDucking(project);
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
                      // R4 8 music ducking: the dB object decides the amount and what it ducks under (check()'s rule).
                      ducks:
                          duck.drops &&
                          ((duck.underTranscript && existsSync(transcriptCachePath(project.source.video))) ||
                              duck.underVoiceovers),
                  },
              }
            : project.audio,
        // R4 voiceover clips: where each plays in the edit (null when its start is cut).
        voiceovers: (project.audio.voiceovers ?? []).map((clip) => {
            // A card's line has no movie time: `at` counts from its card, and it plays only in the export.
            const plays = clip.card === undefined ? outputTimeOf(project, clip.atUs) : undefined;
            const exported = voiceoverExportSpans(project).find((span) => span.id === clip.id);
            return {
                id: clip.id,
                at: seconds(clip.atUs),
                ...(clip.card ? { card: clip.card } : {}),
                seconds: seconds(clip.durationUs),
                plays: plays === undefined ? null : seconds(plays),
                // R5 7: where it plays in the exported file, after the intro card.
                exportPlays: exported === undefined ? null : seconds(exported.startUs),
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
                ? {
                      dim: redaction.dim ?? 0.5,
                      cutout: redaction.cutout ?? "rounded",
                      ...(redaction.dimAround ? { dimAround: redaction.dimAround } : {}),
                  }
                : {}),
            // fx B (round 4): how many keyframes it follows, and the areas it leaves visible.
            ...(redaction.track ? { keyframes: redaction.track.length } : {}),
            ...(redaction.exclude ? { exclude: redaction.exclude } : {}),
            // R5 5 redaction edges
            ...(redaction.style === "spotlight" ? { fadeMs: redaction.fadeMs ?? 200 } : {}),
            ...(redaction.cell !== undefined ? { cell: redaction.cell } : {}),
            // R6 7: a hidden part or a spotlight, and the hide request that made it (hideText, hidePrivate).
            kind: redaction.style === "spotlight" ? ("spotlight" as const) : ("hidden" as const),
            ...(redaction.hide ? { hide: redaction.hide } : {}),
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
    return hideHits(project, picked, {
        style: op.style,
        exclude: op.exclude,
        by: "hidePrivate",
        request: requestOf({ kinds: op.kinds, names: op.names }),
    });
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
            `the screen does not show ${describeTextQuery(op)}${op.from === undefined && op.to === undefined ? "" : " in that range"}; nothing was hidden`
        );
    }

    return hideHits(project, picked, {
        style: op.style,
        exclude: op.exclude,
        label: op.label,
        by: "hideText",
        request: requestOf({
            text: op.text,
            pattern: op.pattern,
            texts: op.texts,
            patterns: op.patterns,
            unit: op.unit,
        }),
    });
}

/** A hide request as a part keeps it (R6 7): only the keys the op was given. */
function requestOf(request: NonNullable<NonNullable<EditRedaction["hide"]>["request"]>) {
    const kept = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
    return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * One hidden part per hit for as long as it shows: a hit that moved keeps its keyframes (`track`), so the part follows
 * the text; the areas to leave visible are the op's and the hit's own. A hit hidden before is skipped.
 */
function hideHits(
    project: EditProject,
    hits: readonly PrivateHit[],
    options: {
        style?: EditRedaction["style"];
        exclude?: ReadonlyArray<z.infer<typeof boxSchema>>;
        label?: string;
        by: NonNullable<EditRedaction["hide"]>["by"];
        request?: NonNullable<EditRedaction["hide"]>["request"];
    }
): EditProject {
    const applied = new Set(project.privacy?.applied ?? []);
    const picked = hits.filter((hit) => !applied.has(hit.id));
    let next = project;
    const seconds = (us: number) => Math.round(us / 10_000) / 100;
    /** Adds one part and sets what addRedaction does not take (its keys, the areas left visible, where it came from). */
    const add = (
        part: { fromUs: number; toUs: number; rect: z.infer<typeof boxSchema>; label: string },
        extra: Partial<EditRedaction>
    ) => {
        const fromUs = Math.max(0, Math.min(part.fromUs, project.source.durationUs - MINIMUM_CLIP_US));
        const toUs = Math.min(project.source.durationUs, Math.max(part.toUs, fromUs + MINIMUM_CLIP_US));
        next = addRedaction(next, {
            fromUs,
            toUs,
            rect: part.rect,
            style: options.style ?? "blur",
            label: part.label,
        });
        const added = next.redactions?.at(-1);

        if (added) {
            next = { ...next, redactions: [...(next.redactions ?? []).slice(0, -1), { ...added, ...extra }] };
        }
    };

    for (const hit of picked) {
        const first = hit.keys[0] ?? hit.box;
        const exclude = [...(options.exclude ?? []), ...(hit.exclude ?? [])];
        const label = options.label ?? `${hit.label} (auto)`;
        const moving = hit.follow && hit.follow.movingUs > 0 ? hit.follow : undefined;
        add(
            {
                fromUs: hit.fromUs,
                toUs: hit.toUs,
                rect: { x: first.x, y: first.y, width: first.width, height: first.height },
                label,
            },
            {
                ...(hit.keys.length > 1
                    ? { track: hit.keys.map((key) => ({ ...key, atUs: Math.round(key.atUs) })) }
                    : {}),
                ...(exclude.length > 0 ? { exclude } : {}),
                hide: {
                    by: options.by,
                    hit: hit.id,
                    ...(options.request ? { request: options.request } : {}),
                    ...(moving
                        ? {
                              movingSeconds: seconds(moving.movingUs),
                              keysPerSecond:
                                  Math.round((moving.keysInMotion / (moving.movingUs / 1_000_000)) * 10) / 10,
                          }
                        : {}),
                },
            }
        );

        // R6 1: where the moving text could not be followed, the band it may cross is hidden as well.
        for (const stretch of hit.uncertain ?? []) {
            add(
                { fromUs: stretch.fromUs, toUs: stretch.toUs, rect: stretch.box, label: `${label} (uncertain)` },
                {
                    hide: {
                        by: options.by,
                        hit: hit.id,
                        uncertain: true,
                        ...(options.request ? { request: options.request } : {}),
                    },
                }
            );
        }

        applied.add(hit.id);
    }

    return picked.length === 0 ? project : { ...next, privacy: privacySchema.parse({ applied: [...applied] }) };
}

/** What a hideText or hidePrivate added to the edit: its parts, how well they follow moving text, and where not. */
export interface Hiding {
    /** Hidden parts added (bands included). */
    parts: number;
    /** Parts that follow a moving text, with the seconds it moved and the fewest places a second any of them has. */
    moving: { parts: number; seconds: number; minKeysPerSecond: number | null };
    /** Source seconds where a moving text could not be followed: the band it may cross is hidden instead. */
    uncertain: Array<{ from: number; to: number }>;
}

/** The hidden parts in `after` and not in `before` that a hide op made, summed up (R6 1). */
export function hidingOf(before: EditProject, after: EditProject): Hiding {
    const had = new Set((before.redactions ?? []).map((part) => part.id));
    const added = (after.redactions ?? []).filter((part) => !had.has(part.id) && part.hide);
    const seconds = (us: number) => Math.round(us / 10_000) / 100;
    const moving = added.filter((part) => !part.hide?.uncertain && (part.hide?.movingSeconds ?? 0) > 0);
    const rates = moving.map((part) => part.hide?.keysPerSecond ?? 0);
    return {
        parts: added.length,
        moving: {
            parts: moving.length,
            seconds: Math.round(moving.reduce((all, part) => all + (part.hide?.movingSeconds ?? 0), 0) * 100) / 100,
            minKeysPerSecond: rates.length > 0 ? Math.min(...rates) : null,
        },
        uncertain: added
            .filter((part) => part.hide?.uncertain)
            .map((part) => ({ from: seconds(part.startUs), to: seconds(part.endUs) }))
            .sort((a, b) => a.from - b.from),
    };
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
    /** Output seconds of the line's first kept moment in the current edit; null when no part of it plays. */
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
            const from = round(segment.start);
            const to = round(segment.end);
            const first = transcriptLineSpans(project, { from, to })[0];
            return {
                from,
                to,
                plays: first === undefined ? null : round(first.fromUs / 1_000_000),
                text: segment.text.trim(),
            };
        });
}

const captionSegmentSchema = z.object({ text: z.string(), start: z.number(), end: z.number() });

/**
 * The transcript cache's lines as the burned-in captions read them (CaptionTrack.load in Captions.swift): each segment
 * with words and an end after its start, in source microseconds, by start. A malformed segment is left out alone.
 */
function captionTrackLines(raw: unknown): Array<{ fromUs: number; toUs: number; text: string }> {
    const parsed = z.object({ segments: z.array(z.unknown()) }).safeParse(raw);

    if (!parsed.success) {
        return [];
    }

    return parsed.data.segments
        .flatMap((value) => {
            const segment = captionSegmentSchema.safeParse(value);
            const text = segment.success ? segment.data.text.trim() : "";

            if (!segment.success || !text || !(segment.data.end > segment.data.start)) {
                return [];
            }

            return [
                {
                    fromUs: Math.trunc(segment.data.start * 1_000_000),
                    toUs: Math.trunc(segment.data.end * 1_000_000),
                    text,
                },
            ];
        })
        .sort((a, b) => a.fromUs - b.fromUs);
}

/**
 * The transcript line said at a source time, read as the captions read it (CaptionTrack.line(atSourceUs:) and
 * EditRenderer.look): the last line that has started, kept only while it has not ended, then its fix from
 * `transcript.fixes`. A fix with no words hides it, and an earlier line that overlaps it does not show through. Null
 * where nothing is said. It does not look at `captions`: captionAt() does.
 */
export function spokenLineAt(project: EditProject, raw: unknown, sourceUs: number): string | null {
    const started = captionTrackLines(raw)
        .filter((line) => line.fromUs <= sourceUs)
        .at(-1);

    if (!started || started.toUs <= sourceUs) {
        return null;
    }

    const fix = project.transcript?.fixes[String(Math.round(started.fromUs / 1000))];

    if (fix === undefined) {
        return started.text;
    }

    return fix === "" ? null : fix;
}

/** The caption line the export draws at a source time: the spoken line while captions show (absent is off), else null. */
export function captionAt(project: EditProject, raw: unknown, sourceUs: number): string | null {
    return project.captions?.show ? spokenLineAt(project, raw, sourceUs) : null;
}

/**
 * Where a transcript line shows in the output, as the burned-in captions show it (Captions.swift
 * CaptionTrack.line(atSourceUs:)): at every kept moment of its source range, pieces that touch in the output joined.
 * A start that only touches the end of the clip before a cut is no kept moment, so it gives no piece there.
 */
export function transcriptLineSpans(
    project: EditProject,
    line: Pick<TranscriptLine, "from" | "to">
): Array<{ fromUs: number; toUs: number }> {
    const spans = outputSpansOf(project, Math.round(line.from * 1_000_000), Math.round(line.to * 1_000_000));
    const joined: Array<{ fromUs: number; toUs: number }> = [];

    for (const span of spans) {
        const last = joined.at(-1);

        if (last && span.fromUs === last.toUs) {
            last.toUs = span.toUs;
        } else {
            joined.push({ ...span });
        }
    }

    return joined;
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
