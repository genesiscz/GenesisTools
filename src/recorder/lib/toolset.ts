import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { execTool, spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { checkProject, type EditFacts, fixOps } from "@genesiscz/utils/recording-editor/check";
import { findIdle } from "@genesiscz/utils/recording-editor/idle";
import { EFFECT_KINDS } from "@genesiscz/utils/recording-editor/lanes";
import { type TimeValue, timeSchema, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    BACKGROUND_KINDS,
    CANVAS_ASPECTS,
    cameraOpSchema,
    describeProject,
    type EditOp,
    type EditProject,
    editOpSchema,
    findInTranscript,
    hexColor,
    outputDurationUs,
    outputTimeOf,
    RANGE_ACTIONS,
    REDACTION_STYLES,
    replaceWordsInLines,
    SHAPE_APPEARS,
    SHAPE_KINDS,
    SPOTLIGHT_CUTOUTS,
    shortcutsOf,
    sourceTimeOf,
    TEXT_STYLES,
    type TranscriptLine,
    transcriptCachePath,
    transcriptLines,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { SUBTITLE_FORMATS, type SubtitleFormat } from "@genesiscz/utils/recording-editor/subtitles";
import { type CutMatch, FILLER_LEVELS, type FillerLevel } from "@genesiscz/utils/recording-editor/transcript-cuts";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";
import {
    RECORDER_SET_SETTINGS_DOC,
    RECORDER_SETTINGS_DOC,
    recorderSetSchema,
    settingsPatchOf,
} from "@genesiscz/utils/repl/toolsets/recorder";
import { readRecordingManifest, renameRecording } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, type LiveEntry, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { z } from "zod";
import { type DemoDriver, type DemoStep, demoEditSchema, runDemo } from "./demo";
import {
    collapseUndo,
    defaultExportName,
    EXPORT_FORMATS,
    type ExportFormat,
    editProject,
    exportAs,
    openProject,
    previewTranscriptCuts,
    undoDepth,
    undoEdit,
    writeSubtitles,
} from "./edit";
import { switchDisplay } from "./frames-movie";
import {
    EDITOR_TABS,
    type EditorTab,
    ensureRecorderPart,
    listLibrary,
    openEditor,
    sheetOfEdit,
    stillOfEdit,
} from "./library";
import { chaptersOf, markersOf, recordingFolderOf, searchLibrary, spreadTimes } from "./moments";
import { copyRecording, revealRecording, trashRecording } from "./quick-actions";
import { commentOn, commentsOf, resolveComment, uncomment } from "./review";
import { findOnScreen, type ScreenHit } from "./screen-search";

const { log } = logger.scoped("recorder-toolset");

/**
 * How long record() waits for the recording to run. A fresh checkout compiles ax-tool first (30 to 60 s, measured
 * 2026-11-05 in a new worktree), as GenesisKit's picker allows for with its own 120 s; a 20 s wait gave up while the
 * child went on and then recorded with no one to stop it.
 */
const START_TIMEOUT_MS = 120_000;
const FINISH_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const range = { from: timeSchema, to: timeSchema };
const focusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const zoomSchema = z
    .object({
        ...range,
        scale: z.number().min(1).max(4).optional(),
        focus: focusSchema.optional(),
        follow: z.boolean().optional(),
        lane: z.string().optional(),
    })
    .strict();
const recordSchema = z
    .object({
        audio: z.array(z.enum(["system", "mic"])).optional(),
        title: z.string().optional(),
        maxSeconds: z
            .number()
            .min(1)
            .max(4 * 60 * 60)
            .optional(),
        display: z.number().int().min(0).optional(),
        app: z.string().optional(),
        window: z.array(z.number().int()).optional(),
        fps: z.number().min(1).max(120).optional(),
        controls: z.boolean().optional(),
        /** The red border around what is recorded (never in the movie). */
        indicator: z.boolean().optional(),
        /** Records the camera beside the screen (camera.mov); the recorder face records it, the edit draws the bubble. */
        camera: z.boolean().optional(),
    })
    .strict();

const demoParamsSchema = z
    .object({
        title: z.string().optional(),
        record: recordSchema.optional(),
        steps: z
            .array(
                z.object({
                    caption: z.string().trim().min(1).max(200),
                    run: z
                        .custom<() => unknown>((value) => typeof value === "function", "run must be a function")
                        .optional(),
                    holdSeconds: z.number().min(0).max(60).optional(),
                })
            )
            .min(1),
        edit: demoEditSchema.partial().optional(),
        settleSeconds: z.number().min(0).max(30).optional(),
        holdSeconds: z.number().min(0).max(60).optional(),
        export: z.boolean().optional(),
    })
    .strict();

const movieDoc =
    "{ path, revision, updatedBy, video, sourceSeconds, outputSeconds, clips, zooms, redactions, audio, export, clicks, frame, cursor, camera, captions, keys, transcriptFixes, motion, shapes, texts, lanes, warnings? }";

/** What every edit method returns, short: the full field list once, on info(), keeps describe()'s lines readable. */
const editResult = "Edit (the fields info() lists, plus warnings?)";

/** A transcript cut as an agent reads it: source seconds, not microseconds. */
function cutsOut(cuts: ReadonlyArray<CutMatch & { plays: number | null }>) {
    return cuts.map((cut) => ({
        from: cut.fromUs / 1_000_000,
        to: cut.toUs / 1_000_000,
        text: cut.text,
        line: cut.line,
        estimated: cut.estimated,
        plays: cut.plays,
    }));
}

const edit = (name: string, params: z.ZodType, doc: string, positional?: string[]) =>
    defineMethod({ name, params, positional, result: z.unknown(), resultName: editResult, doc, effect: "reversible" });

const movieMethods = [
    defineMethod({
        name: "info",
        params: z.object({}),
        result: z.unknown(),
        resultName: movieDoc.replace(" }", ", title, folder }"),
        doc: "The edit as it is on disk now (the window may have changed it), with the recording's title and folder (null for a plain movie).",
        effect: "read",
    }),
    defineMethod({
        name: "check",
        params: z.object({}),
        result: z.unknown(),
        resultName:
            '{ ok, clean, issues: { severity: "fix" | "check", item, message, fix?, at?, target?, action?: { label, ops } }[] }',
        doc: 'What to look at before export(): items whose whole time is cut (they never show), a missing music file, captions, subtitles or ducking without a transcript, a part that follows a cursor the movie lacks, items too short to read, texts drawn over each other. "fix" issues come first, each with a call that fixes it when one does (`fix`, and the same as edit ops in `action.ops` for apply()); ok is true when there is no "fix" issue (the export works), clean when there is no issue at all. It changes nothing.',
        effect: "read",
    }),
    defineMethod({
        name: "fix",
        params: z.object({}),
        result: z.unknown(),
        resultName: "Edit (the fields info() lists) plus fixed: the messages of the issues it fixed",
        doc: "Runs every fix check() offers (each issue's action.ops: remove what never shows, lengthen what is too short to read, move a text off another) in one save and one undo() step. Issues with no fix (a missing transcript or music file) stay; check() again lists them.",
        effect: "reversible",
    }),
    edit("split", z.object({ at: timeSchema }), "Splits the clip at a source time.", ["at"]),
    edit("cut", z.object(range), "Removes a source range from the movie.", ["from", "to"]),
    edit("keep", z.object(range), "Keeps only a source range (trims both ends).", ["from", "to"]),
    edit(
        "speed",
        z.object({ ...range, factor: z.number().min(0.25).max(16) }),
        "Plays a source range faster (2) or slower (0.5).",
        ["from", "to", "factor"]
    ),
    edit(
        "zoom",
        zoomSchema,
        "Zooms over a source range: scale 1–4, focus {x,y} 0..1 from the top left, or follow: true for the cursor."
    ),
    edit("unzoom", z.object({ id: z.string() }), "Removes a zoom by its id.", ["id"]),
    edit(
        "redact",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                rect: z
                    .object({
                        x: z.number().min(0).max(1),
                        y: z.number().min(0).max(1),
                        width: z.number().min(0.005).max(1),
                        height: z.number().min(0.005).max(1),
                    })
                    .strict(),
                style: z.enum(REDACTION_STYLES).optional(),
                label: z.string().max(60).optional(),
                follow: z.boolean().optional(),
                lane: z.string().optional(),
            })
            .strict(),
        'Hides a rectangle of the SOURCE picture from `from` to `to` (source seconds or "m:ss"): rect { x, y, width, height } as 0...1 of the picture from its top left, style "blur" (default) | "pixelate" | "black" | "spotlight" (the rectangle stays sharp and the rest of the picture dims, to point at something), label (what it hides, "API token"), follow: true (it moves with the drawn cursor, centred on it; rect gives its size). It moves with a zoom. The result lists redactions with their ids.'
    ),
    edit("unredact", z.object({ id: z.string() }), "Removes a redaction by its id.", ["id"]),
    edit(
        "text",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                text: z.string().trim().min(1).max(200),
                x: z.number().min(0).max(1).optional(),
                y: z.number().min(0).max(1).optional(),
                size: z.number().min(0.02).max(0.15).optional(),
                style: z.enum(TEXT_STYLES).optional(),
                lane: z.string().optional(),
            })
            .strict(),
        'Puts a line of text over the picture from `from` to `to` (source seconds or "m:ss"): a title or a step\'s name. x, y is its centre as 0...1 of the CANVAS from the top left (0.5, 0.12, top middle, by default), so it stays put through a zoom; size is the text height as a fraction of the short side (0.055); style "plate" (white on a dark plate, default) | "plain" (white with a shadow). It fades in and out. The result lists texts with their ids.'
    ),
    edit("untext", z.object({ id: z.string() }), "Removes a text by its id.", ["id"]),
    edit(
        "retime",
        z
            .object({
                id: z.string(),
                at: timeSchema.optional(),
                by: z.number().optional(),
                from: timeSchema.optional(),
                to: timeSchema.optional(),
            })
            .strict(),
        'Moves or trims a zoom, hidden part, text or shape by its id (info() lists them). To MOVE it with its length kept: `at` (its new start) or `by` (seconds, negative is earlier). To TRIM it: `from` and/or `to` set a new start or end, so `from` alone makes it longer or shorter. Source seconds or "m:ss". retime({ id: "z1", at: 1 }), retime({ id: "t1", by: 2 }), retime({ id: "s1", to: 9 }).'
    ),
    edit(
        "fixLine",
        z.object({ from: timeSchema, text: z.string().max(300) }).strict(),
        'Corrects the transcript line spoken at `from` (any source time inside it, e.g. a line\'s from from transcript() or find()): text is the right words ("" hides the line). Kept in the edit, so captions, transcript(), find() and movies.search() read the fixed words, and a new transcription keeps them.',
        ["from", "text"]
    ),
    edit(
        "replaceWords",
        z
            .object({
                find: z.string().min(1).max(100),
                replace: z.string().max(100),
                matchCase: z.boolean().optional(),
                wholeWord: z.boolean().optional(),
            })
            .strict(),
        'Replaces a word or phrase in every transcript line (captions, subtitles and the search all use the fixed words), saved once and undone with one undo(): e.g. { find: "genesis tolls", replace: "GenesisTools" }. Case is ignored unless matchCase; whole words only unless wholeWord: false. The result lists replaced: [{ from, was, now }]. Throws, saving nothing, when no line has it.'
    ),
    edit(
        "fixLines",
        z.object({
            fixes: z
                .array(z.object({ at: timeSchema, text: z.string().max(300) }).strict())
                .min(1)
                .max(500),
        }),
        "Corrects many transcript lines at once, saved once and undone with one undo(): [{ at, text }] where at is any source time inside the line (a line's from from transcript()). Use it to polish a whole transcript: read transcript(), then send only the lines whose words change. A time where nobody speaks is refused with the nearest lines, and nothing is saved.",
        ["fixes"]
    ),
    edit(
        "unfixLine",
        z.object({ from: timeSchema }).strict(),
        "Drops the correction of the line that starts at `from`.",
        ["from"]
    ),
    edit(
        "autoZoom",
        z.object({ scale: z.number().min(1).max(4).optional() }).strict(),
        "One zoom per group of recorded clicks, following the cursor; replaces earlier auto zooms, keeps manual ones, and throws when there are no clicks."
    ),
    edit(
        "titleMarkers",
        z
            .object({
                seconds: z.number().min(0.5).max(15).optional(),
                numbered: z.boolean().optional(),
                y: z.number().min(0).max(1).optional(),
            })
            .strict(),
        'Puts each marker\'s label on screen as a step title for `seconds` (2.5), "1. Open the settings" (numbered: false drops the number), at the top middle (y 0...1 of the canvas, 0.12): one text per marker in the kept movie, saved once, one undo(). A marker that has a text already is left alone, so running it again adds nothing. Throws when there is no marker.'
    ),
    edit(
        "annotateClicks",
        z
            .object({
                from: timeSchema.optional(),
                to: timeSchema.optional(),
                kind: z.enum(SHAPE_KINDS).optional(),
                seconds: z.number().min(0.3).max(10).optional(),
                color: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/)
                    .optional(),
                appear: z.enum(SHAPE_APPEARS).optional(),
            })
            .strict(),
        'Marks every recorded click from `from` to `to` (source seconds; the whole recording by default) with a shape for `seconds` (1.2): kind "circle" (default) round the point, "box", or "arrow" pointing at it. A double click is one mark; a click that already has a mark of that kind is left alone, so running it again adds nothing. One undo takes them all back. Throws when the range has no clicks.'
    ),
    edit("volume", z.object({ volume: z.number().min(0).max(2) }), "Sets the volume, 0 to 2.", ["volume"]),
    edit("mute", z.object({ track: z.number().int().nonnegative() }), "Mutes an audio track (0 is the first).", [
        "track",
    ]),
    edit("unmute", z.object({ track: z.number().int().nonnegative() }), "Unmutes an audio track.", ["track"]),
    edit("apply", z.object({ ops: z.array(editOpSchema).min(1) }), "Several ops at once, saved once.", ["ops"]),
    edit(
        "undo",
        z.object({ all: z.boolean().optional() }).strict(),
        "Puts back the edit as it was before its last change made through the REPL or " +
            toolCommand("recorder apply") +
            ' (kept in <edit>.undo.json, so it works across runs; 30 steps); undo({ all: true }) goes back through every saved step. The result names the ops it took back (undone: ["text"]) and stepsLeft, how many more undo() calls there are. The revision number still rises: an undo is a new save of the older content. Refused when the editor window changed it since: undo that with ⌘Z there.'
    ),
    edit(
        "shape",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                kind: z.enum(SHAPE_KINDS),
                start: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
                end: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
                color: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/)
                    .optional(),
                width: z.number().min(0.002).max(0.03).optional(),
                appear: z.enum(SHAPE_APPEARS).optional(),
                lane: z.string().optional(),
            })
            .strict(),
        'Draws an "arrow", a "box" or a "circle" over the SOURCE picture from `from` to `to` (source seconds), so it moves with a zoom: an arrow from start { x, y } to its head at end (where it points), a box or circle between the two corners; 0...1 of the picture from its top left. color "#RRGGBB" (red #FF3B30), width 0.002 to 0.03 of the short side (0.006). It draws itself on and fades out; appear "fade" fades it in instead and "none" shows it at once. unshape(id) removes it.'
    ),
    edit(
        "arrow",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                at: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
                tail: z
                    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                    .strict()
                    .optional(),
                color: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/)
                    .optional(),
                appear: z.enum(SHAPE_APPEARS).optional(),
            })
            .strict(),
        'An arrow pointing at `at` (0...1 of the source picture, e.g. a button you found in a still) from `from` to `to`; its tail is `tail`, or 12 % of the picture away towards the centre; appear "draw" (default: it draws itself on), "fade" or "none". The same as shape with kind "arrow".'
    ),
    edit("unshape", z.object({ id: z.string() }).strict(), "Removes the arrow, box or circle with this id.", ["id"]),
    edit(
        "music",
        z
            .object({
                file: z.string().optional(),
                volume: z.number().min(0).max(1).optional(),
                duck: z.number().min(0).max(1).optional(),
                fadeMs: z.number().int().min(0).max(10_000).optional(),
                startMs: z.number().int().min(0).optional(),
                loop: z.boolean().optional(),
                enabled: z.boolean().optional(),
            })
            .strict(),
        "Music under the movie: file (an mp3, m4a, wav… path; needed the first time), from startMs into the file (0), looped to the movie's length (loop: false plays it once), volume 0 to 1 (0.25), fading in and out over fadeMs (1500). While a transcript line plays it drops by duck (0.6 = to 40 %), so speech stays clear; without transcript() nothing ducks (audio.music.ducks in the result says which). enabled: false removes it."
    ),
    edit(
        "spotlight",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                rect: z
                    .object({
                        x: z.number().min(0).max(1),
                        y: z.number().min(0).max(1),
                        width: z.number().min(0.005).max(1),
                        height: z.number().min(0.005).max(1),
                    })
                    .strict(),
                label: z.string().max(60).optional(),
                follow: z.boolean().optional(),
                dim: z.number().min(0.2).max(0.95).optional(),
                cutout: z.enum(SPOTLIGHT_CUTOUTS).optional(),
                lane: z.string().optional(),
            })
            .strict(),
        'Points at a part of the picture from `from` to `to` (source seconds or "m:ss"): rect { x, y, width, height } (0...1 of the picture from its top left) stays as it is and everything around it dims; follow: true moves it with the cursor (a light on the pointer); dim 0.2 to 0.95 is how much black covers the rest (0.7; 0.5 leaves it at half), cutout "rounded" (default), "rect" or "circle" its lit shape (a circle is the ellipse inside rect, so give a square rect in pixels for a round one). The same as redact with style "spotlight" (op "spotlight" in apply); unredact(id) removes it.'
    ),
    edit(
        "addLane",
        z
            .object({
                kinds: z.array(z.enum(EFFECT_KINDS)).min(1).optional(),
                name: z.string().max(40).optional(),
                id: z.string().min(1).max(40).optional(),
            })
            .strict(),
        `Adds an effect lane under the others on the editor's timeline: kinds is what it holds (${EFFECT_KINDS.join(", ")}; absent holds every kind), name its label. info().lanes lists the lanes top to bottom with the ids of their items; zoom, redact, spotlight, text and shape take lane: <id> to put the new item there. A speed lane shows the clips played at another speed.`
    ),
    edit(
        "removeLane",
        z.object({ id: z.string() }).strict(),
        "Removes an effect lane; its items move to the next lane that holds their kind.",
        ["id"]
    ),
    edit(
        "moveLane",
        z.object({ id: z.string(), to: z.number().int().min(0) }).strict(),
        "Moves an effect lane to a place in the list (0 is the top); every item stays on its lane.",
        ["id", "to"]
    ),
    edit(
        "moveToLane",
        z.object({ id: z.string(), lane: z.string() }).strict(),
        "Puts a zoom, hidden part, spotlight, text or shape (by its id) on another effect lane that holds its kind.",
        ["id", "lane"]
    ),
    edit(
        "range",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                action: z.enum(RANGE_ACTIONS),
                factor: z.number().min(0.25).max(16).optional(),
                scale: z.number().min(1).max(4).optional(),
                text: z.string().trim().min(1).max(200).optional(),
                lane: z.string().optional(),
            })
            .strict(),
        'Does what the editor\'s range popover does over `from`..`to` in OUTPUT seconds or "m:ss" (what plays, as the ruler shows it, so after cuts and speed changes): action "cut", "speed" (factor, 2), "zoom" (scale), "hide" or "spotlight" (the middle of the picture; redact and spotlight take a rect), or "text" (text, "Title"). lane puts the new item on an effect lane. Export such a part with export({ from, to }).'
    ),
    edit("reset", z.object({}), "Starts over: the whole movie, no zooms, default audio and export."),
    edit(
        "clicks",
        z
            .object({
                highlight: z.boolean().optional(),
                color: hexColor.optional(),
                radius: z.number().min(0.005).max(0.2).optional(),
                durationMs: z.number().int().min(100).max(3000).optional(),
                sound: z.boolean().optional(),
            })
            .strict(),
        'Draws each recorded click as a disc that grows and fades: highlight, color "#RRGGBB", radius (a fraction of the height, 0.03), durationMs (450); sound: true adds a soft tick at each click to the sound (off by default).'
    ),
    edit(
        "keys",
        z
            .object({
                show: z.boolean().optional(),
                size: z.number().min(0.02).max(0.12).optional(),
                position: z.enum(["bottom", "top"]).optional(),
                durationMs: z.number().int().min(300).max(5000).optional(),
            })
            .strict(),
        'Draws the ⌘/⌃ shortcuts the recording kept as they were pressed: show, size (0.05 of the short side), position "bottom" | "top", durationMs (1200). Throws when the recording kept none.'
    ),
    edit(
        "captions",
        z
            .object({
                show: z.boolean().optional(),
                size: z.number().min(0.02).max(0.1).optional(),
                position: z.enum(["bottom", "top"]).optional(),
            })
            .strict(),
        'Draws the spoken lines over the picture from the cached transcript (call transcript() first): show, size (text height, a fraction of the short side, 0.038), position "bottom" | "top". Captions follow every cut.'
    ),
    edit(
        "cursor",
        z
            .object({
                show: z.boolean().optional(),
                size: z.number().min(0.5).max(3).optional(),
                smoothing: z.number().min(0).max(1).optional(),
                hideAfterMs: z.number().int().min(0).max(30_000).optional(),
            })
            .strict(),
        "The cursor the editor draws (a movie recorded without the system cursor; info() shows cursor: null otherwise): show, size (times the recorded size, 1), smoothing (0 raw path, 1 smoothest, 0.5), hideAfterMs (fade out after standing still this long, 0 never). It still sits on every click."
    ),
    edit(
        "motion",
        z.object({ blur: z.number().min(0).max(1).optional() }).strict(),
        "How the picture moves through a zoom: blur 0 (every frame sharp) to 1 smears it along a pan or a change of scale, as a camera shutter would; 0.5 when never set. A still zoom is never blurred."
    ),
    edit(
        "camera",
        cameraOpSchema.omit({ op: true }),
        'The camera bubble (a recording made with the camera on has one from its camera.json; info() shows camera): corner "bottomRight" | "bottomLeft" | "topRight" | "topLeft", or x and y (the centre, 0–1, makes it "custom"); size (its side over the short side, 0.08–0.6, 0.24); shape "circle" | "rounded" | "square"; mirror; show; offsetMs (camera time = source time - offsetMs); file for an edit without one; enabled: false removes it.'
    ),
    edit(
        "cameraHide",
        z.object(range).strict(),
        "Hides the camera bubble from `from` to `to` (SOURCE seconds, so it moves with a cut); hidden parts that touch are joined.",
        ["from", "to"]
    ),
    edit(
        "cameraShow",
        z.object(range).strict(),
        "Shows the camera bubble again from `from` to `to`: hidden parts lose that stretch.",
        ["from", "to"]
    ),
    edit(
        "frame",
        z
            .object({
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
        'Puts the movie on a background: aspect (the canvas: "16:9", "4:3", "1:1", "9:16" or "source"; its short side is the movie height), fit ("contain" the whole movie, or "cover": cropped to fill the room inside the padding, following the cursor; padding 0 for edge to edge), padding (0.06 of the short side), cornerRadius (0.012), shadow, background { kind: "gradient" | "color" | "image" | "none", colors, image (a picture file; kind image), blur (0–1) }; enabled: false removes it.'
    ),
    edit(
        "removeIdle",
        z
            .object({
                minSeconds: z.number().min(0.5).max(600).optional(),
                keepSeconds: z.number().min(0).max(5).optional(),
                speed: z.number().min(2).max(16).optional(),
            })
            .strict(),
        "Cuts every stretch where the picture does not change AND nothing is heard for minSeconds (default 2), keeping keepSeconds (0.3) at each end; a still picture under speech stays. speed (2–16) plays those stretches that much faster instead of cutting them. The result adds removed: [[from, to], …] in source seconds."
    ),
    defineMethod({
        name: "polish",
        params: z
            .object({
                removeIdle: z.boolean().optional(),
                autoZoom: z.boolean().optional(),
                normalize: z.boolean().optional(),
                frame: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ …info(), steps: { step, done, note }[] }",
        doc: "The usual clean-up in one call: removeIdle, autoZoom on the clicks, normalize to -16 LUFS and a gradient frame (pass false to skip one). A step that cannot run (no clicks, no audio) is reported in steps and the rest still run; one undo() puts it all back.",
        effect: "reversible",
    }),
    defineMethod({
        name: "cutWords",
        params: z
            .object({
                at: timeSchema,
                words: z.string().min(1),
                padMs: z.number().int().min(0).max(500).optional(),
                dryRun: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ …info() } | { from, to, text, line, estimated, plays }[] (dryRun)",
        doc: "Cuts words out of the transcript line spoken at `at` (any source time inside it, a line's from from transcript() or find()): words \"you know\" cuts every place the line says them. A word's time comes from the provider's word times, else it is estimated from where its letters sit in the line (estimated: true; check with still() or sheet()). dryRun: true lists the cuts and saves nothing. One undo() puts it back.",
        effect: "reversible",
    }),
    defineMethod({
        name: "cutFillers",
        params: z
            .object({
                language: z.string().min(2).max(8).optional(),
                level: z.enum(FILLER_LEVELS).optional(),
                words: z.array(z.string().min(1)).optional(),
                padMs: z.number().int().min(0).max(500).optional(),
                dryRun: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ …info() } | { from, to, text, line, estimated, plays }[] (dryRun)",
        doc: 'Cuts every filler of the transcript in one step: language "cs", "sk" or "en" (absent: all of them), level "sounds" (default: ehm, hm, um, uh, éé) or "all" (also the fillers that are real words: jako, jakože, like, so check with dryRun first), or your own words. A run of fillers is one cut, padMs (40) off its edges. dryRun: true lists what it would cut. One undo() puts it all back.',
        effect: "reversible",
    }),
    edit(
        "denoise",
        z
            .object({
                enabled: z.boolean().optional(),
                reductionDb: z.number().min(1).max(40).optional(),
                tracks: z.array(z.number().int().nonnegative()).optional(),
                trackReductionDb: z.record(z.string().regex(/^\d+$/), z.number().min(1).max(40)).optional(),
            })
            .strict(),
        "Turns the room and fan noise of the sound down on export (ffmpeg afftdn): reductionDb 12 by default (8 is gentle, 20+ starts to blur words), on every audio track or only tracks (0 is the first; a screen recording's microphone is its last); trackReductionDb { 1: 20 } gives a track (here the second) its own strength (merged with earlier ones). The export renders from a cleaned copy of the movie, made once per setting under .denoise/ beside it. enabled: false takes it away."
    ),
    edit(
        "normalize",
        z.object({ targetLufs: z.number().min(-30).max(-8).optional() }).strict(),
        "Measures the movie's loudness (EBU R128, the unmuted tracks mixed) and sets the volume so the export reaches targetLufs (default -16, speech on the web; -14 music). The volume tops out at 200 % (+6 dB). The result adds loudness: { measuredLufs, volume }."
    ),
    defineMethod({
        name: "export",
        params: z
            .object({
                out: z.string().optional(),
                format: z.enum(EXPORT_FORMATS).optional(),
                from: timeSchema.optional(),
                to: timeSchema.optional(),
                subtitles: z.enum(SUBTITLE_FORMATS).optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, bytes, outputSeconds, width, height, renderSeconds, subtitles? }",
        doc: 'Renders the edit with the editor\'s renderer to format "mp4" (default), "gif" (10 fps, at most 960 wide) or "webm"; from/to (OUTPUT seconds, what plays) export only that part and leave the edit as it is. subtitles "srt" | "vtt" also writes the transcript beside it in the movie\'s time (default: the edit\'s export.subtitles). An MP4 gets the recording\'s markers as chapters (chapters: the count) unless exportSettings { chapters: false }. warnings also carries what check() says must be fixed (an item whose time is cut, missing music). Throws when the file exists (it never overwrites).',
        effect: "reversible",
    }),
    defineMethod({
        name: "subtitles",
        params: z.object({ format: z.enum(SUBTITLE_FORMATS).optional(), out: z.string().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ path, cues, format }",
        doc: 'Writes the transcript as a subtitle file in OUTPUT time: format "srt" (default) or "vtt", lines that were cut left out, fixed lines as fixed, beside the movie unless out is given. Needs transcript() first.',
        effect: "reversible",
    }),
    defineMethod({
        name: "transcript",
        params: z
            .object({ provider: z.string().optional(), lang: z.string().optional(), refresh: z.boolean().optional() })
            .strict(),
        result: z.unknown(),
        resultName: "{ from, to, plays, text }[]",
        doc:
            "The spoken lines in source seconds (plays: where each starts in the edit, null when cut), from " +
            toolCommand("transcribe") +
            "; cached beside the movie, refresh: true transcribes again. The first run may ask for the AI vault key.",
        effect: "read",
    }),
    defineMethod({
        name: "poster",
        params: z.object({ at: timeSchema.optional(), out: z.string().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ path, width, height }",
        doc: "One frame of the edit at OUTPUT seconds `at` (0), rendered at the export's full size with every look, as a PNG for a video thumbnail or a README: at out, or beside the movie as <export name>-poster.png (never over a file). still() is the quick preview-size look.",
        effect: "reversible",
    }),
    defineMethod({
        name: "sheet",
        params: z
            .object({
                from: timeSchema.optional(),
                to: timeSchema.optional(),
                count: z.number().int().min(1).max(12).optional(),
                at: z.array(timeSchema).min(1).max(12).optional(),
                out: z.string().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, width, height, times }",
        doc: "One picture of several frames of the edit as it exports, in rows of three, each labelled with its OUTPUT time: count (6) frames spread over from…to (the whole edit), or the times in at. One call to check a whole edit after a change, instead of a still() per moment. out keeps the PNG at that path (the REPL's own copy goes when the run ends).",
        effect: "read",
    }),
    defineMethod({
        name: "itemsAt",
        params: z.object({ at: timeSchema }),
        positional: ["at"],
        result: z.unknown(),
        resultName: "{ output, source, zoom, redactions, texts, shapes, caption }",
        doc: "What plays at OUTPUT seconds `at` (as still() and show() take it), in words: the source time there, the zoom (or null), the hidden parts and spotlights, texts and shapes on screen (as info() lists them, with their ids for retime() or untext(), plus `plays: { from, to }` in output seconds, null where cut), and the caption line (or null). A cheap way to check an edit without a picture.",
        effect: "read",
    }),
    defineMethod({
        name: "still",
        params: z.object({ at: timeSchema.optional(), out: z.string().optional() }),
        positional: ["at", "out"],
        result: z.unknown(),
        resultName: "{ path, width, height }",
        doc: "Shows one frame of the edit as it exports (zoom, clicks, cursor, captions, shortcuts, frame style) at OUTPUT seconds (what plays), so you can look at a change. Without `out` the PNG goes to the run's scratch folder and is gone after the run; give `out` (a .png path) to keep it. It renders at preview size (at most 1080 pixels on the short side), so its size can differ from export()'s, which follows the export settings; the picture is the same.",
        effect: "read",
    }),
    defineMethod({
        name: "find",
        params: z.object({ text: z.string().min(1) }),
        positional: ["text"],
        result: z.unknown(),
        resultName: "{ from, to, plays, text }[]",
        doc: "The transcript lines that hold the text (case and accents ignored); cut one with cut(line.from, line.to).",
        effect: "read",
    }),
    defineMethod({
        name: "switchDisplay",
        params: z.object({ from: timeSchema, to: timeSchema, display: z.number().int().nonnegative() }).strict(),
        result: z.unknown(),
        resultName: "{ path, frames, plan: { policy, windowSec, ranges: { fromUs, toUs, displayId }[] } }",
        doc: `A frames recording of several displays (a meeting): its proxy movie shows \`display\` from \`from\` to \`to\` (source seconds or "m:ss") and is made again, the rest of its display plan (proxy.json) kept. The same as ${toolCommand("recorder proxy")} <rec> --keep-plan --switch from-to=display, and the editor's display lane.`,
        effect: "reversible",
    }),
    defineMethod({
        name: "findOnScreen",
        params: z.object({ text: z.string().min(1), limit: z.number().int().positive().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ sec, displayId, file, lines, shown }[]",
        doc: "Where a text was on the screen of a frames recording (a meeting, or a library recording with OCR): each frame whose OCR holds it (case and accents ignored), at source seconds, with the matching lines; shown: the proxy movie shows that display then. Jump there with show({ at: sec }).",
        effect: "read",
    }),
    defineMethod({
        name: "markers",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ at, plays, label }[]",
        doc:
            "The moments marked while it recorded (recording.mark(label) or " +
            toolCommand("recorder mark") +
            "), at source seconds, plays: where each is in the edit (null when cut).",
        effect: "read",
    }),
    defineMethod({
        name: "comments",
        params: z.object({}).strict(),
        result: z.unknown(),
        resultName: "{ path, comments: { id, text, from, to?, plays, author?, link?, resolved, at }[] }",
        doc: "The recording's review comments (comments.jsonl beside it) in time order: from/to in source seconds, plays where that moment plays in the edit now (null when cut). The editor shows each as a marker on the timeline; a click there jumps to it.",
        effect: "read",
    }),
    defineMethod({
        name: "comment",
        params: z
            .object({
                at: timeSchema,
                to: timeSchema.optional(),
                text: z.string().min(1).max(2000),
                author: z.string().max(80).optional(),
                link: z.string().url().optional(),
                source: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, comment }",
        doc: 'A review comment at `at` (to: the end of a range) in OUTPUT seconds or "m:ss", what plays, as a reviewer of the export sees it; source: true takes times of the recording itself. link: the page it came from (a vitrinka board, a PR). The editor window shows it at once.',
        effect: "reversible",
    }),
    defineMethod({
        name: "resolveComment",
        params: z.object({ id: z.string(), resolved: z.boolean().optional() }).strict(),
        positional: ["id", "resolved"],
        result: z.unknown(),
        resultName: "{ path, comment }",
        doc: "Marks a review comment done (resolved: false opens it again); the timeline shows a resolved one dimmed.",
        effect: "reversible",
    }),
    defineMethod({
        name: "uncomment",
        params: z.object({ id: z.string() }).strict(),
        positional: ["id"],
        result: z.unknown(),
        resultName: "{ path, removed }",
        doc: "Removes a review comment (the file keeps the line that says so).",
        effect: "reversible",
    }),
    defineMethod({
        name: "copy",
        params: z.object({ gif: z.boolean().optional() }).strict(),
        result: z.unknown(),
        resultName: '{ path, kind: "movie" | "gif", exported }',
        doc: "Puts the recording's movie on the clipboard as a file (the newest export beside it, else its own movie), so a paste in Finder, Slack or Mail gets it; gif: true copies a GIF of the edit, exporting one when none is newer than the edit (exported says so). The menu bar's Recent list and the library window do the same.",
        effect: "reversible",
    }),
    defineMethod({
        name: "reveal",
        params: z.object({ meeting: z.boolean().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ revealed }",
        doc: "Shows the recording's folder in Finder; meeting: true shows its meeting's meeting.json (a meeting's screen recording only).",
        effect: "read",
    }),
    defineMethod({
        name: "trash",
        params: z.object({}).strict(),
        result: z.unknown(),
        resultName: "{ trashed }",
        doc: "Moves a library recording's folder to the Trash (Finder's Put Back restores it). A meeting's screen recording is refused: its folder holds the whole meeting.",
        effect: "destructive",
    }),
    defineMethod({
        name: "rename",
        params: z.object({ title: z.string().min(1).max(120) }),
        positional: ["title"],
        result: z.unknown(),
        resultName: "{ id, title, folder }",
        doc: "Gives the recording a new title (the library, the editor window, info() and movies.list() show it); a plain movie has no title and refuses.",
        effect: "reversible",
    }),
    defineMethod({
        name: "chapters",
        params: z.object({ intro: z.string().optional(), minSeconds: z.number().positive().optional() }),
        result: z.unknown(),
        resultName: "string[]",
        doc: 'The markers as video chapters, "0:00 Intro" lines in output time for a YouTube or Vimeo description: none without markers; with markers a first chapter at 0:00 (named intro, "Intro" by default), cut markers left out, a marker under minSeconds (10) after the one before it left out.',
        effect: "read",
    }),
    defineMethod({
        name: "shortcuts",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ at, plays, key }[]",
        doc: 'The ⌘/⌃ shortcuts the recording kept ("⌘C"), at source seconds, plays: where each shows in the edit (null when cut). keys() draws them.',
        effect: "read",
    }),
    defineMethod({
        name: "show",
        params: z
            .object({
                focus: z.boolean().optional(),
                at: z.number().nonnegative().optional(),
                tab: z.enum(EDITOR_TABS).optional(),
            })
            .strict(),
        result: z.unknown(),
        doc: 'Opens the edit in the recorder window (behind the front window unless focus: true), at OUTPUT seconds `at` and on the inspector `tab` ("zoom", "clip", "hide", "text", "style", "cursor", "captions", "audio", "export"), so you can show the user a moment.',
        effect: "reversible",
    }),
];

const recordingMethods = [
    defineMethod({
        name: "status",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ state, elapsedMs, limitMs, segments }",
        doc: "The recording's state.",
        effect: "read",
    }),
    defineMethod({ name: "pause", params: z.object({}), result: z.unknown(), doc: "Pauses.", effect: "reversible" }),
    defineMethod({ name: "resume", params: z.object({}), result: z.unknown(), doc: "Resumes.", effect: "reversible" }),
    defineMethod({
        name: "mark",
        params: z.object({ label: z.string().min(1).max(80) }),
        positional: ["label"],
        result: z.unknown(),
        resultName: "{ atMs, label }",
        doc: 'Marks this moment with a label ("login done"); after stop(), movie.markers() lists it at its movie time, so you can cut or zoom by what you did.',
        effect: "reversible",
    }),
    defineMethod({
        name: "settings",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ settings, audio }",
        doc: RECORDER_SETTINGS_DOC,
        effect: "read",
    }),
    defineMethod({
        name: "setSettings",
        params: recorderSetSchema,
        result: z.unknown(),
        resultName: "{ settings, audio, applied }",
        doc: RECORDER_SET_SETTINGS_DOC,
        effect: "reversible",
    }),
    defineMethod({
        name: "stop",
        params: z.object({}),
        result: z.unknown(),
        resultName: "Movie",
        doc: "Stops, waits for the movie, and returns it as a Movie to edit.",
        effect: "reversible",
    }),
];

export const moviesApi = defineApi({
    id: "movies",
    global: "movies",
    title: "Movie recorder and editor",
    summary:
        "Record the screen as a movie, then cut, speed up, zoom and export it; the recorder window shows each edit.",
    methods: [
        defineMethod({
            name: "list",
            params: z.object({ limit: z.number().int().positive().optional() }).strict(),
            result: z.unknown(),
            resultName: "{ id, title, folder, startedAt, movie?, edited }[]",
            doc: "The recordings library, newest first.",
            effect: "read",
        }),
        defineMethod({
            name: "search",
            params: z.object({ text: z.string().min(1) }),
            positional: ["text"],
            result: z.unknown(),
            resultName: "{ recording, title, folder, kind, at, to?, text }[]",
            doc: 'Finds a moment across the whole library (case and accents ignored): a recording\'s title, a marker\'s label, or a line of a transcript it already has (kind "title" | "marker" | "line", at and to in source seconds); open(hit.folder) then cuts or zooms there. It never transcribes.',
            effect: "read",
        }),
        defineMethod({
            name: "open",
            params: z.object({ recording: z.string() }),
            positional: ["recording"],
            result: z.unknown(),
            resultName: "Movie",
            doc: 'A library id, "last", a recording folder, a movie or an edit.json. Every method of the Movie it returns is async: await each call (an un-awaited one prints as "[a Promise: …]"). An edit may already hold zooms, shapes, texts or music: call info() first, whose summary line lists them, so you do not add a second copy.',
            effect: "read",
        }),
        defineMethod({
            name: "record",
            params: recordSchema,
            result: z.unknown(),
            resultName: "MovieRecording",
            doc: "Starts a movie recording of the main display (or display, app, window) in its own process.",
            effect: "reversible",
        }),
        defineMethod({
            name: "demo",
            params: demoParamsSchema,
            result: z.unknown(),
            resultName:
                "{ movie: Movie, folder, steps: { caption, startMs, endMs }[], failed, ops, sourceSeconds, exported? }",
            doc: 'One call gives a finished demo: records the screen (record: the options of record()), runs each step ({ caption, run: async () => …, holdSeconds? }) between a marker at its start and a hold after it (holdSeconds, 1: the result stays on screen and is never cut), stops, cuts the waiting (still, silent stretches while the code of a step runs, and the time before the first and after the last step), adds the caption of each step while it plays, and exports (export: false skips it). A step that throws is listed in failed and the next one runs. edit takes cutIdle (true), idleMinSeconds (1), cutWaits (true), minWaitSeconds (0.8), keepSeconds (0.3), leadSeconds (0.5), tailSeconds (1), captions (true), captionPosition "bottom" | "top", captionMinSeconds (1.8), markers (true). Save a demo that worked with presets.save(name, script) to run it again.',
            effect: "reversible",
        }),
    ],
    handles: [
        { name: "Movie", summary: "One recording's edit (edit.json).", methods: movieMethods },
        { name: "MovieRecording", summary: "A movie recording that runs now.", methods: recordingMethods },
    ],
    notes: [
        'Times are SOURCE seconds (the movie as recorded) or "mm:ss": a cut never moves later times.',
        "Every edit reads the file fresh and saves once, so the open window and you never overwrite each other.",
        'The edit is a file: it stays after the worker ends, and the next run starts from it. apply([{ op: "reset" }]) starts over; undo() reaches only the changes of this handle.',
        "Limits: speed 0.25–16, zoom scale 1–4, focus x and y 0–1, volume 0–2.",
    ],
});

/** Where an arrow starts when only its head is given: 12 % of the picture away, towards the centre and down-left. */
function arrowTail(at: { x: number; y: number }): { x: number; y: number } {
    const dx = at.x > 0.5 ? -1 : 1;
    const dy = at.y > 0.5 ? -1 : 1;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    return { x: clamp(at.x + dx * 0.085), y: clamp(at.y + dy * 0.085) };
}

/** One line a reader takes in at a glance: the length and what the edit holds. */
function summarize(project: EditProject, title: string | undefined): string {
    const seconds = (us: number) => `${Math.round(us / 100_000) / 10} s`;
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    const redactions = project.redactions ?? [];
    const spotlights = redactions.filter((redaction) => redaction.style === "spotlight").length;
    const parts = [
        `${seconds(outputDurationUs(project))} long (source ${seconds(project.source.durationUs)})`,
        count(project.clips.length, "clip"),
        count(project.zooms.length, "zoom"),
        count(redactions.length - spotlights, "hidden part"),
        count(spotlights, "spotlight"),
        count((project.texts ?? []).length, "text"),
        count((project.shapes ?? []).length, "shape"),
        `captions ${project.captions?.show ? "on" : "off"}`,
        `frame ${project.frame ? (project.frame.aspect ?? "on") : "off"}`,
        `music ${project.audio.music ? `${project.audio.music.file.split(/[/\\]/).pop()}${project.audio.music.loop === false ? " once" : ""}` : "none"}`,
        `click rings ${project.clicks?.highlight ? "on" : "off"}${project.clicks?.sound ? ", click sound" : ""}`,
        count(Object.keys(project.transcript?.fixes ?? {}).length, "edited caption line"),
    ];
    return `${title ? `"${title}": ` : ""}${parts.join(", ")}`;
}

/** What check() cannot read from the edit itself, looked up on the disk. */
function facts(project: EditProject): EditFacts {
    return {
        hasTranscript: existsSync(transcriptCachePath(project.source.video)),
        hasCursorTrack: Boolean(project.source.cursor && existsSync(project.source.cursor)),
        musicFileExists: project.audio.music ? existsSync(project.audio.music.file) : true,
    };
}

export class Movie {
    /** `ctx`: the worker's scratch folder and `show`, for still(); absent outside a REPL. */
    constructor(
        readonly recording: string,
        private readonly ctx?: ToolsetContext
    ) {}

    async info() {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);
        const manifest = folder ? readRecordingManifest(folder) : undefined;
        return {
            summary: summarize(opened.project, manifest?.title),
            ...describeProject(opened.project, opened.path),
            title: manifest?.title ?? null,
            folder: folder ?? null,
        };
    }

    async check() {
        const { project } = await openProject(this.recording);
        const issues = checkProject(project, facts(project));
        log.debug({ recording: this.recording, issues: issues.length }, "edit checked");
        // ok: nothing that breaks the export; clean: nothing to look at either.
        return { ok: !issues.some((issue) => issue.severity === "fix"), clean: issues.length === 0, issues };
    }

    async fix() {
        const { project } = await openProject(this.recording);
        const { ops, fixed } = fixOps(project, facts(project));

        if (ops.length === 0) {
            return { ...(await this.info()), fixed: [], warnings: ["check() found nothing that fix() can fix"] };
        }

        log.debug({ recording: this.recording, ops: ops.length, fixed: fixed.length }, "fixing what check found");
        const edited = await this.change(ops);
        return { ...edited, fixed };
    }

    private async change(ops: EditOp[]) {
        const edited = await editProject(this.recording, ops);
        const described = describeProject(edited.project, edited.path);
        const seconds = (us: number) => Math.round(us / 1000) / 1000;
        return {
            summary: summarize(edited.project, undefined),
            ...described,
            ...(edited.removedIdleUs
                ? { removed: edited.removedIdleUs.map(([from, to]) => [seconds(from), seconds(to)]) }
                : {}),
            ...(edited.loudness ? { loudness: edited.loudness } : {}),
            ...(edited.warnings ? { warnings: edited.warnings } : {}),
        };
    }

    async split(at: z.infer<typeof timeSchema>) {
        return this.change([{ op: "split", at }]);
    }

    async cut(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "cut", from, to }]);
    }

    async keep(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "keep", from, to }]);
    }

    async speed(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>, factor: number) {
        return this.change([{ op: "speed", from, to, factor }]);
    }

    async zoom(options: z.infer<typeof zoomSchema>) {
        return this.change([{ op: "zoom", ...options }]);
    }

    async unzoom(id: string) {
        return this.change([{ op: "unzoom", id }]);
    }

    async redact(options: Omit<Extract<EditOp, { op: "redact" }>, "op">) {
        return this.change([{ op: "redact", ...options }]);
    }

    async unredact(id: string) {
        return this.change([{ op: "unredact", id }]);
    }

    async text(options: Omit<Extract<EditOp, { op: "text" }>, "op">) {
        return this.change([{ op: "text", ...options }]);
    }

    async retime(options: {
        id: string;
        at?: z.infer<typeof timeSchema>;
        from?: z.infer<typeof timeSchema>;
        to?: z.infer<typeof timeSchema>;
        by?: number;
    }) {
        return this.change([{ op: "retime", ...options }]);
    }

    async untext(id: string) {
        return this.change([{ op: "untext", id }]);
    }

    /** Fixes the line spoken at `at` (any time inside it, so a time from find() or a still works). */
    async fixLine(at: number | string, text: string) {
        return this.fixLines([{ at, text }]);
    }

    async fixLines(fixes: Array<{ at: number | string; text: string }>) {
        const opened = await openProject(this.recording);
        const cache = transcriptCachePath(opened.project.source.video);

        if (!existsSync(cache)) {
            throw new Error("this movie has no transcript yet; call transcript() first, then fix its lines");
        }

        const raw = z
            .object({ segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) })
            .parse(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }));
        const ops = fixes.map(({ at, text }): EditOp => {
            const seconds = timeToUs(at) / 1_000_000;
            const line = raw.segments.find((segment) => segment.start <= seconds + 0.0005 && seconds < segment.end);

            if (!line) {
                const near = raw.segments
                    .map((segment) => segment.start)
                    .sort((a, b) => Math.abs(a - seconds) - Math.abs(b - seconds))
                    .slice(0, 3);
                throw new Error(
                    `no line is spoken at ${seconds} s, nothing was saved; the nearest lines start at ${near.join(", ")} s`
                );
            }

            return { op: "fixLine", from: line.start, text };
        });
        return this.change(ops);
    }

    async replaceWords(options: { find: string; replace: string; matchCase?: boolean; wholeWord?: boolean }) {
        const opened = await openProject(this.recording);
        const cache = transcriptCachePath(opened.project.source.video);

        if (!existsSync(cache)) {
            throw new Error("this movie has no transcript yet; call transcript() first, then replace words in it");
        }

        const raw = z
            .object({ segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) })
            .parse(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }));
        const lines = replaceWordsInLines(raw.segments, opened.project.transcript?.fixes ?? {}, options);

        if (!lines.length) {
            throw new RangeError(
                `"${options.find}" is in no line${options.wholeWord === false ? "" : " as a whole word"}; nothing was saved (find(text) searches the transcript)`
            );
        }

        const result = await this.change(lines.map(({ from, text }): EditOp => ({ op: "fixLine", from, text })));
        return { ...result, replaced: lines.map(({ from, was, text }) => ({ from, was, now: text })) };
    }

    async unfixLine(from: number | string) {
        return this.change([{ op: "unfixLine", from }]);
    }

    async autoZoom(options: { scale?: number } = {}) {
        return this.change([{ op: "autoZoom", ...options }]);
    }

    async annotateClicks(options: Omit<Extract<EditOp, { op: "annotateClicks" }>, "op"> = {}) {
        const result = await this.change([{ op: "annotateClicks", ...options }]);
        // Say why nothing was added, not only that nothing changed.
        const warnings = (result.warnings ?? []).map((warning) =>
            warning === "nothing changed, so nothing was saved"
                ? "every click in the range has its mark already, so nothing was saved"
                : warning
        );
        return warnings.length ? { ...result, warnings } : result;
    }

    async volume(volume: number) {
        return this.change([{ op: "volume", volume }]);
    }

    async mute(track: number) {
        return this.change([{ op: "mute", track, muted: true }]);
    }

    async unmute(track: number) {
        return this.change([{ op: "mute", track, muted: false }]);
    }

    async apply(ops: EditOp[]) {
        return this.change(ops);
    }

    async reset() {
        return this.change([{ op: "reset" }]);
    }

    async clicks(options: Omit<Extract<EditOp, { op: "clicks" }>, "op"> = {}) {
        return this.change([{ op: "clicks", ...options }]);
    }

    async keys(options: Omit<Extract<EditOp, { op: "keys" }>, "op"> = {}) {
        return this.change([{ op: "keys", ...options }]);
    }

    async captions(options: Omit<Extract<EditOp, { op: "captions" }>, "op"> = {}) {
        return this.change([{ op: "captions", ...options }]);
    }

    async cursor(options: Omit<Extract<EditOp, { op: "cursor" }>, "op"> = {}) {
        return this.change([{ op: "cursor", ...options }]);
    }

    async motion(options: Omit<Extract<EditOp, { op: "motion" }>, "op"> = {}) {
        return this.change([{ op: "motion", ...options }]);
    }

    async camera(options: Omit<Extract<EditOp, { op: "camera" }>, "op"> = {}) {
        return this.change([{ op: "camera", ...options }]);
    }

    async cameraHide(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "cameraHide", from, to }]);
    }

    async cameraShow(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "cameraShow", from, to }]);
    }

    async frame(options: Omit<Extract<EditOp, { op: "frame" }>, "op"> = {}) {
        return this.change([{ op: "frame", ...options }]);
    }

    /**
     * The usual clean-up in one call, each step on its own so one that cannot run (no clicks, no audio) is reported
     * and the rest still run; one undo() puts the whole polish back.
     */
    async polish(options: { removeIdle?: boolean; autoZoom?: boolean; normalize?: boolean; frame?: boolean } = {}) {
        const before = await openProject(this.recording);
        const depth = undoDepth(before.path);
        const plan: Array<[string, EditOp[]]> = [];

        if (options.removeIdle !== false) {
            plan.push(["removeIdle", [{ op: "removeIdle", minSeconds: 2, keepSeconds: 0.3 }]]);
        }

        if (options.autoZoom !== false) {
            plan.push(["autoZoom", [{ op: "autoZoom" }]]);
        }

        if (options.normalize !== false) {
            plan.push(["normalize", [{ op: "normalize", targetLufs: -16 }]]);
        }

        if (options.frame !== false && !before.project.frame) {
            plan.push(["frame", [{ op: "frame" }]]);
        }

        const steps: Array<{ step: string; done: boolean; note: string }> = [];

        for (const [step, ops] of plan) {
            try {
                const edited = await editProject(this.recording, ops);
                const seconds = (us: number) => Math.round(us / 1000) / 1000;
                const note =
                    step === "removeIdle"
                        ? `${edited.removedIdleUs?.length ?? 0} still part(s) cut, ${seconds(outputDurationUs(edited.project))} s left`
                        : step === "autoZoom"
                          ? `${edited.project.zooms.filter((zoom) => zoom.mode === "follow").length} zoom(s) on the clicks`
                          : step === "normalize"
                            ? `volume ${Math.round(edited.project.audio.volume * 100)} % (measured ${edited.loudness?.measuredLufs} LUFS)`
                            : "gradient frame with padding and a shadow";
                steps.push({ step, done: true, note });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.debug({ error, step }, "polish step skipped");
                steps.push({ step, done: false, note: message.replace(/^\w+ refused, nothing was saved: /, "") });
            }
        }

        // Its steps undo as one.
        collapseUndo(before.path, depth);
        const opened = await openProject(this.recording);
        return { ...describeProject(opened.project, opened.path), steps };
    }

    async removeIdle(options: { minSeconds?: number; keepSeconds?: number; speed?: number } = {}) {
        return this.change([
            {
                op: "removeIdle",
                minSeconds: options.minSeconds ?? 2,
                keepSeconds: options.keepSeconds ?? 0.3,
                ...(options.speed ? { speed: options.speed } : {}),
            },
        ]);
    }

    async cutWords(options: { at: TimeValue; words: string; padMs?: number; dryRun?: boolean }) {
        const { dryRun, ...rest } = options;
        const op = { op: "cutWords" as const, ...rest };
        return dryRun ? cutsOut(await previewTranscriptCuts(this.recording, op)) : this.change([op]);
    }

    async cutFillers(
        options: { language?: string; level?: FillerLevel; words?: string[]; padMs?: number; dryRun?: boolean } = {}
    ) {
        const { dryRun, ...rest } = options;
        const op = { op: "cutFillers" as const, ...rest };
        return dryRun ? cutsOut(await previewTranscriptCuts(this.recording, op)) : this.change([op]);
    }

    async denoise(
        options: {
            enabled?: boolean;
            reductionDb?: number;
            tracks?: number[];
            trackReductionDb?: Record<string, number>;
        } = {}
    ) {
        return this.change([{ op: "denoise", ...options }]);
    }

    async normalize(options: { targetLufs?: number } = {}) {
        return this.change([{ op: "normalize", targetLufs: options.targetLufs ?? -16 }]);
    }

    async undo(options: { all?: boolean } = {}) {
        let undone = await undoEdit(this.recording);
        const ops = [...(undone.undone ?? [])];

        while (options.all && undoDepth(undone.path) > 0) {
            undone = await undoEdit(this.recording);
            ops.push(...(undone.undone ?? []));
        }

        return {
            undone: ops,
            stepsLeft: undoDepth(undone.path),
            ...describeProject(undone.project, undone.path),
        };
    }

    async shape(options: Omit<Extract<EditOp, { op: "shape" }>, "op">) {
        return this.change([{ op: "shape", ...options }]);
    }

    async arrow(options: {
        from: z.infer<typeof timeSchema>;
        to: z.infer<typeof timeSchema>;
        at: { x: number; y: number };
        tail?: { x: number; y: number };
        color?: string;
        appear?: (typeof SHAPE_APPEARS)[number];
    }) {
        return this.change([
            {
                op: "shape",
                kind: "arrow",
                from: options.from,
                to: options.to,
                start: options.tail ?? arrowTail(options.at),
                end: options.at,
                ...(options.color ? { color: options.color } : {}),
                ...(options.appear ? { appear: options.appear } : {}),
            },
        ]);
    }

    async unshape(id: string) {
        return this.change([{ op: "unshape", id }]);
    }

    async range(options: Omit<Extract<EditOp, { op: "range" }>, "op">) {
        return this.change([{ op: "range", ...options }]);
    }

    async addLane(options: Omit<Extract<EditOp, { op: "addLane" }>, "op"> = {}) {
        return this.change([{ op: "addLane", ...options }]);
    }

    async removeLane(id: string) {
        return this.change([{ op: "removeLane", id }]);
    }

    async moveLane(id: string, to: number) {
        return this.change([{ op: "moveLane", id, to }]);
    }

    async moveToLane(id: string, lane: string) {
        return this.change([{ op: "moveToLane", id, lane }]);
    }

    async music(options: Omit<Extract<EditOp, { op: "music" }>, "op"> = {}) {
        return this.change([{ op: "music", ...options }]);
    }

    /** A redaction with the spotlight style: the rectangle stays sharp and the rest of the picture dims. */
    async spotlight(options: Omit<Extract<EditOp, { op: "spotlight" }>, "op">) {
        return this.change([{ op: "spotlight", ...options }]);
    }

    async export(
        options: {
            out?: string;
            format?: ExportFormat;
            from?: z.infer<typeof timeSchema>;
            to?: z.infer<typeof timeSchema>;
            subtitles?: SubtitleFormat;
        } = {}
    ) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        const part =
            options.from === undefined && options.to === undefined
                ? undefined
                : {
                      fromUs: options.from === undefined ? 0 : timeToUs(options.from),
                      toUs: options.to === undefined ? outputDurationUs(opened.project) : timeToUs(options.to),
                  };
        await ensureRecorderPart();
        const answer = await exportAs(opened.path, {
            out: options.out,
            format: options.format,
            part,
            subtitles: options.subtitles,
        });

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the export failed without a reason");
        }

        const info = await probeVideo({ input: answer.path });
        // What check() would say must be fixed rides along, so an export never hides it.
        const { issues } = await this.check();
        const warnings = [
            ...(answer.warnings ?? []),
            ...issues
                .filter((issue) => issue.severity === "fix")
                .map((issue) => `${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`),
        ];
        return {
            path: answer.path,
            bytes: answer.bytes,
            outputSeconds: Math.round(info.durationUs / 1000) / 1000,
            width: info.width,
            height: info.height,
            renderSeconds: answer.seconds,
            ...(answer.subtitles ? { subtitles: answer.subtitles } : {}),
            ...(answer.chapters ? { chapters: answer.chapters } : {}),
            ...(warnings.length ? { warnings } : {}),
        };
    }

    async subtitles(options: { format?: SubtitleFormat; out?: string } = {}) {
        return writeSubtitles({ value: this.recording, format: options.format ?? "srt", out: options.out });
    }

    /** `<movie>.transcript.json` beside the movie: the raw result, so a later edit maps it again for free. */
    async transcript(options: { provider?: string; lang?: string; refresh?: boolean } = {}): Promise<TranscriptLine[]> {
        const opened = await openProject(this.recording);
        const video = opened.project.source.video;
        const cache = transcriptCachePath(video);

        if (!options.refresh && existsSync(cache)) {
            return transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project);
        }

        const args = ["transcribe", video, "--format", "json", "-o", cache];

        if (options.provider) {
            args.push("--provider", options.provider);
        }

        if (options.lang) {
            args.push("--lang", options.lang);
        }

        log.info({ video, provider: options.provider ?? "default", cache }, "transcribing the movie");
        const result = await execTool(args, { timeout: 60 * 60_000 });

        if (!result.success || !existsSync(cache)) {
            // The CLI's error lines start with ■; the last line alone is often only the suggested command.
            const lines = result.stderr.trim().split("\n").filter(Boolean);
            const marked = lines.filter((line) => line.includes("■")).map((line) => line.replace(/^.*■\s*/, ""));
            const reason = (marked.length > 0 ? marked.join("; ") : lines.at(-1)) ?? `exit ${result.exitCode}`;
            throw new Error(`the transcription failed: ${reason}`);
        }

        return transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project);
    }

    /** One frame of the edit as it exports, shown to the model; `at` is OUTPUT seconds (what plays). */
    async poster(options: { at?: z.infer<typeof timeSchema>; out?: string } = {}) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        const atUs = timeToUs(options.at ?? 0);
        const lengthUs = outputDurationUs(opened.project);

        if (atUs > lengthUs) {
            throw new Error(
                `at (${atUs / 1_000_000} s) is after the end of the edit (${Math.round(lengthUs / 1000) / 1000} s); poster() takes OUTPUT seconds`
            );
        }

        const video = opened.project.source.video;
        const out = options.out ? resolve(options.out) : join(dirname(video), `${defaultExportName(video)}-poster.png`);

        if (existsSync(out)) {
            throw new Error(`${out} exists already; poster() never overwrites a file, so pass another out`);
        }

        await ensureRecorderPart();
        const answer = await stillOfEdit({ path: opened.path, atSeconds: atUs / 1_000_000, out, full: true });

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the poster failed without a reason");
        }

        await this.ctx?.show({ path: answer.path });
        return { path: answer.path, width: answer.width, height: answer.height };
    }

    async sheet(
        options: {
            from?: z.infer<typeof timeSchema>;
            to?: z.infer<typeof timeSchema>;
            count?: number;
            at?: z.infer<typeof timeSchema>[];
            out?: string;
        } = {}
    ) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        const lengthUs = outputDurationUs(opened.project);
        const times = options.at
            ? options.at.map((time) => timeToUs(time))
            : spreadTimes({
                  fromUs: options.from === undefined ? 0 : timeToUs(options.from),
                  toUs: options.to === undefined ? lengthUs : timeToUs(options.to),
                  count: options.count ?? 6,
              });
        const late = times.find((us) => us > lengthUs);

        if (late !== undefined) {
            throw new Error(
                `${late / 1_000_000} s is after the end of the edit (${Math.round(lengthUs / 1000) / 1000} s); sheet() takes OUTPUT seconds`
            );
        }

        await ensureRecorderPart();
        const out = options.out ?? join(this.ctx?.scratchDir ?? tmpdir(), `sheet-${Date.now()}.png`);
        const answer = await sheetOfEdit({ path: opened.path, times: times.map((us) => us / 1_000_000), out });

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the sheet failed without a reason");
        }

        await this.ctx?.show({ path: answer.path });
        return { path: answer.path, width: answer.width, height: answer.height, times: answer.times };
    }

    async itemsAt(at: z.infer<typeof timeSchema>) {
        const opened = await openProject(this.recording);
        const project = opened.project;
        const askedUs = timeToUs(at);
        const outUs = Math.min(Math.max(0, askedUs), outputDurationUs(project));
        const sourceUs = sourceTimeOf(project, outUs);
        const live = (item: { id: string; startUs: number; endUs: number }) =>
            item.startUs <= sourceUs && sourceUs < item.endUs;
        const spans = new Map(
            [...project.zooms, ...(project.redactions ?? []), ...(project.texts ?? []), ...(project.shapes ?? [])]
                .filter(live)
                .map((item) => [item.id, item] as const)
        );
        const described = describeProject(project, opened.path);
        const playsAt = (us: number) => {
            const out = outputTimeOf(project, us);
            return out === undefined ? null : Math.round(out / 1000) / 1000;
        };
        // Each item as info() lists it (source seconds), plus `plays`: its OUTPUT start and end, null where cut.
        const onScreen = <T extends { id: string }>(list: T[] | undefined) =>
            (list ?? []).flatMap((item) => {
                const span = spans.get(item.id);
                return span ? [{ ...item, plays: { from: playsAt(span.startUs), to: playsAt(span.endUs) } }] : [];
            });
        const cache = transcriptCachePath(project.source.video);
        const lines = existsSync(cache)
            ? transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), project)
            : [];
        const line = lines.find((one) => one.from * 1e6 <= sourceUs && sourceUs < one.to * 1e6);
        const seconds = (us: number) => Math.round(us / 1000) / 1000;
        return {
            output: seconds(outUs),
            source: seconds(sourceUs),
            zoom: onScreen(described.zooms)[0] ?? null,
            redactions: onScreen(described.redactions),
            texts: onScreen(described.texts),
            shapes: onScreen(described.shapes),
            caption: line?.text ?? null,
            ...(outUs === askedUs
                ? {}
                : {
                      warnings: [`${seconds(askedUs)} s is past the end; this is the last moment, ${seconds(outUs)} s`],
                  }),
        };
    }

    async still(at: z.infer<typeof timeSchema> = 0, keep?: string) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        const atUs = timeToUs(at);
        const lengthUs = outputDurationUs(opened.project);

        if (atUs > lengthUs) {
            throw new Error(
                `at (${atUs / 1_000_000} s) is after the end of the edit (${Math.round(lengthUs / 1000) / 1000} s); still() takes OUTPUT seconds, 0 to the edit's length`
            );
        }

        await ensureRecorderPart();
        const out = keep ? resolve(keep) : join(this.ctx?.scratchDir ?? tmpdir(), `still-${Date.now()}.png`);
        const answer = await stillOfEdit({ path: opened.path, atSeconds: atUs / 1_000_000, out });

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the still failed without a reason");
        }

        await this.ctx?.show({ path: answer.path });
        return { path: answer.path, width: answer.width, height: answer.height };
    }

    async find(text: string): Promise<TranscriptLine[]> {
        return findInTranscript(await this.transcript(), text);
    }

    async switchDisplay(input: { from: z.infer<typeof timeSchema>; to: z.infer<typeof timeSchema>; display: number }) {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);

        if (!folder) {
            throw new Error(`${opened.project.source.video} is a plain movie: it shows one picture, not displays`);
        }

        return switchDisplay(folder, {
            fromUs: timeToUs(input.from),
            toUs: timeToUs(input.to),
            displayId: input.display,
        });
    }

    async findOnScreen(input: { text: string; limit?: number }): Promise<ScreenHit[]> {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);

        if (!folder) {
            throw new Error(`${opened.project.source.video} is a plain movie: it has no frames with OCR to search`);
        }

        return findOnScreen(folder, input.text, input.limit !== undefined ? { limit: input.limit } : {});
    }

    async shortcuts() {
        return shortcutsOf((await openProject(this.recording)).project);
    }

    /** The moments marked while it recorded (`recording.mark()`, `tools recorder mark`), with where each plays. */
    async markers() {
        return markersOf(await openProject(this.recording));
    }

    async titleMarkers(options: { seconds?: number; numbered?: boolean; y?: number } = {}) {
        const opened = await openProject(this.recording);
        const marks = markersOf(opened).filter((mark) => mark.plays !== null);

        if (!marks.length) {
            throw new RangeError(
                "the recording has no marker in the kept movie; mark moments while recording (recording.mark(), " +
                    toolCommand("recorder mark") +
                    "), or add texts with text()"
            );
        }

        const lengthUs = Math.round((options.seconds ?? 2.5) * 1_000_000);
        // A marker that already has a text starting within 0.1 s keeps it, so a second run adds nothing.
        const taken = (opened.project.texts ?? []).map((note) => note.startUs);
        const ops = marks.flatMap((mark, index): EditOp[] => {
            const startUs = Math.round(mark.at * 1_000_000);

            if (taken.some((us) => Math.abs(us - startUs) <= 100_000)) {
                return [];
            }

            const text = options.numbered === false ? mark.label : `${index + 1}. ${mark.label}`;
            const to = Math.min(opened.project.source.durationUs, startUs + lengthUs) / 1_000_000;
            return [
                {
                    op: "text",
                    from: mark.at,
                    to,
                    text: text.slice(0, 200),
                    ...(options.y === undefined ? {} : { y: options.y }),
                },
            ];
        });

        if (!ops.length) {
            throw new RangeError(`every marker has its title already (${marks.length}); nothing was saved`);
        }

        return this.change(ops);
    }

    /** The recording's folder, for the quick actions; a plain movie has none. */
    private async folder(what: string): Promise<string> {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);

        if (!folder) {
            throw new Error(`${opened.project.source.video} is a plain movie, not a recording folder, so ${what}`);
        }

        return folder;
    }

    async comments() {
        return commentsOf(this.recording);
    }

    async comment(options: {
        at: z.infer<typeof timeSchema>;
        to?: z.infer<typeof timeSchema>;
        text: string;
        author?: string;
        link?: string;
        source?: boolean;
    }) {
        return commentOn(this.recording, options);
    }

    async resolveComment(id: string, resolved = true) {
        return resolveComment(this.recording, id, resolved);
    }

    async uncomment(id: string) {
        return uncomment(this.recording, id);
    }

    async copy(options: { gif?: boolean } = {}) {
        await ensureRecorderPart();
        return copyRecording(await this.folder("it has no library copy"), options);
    }

    async reveal(options: { meeting?: boolean } = {}) {
        return revealRecording(await this.folder("Finder shows the movie itself"), options);
    }

    async trash() {
        return trashRecording(await this.folder("move the movie to the Trash in Finder"));
    }

    async rename(title: string) {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);

        if (!folder) {
            throw new Error(
                `${opened.project.source.video} is a plain movie, not a recording folder, so it has no title to change`
            );
        }

        const manifest = renameRecording(folder, title);
        return { id: manifest.id, title: manifest.title, folder };
    }

    async chapters(options: { intro?: string; minSeconds?: number } = {}) {
        return chaptersOf(markersOf(await openProject(this.recording)), options);
    }

    async show(options: { focus?: boolean; at?: number; tab?: EditorTab } = {}) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        await ensureRecorderPart();
        openEditor(opened.path, { focus: options.focus === true, atSeconds: options.at, tab: options.tab });
        return {
            opened: opened.path,
            ...(options.at === undefined ? {} : { at: options.at }),
            ...(options.tab ? { tab: options.tab } : {}),
        };
    }
}

