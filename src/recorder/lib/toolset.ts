import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RecordingTarget } from "@app/control/lib/recording-targets";
import { assertReach, defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { execTool, spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { FlockState } from "@genesiscz/utils/fs/flock";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { awaitStart, startGatePath, stopPassedChild, sweepStartGates } from "@genesiscz/utils/process/start-gate";
import { checkProject, type EditFacts, type EditIssue, fixOps } from "@genesiscz/utils/recording-editor/check";
import {
    eventAnchorSchema,
    MOVIE_EVENT_KINDS,
    type MovieEventKind,
    type Tap,
    tapSchema,
} from "@genesiscz/utils/recording-editor/events";
import { TRANSITION_KINDS } from "@genesiscz/utils/recording-editor/fx";
import { findIdle } from "@genesiscz/utils/recording-editor/idle";
import { placedShape } from "@genesiscz/utils/recording-editor/item-ops";
import { DEFAULT_LANES, EFFECT_KINDS, type EffectLane } from "@genesiscz/utils/recording-editor/lanes";
import { CAPTION_KINDS, TEXT_ANIMATIONS } from "@genesiscz/utils/recording-editor/overlays";
import {
    outputTimeSchema,
    sourceTimeSchema,
    type TimeValue,
    type timeSchema,
    timeToUs,
} from "@genesiscz/utils/recording-editor/plan";
import { type FractionBox, PRIVATE_KINDS, PRIVATE_STYLES } from "@genesiscz/utils/recording-editor/private-data";
import {
    BACKGROUND_KINDS,
    CANVAS_ASPECTS,
    cameraOpSchema,
    describeProject,
    type EditOp,
    type EditProject,
    editOpSchema,
    FRAME_ALIGNS,
    FRAME_PRESETS,
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
    TEXT_ALIGNS,
    TEXT_MAX_CHARS,
    TEXT_STYLES,
    type TranscriptLine,
    transcriptCachePath,
    transcriptLines,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { SUBTITLE_FORMATS, type SubtitleFormat } from "@genesiscz/utils/recording-editor/subtitles";
import { type CutMatch, FILLER_LEVELS, type FillerLevel } from "@genesiscz/utils/recording-editor/transcript-cuts";
import { SPEED_BADGE_POSITIONS } from "@genesiscz/utils/recording-editor/waits";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { recorderSetSchema, settingsPatchOf } from "@genesiscz/utils/repl/toolsets/recorder";
import { readRecordingManifest, renameRecording } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, type LiveEntry, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { hasAudio, type MediaFacts, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { z } from "zod";
import { cameraRefusal, recorderFaceState } from "./camera-recorder";
import { type DemoDriver, type DemoStep, demoEditSchema, runDemo } from "./demo";
import { duplicateRecording } from "./duplicate";
import {
    collapseUndo,
    defaultExportName,
    EXPORT_FORMATS,
    type ExportFormat,
    type ExportRun,
    editProject,
    exportAs,
    exportProgressPrinter,
    openProject,
    previewTranscriptCuts,
    transcriptWords,
    undoDepth,
    undoEdit,
    writeSubtitles,
} from "./edit";
import { stepDisplaySwitch, switchDisplay } from "./frames-movie";
import { eventsOf, eventsOut, findText, privateData, snapOf, verifyHidden, waits } from "./fx-analysis";
import {
    EDITOR_TABS,
    type EditorTab,
    type LibraryRow,
    listLibrary,
    requireRecorderPart,
    resolveRecording,
} from "./library";
import {
    chaptersOf,
    clickGroupsOf,
    markersOf,
    recordedMarkersOf,
    recordingFolderOf,
    searchLibrary,
    spreadTimes,
} from "./moments";
import { serviceRoutedMovie } from "./movie-client";
import { copyRecording, revealRecording, trashRecording } from "./quick-actions";
import { commentOn, commentsOf, importBoardComments, resolveComment, uncomment } from "./review";
import { type ScreenHitWithOps, screenHitsWithOps } from "./screen-ops";
import { findOnScreen } from "./screen-search";
import { hostCloseEditor, hostOpenEditor, hostSheet, hostStill } from "./service-client";
import {
    checkTargetOnScreen,
    parseStartFlags,
    type RecordOptions,
    readStartArgs,
    recordOptionsSchema,
    startArgsOf,
} from "./start-options";

const { log } = logger.scoped("recorder-toolset");

/**
 * How long record() waits for the recording to run. A fresh checkout compiles ax-tool first (30 to 60 s, measured
 * 2026-11-05 in a new worktree), as GenesisKit's picker allows for with its own 120 s; a 20 s wait gave up while the
 * child went on and then recorded with no one to stop it.
 */
const START_TIMEOUT_MS = 120_000;
/** How long a recorder that passed its start gate before the wait ended may still take to record. */
const START_GRACE_MS = 30_000;
/** A gate a recorder never read (it died first) is swept after a day. */
const START_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FINISH_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const range = { from: sourceTimeSchema, to: sourceTimeSchema };
const focusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const zoomSchema = z
    .object({
        ...range,
        scale: z.number().min(1).max(4).optional(),
        focus: focusSchema.optional(),
        follow: z.boolean().optional(),
        lane: z.string().optional(),
        // R5 4 canvas zoom
        target: z.enum(["picture", "canvas"]).optional(),
    })
    .strict();

const demoParamsSchema = z
    .object({
        title: z.string().optional(),
        record: recordOptionsSchema.optional(),
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
    "{ path, revision, updatedBy, video, sourceSeconds, outputSeconds, clips, zooms, redactions, audio, export, clicks, frame, cursor, camera, captions, keys, transcriptFixes, motion, shapes, texts, lanes, transitions, lenses, tilt, warnings? }";

/** What every edit method returns, short: the full field list once, on info(), keeps describe()'s lines readable. */
const editResult = "{ summary, path, revision, outputSeconds, warnings? } (info() lists the whole edit)";

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

/** A rectangle as fractions of the picture from its top left (fx B: areas a hidden part leaves visible). */
const boxParamSchema = z
    .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0).max(1),
        height: z.number().min(0).max(1),
    })
    .strict();

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
        doc: 'What to look at before export(): items whose whole time is cut (they never show), a marker in cut time (no chapter: an edit marker comes with a move to the nearest kept moment, one set while it recorded is stood in for by an edit marker of its name), a text a cut shortens, a missing music file, captions, subtitles or ducking without a transcript, a part that follows a cursor the movie lacks, items too short to read, texts drawn over each other. "fix" issues come first, each with a call that fixes it when one does (`fix`, and the same as edit ops in `action.ops` for apply()); ok is true when there is no "fix" issue (the export works), clean when there is no issue at all. It changes nothing. An edit call whose cut hides an item or a marker, or shortens a text, says so in its own warnings too.',
        effect: "read",
    }),
    defineMethod({
        name: "fix",
        params: z.object({}),
        result: z.unknown(),
        resultName:
            "{ summary, path, revision, outputSeconds, warnings? } plus fixed (the issues check() no longer finds) and unchanged (the issues whose action changed nothing)",
        doc: "Runs every fix check() offers (each issue's action.ops: remove what never shows, move an edit marker a cut hides to the nearest kept moment, lengthen what is too short to read, move a text off another) in one save and one undo() step. Issues with no fix (a missing transcript or music file) stay; check() again lists them. An issue its action did not remove is reported as no change, never as fixed.",
        effect: "reversible",
    }),
    edit("split", z.object({ at: sourceTimeSchema }), "Splits the clip at a source time.", ["at"]),
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
        'Zooms over a source range: scale 1–4, focus {x,y} 0..1 from the top left, or follow: true for the cursor. target "canvas" zooms the whole framed export instead of the picture inside it (focus is then 0..1 of the canvas): a phone on the left of a 16:9 frame fills it with zoom({ from, to, scale: 2.5, focus: { x: 0.15, y: 0.5 }, target: "canvas" }). A canvas zoom may overlap a picture zoom; texts, captions and keys stay where they are.'
    ),
    edit("unzoom", z.object({ id: z.string() }), "Removes a zoom by its id.", ["id"]),
    edit(
        "redact",
        z
            .object({
                from: sourceTimeSchema,
                to: sourceTimeSchema,
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
                // R5 5 redaction edges
                cell: z.number().min(2).max(256).optional(),
            })
            .strict(),
        'Hides a rectangle of the SOURCE picture from `from` to `to` (source seconds or "m:ss"): rect { x, y, width, height } as 0...1 of the picture from its top left, style "blur" (default) | "pixelate" | "black" | "spotlight" (the rectangle stays sharp and the rest of the picture dims, to point at something), label (what it hides, "API token"), follow: true (it moves with the drawn cursor, centred on it; rect gives its size). It moves with a zoom. The result lists redactions with their ids. Edges: blur, pixelate and black never fade; they cover fully from the first frame of `from` to the last frame of `to`. The export keeps a part on while a frame from its time stays on screen (a screen recording writes no frame while nothing moves), draws a part that ends up to 250 ms before a cut up to the cut (and one that starts up to 250 ms after a cut from it), and joins two parts with a gap up to 250 ms (redactionJoins({ snapMs }) changes it, 0 turns it off); check() names every such hole and every part under 0.15 s. cell (pixelate only): a block\'s side in source pixels, 2 to 256 (default 1.8 % of the height, about 19 px at 1080p; 8 to 12 reads as a soft mosaic, 40 and up as big blocks).'
    ),
    edit("unredact", z.object({ id: z.string() }), "Removes a redaction by its id.", ["id"]),
    edit(
        "text",
        z
            .object({
                from: sourceTimeSchema,
                to: sourceTimeSchema,
                text: z.string().trim().min(1).max(TEXT_MAX_CHARS),
                x: z.number().min(0).max(1).optional(),
                y: z.number().min(0).max(1).optional(),
                size: z.number().min(0.02).max(0.15).optional(),
                style: z.enum(TEXT_STYLES).optional(),
                lane: z.string().optional(),
                // R4 6 animated texts
                animate: z
                    .object({ kind: z.enum(TEXT_ANIMATIONS), ms: z.number().int().min(100).max(5000).optional() })
                    .strict()
                    .optional(),
                // R5 10 multi-line texts
                block: z
                    .object({
                        width: z.number().min(0.15).max(0.95).optional(),
                        align: z.enum(TEXT_ALIGNS).optional(),
                    })
                    .strict()
                    .optional(),
            })
            .strict(),
        'animate { kind: "typewriter" | "slideUp" | "fade", ms (600) } is how it comes in (a fade by default). Puts a line of text over the picture from `from` to `to` (source seconds or "m:ss"): a title or a step\'s name. x, y is its centre as 0...1 of the CANVAS from the top left (0.5, 0.12, top middle, by default), so it stays put through a zoom; size is the text height as a fraction of the short side (0.055); style "plate" (white on a dark plate, default) | "plain" (white with a shadow). It fades in and out. The result lists texts with their ids. Several lines: "\\n" starts a new line (text: "Step 1\\nOpen the inbox"), and a line longer than the block wraps; the whole text is drawn, up to 500 characters (a longer one is refused, never cut). block { width: 0.15–0.95 of the canvas width (0.8), align: "left" | "center" | "right" } sets where the lines wrap and how they line up, e.g. block: { width: 0.35, align: "left" } for a callout beside a phone (frame({ preset: "phone-left" }), x 0.62). info().texts[].lines counts the lines it was written with.'
    ),
    edit("untext", z.object({ id: z.string() }), "Removes a text by its id.", ["id"]),
    edit(
        "retime",
        z
            .object({
                id: z.string(),
                at: sourceTimeSchema.optional(),
                by: z.number().optional(),
                from: sourceTimeSchema.optional(),
                to: sourceTimeSchema.optional(),
            })
            .strict(),
        'Moves or trims a zoom, hidden part, text or shape by its id (info() lists them). To MOVE it with its length kept: `at` (its new start) or `by` (seconds, negative is earlier). To TRIM it: `from` and/or `to` set a new start or end, so `from` alone makes it longer or shorter. Source seconds or "m:ss". retime({ id: "z1", at: 1 }), retime({ id: "t1", by: 2 }), retime({ id: "s1", to: 9 }).'
    ),
    edit(
        "fixLine",
        z.object({ from: sourceTimeSchema, text: z.string().max(300) }).strict(),
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
                .array(z.object({ at: sourceTimeSchema, text: z.string().max(300) }).strict())
                .min(1)
                .max(500),
        }),
        "Corrects many transcript lines at once, saved once and undone with one undo(): [{ at, text }] where at is any source time inside the line (a line's from from transcript()). Use it to polish a whole transcript: read transcript(), then send only the lines whose words change. A time where nobody speaks is refused with the nearest lines, and nothing is saved.",
        ["fixes"]
    ),
    edit(
        "unfixLine",
        z.object({ from: sourceTimeSchema }).strict(),
        "Drops the correction of the line that starts at `from`.",
        ["from"]
    ),
    edit(
        "autoZoom",
        z.object({ scale: z.number().min(1).max(4).optional() }).strict(),
        "One zoom per group of recorded clicks (the groups clickGroups() lists), following the cursor; replaces earlier auto zooms, keeps manual ones, and throws when there are no clicks."
    ),
    edit(
        "titleMarkers",
        z
            .object({
                seconds: z.number().min(0.5).max(15).optional(),
                numbered: z.boolean().optional(),
                y: z.number().min(0).max(1).optional(),
                // R4 6 animated texts
                animate: z
                    .object({ kind: z.enum(TEXT_ANIMATIONS), ms: z.number().int().min(100).max(5000).optional() })
                    .strict()
                    .optional(),
            })
            .strict(),
        'Puts each marker\'s label on screen as a step title for `seconds` (2.5), "1. Open the settings" (numbered: false drops the number), at the top middle (y 0...1 of the canvas, 0.12): one text per marker in the kept movie, saved once, one undo(). A marker that has a text already is left alone, so running it again adds nothing. Throws when there is no marker.'
    ),
    edit(
        "annotateClicks",
        z
            .object({
                from: sourceTimeSchema.optional(),
                to: sourceTimeSchema.optional(),
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
    edit(
        "mute",
        z.object({ track: z.number().int().nonnegative() }),
        "Mutes an audio track (0 is the first); a movie whose video has no audio track is refused.",
        ["track"]
    ),
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
                from: sourceTimeSchema,
                to: sourceTimeSchema,
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
                from: sourceTimeSchema,
                to: sourceTimeSchema,
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
                from: sourceTimeSchema,
                to: sourceTimeSchema,
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
                // R5 5 redaction edges
                fadeMs: z.number().int().min(0).max(2000).optional(),
            })
            .strict(),
        'Points at a part of the picture from `from` to `to` (source seconds or "m:ss"): rect { x, y, width, height } (0...1 of the picture from its top left) stays as it is and everything around it dims; follow: true moves it with the cursor (a light on the pointer); dim 0.2 to 0.95 is how much black covers the rest (0.7; 0.5 leaves it at half), cutout "rounded" (default), "rect" or "circle" its lit shape (a circle is the ellipse inside rect, so give a square rect in pixels for a round one). The dim fades in after `from` and out before `to` over fadeMs (200, at most a third of its length, linear); fadeMs: 0 is a hard cut. The same as redact with style "spotlight" (op "spotlight" in apply); unredact(id) removes it.'
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
        "Removes an effect lane; its items move to the next lane that holds their kind. The last lane that holds zooms is refused.",
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
                from: outputTimeSchema,
                to: outputTimeSchema,
                action: z.enum(RANGE_ACTIONS),
                factor: z.number().min(0.25).max(16).optional(),
                scale: z.number().min(1).max(4).optional(),
                text: z.string().trim().min(1).max(200).optional(),
                lane: z.string().optional(),
            })
            .strict(),
        'Does what the editor\'s range popover does over `from`..`to` in OUTPUT seconds or "m:ss" (what plays, as the ruler shows it, so after cuts and speed changes): action "cut", "speed" (factor, 2), "zoom" (scale), "hide" or "spotlight" (the middle of the picture; redact and spotlight take a rect), or "text" (text, "Title"), or "marker" (a marker at from, named text or "Marker <n>"). lane puts the new item on an effect lane. Export such a part with export({ from, to }).'
    ),
    edit(
        "marker",
        z.object({ at: sourceTimeSchema, label: z.string().trim().min(1).max(80).optional() }).strict(),
        'A marker in the edit at `at` (SOURCE seconds or "m:ss"), named label or "Marker <n>": the marks lane, step titles and chapters show it beside the recording\'s own markers; markers() lists it with its id.',
        ["at", "label"]
    ),
    edit(
        "unmarker",
        z.object({ id: z.string() }).strict(),
        "Removes a marker set while editing, by the id markers() gives it; the recording's own markers stay.",
        ["id"]
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
        'Draws each recorded click as a disc that grows and fades: highlight, color "#RRGGBB", radius (a fraction of the height, 0.03), durationMs (450); sound: true adds a soft tick at each click to the sound (off by default). It draws the clicks; clickGroups() reads them.'
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
                // R5 4 frame layouts
                layout: z
                    .object({ align: z.enum(FRAME_ALIGNS).optional(), scale: z.number().min(0.5).max(3).optional() })
                    .strict()
                    .optional(),
                preset: z.enum(FRAME_PRESETS).optional(),
            })
            .strict(),
        'Puts the movie on a background: aspect (the canvas: "16:9", "4:3", "1:1", "9:16" or "source"; its short side is the movie height), fit ("contain" the whole movie, or "cover": cropped to fill the room inside the padding, following the cursor; padding 0 for edge to edge), padding (0.06 of the short side), cornerRadius (0.012), shadow, background { kind: "gradient" | "color" | "image" | "none", colors, image (a picture file; kind image), blur (0–1) }; enabled: false removes it. layout { align: "center" | "left" | "right" | "top" | "bottom", scale: 0.5–3 } places the picture against one edge (inside the padding) and sizes it (above 1 the canvas cuts what does not fit). preset sets aspect, padding, corner radius and layout for a phone recording, and the call\'s own fields win: "phone-left" / "phone-right" (16:9, the phone against one side, the other three quarters free for texts at x 0.62 or 0.38), "phone-portrait" (9:16, the phone from the top with the bottom eighth free for captions, for Shorts). Example: frame({ preset: "phone-left", layout: { scale: 1.1 } }), then text({ from, to, text: "Line one\\nLine two", x: 0.64 }).'
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
                at: sourceTimeSchema,
                words: z.string().min(1),
                occurrence: z.number().int().min(1).optional(),
                padMs: z.number().int().min(0).max(500).optional(),
                dryRun: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ …info() } | { from, to, text, line, estimated, plays }[] (dryRun)",
        doc: "Cuts words out of the transcript line spoken at `at` (any source time inside it, a line's from from transcript() or find()): words \"you know\" cuts every place the line says them, occurrence: 2 only the second place (the editor's word pick does this). A word's time comes from the provider's word times, else it is estimated from where its letters sit in the line (estimated: true; check with still() or sheet()). dryRun: true lists the cuts and saves nothing. One undo() puts it back.",
        effect: "reversible",
    }),
    defineMethod({
        name: "lineWords",
        params: z.object({ at: sourceTimeSchema.optional() }).strict(),
        result: z.unknown(),
        resultName: "{ start, end, text, plays, words: { word, fold, start, end, estimated }[] }[]",
        doc: "The words of every transcript line (or of the line spoken at `at`) as cutWords splits and times them: pick words, then cutWords({ at: line.start, words, occurrence }), where occurrence counts the earlier places of the same folded words in that line.",
        effect: "read",
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
        "Turns the room and fan noise of the sound down on export (ffmpeg afftdn): reductionDb 12 by default (8 is gentle, 20+ starts to blur words), on every audio track or only tracks (0 is the first; a screen recording's microphone is its last); trackReductionDb { 1: 20 } gives a track (here the second) its own strength (merged with earlier ones). The export renders from a cleaned copy of the movie, made once per setting under .denoise/ beside it. enabled: false takes it away. A movie whose video has no audio track is refused."
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
                from: outputTimeSchema.optional(),
                to: outputTimeSchema.optional(),
                subtitles: z.enum(SUBTITLE_FORMATS).optional(),
                // R5 3 export overwrite, size, progress
                overwrite: z.boolean().optional(),
                size: z
                    .object({
                        width: z.number().int().min(16).max(8192).optional(),
                        height: z.number().int().min(16).max(8192).optional(),
                    })
                    .strict()
                    .optional(),
                onProgress: z.custom<(fraction: number) => void>((value) => typeof value === "function").optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, bytes, outputSeconds, width, height, renderSeconds, replaced?, subtitles? }",
        doc: 'Renders the edit with the editor\'s renderer to format "mp4" (default), "gif" (10 fps, at most 960 wide) or "webm"; from/to (OUTPUT seconds, what plays) export only that part and leave the edit as it is. subtitles "srt" | "vtt" also writes the transcript beside it in the movie\'s time (default: the edit\'s export.subtitles). An MP4 gets the recording\'s markers as chapters (chapters: the count) unless exportSettings { chapters: false }. warnings also carries what check() says must be fixed (an item whose time is cut, missing music). Without overwrite it throws when the file exists; overwrite: true replaces out (or, without out, the usual "<title>.mp4" beside the movie) in one step, after the new movie is complete (replaced: true says it did). size { width } or { height } (or both, in the canvas\'s shape) sets the picture\'s exact pixels, e.g. { height: 1080 }; absent follows exportSettings({ maxHeight }) and keeps the frame rate H.264 can hold (a 2698×1516 export came from that budget). onProgress(fraction) is called about once a percent; the run also logs "export 30%" lines every 10 %. Example: await movie.export({ out: "/tmp/demo.mp4", overwrite: true, size: { height: 1080 } }).',
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
            "; cached beside the movie, refresh: true transcribes again. A run without the cache is a paid transcription and may ask the user for the AI vault key; a video recorded without sound is refused.",
        effect: "reversible",
        reaches: ["paid", "user"],
    }),
    defineMethod({
        name: "poster",
        params: z.object({ at: outputTimeSchema.optional(), out: z.string().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ path, width, height }",
        doc: "One frame of the edit at OUTPUT seconds `at` (0), rendered at the export's full size with every look, as a PNG for a video thumbnail or a README: at out, or beside the movie as <export name>-poster.png (never over a file). still() is the quick preview-size look.",
        effect: "reversible",
    }),
    defineMethod({
        name: "sheet",
        params: z
            .object({
                from: outputTimeSchema.optional(),
                to: outputTimeSchema.optional(),
                count: z.number().int().min(1).max(12).optional(),
                at: z.array(outputTimeSchema).min(1).max(12).optional(),
                out: z.string().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, width, height, times }",
        doc: "One picture of several frames of the edit as it exports, in rows of three, each labelled with its OUTPUT time: count (6) frames spread over from…to (the whole edit), or the times in at. One call to check a whole edit after a change, instead of a still() per moment. out keeps the PNG at that path (the REPL's own copy goes when the run ends).",
        effect: "reversible",
    }),
    defineMethod({
        name: "itemsAt",
        params: z.object({ at: outputTimeSchema }),
        positional: ["at"],
        result: z.unknown(),
        resultName: "{ output, source, zoom, redactions, texts, shapes, caption }",
        doc: "What plays at OUTPUT seconds `at` (as still() and show() take it), in words: the source time there, the zoom (or null), the hidden parts and spotlights, texts and shapes on screen (as info() lists them, with their ids for retime() or untext(), plus `plays: { from, to }` in output seconds, null where cut), and the caption line (or null). A cheap way to check an edit without a picture.",
        effect: "read",
    }),
    defineMethod({
        name: "still",
        params: z.object({ at: outputTimeSchema.optional(), out: z.string().optional() }),
        positional: ["at", "out"],
        result: z.unknown(),
        resultName: "{ path, width, height }",
        doc: "Shows one frame of the edit as it exports (zoom, clicks, cursor, captions, shortcuts, frame style) at OUTPUT seconds (what plays), so you can look at a change. Without `out` the PNG goes to the run's scratch folder and is gone after the run; give `out` (a .png path) to keep it. It renders at preview size (at most 1080 pixels on the short side), so its size can differ from export()'s, which follows the export settings; the picture is the same.",
        effect: "reversible",
    }),
    defineMethod({
        name: "find",
        params: z.object({ text: z.string().min(1) }),
        positional: ["text"],
        result: z.unknown(),
        resultName: "{ from, to, plays, text }[]",
        doc: "The lines of the cached transcript that hold the text (case and accents ignored); cut one with cut(line.from, line.to). Without a transcript it throws: transcript() makes one (a paid run), find() never does.",
        effect: "read",
    }),
    defineMethod({
        name: "switchDisplay",
        params: z
            .object({ from: sourceTimeSchema, to: sourceTimeSchema, display: z.number().int().nonnegative() })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, frames, plan: { policy, windowSec, ranges: { fromUs, toUs, displayId }[] } }",
        doc: `A frames recording of several displays (a meeting): its proxy movie shows \`display\` from \`from\` to \`to\` (source seconds or "m:ss") and is made again, the rest of its display plan (proxy.json) kept. The same as ${toolCommand("recorder proxy")} <rec> --keep-plan --switch from-to=display, and the editor's display lane. undoDisplaySwitch() takes it back.`,
        effect: "reversible",
    }),
    defineMethod({
        name: "undoDisplaySwitch",
        params: z.object({}).strict(),
        result: z.unknown(),
        resultName: "{ path, frames, plan: { policy, windowSec, ranges: { fromUs, toUs, displayId }[] } }",
        doc: `Takes the last display switch back: the proxy movie is made again with the display plan from before it (proxy.undo.json keeps each switch). Refused when proxy.json changed since in another way. The same as ${toolCommand("recorder proxy")} <rec> --undo-switch, and the editor's ⌘Z after a switch.`,
        effect: "reversible",
    }),
    defineMethod({
        name: "redoDisplaySwitch",
        params: z.object({}).strict(),
        result: z.unknown(),
        resultName: "{ path, frames, plan: { policy, windowSec, ranges: { fromUs, toUs, displayId }[] } }",
        doc: `Makes the last undone display switch again. The same as ${toolCommand("recorder proxy")} <rec> --redo-switch, and the editor's ⇧⌘Z.`,
        effect: "reversible",
    }),
    defineMethod({
        name: "findOnScreen",
        params: z.object({ text: z.string().min(1), limit: z.number().int().positive().optional() }).strict(),
        result: z.unknown(),
        resultName:
            "{ sec, untilSec, displayId, file, lines, shown, boxes: { text, x, y, width, height }[], ops: { hide, mark, cut } }[]",
        doc: "Where a text was on the screen of a frames recording (a meeting, or a library recording with OCR): each frame whose OCR holds it (case and accents ignored), at source seconds until untilSec (its next frame), with the matching lines; shown: the proxy movie shows that display then; boxes: those lines over the proxy movie as fractions of its picture. ops names what a hit can become, for apply({ ops }): ops.hide[i] blurs boxes[i] and ops.mark[i] draws a box round it while the frame shows, ops.cut cuts the frame's time (all empty when the movie does not show it); the editor's Find tab sends the same ops. Jump there with show({ at: sec }).",
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
        name: "clickGroups",
        params: z.object({ gapSeconds: z.number().min(0.1).max(60).optional() }),
        result: z.unknown(),
        resultName: "{ from, to, count, plays: { from, to } | null, cut }[]",
        doc: "The recorded clicks in groups, as autoZoom() groups them (a click under gapSeconds, default 3, after the one before joins its group), in time order. from and to are SOURCE seconds of the first and last click; plays is where they play in OUTPUT seconds (the first and last click not cut, null when a cut hides all of them); cut counts the clicks in cut time. Sort by count for the part with the most clicking. Throws when the movie has no cursor track. Reads only.",
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
                at: outputTimeSchema,
                to: outputTimeSchema.optional(),
                text: z.string().min(1).max(2000),
                author: z.string().max(80).optional(),
                link: z.string().url().optional(),
                annotation: z.number().int().positive().optional(),
                source: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, comment }",
        doc: "A review comment at `at` (to: the end of a range) in OUTPUT seconds or \"m:ss\", what plays, as a reviewer of the export sees it; source: true takes times of the recording itself. link: the page it came from (a vitrinka annotation's link, a board, a PR); annotation: that annotation's number on the board link names, so the comment opens it. The editor window shows it at once.",
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
        name: "importComments",
        params: z
            .object({
                board: z.string().min(1),
                card: z.number().int().positive().optional(),
                dryRun: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName:
            "{ path, board, card?, dryRun, added: comment[], wouldAdd: planned[], untimed, alreadyImported, notOnScreens }",
        doc:
            "Imports a vitrinka board's annotations as review comments (" +
            toolCommand("recorder comment import") +
            " does the same): board is its link (a ?card= link picks that card), <workspace>/<slug>, or a bare slug, which is looked up in the vitrinka CLI's default workspace (name the workspace for a board elsewhere); card: only that card. Each annotation on a shot, movie or step card lands at the OUTPUT time its text starts with (0:42, 1:02:03, 42s), else at 0:00 with a note that says so; a resolved one is resolved. A second import adds nothing (each comment keeps the annotation's link). dryRun: true reads the board and writes nothing.",
        effect: "reversible",
    }),
    defineMethod({
        name: "copy",
        params: z.object({ gif: z.boolean().optional() }).strict(),
        result: z.unknown(),
        resultName: '{ path, kind: "movie" | "gif", exported }',
        doc: "Puts the recording's movie on the clipboard as a file (the newest export beside it, else its own movie), so a paste in Finder, Slack or Mail gets it; it replaces what the user's clipboard held. gif: true copies a GIF of the edit, exporting one when none is newer than the edit (exported says so). The menu bar's Recent list and the library window do the same.",
        effect: "destructive",
        reaches: ["user"],
    }),
    defineMethod({
        name: "reveal",
        params: z.object({ meeting: z.boolean().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ revealed }",
        doc: "Shows the recording's folder in a Finder window and brings Finder to the front; meeting: true shows its meeting's meeting.json (a meeting's screen recording only).",
        effect: "reversible",
        reaches: ["user"],
    }),
    defineMethod({
        name: "trash",
        params: z.object({}).strict(),
        result: z.unknown(),
        resultName: "{ trashed }",
        doc: `Moves a library recording through the shared removal policy and recovery trash. Use ${toolCommand("rm", "trash")} to find its restore command. A meeting's screen recording is refused: its folder holds the whole meeting.`,
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
        reaches: ["user"],
    }),
    defineMethod({
        name: "closeEditor",
        params: z.object({}).strict(),
        result: z.unknown(),
        resultName: "{ closed, window? }",
        doc: "Closes the edit's recorder window, as its close button does (show() opens it); closed: false when no window shows it. Refused (1021) while the window has a drag not saved yet or an export running.",
        effect: "reversible",
        reaches: ["user"],
    }),
    // R4 voiceover clips
    edit(
        "voiceover",
        z
            .object({
                at: sourceTimeSchema.optional(),
                file: z.string().min(1).optional(),
                volume: z.number().min(0).max(2).optional(),
                label: z.string().max(200).optional(),
                id: z.string().optional(),
            })
            .strict(),
        'Plays a sound file (mp3, wav, aiff, m4a) from SOURCE time `at` (seconds or "m:ss") at its own speed, mixed into the preview and the export: a narration. volume 0 to 2 (1), label names it ("Intro"). With id (from info().voiceovers) it changes that clip instead: a new at moves it, a new file replaces it. The music drops under it (ducking()). unvoiceover(id) removes it. info().voiceovers lists each with plays (its OUTPUT second, null when its start is cut).'
    ),
    edit("unvoiceover", z.object({ id: z.string() }).strict(), "Removes a voiceover clip by its id.", ["id"]),
    defineMethod({
        name: "say",
        params: z
            .object({
                at: sourceTimeSchema,
                text: z.string().trim().min(1).max(2000),
                provider: z.enum(["xai", "openai", "macos"]).optional(),
                voice: z.string().optional(),
                rate: z.number().min(0).max(2).optional(),
                volume: z.number().min(0).max(2).optional(),
                label: z.string().max(200).optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: `${editResult.replace(" }", ", voiceover: { id, file, seconds } }")}`,
        doc: 'Speaks `text` into a sound file with `tools say --output` (provider "xai" by default, voice and rate as tools say takes them; it costs a cloud call) in the recording\'s voiceovers/ folder, then adds it as a voiceover at SOURCE time `at`, like voiceover(). Nothing plays aloud. A cloud failure throws (no fallback to the macOS voice).',
        effect: "reversible",
    }),
    // R4 8 music ducking
    edit(
        "ducking",
        z
            .object({
                db: z.number().min(0).max(40).optional(),
                fadeMs: z.number().int().min(0).max(5000).optional(),
                transcript: z.boolean().optional(),
                voiceovers: z.boolean().optional(),
                enabled: z.boolean().optional(),
            })
            .strict(),
        "How far the music drops while someone speaks: db quieter (12), reached over fadeMs (300), under the transcript's lines (transcript, true) and under the voiceover clips (voiceovers, true). Without it the music's older duck share applies (to both). enabled: false removes it."
    ),
    // R4 6 animated captions
    edit(
        "captionsStyle",
        z
            .object({
                kind: z.enum(CAPTION_KINDS).optional(),
                color: hexColor.optional(),
                enabled: z.boolean().optional(),
            })
            .strict(),
        'How the captions animate: kind "karaoke" (the default once set) colours each word as it is said, in color ("#FFD60A"), from the transcript\'s word times (cut-words uses the same; estimated from the letters when the transcription has none); "line" shows each line at once. Captions themselves are captions({ show: true }). enabled: false goes back to plain lines.'
    ),
    // R4 10 progress bar and chapter strip
    edit(
        "progress",
        z
            .object({
                show: z.boolean().optional(),
                color: hexColor.optional(),
                height: z.number().min(0.002).max(0.03).optional(),
                chapters: z.boolean().optional(),
                chapterMs: z.number().int().min(500).max(10_000).optional(),
                enabled: z.boolean().optional(),
            })
            .strict(),
        "A thin bar along the bottom of the movie (preview and export) showing how much has played, in color (\"#FFFFFF\"), height a share of the short side (0.008), divided at the markers (the recording's and the edit's, markers()); with chapters (true) each marker's label shows at the top left for chapterMs (2000) when it starts. show: false hides it and keeps the settings; enabled: false removes it."
    ),
    // R4 9 intro and end cards
    edit(
        "introCard",
        z
            .object({
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
        'A title card the export plays BEFORE the movie for seconds (3): title (needed the first time), subtitle, logo (a picture file; "" removes it) and date (any text), on the frame\'s background (frame(); a gradient without one). The preview plays the movie alone; still({ card: "intro" }) is not a thing: export() shows it. A part export (from/to) leaves the cards out. Subtitles and chapters written with the export move by its length. enabled: false removes it.'
    ),
    edit(
        "endCard",
        z
            .object({
                text: z.string().trim().min(1).max(200).optional(),
                link: z.string().max(300).optional(),
                qr: z.boolean().optional(),
                seconds: z.number().min(0.5).max(15).optional(),
                /** false removes the card. */
                enabled: z.boolean().optional(),
            })
            .strict(),
        "A card the export plays AFTER the movie for seconds (3): text (needed the first time), a link under it and, with qr: true, a QR code of the link, on the frame's background. enabled: false removes it."
    ),
    // Round 4 fx-render: transitions at cuts, the magnifier lens, the 3D tilt (src/utils/recording-editor/fx.ts).
    edit(
        "transition",
        z
            .object({
                kind: z.enum([...TRANSITION_KINDS, "default"]).optional(),
                ms: z.number().int().min(50).max(2000).optional(),
                clip: z.string().optional(),
            })
            .strict(),
        'The transition at the joins of two clips (a cut; a split alone joins nothing): kind "none" (a hard cut, the default), "crossfade", "zoom" (zooms through) or "blur" (a blurred wipe), ms its whole length centred on the join (300). Without clip it sets the edit-wide default; with clip (the id of the clip that starts at the join, from info().transitions.joins) only that join, and kind "default" gives it the default back. Every duration stays: the transition blends each side with a still of the other.'
    ),
    edit(
        "lens",
        z
            .object({
                from: sourceTimeSchema,
                to: sourceTimeSchema,
                radius: z.number().min(0.04).max(0.4).optional(),
                magnification: z.number().min(1.5).max(4).optional(),
                follow: z.boolean().optional(),
                at: z
                    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                    .strict()
                    .optional(),
                ring: z.string().optional(),
            })
            .strict(),
        'A round magnifier lens from `from` to `to` (SOURCE seconds): radius (a fraction of the picture\'s short side, 0.12), magnification 1.5 to 4 (2), ring "#RRGGBB" (white). It follows the cursor (a movie without a cursor track holds the middle) unless `at` { x, y } (0 to 1 of the source picture) or follow: false. A ring and a soft shadow; the rest of the picture stays visible. info().lenses lists them with their ids.'
    ),
    edit(
        "setLens",
        z
            .object({
                id: z.string(),
                from: sourceTimeSchema.optional(),
                to: sourceTimeSchema.optional(),
                radius: z.number().min(0.04).max(0.4).optional(),
                magnification: z.number().min(1.5).max(4).optional(),
                follow: z.boolean().optional(),
                at: z
                    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
                    .strict()
                    .optional(),
                ring: z.string().optional(),
            })
            .strict(),
        "Changes a lens by its id: its range, radius, magnification, ring, or where it stays (`at` stops it following the cursor unless follow: true)."
    ),
    edit("unlens", z.object({ id: z.string() }).strict(), "Removes a lens by its id.", ["id"]),
    edit(
        "tilt",
        z
            .object({
                enabled: z.boolean().optional(),
                strength: z.number().min(0).max(1).optional(),
                drift: z.boolean().optional(),
                tiltIn: z.boolean().optional(),
                tiltOut: z.boolean().optional(),
                inMs: z.number().int().min(100).max(5000).optional(),
                outMs: z.number().int().min(100).max(5000).optional(),
            })
            .strict(),
        "The 3D tilt camera: a slight perspective tilt of the framed picture and its shadow (strength 0 to 1, 0.5), drifting slowly (drift, on), tilting in over the first inMs (1200) and out over the last outMs (1200). Best with a frame (frame()); without one the picture tilts over black. enabled: false removes it."
    ),
    // fx B (round 4): private data, smooth cursor, typing and waiting speed-ups.
    defineMethod({
        name: "privateData",
        params: z
            .object({
                names: z.array(z.string().trim().min(2).max(120)).max(50).optional(),
                exclude: z.array(boxParamSchema).max(20).optional(),
                excludeFixed: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName:
            "{ id, kind, label, masked, from, to, plays, box: { x, y, width, height }, moves, exclude?, hidden }[]",
        doc: 'The private data on the screen: emails, tokens and keys, phone numbers, IBANs and card numbers (and names you pass) in the text of its frames, read with Vision on this Mac (a movie: one frame a second, then five a second around each hit\'s edges and while it moves; cached beside the edit; the first scan of a long movie takes minutes). One hit per value while it shows, at source seconds, tracked through a scroll (moves: true; its hidden part follows the text). masked shows only the first and last two characters. exclude: areas never searched and left visible (a toast); excludeFixed: true finds what stays still while the content scrolls and leaves it visible. hidePrivate({ ids }) hides them; kind is "email" | "token" | "phone" | "iban" | "card" | "name".',
        effect: "read",
    }),
    edit(
        "hidePrivate",
        z
            .object({
                ids: z.array(z.string()).optional(),
                kinds: z.array(z.enum([...PRIVATE_KINDS, "name"])).optional(),
                style: z.enum(PRIVATE_STYLES).optional(),
                names: z.array(z.string().trim().min(2).max(120)).max(50).optional(),
                exclude: z.array(boxParamSchema).max(20).optional(),
                excludeFixed: z.boolean().optional(),
            })
            .strict(),
        'Hides the private data privateData() lists (pass the same names, exclude and excludeFixed): one blurred part per hit that starts and ends when the value shows and follows it through a scroll (style "pixelate" or "black" instead). ids picks hits (absent: all), kinds picks kinds; a hit hidden before is skipped. Check the result with verifyHidden({ private: true }). One undo() puts it back.'
    ),
    defineMethod({
        name: "findText",
        params: z
            .object({
                text: z.string().trim().min(1).max(200).optional(),
                pattern: z.string().min(1).max(200).optional(),
                exclude: z.array(boxParamSchema).max(20).optional(),
                excludeFixed: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ id, label, masked, from, to, plays, box, moves, exclude?, hidden }[]",
        doc: "Every place a text (without case) or a pattern (a regular expression) shows on the screen, tracked as privateData() tracks a hit: what hideText() will hide, so you never guess coordinates or seconds.",
        effect: "read",
    }),
    edit(
        "hideText",
        z
            .object({
                text: z.string().trim().min(1).max(200).optional(),
                pattern: z.string().min(1).max(200).optional(),
                from: sourceTimeSchema.optional(),
                to: sourceTimeSchema.optional(),
                style: z.enum(PRIVATE_STYLES).optional(),
                exclude: z.array(boxParamSchema).max(20).optional(),
                excludeFixed: z.boolean().optional(),
                label: z.string().max(60).optional(),
            })
            .strict(),
        "Hides every place a text or a pattern shows (between from and to, source seconds; absent: all): one hidden part per place, found by OCR, that starts and ends when the text shows and follows it through a scroll. exclude and excludeFixed leave a toast or a tab bar over it visible. Refused when the screen never shows it. Check with verifyHidden({ text })."
    ),
    defineMethod({
        name: "verifyHidden",
        params: z
            .object({
                text: z.string().trim().min(1).max(200).optional(),
                pattern: z.string().min(1).max(200).optional(),
                private: z.boolean().optional(),
                names: z.array(z.string().trim().min(2).max(120)).max(50).optional(),
                everySeconds: z.number().min(0.1).max(5).optional(),
                movie: z.string().min(1).optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ ok, movie, frames, leaks: { at, until, label, masked, box }[] }",
        doc: "Checks the OUTPUT: exports the edit (or reads movie, an export you made), reads its frames with Vision every everySeconds (0.25) and lists every moment (output seconds) where text, pattern or the private data (private: true, the default without text or pattern; names too) is still readable. ok: true means nothing leaked. Run it before you hand an export over.",
        effect: "read",
    }),
    edit(
        "smoothCursor",
        z
            .object({
                enabled: z.boolean().optional(),
                strength: z.number().min(0).max(1).optional(),
                jitterPx: z.number().min(0).max(20).optional(),
                idleFadeSeconds: z.number().min(0).max(30).optional(),
            })
            .strict(),
        "The smooth cursor (a movie with a drawn cursor): the path follows an averaged curve, strength 0 to 1 (0.6; 1 averages over ±400 ms), moves under jitterPx points (3) are dropped, and the cursor fades after idleFadeSeconds (2; 0 keeps it) without a move. The cursor still sits exactly on each click. enabled: false turns it off (the cursor's own smoothing applies again)."
    ),
    defineMethod({
        name: "waits",
        params: z
            .object({
                minSeconds: z.number().min(1).max(600).optional(),
                maxArea: z.number().min(0).max(0.5).optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: '{ id, kind: "still" | "typing", from, to, seconds, speed, saves, plays, region }[]',
        doc: "The typing and waiting stretches: where only a small part of the picture changes (at most maxArea of it per quarter second, 0.06: typing, a spinner, a progress bar) or nothing does, for at least minSeconds (4), inside the kept parts at normal speed and away from clicks, cursor moves and speech. Each has a proposed speed (4x to 8x, longer is faster), the seconds it saves and the region that changed. The picture is compared once and cached in waits.json. speedUpWaits({ ids }) applies them.",
        effect: "read",
    }),
    edit(
        "speedUpWaits",
        z
            .object({
                ids: z.array(z.string()).optional(),
                minSeconds: z.number().min(1).max(600).optional(),
                maxArea: z.number().min(0).max(0.5).optional(),
                speed: z.number().min(1.5).max(16).optional(),
            })
            .strict(),
        'Speeds up the stretches waits() lists, each at its proposed speed (or at speed), and turns on the "⏩ 6x" badge over them. ids picks stretches (absent: all; the same minSeconds and maxArea as the list). One undo() puts it back.'
    ),
    edit(
        "speedBadge",
        z
            .object({
                badge: z.boolean().optional(),
                position: z.enum(SPEED_BADGE_POSITIONS).optional(),
            })
            .strict(),
        'The "⏩ 6x" badge drawn while a part plays at 1.5x or faster: badge false hides it, position "top-right" (default), "top-left", "bottom-right" or "bottom-left".'
    ),
    defineMethod({
        name: "duplicate",
        params: z
            .object({ title: z.string().trim().min(1).max(120).optional(), to: z.string().min(1).optional() })
            .strict(),
        result: z.unknown(),
        resultName: "{ path, folder, id?, title }",
        doc: 'A copy of the recording with its edit, so a before and an after live side by side: a new library recording titled "<title> (copy)" (or title), or the folder `to`. Its files are APFS clones (no disk until one side changes), every path in its edit points into the copy, and the undo history stays behind. movies.open(id) opens the copy.',
        effect: "reversible",
    }),
    // fx B (round 4): events, so effects land on what happens on screen instead of on guessed seconds.
    defineMethod({
        name: "events",
        params: z
            .object({ kinds: z.array(z.enum(MOVIE_EVENT_KINDS)).optional(), taps: z.array(tapSchema).optional() })
            .strict(),
        result: z.unknown(),
        resultName: '{ kind: "scene" | "scroll" | "still" | "click" | "tap", index, at, to?, plays, shift?, x?, y? }[]',
        doc: 'What happens on screen, at source seconds: scene changes (most of the picture changes at once), scrolls (shift: the share of the picture\'s height the content moved, down positive), still stretches (1 s or more), clicks from the cursor track, and taps you pass ({ at, x?, y? }, for a movie without a cursor track such as a simulator). index counts per kind from 1. Place an effect on one: zoom({ from: (await snap({ event: "scene", index: 3, lead: -0.2 })).at, … }). The picture is compared once and cached in waits.json.',
        effect: "read",
    }),
    defineMethod({
        name: "snap",
        params: z
            .object({
                at: z.number().nonnegative().optional(),
                event: z.enum(MOVIE_EVENT_KINDS).optional(),
                index: z.number().int().optional(),
                lead: z.number().min(-60).max(60).optional(),
                end: z.boolean().optional(),
                kinds: z.array(z.enum(MOVIE_EVENT_KINDS)).optional(),
                taps: z.array(tapSchema).optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ at, event, edge? }",
        doc: "A source time on screen: { at } moves a guessed second to the nearest event (of kinds, when given; a stretch counts by its start or its end); { event, index, lead?, end? } names one (index 1 is the first, -1 the last; lead -0.2 starts 0.2 s before it; end: a stretch's end). Use the answer's at in zoom(), spotlight(), text(), shape() or hideText().",
        effect: "read",
    }),
    // R5 5 redaction edges
    edit(
        "redactionJoins",
        z.object({ snapMs: z.number().int().min(0).max(2000) }).strict(),
        "How the export closes small holes around the hiding parts (blur, pixelate, black): a part that ends up to snapMs (250) before a cut is drawn to the cut, one that starts up to snapMs after a cut is drawn from it, and two parts with a gap up to snapMs meet. snapMs: 0 draws every part exactly as placed. Whatever it says, a part stays on while a frame from its time stays on screen. info().redactionJoins reads it.",
        ["snapMs"]
    ),
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
        resultName: "{ settings, audio, fixed }",
        doc: "The movie's rates (activeFps, idleFps: the same as activeFps when it keeps one rate) and threshold, its audio, and fixed: the keys a movie keeps as they are, with why.",
        effect: "read",
    }),
    defineMethod({
        name: "setSettings",
        params: recorderSetSchema,
        result: z.unknown(),
        resultName: "{ settings, audio, applied, fixed }",
        doc: 'Changes fps, idleFps or threshold while it records: the running segment ends and the next one records with them (applied "restart", a gap of about a second while it arms; "next-piece" while paused). A movie keeps maxLongSide, heartbeatSec and ocr as they are, and refuses them by name.',
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
        "Record the screen as a movie, then cut, speed up, zoom and export it; the recorder window shows each edit. Use it for a demo video; recorder and editor are the lower-level frames tools.",
    methods: [
        defineMethod({
            name: "list",
            params: z.object({ limit: z.number().int().positive().optional() }).strict(),
            result: z.unknown(),
            resultName: "{ id, title, folder, startedAt, seconds, bytes, movie?, edited }[]",
            doc: "The recordings library, newest first. `seconds` is the recording's length (null while it runs); `bytes` is its movie's size (null without a movie).",
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
            params: recordOptionsSchema,
            result: z.unknown(),
            resultName: "MovieRecording",
            doc: `Starts a movie recording in its own process: the screen in use (it follows the pointer), or display (an index), app, window (CG ids) or region ("x,y,width,height" in points). The options are the flags of ${toolCommand("recorder start")} with the same limits: fps, idleFps (the rate while nothing moves), threshold (the % that must change to leave it), countdown (seconds on screen before it records; true is 3), systemCursor, shortcuts (false: no keys overlay), micDevice (with audio: ["mic"]), excludeWindowIds, camera (needs the menu bar recorder running), controls, indicator, maxSeconds, title. It records what the user's screen shows, with an on-screen countdown and indicator unless they are off.`,
            effect: "reversible",
            reaches: ["user"],
        }),
        defineMethod({
            name: "demo",
            params: demoParamsSchema,
            result: z.unknown(),
            resultName:
                "{ movie: Movie, folder, steps: { caption, startMs, endMs }[], failed, ops, sourceSeconds, exported? }",
            doc: 'One call gives a finished demo: records the screen (record: the options of record()), runs each step ({ caption, run: async () => …, holdSeconds? }) between a marker at its start and a hold after it (holdSeconds, 1: the result stays on screen and is never cut), stops, cuts the waiting (still, silent stretches while the code of a step runs, and the time before the first and after the last step), adds the caption of each step while it plays, and exports (export: false skips it). A step that throws is listed in failed and the next one runs. edit takes cutIdle (true), idleMinSeconds (1), cutWaits (true), minWaitSeconds (0.8), keepSeconds (0.3), leadSeconds (0.5), tailSeconds (1), captions (true), captionPosition "bottom" | "top", captionMinSeconds (1.8), markers (true). Save a demo that worked with presets.save(name, script) to run it again.',
            effect: "reversible",
            reaches: ["user"],
        }),
    ],
    handles: [
        { name: "Movie", summary: "One recording's edit (edit.json).", methods: movieMethods },
        { name: "MovieRecording", summary: "A movie recording that runs now.", methods: recordingMethods },
    ],
    notes: [
        'SourceTime is seconds (or "m:ss", "h:mm:ss") of the movie as recorded, before any cut or speed change: every edit op and every method that places an item takes it, and a cut never moves it.',
        'OutputTime is seconds (or "m:ss") of the edited movie, what plays after cuts and speed changes: range(), itemsAt(), still(), poster(), sheet(), export({ from, to }) and comment() take it (comment({ source: true }) takes SourceTime).',
        "In an answer, from, to, at, start and end are source seconds and plays is output seconds (null where that moment is cut). The exceptions say so: itemsAt() gives output and source, info() gives sourceSeconds and outputSeconds, sheet() times and chapters() are output seconds, and a comment's at is when it was written.",
        "Every edit reads the file fresh and saves once, so the open window and you never overwrite each other.",
        'The edit is a file: it stays after the worker ends, and the next run starts from it. apply([{ op: "reset" }]) starts over; undo() takes back the last change, one of an earlier run too (<edit>.undo.json, 30 steps).',
        "Limits: speed 0.25–16, zoom scale 1–4, focus x and y 0–1, volume 0–2.",
    ],
});

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
function facts(opened: { path: string; project: EditProject }): EditFacts {
    const { project } = opened;
    return {
        hasTranscript: existsSync(transcriptCachePath(project.source.video)),
        hasCursorTrack: Boolean(project.source.cursor && existsSync(project.source.cursor)),
        musicFileExists: project.audio.music ? existsSync(project.audio.music.file) : true,
        recordedMarkers: recordedMarkersOf(opened),
        // R4 voiceover clips
        missingVoiceovers: (project.audio.voiceovers ?? [])
            .filter((clip) => !existsSync(clip.file))
            .map((clip) => clip.id),
    };
}

/** True when a video recording's manifest lists no sound source, so a transcription would pay for silence. */
function recordedWithoutSound(opened: { path: string; project: EditProject }): boolean {
    const folder = recordingFolderOf(opened);
    const settings = folder ? readRecordingManifest(folder)?.settings : undefined;
    const audio = settings?.audio;

    if (settings?.kind !== "video" || typeof audio !== "object" || audio === null || !("sources" in audio)) {
        return false;
    }

    return Array.isArray(audio.sources) && audio.sources.length === 0;
}

/**
 * Why an edit of the sound cannot work on a movie whose video has no audio track, or undefined. denoise() saved such an
 * edit, check() said ok and every export then failed (NR36); mute(0) saved an edit with no effect (NR34). Unknown facts
 * (a probe that failed) refuse nothing.
 */
export function silentMovieReason(facts: MediaFacts | undefined, action: string): string | undefined {
    if (!facts || hasAudio(facts)) {
        return undefined;
    }

    return `this movie has no sound to ${action}: its video ${basename(facts.path)} has no audio track`;
}

/** A library row with its length and its movie's size: an agent that wants a short recording had to open each one (NR33). */
export function withLength(row: LibraryRow): LibraryRow & { seconds: number | null; bytes: number | null } {
    const seconds = row.endedAt ? Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000) : null;
    const bytes = row.movie && existsSync(row.movie) ? statSync(row.movie).size : null;
    return { ...row, seconds, bytes };
}

/**
 * Why a lane cannot go, or undefined: the movie keeps one lane that holds zooms, as an edit that never saved its lanes
 * has. removeLane('zooms') removed it without a word, and the movie had no lane for zooms after it (NR37).
 */
export function laneRemovalReason(lanes: readonly EffectLane[], id: string): string | undefined {
    const holdsZooms = (lane: EffectLane) => !lane.kinds || lane.kinds.includes("zoom");
    const lane = lanes.find((candidate) => candidate.id === id);

    if (!lane || !holdsZooms(lane) || lanes.some((other) => other.id !== id && holdsZooms(other))) {
        return undefined;
    }

    return `the ${id} lane is the only lane that holds zooms, and a movie keeps one; addLane({ kinds: ["zoom"] }) first, then remove this one`;
}

/**
 * Which fixable issues an edit fixed: those check() no longer finds after it. An action that changed nothing used to be
 * counted as fixed (NR43); those are `unchanged`, reported as "no change".
 */
export function fixOutcome(
    before: readonly EditIssue[],
    after: readonly EditIssue[]
): { fixed: string[]; unchanged: string[] } {
    const remaining = new Set(after.map((issue) => issue.message));
    const fixable = before.filter((issue) => issue.action).map((issue) => issue.message);
    return {
        fixed: fixable.filter((message) => !remaining.has(message)),
        unchanged: fixable.filter((message) => remaining.has(message)),
    };
}

/**
 * What an edit answers: the movie in one line and where. The whole edit (every clip, lane, cursor and audio setting)
 * was about 1,500 characters per call, which an agent reads to find the summary (NR23, R2-NR4); info() has it.
 */
function briefOf(project: EditProject, path: string) {
    const described = describeProject(project, path);
    return {
        summary: summarize(project, undefined),
        path: described.path,
        revision: described.revision,
        outputSeconds: described.outputSeconds,
    };
}

export class Movie {
    /** `ctx`: the worker's scratch folder and `show`, for still(); absent outside a REPL. */
    constructor(
        readonly recording: string,
        private readonly ctx?: ToolsetContext
    ) {}

    /** Printed as what it names: the whole object showed the worker's context, its scratch path and private methods (NR11). */
    [Symbol.for("nodejs.util.inspect.custom")](): string {
        return `Movie ${SafeJSON.stringify(this.recording)} (info() reads its edit; help() lists its methods)`;
    }

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
        const opened = await openProject(this.recording);
        const issues = checkProject(opened.project, facts(opened));
        log.debug({ recording: this.recording, issues: issues.length }, "edit checked");
        // ok: nothing that breaks the export; clean: nothing to look at either.
        return { ok: !issues.some((issue) => issue.severity === "fix"), clean: issues.length === 0, issues };
    }

    async fix() {
        const opened = await openProject(this.recording);
        const before = checkProject(opened.project, facts(opened));
        const { ops } = fixOps(opened.project, facts(opened));

        if (ops.length === 0) {
            return {
                ...briefOf(opened.project, opened.path),
                fixed: [],
                unchanged: [],
                warnings: ["check() found nothing that fix() can fix"],
            };
        }

        log.debug({ recording: this.recording, ops: ops.length }, "fixing what check found");
        const edited = await this.change(ops);
        const after = await openProject(this.recording);
        const outcome = fixOutcome(before, checkProject(after.project, facts(after)));
        const warnings = [
            ...(edited.warnings ?? []),
            ...(outcome.unchanged.length > 0
                ? [`no change: fix() ran the action of ${outcome.unchanged.join("; ")}, and check() still finds it`]
                : []),
        ];
        return { ...edited, ...outcome, ...(warnings.length > 0 ? { warnings } : {}) };
    }

    /** One edit's answer (briefOf), with what the edit removed, measured or warns about. */
    private async change(ops: EditOp[]) {
        const edited = await editProject(this.recording, ops);
        const seconds = (us: number) => Math.round(us / 1000) / 1000;
        return {
            ...briefOf(edited.project, edited.path),
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

    async marker(at: TimeValue, label?: string) {
        return this.change([{ op: "marker", at, ...(label ? { label } : {}) }]);
    }

    async unmarker(id: string) {
        return this.change([{ op: "unmarker", id }]);
    }

    // R4 voiceover clips
    async voiceover(options: Omit<Extract<EditOp, { op: "voiceover" }>, "op">) {
        return this.change([{ op: "voiceover", ...options }]);
    }

    async unvoiceover(id: string) {
        return this.change([{ op: "unvoiceover", id }]);
    }

    /** Speaks the text into a file beside the recording (never aloud) and adds it as a voiceover. */
    async say(options: {
        at: TimeValue;
        text: string;
        provider?: "xai" | "openai" | "macos";
        voice?: string;
        rate?: number;
        volume?: number;
        label?: string;
    }) {
        const { project } = await openProject(this.recording);
        const provider = options.provider ?? "xai";
        const folder = join(dirname(project.source.video), "voiceovers");
        mkdirSync(folder, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
        const file = join(
            folder,
            `say-${stamp}-${Math.random().toString(36).slice(2, 6)}.${provider === "macos" ? "aiff" : "mp3"}`
        );
        const args = ["say", "--output", file, "--provider", provider];

        if (provider !== "macos") {
            args.push("--format", "mp3", "--no-fallback");
        }

        if (options.voice) {
            args.push("--voice", options.voice);
        }

        if (options.rate !== undefined) {
            args.push("--rate", String(options.rate));
        }

        args.push(options.text);
        log.info({ provider, file, chars: options.text.length }, "movie.say: tools say --output");
        const result = await execTool(args, { timeout: 120_000 });

        if (!result.success || !existsSync(file) || statSync(file).size === 0) {
            throw new Error(
                `tools say --provider ${provider} wrote no sound (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(-400)}`
            );
        }

        const label = options.label ?? options.text.slice(0, 60);
        const before = new Set((project.audio.voiceovers ?? []).map((clip) => clip.id));
        const answer = await this.change([
            {
                op: "voiceover",
                at: options.at,
                file,
                label,
                ...(options.volume === undefined ? {} : { volume: options.volume }),
            },
        ]);
        const after = await openProject(this.recording);
        const added = (after.project.audio.voiceovers ?? []).find((clip) => !before.has(clip.id) && clip.file === file);
        return {
            ...answer,
            voiceover: { id: added?.id ?? null, file, seconds: added ? added.durationUs / 1_000_000 : null },
        };
    }

    // R4 6 animated captions
    async captionsStyle(options: Omit<Extract<EditOp, { op: "captionsStyle" }>, "op"> = {}) {
        return this.change([{ op: "captionsStyle", ...options }]);
    }

    // R4 10 progress bar and chapter strip
    async progress(options: Omit<Extract<EditOp, { op: "progress" }>, "op"> = {}) {
        return this.change([{ op: "progress", ...options }]);
    }

    // R4 9 intro and end cards
    async introCard(options: Omit<Extract<EditOp, { op: "introCard" }>, "op">) {
        return this.change([{ op: "introCard", ...options }]);
    }

    async endCard(options: Omit<Extract<EditOp, { op: "endCard" }>, "op">) {
        return this.change([{ op: "endCard", ...options }]);
    }

    // R4 8 music ducking
    async ducking(options: Omit<Extract<EditOp, { op: "ducking" }>, "op"> = {}) {
        return this.change([{ op: "ducking", ...options }]);
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
        await this.requireSound("mute");
        return this.change([{ op: "mute", track, muted: true }]);
    }

    /** Throws `silentMovieReason` for a movie whose video has no audio track; a probe that fails refuses nothing. */
    private async requireSound(action: string): Promise<void> {
        const opened = await openProject(this.recording);
        const facts = await readMediaFacts({ input: opened.project.source.video }).catch((error: unknown) => {
            log.debug({ error, recording: this.recording }, "no media facts to check the movie's sound against");
            return undefined;
        });
        const reason = silentMovieReason(facts, action);

        if (reason) {
            throw new Error(reason);
        }
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

    async cutWords(options: { at: TimeValue; words: string; occurrence?: number; padMs?: number; dryRun?: boolean }) {
        const { dryRun, ...rest } = options;
        const op = { op: "cutWords" as const, ...rest };
        return dryRun ? cutsOut(await previewTranscriptCuts(this.recording, op)) : this.change([op]);
    }

    async lineWords(options: { at?: TimeValue } = {}) {
        return transcriptWords(this.recording, options);
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
        if (options.enabled !== false) {
            await this.requireSound("clean");
        }

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

        return { undone: ops, stepsLeft: undoDepth(undone.path), ...briefOf(undone.project, undone.path) };
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
                // Where an arrow starts when only its head is given: the editor window's arrow tail.
                start: options.tail ?? placedShape("arrow", options.at).start,
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
        const opened = await openProject(this.recording);
        const reason = laneRemovalReason(opened.project.lanes ?? DEFAULT_LANES, id);

        if (reason) {
            throw new Error(reason);
        }

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
        } & ExportRun = {}
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
        requireRecorderPart("movie.export()");
        // R5 3: progress lines in the run's log (stderr), and the caller's own callback.
        const logged = exportProgressPrinter((line) => log.info({ recording: this.recording }, line));
        const answer = await exportAs(opened.path, {
            out: options.out,
            format: options.format,
            part,
            subtitles: options.subtitles,
            overwrite: options.overwrite,
            size: options.size,
            onProgress: (fraction) => {
                logged(fraction);
                options.onProgress?.(fraction);
            },
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
            ...(answer.replaced ? { replaced: true } : {}),
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

        if (recordedWithoutSound(opened)) {
            throw new Error(`${video} was recorded without sound, so there is nothing to transcribe`);
        }

        // The guard sits on the paid call itself: a method declared read that reaches here is refused (NR1).
        assertReach("paid", "start a transcription", "Call movie.transcript() first; it declares the paid run.");
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

        requireRecorderPart("movie.poster()");
        const answer = await hostStill({ path: opened.path, atSeconds: atUs / 1_000_000, out, full: true });

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
        // The REPL's schema keeps these to 1…12; `tools recorder sheet` calls here directly, and --count 100000 ran
        // for minutes on 100000 frames.
        const count = options.count;

        if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 12)) {
            throw new Error(`the count must be a whole number from 1 to 12 (got ${count})`);
        }

        if (options.at && (options.at.length < 1 || options.at.length > 12)) {
            throw new Error(`a sheet takes 1 to 12 times (got ${options.at.length})`);
        }

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

        requireRecorderPart("movie.sheet()");
        const out = options.out ?? join(this.ctx?.scratchDir ?? tmpdir(), `sheet-${Date.now()}.png`);
        const answer = await hostSheet({ path: opened.path, times: times.map((us) => us / 1_000_000), out });

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

        requireRecorderPart("movie.still()");
        const out = keep ? resolve(keep) : join(this.ctx?.scratchDir ?? tmpdir(), `still-${Date.now()}.png`);
        const answer = await hostStill({ path: opened.path, atSeconds: atUs / 1_000_000, out });

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the still failed without a reason");
        }

        await this.ctx?.show({ path: answer.path });
        return { path: answer.path, width: answer.width, height: answer.height };
    }

    /** Reads the cached transcript only: a search must never start the paid transcription transcript() runs. */
    async find(text: string): Promise<TranscriptLine[]> {
        const opened = await openProject(this.recording);
        const cache = transcriptCachePath(opened.project.source.video);

        if (!existsSync(cache)) {
            throw new Error(
                "this movie has no transcript yet; call movie.transcript() first (a paid transcription), then find()"
            );
        }

        return findInTranscript(
            transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project),
            text
        );
    }

    async switchDisplay(input: { from: z.infer<typeof timeSchema>; to: z.infer<typeof timeSchema>; display: number }) {
        const folder = await this.framesFolder("switch between");

        return switchDisplay(folder, {
            fromUs: timeToUs(input.from),
            toUs: timeToUs(input.to),
            displayId: input.display,
        });
    }

    async undoDisplaySwitch() {
        return stepDisplaySwitch(await this.framesFolder("undo a display switch"), "undo");
    }

    async redoDisplaySwitch() {
        return stepDisplaySwitch(await this.framesFolder("redo a display switch"), "redo");
    }

    /** The frames folder of this recording; a plain movie has no displays to switch. */
    private async framesFolder(doing: string): Promise<string> {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);

        if (!folder) {
            throw new Error(
                `${opened.project.source.video} is a plain movie: it has no displays, so nothing to ${doing}`
            );
        }

        // A video recording has a folder but no frames, and the error was "has no frames to make a movie of" (NR35).
        if (readRecordingManifest(folder)?.settings?.kind === "video") {
            throw new Error(
                `this is a video recording: it has no display frames to ${doing}; only a frames recording (a meeting or a library frames recording) has them`
            );
        }

        return folder;
    }

    async findOnScreen(input: { text: string; limit?: number }): Promise<ScreenHitWithOps[]> {
        const opened = await openProject(this.recording);
        const folder = recordingFolderOf(opened);

        if (!folder) {
            throw new Error(`${opened.project.source.video} is a plain movie: it has no frames with OCR to search`);
        }

        const hits = findOnScreen(folder, input.text, input.limit !== undefined ? { limit: input.limit } : {});
        return screenHitsWithOps(hits, opened.project.source.durationUs / 1_000_000);
    }

    async shortcuts() {
        return shortcutsOf((await openProject(this.recording)).project);
    }

    /** The moments marked while it recorded (`recording.mark()`, `tools recorder mark`), with where each plays. */
    async markers() {
        return markersOf(await openProject(this.recording));
    }

    /** The recorded clicks in groups, as autoZoom groups them, with where each group plays. */
    async clickGroups(options: { gapSeconds?: number } = {}) {
        return clickGroupsOf((await openProject(this.recording)).project, options);
    }

    async titleMarkers(
        options: {
            seconds?: number;
            numbered?: boolean;
            y?: number;
            animate?: { kind: (typeof TEXT_ANIMATIONS)[number]; ms?: number };
        } = {}
    ) {
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
                    ...(options.animate ? { animate: options.animate } : {}),
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
        annotation?: number;
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

    async importComments(options: { board: string; card?: number; dryRun?: boolean }) {
        return importBoardComments(this.recording, options);
    }

    async copy(options: { gif?: boolean } = {}) {
        requireRecorderPart("movie.copy()");
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

        requireRecorderPart("movie.show()");
        const shown = await hostOpenEditor(opened.path, {
            focus: options.focus === true,
            atSeconds: options.at,
            tab: options.tab,
        });
        return {
            opened: opened.path,
            window: shown.window,
            ...(options.at === undefined ? {} : { at: options.at }),
            ...(options.tab ? { tab: options.tab } : {}),
        };
    }

    async closeEditor() {
        return hostCloseEditor({ path: (await openProject(this.recording)).path });
    }

    // Round 4 fx-render: transitions at cuts, the magnifier lens, the 3D tilt.
    async transition(options: Omit<Extract<EditOp, { op: "transition" }>, "op"> = {}) {
        return this.change([{ op: "transition", ...options }]);
    }

    async lens(options: Omit<Extract<EditOp, { op: "lens" }>, "op">) {
        return this.change([{ op: "lens", ...options }]);
    }

    async setLens(options: Omit<Extract<EditOp, { op: "setLens" }>, "op">) {
        return this.change([{ op: "setLens", ...options }]);
    }

    async unlens(id: string) {
        return this.change([{ op: "unlens", id }]);
    }

    async tilt(options: Omit<Extract<EditOp, { op: "tilt" }>, "op"> = {}) {
        return this.change([{ op: "tilt", ...options }]);
    }

    // fx B (round 4): private data, smooth cursor, typing and waiting speed-ups.

    async privateData(options: { names?: string[]; exclude?: FractionBox[]; excludeFixed?: boolean } = {}) {
        return privateData((await openProject(this.recording)).project, options);
    }

    async findText(options: { text?: string; pattern?: string; exclude?: FractionBox[]; excludeFixed?: boolean }) {
        return findText((await openProject(this.recording)).project, options);
    }

    async hideText(options: Omit<Extract<EditOp, { op: "hideText" }>, "op">) {
        return this.change([{ op: "hideText", ...options }]);
    }

    async verifyHidden(
        options: {
            text?: string;
            pattern?: string;
            private?: boolean;
            names?: string[];
            everySeconds?: number;
            movie?: string;
        } = {}
    ) {
        return verifyHidden(this.recording, options);
    }

    async hidePrivate(options: Omit<Extract<EditOp, { op: "hidePrivate" }>, "op"> = {}) {
        return this.change([{ op: "hidePrivate", ...options }]);
    }

    async smoothCursor(options: Omit<Extract<EditOp, { op: "cursorSmooth" }>, "op"> = {}) {
        return this.change([{ op: "cursorSmooth", ...options }]);
    }

    async waits(options: { minSeconds?: number; maxArea?: number } = {}) {
        return waits((await openProject(this.recording)).project, options);
    }

    async speedUpWaits(options: Omit<Extract<EditOp, { op: "speedUpWaits" }>, "op"> = {}) {
        return this.change([{ op: "speedUpWaits", ...options }]);
    }

    async speedBadge(options: Omit<Extract<EditOp, { op: "autoSpeed" }>, "op"> = {}) {
        return this.change([{ op: "autoSpeed", ...options }]);
    }

    // R5 5 redaction edges
    async redactionJoins(options: Omit<Extract<EditOp, { op: "redactionJoins" }>, "op">) {
        return this.change([{ op: "redactionJoins", ...options }]);
    }

    /** A copy of the recording and its edit (APFS clones), as a new library recording or in `to`. */
    async duplicate(options: { title?: string; to?: string } = {}) {
        return duplicateRecording(this.recording, options);
    }

    async events(options: { kinds?: MovieEventKind[]; taps?: Tap[] } = {}) {
        const { project } = await openProject(this.recording);
        const events = await eventsOf(project, { taps: options.taps });
        return eventsOut(
            project,
            options.kinds ? events.filter((event) => options.kinds?.includes(event.kind)) : events
        );
    }

    async snap(
        options: {
            at?: number;
            event?: MovieEventKind;
            index?: number;
            lead?: number;
            end?: boolean;
            kinds?: MovieEventKind[];
            taps?: Tap[];
        } = {}
    ) {
        const { project } = await openProject(this.recording);
        const anchor = options.event
            ? eventAnchorSchema.parse({
                  event: options.event,
                  index: options.index ?? 1,
                  ...(options.lead === undefined ? {} : { lead: options.lead }),
                  ...(options.end ? { end: true } : {}),
              })
            : undefined;
        return snapOf(project, { at: options.at, anchor, kinds: options.kinds, taps: options.taps });
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

/** What `movies.record()` reaches outside the process; a test passes a fake recorder and a face state. */
export interface MovieRecorderDeps {
    /** Starts `tools recorder start <args>`: detached, so a REPL reset does not end the recording. */
    start: (args: string[]) => void;
    /** Whether the menu bar recorder, the camera's only writer, runs. */
    recorderFace: () => FlockState;
    /** Refuses a display that is not connected or an area off every display (`ax-tool screens`). */
    checkTarget: (target: RecordingTarget) => Promise<void>;
}

const REAL_DEPS: MovieRecorderDeps = {
    start: (args) => {
        spawnToolDetached(args, { reparent: true });
    },
    recorderFace: recorderFaceState,
    checkTarget: checkTargetOnScreen,
};

/** Starts `tools recorder start` in its own process and waits for its entry. */
async function record({
    options,
    ctx,
    deps = REAL_DEPS,
}: {
    options: RecordOptions;
    ctx?: ToolsetContext;
    deps?: MovieRecorderDeps;
}): Promise<MovieRecording> {
    const flags = startArgsOf(options);
    // The CLI's own checks, here: the child runs detached, so a refusal there would only show as a start that timed out.
    const request = parseStartFlags(readStartArgs(flags));

    if (request.target) {
        await deps.checkTarget(request.target);
    }

    const cameraProblem = request.camera ? cameraRefusal(deps.recorderFace()) : undefined;

    if (cameraProblem) {
        throw new Error(cameraProblem);
    }

    const before = new Set(listLiveRecordings().map((entry) => entry.id));
    const args = ["recorder", "start", ...flags];

    // The recorder passes this gate right before it records; when the wait below ends first, it closes the gate, so a
    // recorder that starts later records nothing instead of running with no one to stop it.
    const gates = toolDataDir("recorder", "start-gates");
    mkdirSync(gates, { recursive: true });
    sweepStartGates(gates, START_GATE_MAX_AGE_MS);
    const gate = startGatePath(gates);
    args.push("--start-gate", gate);
    log.info({ args }, "movie recording requested");
    deps.start(args);
    const outcome = await awaitStart({
        gate,
        find: () =>
            listLiveRecordings().find(
                (entry) => !before.has(entry.id) && entry.folder?.includes("/video-") && entry.state === "recording"
            ),
        timeoutMs: START_TIMEOUT_MS,
        graceMs: START_GRACE_MS,
        pollMs: POLL_MS,
        stop: (pid) => {
            stopPassedChild({
                gate,
                pid,
                signal: (target) => {
                    log.warn({ pid: target, gate }, "the recorder passed its start but never recorded; stopping it");
                    // pid-verified: stopPassedChild calls this only after inspectPidFile confirmed the gate's writer is this live process
                    process.kill(target, "SIGTERM");
                },
            });
        },
    });

    if (outcome.status === "started") {
        return new MovieRecording(outcome.value, ctx);
    }

    const why = `run ${toolCommand("genesis-tools logs failures")} or ${toolCommand("recorder start")} in a terminal to see why`;

    if (outcome.status === "cancelled") {
        throw new Error(
            `the recording did not start within ${START_TIMEOUT_MS / 1000} s, and it will not start later (its start was cancelled); ${why}`
        );
    }

    throw new Error(
        `the recorder began its start but did not record within ${(START_TIMEOUT_MS + START_GRACE_MS) / 1000} s; ${outcome.pid === null ? "it is no longer running" : `it was stopped (pid ${outcome.pid})`}; ${why}`
    );
}

const markerAnswer = z.object({ atMs: z.number() });

/** The demo driver on a real movie recording: `tools recorder start` in its own process, the edit, the export. */
export function movieDemoDriver(options: RecordOptions, ctx?: ToolsetContext): DemoDriver {
    return {
        async start() {
            const recording = await record({ options, ctx });
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

    if (parsed.export !== false) {
        // Before the recording, not after minutes of steps.
        requireRecorderPart("movies.demo() with its export");
    }

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

    /** What record() reaches outside the process; a test passes a fake recorder. */
    constructor(private readonly deps: Partial<MovieRecorderDeps> = {}) {
        super();
    }

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        return {
            movies: {
                list: (options: { limit?: number } = {}) => listLibrary({ limit: options.limit ?? 20 }).map(withLength),
                // A name that matches nothing answered a Movie, and the first call failed far from the typo (NR11).
                open: (recording: string) => {
                    resolveRecording(recording);
                    return serviceRoutedMovie(new Movie(recording, ctx), movieMethods);
                },
                record: (options: RecordOptions = {}) => record({ options, ctx, deps: { ...REAL_DEPS, ...this.deps } }),
                demo: (options: z.input<typeof demoParamsSchema> & { steps: DemoStep[] }) => recordDemo(options, ctx),
                search: (text: string) => searchLibrary(text),
            },
        };
    }
}