export class MovieRecording {
    constructor(
        readonly entry: LiveEntry,
        private readonly ctx?: ToolsetContext
    ) {}

    get id(): string {
        return this.entry.id;
    }

    get folder(): string | undefined {
        return this.entry.folder;
    }

    status() {
        return callRecorder({ id: this.id, method: "status" });
    }

    pause() {
        return callRecorder({ id: this.id, method: "pause" });
    }

    resume() {
        return callRecorder({ id: this.id, method: "resume" });
    }

    mark(label: string) {
        return callRecorder({ id: this.id, method: "marker.add", params: { label } });
    }

    settings() {
        return callRecorder({ id: this.id, method: "settings.get" });
    }

    async setSettings(patch: z.input<typeof recorderSetSchema>) {
        return await callRecorder({ id: this.id, method: "settings.set", params: settingsPatchOf(patch) });
    }

    /** Stops, then waits until the recorder wrote the final manifest, so the movie is complete. */
    async stop(): Promise<Movie> {
        const folder = this.folder;

        if (!folder) {
            throw new Error(`the recording ${this.id} names no folder`);
        }

        if (listLiveRecordings().some((entry) => entry.id === this.id)) {
            await callRecorder({ id: this.id, method: "stop", params: { wait: true } });
        }

        const deadline = Date.now() + FINISH_TIMEOUT_MS;

        while (!readRecordingManifest(folder)?.endedAt) {
            if (Date.now() > deadline) {
                throw new Error(`the recording stopped but ${folder} has no finished manifest after 120 s`);
            }

            await Bun.sleep(POLL_MS);
        }

        return new Movie(folder, this.ctx);
    }
}

/** Starts `tools recorder start` in its own process (a REPL reset must not end a recording) and waits for its entry. */
async function record(options: z.infer<typeof recordSchema>, ctx?: ToolsetContext): Promise<MovieRecording> {
    const before = new Set(listLiveRecordings().map((entry) => entry.id));
    const args = ["recorder", "start"];

    if (options.audio?.length) {
        args.push("--audio", options.audio.join(","));
    }

    if (options.title) {
        args.push("--title", options.title);
    }

    if (options.maxSeconds !== undefined) {
        args.push("--max-seconds", String(options.maxSeconds));
    }

    if (options.display !== undefined) {
        args.push("--display", String(options.display));
    }

    if (options.app) {
        args.push("--app", options.app);
    }

    if (options.window?.length) {
        args.push("--window", options.window.join(","));
    }

    if (options.fps !== undefined) {
        args.push("--fps", String(options.fps));
    }

    if (options.controls === false) {
        args.push("--no-controls");
    }

    if (options.indicator === false) {
        args.push("--no-indicator");
    }

    if (options.camera) {
        args.push("--camera");
    }

    log.info({ args }, "movie recording requested");
    spawnToolDetached(args, { reparent: true });
    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const started = listLiveRecordings().find(
            (entry) => !before.has(entry.id) && entry.folder?.includes("/video-") && entry.state === "recording"
        );

        if (started) {
            return new MovieRecording(started, ctx);
        }

        await Bun.sleep(POLL_MS);
    }

    throw new Error(
        `the recording did not start within ${START_TIMEOUT_MS / 1000} s; if it starts later, end it with ${toolCommand("recorder stop")}; run ${toolCommand("genesis-tools logs failures")} or ${toolCommand("recorder start")} in a terminal to see why`
    );
}

const markerAnswer = z.object({ atMs: z.number() });

/** The demo driver on a real movie recording: `tools recorder start` in its own process, the edit, the export. */
export function movieDemoDriver(options: z.infer<typeof recordSchema>, ctx?: ToolsetContext): DemoDriver {
    return {
        async start() {
            const recording = await record(options, ctx);
            return {
                mark: async (label: string) => markerAnswer.parse(await recording.mark(label)),
                stop: async () => {
                    await recording.stop();

                    if (!recording.folder) {
                        throw new Error(`the recording ${recording.id} names no folder`);
                    }

                    return recording.folder;
                },
            };
        },
        async durationMs(folder) {
            return (await openProject(folder)).project.source.durationUs / 1000;
        },
        async idleMs(folder, minMs) {
            const { project } = await openProject(folder);
            const ranges = await findIdle({
                video: project.source.video,
                durationUs: project.source.durationUs,
                minUs: minMs * 1000,
                keepUs: 0,
            });
            return ranges.map(([from, to]): [number, number] => [from / 1000, to / 1000]);
        },
        async edit(folder, ops) {
            await editProject(folder, ops);
        },
        async exportMovie(folder) {
            const answer = await new Movie(folder, ctx).export();
            return { path: answer.path, outputSeconds: answer.outputSeconds };
        },
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
    };
}

/** `movies.demo()`: the REPL door of runDemo, with the Movie of the result to keep editing. */
async function recordDemo(options: z.input<typeof demoParamsSchema> & { steps: DemoStep[] }, ctx?: ToolsetContext) {
    const parsed = demoParamsSchema.parse(options);
    const recordOptions = { ...parsed.record, ...(parsed.title ? { title: parsed.title } : {}) };
    const result = await runDemo({
        steps: options.steps,
        driver: movieDemoDriver(recordOptions, ctx),
        edit: parsed.edit,
        settleSeconds: parsed.settleSeconds,
        holdSeconds: parsed.holdSeconds,
        export: parsed.export,
    });
    return { movie: new Movie(result.folder, ctx), ...result };
}

export class MoviesToolset extends ReplToolset {
    readonly api = moviesApi;

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        return {
            movies: {
                list: (options: { limit?: number } = {}) => listLibrary().slice(0, options.limit ?? 20),
                open: (recording: string) => new Movie(recording, ctx),
                record: (options: z.infer<typeof recordSchema> = {}) => record(options, ctx),
                demo: (options: z.input<typeof demoParamsSchema> & { steps: DemoStep[] }) => recordDemo(options, ctx),
                search: (text: string) => searchLibrary(text),
            },
        };
    }
}
