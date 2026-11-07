import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fillerListsOf, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { isArbitrationBusy, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { bubbleFromSidecar, readCameraSidecar } from "@genesiscz/utils/recording-editor/camera";
import { cutIssues, type EditIssue } from "@genesiscz/utils/recording-editor/check";
import { audioTrackCount, ensureDenoisedSource } from "@genesiscz/utils/recording-editor/denoise";
import { exportVideoArgv } from "@genesiscz/utils/recording-editor/ffmpeg";
import { findIdle } from "@genesiscz/utils/recording-editor/idle";
import { integratedLoudness } from "@genesiscz/utils/recording-editor/loudness";
import { cardsLeadUs } from "@genesiscz/utils/recording-editor/overlays";
import { type TimeValue, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    applyOp,
    type EditOp,
    type EditProject,
    EXPORT_FORMATS,
    type ExportFormat,
    editProjectSchema,
    type OpFacts,
    opPlacementWarnings,
    opTimeWarnings,
    outputTimeOf,
    partOf,
    projectPathFor,
    readProject,
    transcriptCachePath,
    transcriptLines,
    wholeProject,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { readFrameFolder } from "@genesiscz/utils/recording-editor/source";
import { formatSubtitles, type SubtitleFormat, subtitleCues } from "@genesiscz/utils/recording-editor/subtitles";
import {
    type CutMatch,
    type FillerLists,
    fillerCuts,
    fillerList,
    foldWord,
    lineAt,
    type TranscriptSegment,
    transcriptFileSchema,
    wordCuts,
    wordSpans,
} from "@genesiscz/utils/recording-editor/transcript-cuts";
import { audioFileDurationUs, voiceoverFile } from "@genesiscz/utils/recording-editor/voiceovers";
import { RPC_ERRORS, RpcError } from "@genesiscz/utils/screen-recorder/control";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { probeVideo, type VideoProbeLimits } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { privateHitsOf, textHitsOf, waitsOf } from "./fx-analysis";
import { type ExportAnswer, movieOf, resolveRecording } from "./library";
import { chapterMetadata, chapterPoints, chaptersOfPart, markersOf, recordedMarkersOf } from "./moments";
import { hostExport } from "./service-client";

const { log } = logger.scoped("recorder-edit");

export interface OpenedProject {
    path: string;
    project: EditProject;
    /** The file did not exist: this project keeps the whole movie and is not saved yet. */
    fresh: boolean;
    /** The source stretches a removeIdle op cut, in microseconds. */
    removedIdleUs?: Array<[number, number]>;
    /** A normalize op: the loudness it measured at volume 1 (null: no audio) and the volume it set. */
    loudness?: { measuredLufs: number | null; volume: number };
    /** What an edit changed that its caller may not expect: a time past the end clamped to it. */
    warnings?: string[];
    /** An undo: the ops of the change it took back, in the order they ran. */
    undone?: string[];
    /** A redo: the ops of the change it made again. */
    redone?: string[];
    /**
     * `editProject` and `undoEdit` on the file: true when they saved a revision. Absent when an open session made the
     * change, since the session tells its subscribers itself.
     */
    saved?: boolean;
}

/** The movie file a movie recording's recording.json names (`settings.video.file`); undefined for a frames recording. */
function recordedMovieName(folder: string): string | undefined {
    const manifest = join(folder, "recording.json");

    if (!existsSync(manifest)) {
        return undefined;
    }

    try {
        const file = SafeJSON.parse(readFileSync(manifest, "utf8"), { strict: true })?.settings?.video?.file;
        return typeof file === "string" && file.length > 0 ? basename(file) : undefined;
    } catch (error) {
        logger.debug({ manifest, error }, "recording.json does not parse; the movie's name is unknown");
        return undefined;
    }
}

/** The frames `tools recorder proxy` would read (the same reader); undefined when they cannot be read. */
function frameCountOf(folder: string): number | undefined {
    try {
        return readFrameFolder(folder).length;
    } catch (error) {
        logger.debug({ folder, error }, "the frames of a folder without a movie could not be read");
        return undefined;
    }
}

/** The movie a recording argument names: the folder's movie, or the movie an edit file points at. */
function movieFor(path: string): string {
    if (path.endsWith(".json")) {
        return readProject(path).source.video;
    }

    if (existsSync(path) && statSync(path).isDirectory()) {
        const movie = movieOf(path);

        if (!movie) {
            const lost = recordedMovieName(path);

            // A movie recording whose movie went away: a proxy makes nothing there ("has no frames to make a movie of").
            if (lost) {
                throw new Error(
                    `${join(path, lost)} is missing: recording.json names it, but the file was moved or removed`
                );
            }

            // No frames either: offering a proxy only led to "has no frames to make a movie of".
            if (frameCountOf(path) === 0) {
                throw new Error(`${path} has no movie and no frames: there is nothing to edit`);
            }

            throw new Error(`${path} has no movie yet; make one with ${toolCommand("recorder proxy", basename(path))}`);
        }

        return movie;
    }

    return path;
}

/** Opens a recording's edit (a library id, `last`, a folder, a movie or an edit file), or a new one of the whole movie. */
/** A recording the editor opens may be a whole meeting: up to 12 h and 64 GiB, not the evidence pipeline's 10 minutes. */
const EDITOR_VIDEO_LIMITS: VideoProbeLimits = {
    maxBytes: 64 * 1024 ** 3,
    maxDurationUs: 12 * 3600 * 1_000_000,
    maxPixels: 48_000_000,
};

/**
 * An open edit session of this process (the recorder service's), seen from the file functions below: while one
 * holds an edit, they read and change it through the session, so a REPL or CLI call the service makes never writes
 * past the window's unsaved changes. Its changes are saved at once (`flush`), so the file a caller reads next is
 * current.
 */
export interface OwnedEdit {
    readonly current: { project: EditProject; revision: number };
    readonly undoDepth: number;
    apply(
        ops: readonly EditOp[],
        options: { by: string; baseRevision?: number }
    ): Promise<{
        project: EditProject;
        warnings?: string[];
        removedIdleUs?: Array<[number, number]>;
        loudness?: { measuredLufs: number | null; volume: number };
    }>;
    undo(options: { by: string }): Promise<{ project: EditProject; undone: string[] }>;
    redo(options: { by: string }): Promise<{ project: EditProject; redone: string[] }>;
    collapseUndo(depth: number): void;
    flush(): void;
}

/** Who holds edits open in this process; none outside the recorder service. */
export interface EditOwner {
    sessionOf(editPath: string): OwnedEdit | undefined;
}

let editOwner: EditOwner | undefined;

/** The recorder service registers its sessions here while it runs, and clears them when it stops. */
export function setEditOwner(owner: EditOwner | undefined): void {
    editOwner = owner;
}

function ownedEdit(editPath: string): OwnedEdit | undefined {
    return editOwner?.sessionOf(editPath);
}

const editCancel = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs `work` with `signal` as the cancel of every edit it makes: `editProject` and an open session check it right
 * before they change or save, so a request the caller cancelled (the recorder service's `$/cancel`) never saves after
 * its cancel was answered. The REPL's Movie methods reach these functions through layers that take no signal, so the
 * service sets it once around each request instead.
 */
export function withEditCancel<T>(signal: AbortSignal, work: () => T): T {
    return editCancel.run(signal, work);
}

/** Throws the cancel of the request this runs for (an RpcError of code 1013 from the service), if it came. */
export function throwIfEditCancelled(): void {
    editCancel.getStore()?.throwIfAborted();
}

/** The edit file of a recording argument, whether or not it exists yet. */
export function editPathOf(value: string): string {
    const resolved = resolveRecording(value);
    return resolved.endsWith(".json") ? resolved : projectPathFor(movieFor(resolved));
}

export async function openProject(value: string): Promise<OpenedProject> {
    const resolved = resolveRecording(value);
    const path = editPathOf(value);
    const owned = ownedEdit(path);

    if (owned) {
        return { path, project: owned.current.project, fresh: false };
    }

    if (existsSync(path)) {
        return { path, project: inItsFolder(path, readProject(path)), fresh: false };
    }

    const video = movieFor(resolved);
    const info = await probeVideo({ input: video, limits: EDITOR_VIDEO_LIMITS });
    const folder = dirname(video);
    const manifest = readRecordingManifest(folder);
    const cursor = join(folder, "cursor.jsonl");
    const camera = readCameraSidecar(video);
    log.debug({ video, path, durationUs: info.durationUs, camera: camera?.file }, "new edit of a whole movie");
    const project = wholeProject({
        video,
        durationUs: info.durationUs,
        width: info.displayWidth || info.width,
        height: info.displayHeight || info.height,
        ...(existsSync(cursor) ? { cursor } : {}),
        ...(manifest ? { recording: manifest.id } : {}),
    });
    return { path, project: camera ? { ...project, camera: bubbleFromSidecar(camera) } : project, fresh: true };
}

/**
 * A recording folder copied whole keeps an edit.json whose source paths name the ORIGINAL folder, so a transcript or a
 * still of the copy would read (and a refreshed transcript write) beside the original. When the edit's own folder
 * holds the same movie (same name and size), its paths are read from that folder instead; the file changes on the
 * next save only.
 */
export function inItsFolder(path: string, project: EditProject): EditProject {
    const folder = dirname(path);
    const video = project.source.video;

    if (dirname(video) === folder) {
        return project;
    }

    const here = join(folder, basename(video));

    if (!existsSync(here) || !existsSync(video) || statSync(here).size !== statSync(video).size) {
        return project;
    }

    const cursor = project.source.cursor ? join(folder, basename(project.source.cursor)) : undefined;
    log.debug({ path, from: dirname(video), to: folder }, "a copied recording folder: its own movie and cursor track");
    return {
        ...project,
        source: {
            ...project.source,
            video: here,
            ...(cursor && existsSync(cursor) ? { cursor } : {}),
        },
    };
}

/** What a list of ops did to a project, before anything is saved. */
export interface ComputedEdit {
    /** The project after the ops; its revision is the input's. */
    project: EditProject;
    /** False when the ops left the project as it was (a second annotateClicks); nothing is saved then. */
    changed: boolean;
    /** The facts each op was applied with, in order, so the same ops can be applied again without measuring. */
    facts: OpFacts[];
    removedIdleUs: Array<[number, number]>;
    loudness?: { measuredLufs: number | null; volume: number };
    warnings: string[];
}

/**
 * Applies ops in order to `project`, measuring what each needs first (idle stretches, the loudness, the transcript).
 * One op that fails throws and names the op. `facts` replays ops measured before (a rebase onto a newer file).
 */
export async function computeEdit({
    project,
    ops,
    fresh,
    facts: known,
    recordedMarkers = [],
}: {
    project: EditProject;
    ops: readonly EditOp[];
    /** The project has no file yet: it changes, and is saved, even when the ops change nothing. */
    fresh: boolean;
    facts?: readonly OpFacts[];
    /** The markers set while it recorded (recordedMarkersOf), so a cut that hides one says so. */
    recordedMarkers?: ReadonlyArray<{ atMs: number; label: string }>;
}): Promise<ComputedEdit> {
    let next = project;
    const removedIdleUs: Array<[number, number]> = [];
    const facts: OpFacts[] = [];
    let loudness: { measuredLufs: number | null; volume: number } | undefined;
    const warnings = ops.flatMap((op) => opTimeWarnings(op, project.source.durationUs));

    for (const [index, op] of ops.entries()) {
        try {
            const measured = known?.[index] ?? (await probeFacts(next, op));
            const before = next;
            next = applyOp(next, op, measured);
            warnings.push(...opPlacementWarnings(op, before, next));
            facts.push(measured);
            removedIdleUs.push(...(measured.idleUs ?? []).map(([from, to]): [number, number] => [from, to]));

            if (measured.loudnessLufs !== undefined) {
                loudness = { measuredLufs: measured.loudnessLufs, volume: next.audio.volume };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.debug({ error, op, index }, "edit op refused");
            const which = ops.length > 1 ? `op ${index + 1} (${op.op})` : op.op;
            throw new Error(`${which} refused, nothing was saved: ${message}`);
        }
    }

    // Ops that change nothing (a second annotateClicks, a fix to the same words) save no revision and no undo step.
    if (!fresh && SafeJSON.stringify(next) === SafeJSON.stringify(project)) {
        return {
            project,
            changed: false,
            facts,
            removedIdleUs,
            ...(loudness ? { loudness } : {}),
            warnings: [...warnings, "nothing changed, so nothing was saved"],
        };
    }

    // What this edit's cuts cost that they did not before (an item or a marker that no longer plays, a text cut
    // short): say so now, not only in check().
    const costBefore = new Set(cutIssues(project, recordedMarkers).map(costKey));
    warnings.push(
        ...cutIssues(next, recordedMarkers)
            .filter((issue) => !costBefore.has(costKey(issue)))
            .map(
                (issue) =>
                    `${issue.message}${issue.fix ? `; ${issue.fix} ${issue.action?.label === "Remove" ? "removes it" : "fixes it"}` : ""}`
            )
    );
    return { project: next, changed: true, facts, removedIdleUs, ...(loudness ? { loudness } : {}), warnings };
}

/** How often an edit runs again on a newer file before it refuses with `staleRevision`. */
const EDIT_REPLAYS = 3;
/** A save that finds another process saving the edit waits this long before it reads the file again. */
const ARBITER_BUSY_WAIT_MS = 25;

/**
 * Applies ops in order to the file as it is now (the window may have saved since the last read) and saves once. One
 * op that fails leaves the file as it was and names the op. When another writer saved while the ops ran, they run
 * again on its file; the save only happens on the file the ops last ran on. `baseRevision`: refused with
 * `staleRevision` when the edit is at another revision, then or when it saves, instead of running again.
 */
export async function editProject(
    value: string,
    ops: readonly EditOp[],
    options: { baseRevision?: number } = {}
): Promise<OpenedProject> {
    const path = editPathOf(value);
    const owned = ownedEdit(path);
    const { baseRevision } = options;

    if (owned) {
        const answer = await owned.apply(ops, { by: "agent", baseRevision });
        owned.flush();
        return { path, fresh: false, ...answer };
    }

    let opened = await openProject(value);

    if (baseRevision !== undefined && opened.project.revision !== baseRevision) {
        throw notAtBase(opened.project.revision, baseRevision);
    }

    let edit = await computeEdit({
        project: opened.project,
        ops,
        fresh: opened.fresh,
        recordedMarkers: recordedMarkersOf(opened),
    });
    let saved: EditProject | undefined;

    for (let replay = 0; ; replay++) {
        if (!edit.changed) {
            log.debug({ path: opened.path, ops: ops.map((op) => op.op) }, "edit changed nothing, not saved");
            return { path: opened.path, project: opened.project, fresh: false, warnings: edit.warnings, saved: false };
        }

        const base = opened;
        const next = edit.project;
        throwIfEditCancelled();
        const attempt = saveIfAt(base.path, base.fresh ? null : base.project.revision, () => {
            const written = writeProject(base.path, next);
            pushUndo({
                editPath: base.path,
                before: base.project,
                afterRevision: written.revision,
                ops: ops.map((op) => op.op),
            });
            return written;
        });

        if (attempt.outcome === "saved") {
            saved = attempt.value;
            break;
        }

        if (baseRevision !== undefined && attempt.outcome === "moved") {
            throw notAtBase(diskRevision(base.path) ?? 0, baseRevision);
        }

        if (replay >= EDIT_REPLAYS) {
            throw new RpcError(
                RPC_ERRORS.staleRevision,
                `the edit kept changing on disk while these ops ran (${EDIT_REPLAYS + 1} tries); nothing was saved`
            );
        }

        if (attempt.outcome === "busy") {
            await Bun.sleep(ARBITER_BUSY_WAIT_MS);
        }

        // Another writer (the window, a second CLI) saved while the ops ran: they run again on its file, with the
        // measurements they had, so neither edit is lost.
        const measured = edit.facts;
        opened = await openProject(value);
        log.info(
            { path: opened.path, revision: opened.project.revision, by: opened.project.updatedBy, replay },
            "the edit changed on disk since it was read; the ops run again on the newer file"
        );
        edit = await computeEdit({
            project: opened.project,
            ops,
            fresh: opened.fresh,
            facts: measured,
            recordedMarkers: recordedMarkersOf(opened),
        });
    }

    log.debug({ path: opened.path, ops: ops.map((op) => op.op), warnings: edit.warnings }, "edit applied");
    return {
        path: opened.path,
        project: saved,
        fresh: false,
        saved: true,
        ...(edit.removedIdleUs.length ? { removedIdleUs: edit.removedIdleUs } : {}),
        ...(edit.loudness ? { loudness: edit.loudness } : {}),
        ...(edit.warnings.length ? { warnings: edit.warnings } : {}),
    };
}

/** The refusal of an edit that named `baseRevision` while the edit is at another one. */
function notAtBase(revision: number, baseRevision: number): RpcError {
    return new RpcError(RPC_ERRORS.staleRevision, `the edit is at revision ${revision}, not ${baseRevision}`);
}

/** The revision of the edit file now, or null when it has none. */
function diskRevision(path: string): number | null {
    return existsSync(path) ? readProject(path).revision : null;
}

/**
 * Runs `write` only while the edit file is still at `expected` (null: no file yet). The check and the write are one
 * synchronous step under the path's arbiter, so no writer in this process, and no TypeScript writer in another one,
 * saves between them. `moved`: another writer saved since; `busy`: another process is saving it now.
 */
function saveIfAt<T>(
    path: string,
    expected: number | null,
    write: () => T
): { outcome: "saved"; value: T } | { outcome: "moved" | "busy" } {
    try {
        return withPathArbitrationSync(path, () =>
            diskRevision(path) === expected ? { outcome: "saved", value: write() } : { outcome: "moved" }
        );
    } catch (error) {
        if (isArbitrationBusy(error)) {
            log.debug({ error, path }, "another process saves the edit now");
            return { outcome: "busy" };
        }

        throw error;
    }
}

/** The items of an edit that never show because their whole time is cut (check()'s first kind of issue). */
/** One cost of a cut: the item it is about and what it costs, so a text cut shorter again is a new one. */
function costKey(issue: EditIssue): string {
    return `${issue.item}\n${issue.message}`;
}

/** The cached transcript's lines (with word times when the provider gave them); throws when there is none. */
export function readTranscriptSegments(project: EditProject): TranscriptSegment[] {
    const cache = transcriptCachePath(project.source.video);

    if (!existsSync(cache)) {
        throw new Error(
            "this movie has no transcript yet; transcribe it first with movie.transcript() (the movies REPL toolset)"
        );
    }

    return transcriptFileSchema.parse(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true })).segments;
}

/**
 * The filler lists the meetings config holds (`languages.<code>.fillers`). A config that cannot be read leaves the
 * shipped lists in place, so a movie that is no meeting still edits.
 */
async function configuredFillerLists(): Promise<FillerLists | undefined> {
    try {
        return fillerListsOf((await new MeetingsConfigStore().read()).languages);
    } catch (err) {
        log.warn({ err }, "meetings config not readable; cutFillers uses the shipped filler lists");
        return undefined;
    }
}

/**
 * What `cutWords` or `cutFillers` would cut, without saving: each cut with its source range, the line it is in, whether
 * its time is estimated, and where it plays in the edit now (null when that part is cut already).
 */
export async function previewTranscriptCuts(
    value: string,
    op: Extract<EditOp, { op: "cutWords" | "cutFillers" }>
): Promise<Array<CutMatch & { plays: number | null }>> {
    const { project } = await openProject(value);
    const segments = readTranscriptSegments(project);
    const lists = op.op === "cutFillers" ? await configuredFillerLists() : undefined;
    const cuts =
        op.op === "cutWords"
            ? wordCuts({
                  segments,
                  atSec: timeToUs(op.at) / 1_000_000,
                  words: op.words,
                  occurrence: op.occurrence,
                  padMs: op.padMs,
              })
            : fillerCuts({
                  segments,
                  fillers: fillerList({ language: op.language, words: op.words, level: op.level, lists }),
                  padMs: op.padMs,
              });
    return cuts.map((cut) => {
        const plays = outputTimeOf(project, cut.fromUs);
        return { ...cut, plays: plays === undefined ? null : Math.round(plays / 1000) / 1000 };
    });
}

/** A transcript line as `cutWords` reads it: its source seconds, where it plays now, and its words. */
export interface TranscriptLineWords {
    start: number;
    end: number;
    text: string;
    /** Output seconds where the line starts in the edit now; null when that moment is cut. */
    plays: number | null;
    /** `fold` is the form `cutWords` matches (lowercase, no punctuation around it); times are source seconds. */
    words: Array<{ word: string; fold: string; start: number; end: number; estimated: boolean }>;
}

/**
 * The words of each transcript line (or only of the line spoken at `at`), as `cutWords` splits and times them, so a
 * caller can pick words and send `{ op: "cutWords", at, words, occurrence }` without splitting a line itself.
 */
export async function transcriptWords(value: string, options: { at?: TimeValue } = {}): Promise<TranscriptLineWords[]> {
    const { project } = await openProject(value);
    const segments = readTranscriptSegments(project);
    const picked =
        options.at === undefined ? segments : [lineAt(segments, timeToUs(options.at) / 1_000_000)].filter(Boolean);

    return picked.flatMap((segment) => {
        if (!segment) {
            return [];
        }

        const plays = outputTimeOf(project, Math.round(segment.start * 1_000_000));
        return [
            {
                start: segment.start,
                end: segment.end,
                text: segment.text.trim(),
                plays: plays === undefined ? null : Math.round(plays / 1000) / 1000,
                words: wordSpans(segment).map((span) => ({ ...span, fold: foldWord(span.word) })),
            },
        ];
    });
}

/** What an op needs measured on the movie before it applies: idle stretches, the loudness, or the transcript. */
async function probeFacts(project: EditProject, op: EditOp): Promise<OpFacts> {
    if (op.op === "removeIdle") {
        return {
            idleUs: await findIdle({
                video: project.source.video,
                durationUs: project.source.durationUs,
                minUs: op.minSeconds * 1_000_000,
                keepUs: op.keepSeconds * 1_000_000,
            }),
        };
    }

    if (op.op === "normalize") {
        const lufs = await integratedLoudness({ video: project.source.video, mutedTracks: project.audio.mutedTracks });
        return { loudnessLufs: lufs ?? null };
    }

    if (op.op === "denoise" && op.enabled !== false && existsSync(project.source.video)) {
        return { audioTracks: await audioTrackCount(project.source.video) };
    }

    if (op.op === "cutWords" || op.op === "cutFillers") {
        const fillerLists = op.op === "cutFillers" ? await configuredFillerLists() : undefined;
        return { transcript: readTranscriptSegments(project), ...(fillerLists ? { fillerLists } : {}) };
    }

    // R4 voiceover clips: the clip's length, so ducking and the lists know where it ends.
    if (op.op === "voiceover" && op.file !== undefined) {
        return { voiceoverDurationUs: await audioFileDurationUs(voiceoverFile(op.file)) };
    }

    // A fix is keyed by its line's start; without a transcript the time is taken as that start.
    if (op.op === "fixLine" && existsSync(transcriptCachePath(project.source.video))) {
        return { transcript: readTranscriptSegments(project) };
    }

    // fx B (round 4): the screen text's private data, and the typing and waiting stretches (both cached).
    if (op.op === "hidePrivate") {
        return {
            privateHits: await privateHitsOf(project, {
                names: op.names,
                exclude: op.exclude,
                excludeFixed: op.excludeFixed,
            }),
        };
    }

    if (op.op === "hideText") {
        return {
            textHits: await textHitsOf(project, {
                text: op.text,
                pattern: op.pattern,
                exclude: op.exclude,
                excludeFixed: op.excludeFixed,
            }),
        };
    }

    if (op.op === "speedUpWaits") {
        return { waits: await waitsOf(project, { minSeconds: op.minSeconds, maxArea: op.maxArea }) };
    }

    return {};
}

/** At most this many steps are kept in the undo file; the oldest goes first. */
export const UNDO_STEPS = 30;

const undoStepSchema = z.object({
    before: editProjectSchema,
    afterRevision: z.number().int().nonnegative(),
    /** The ops of the change; absent in a file from before it was kept. */
    ops: z.array(z.string()).optional(),
});
/** One change to undo: the edit as it was before it, and the revision the change saved. */
export type UndoStep = z.infer<typeof undoStepSchema>;

const redoStepSchema = z.object({
    /** The edit as the undo found it, which a redo writes back. */
    after: editProjectSchema,
    /** The revision the undo saved: a redo is refused once the edit moved past it. */
    undoneRevision: z.number().int().nonnegative(),
    ops: z.array(z.string()).optional(),
});
type RedoStep = z.infer<typeof redoStepSchema>;

/** `redo` came later than `steps`; a file without it has nothing to redo. Any new change writes `steps` alone. */
const undoFileSchema = z.object({
    steps: z.array(undoStepSchema).default([]),
    redo: z.array(redoStepSchema).default([]),
});

/** `<edit>.undo.json` beside the edit: the agent's and the CLI's undo steps, so an undo outlives one process. */
function undoPath(editPath: string): string {
    return editPath.replace(/\.json$/, ".undo.json");
}

/** The undo file's steps, oldest first; a file that does not read is no steps. */
export function readUndoSteps(editPath: string): UndoStep[] {
    return readUndo(editPath);
}

/** Replaces the undo file's steps (the newest `UNDO_STEPS` of them). */
export function writeUndoSteps(editPath: string, steps: readonly UndoStep[]): void {
    atomicWriteFileSync(undoPath(editPath), SafeJSON.stringify({ steps: steps.slice(-UNDO_STEPS) }));
}

function readUndo(editPath: string): UndoStep[] {
    return readJournal(editPath).steps;
}

function readJournal(editPath: string): { steps: UndoStep[]; redo: RedoStep[] } {
    const path = undoPath(editPath);

    if (!existsSync(path)) {
        return { steps: [], redo: [] };
    }

    try {
        return undoFileSchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
    } catch (error) {
        log.debug({ error, path }, "the undo file does not read; it starts again empty");
        return { steps: [], redo: [] };
    }
}

/** Remembers the edit as it was before a change that saved `afterRevision`. */
export function pushUndo({
    editPath,
    before,
    afterRevision,
    ops,
}: {
    editPath: string;
    before: EditProject;
    afterRevision: number;
    ops: string[];
}): void {
    const steps = [...readUndo(editPath), { before, afterRevision, ops }].slice(-UNDO_STEPS);
    atomicWriteFileSync(undoPath(editPath), SafeJSON.stringify({ steps }));
}

/** How many steps the edit has to undo now. */
export function undoDepth(editPath: string): number {
    return ownedEdit(editPath)?.undoDepth ?? readUndo(editPath).length;
}

/** Makes every step pushed since the undo had `depth` steps into one, so a multi-step change undoes at once. */
export function collapseUndo(editPath: string, depth: number): void {
    const owned = ownedEdit(editPath);

    if (owned) {
        owned.collapseUndo(depth);
        owned.flush();
        return;
    }

    const steps = readUndo(editPath);
    const added = steps.slice(depth);
    const first = added[0];
    const last = added.at(-1);

    if (!first || !last || added.length < 2) {
        return;
    }

    atomicWriteFileSync(
        undoPath(editPath),
        SafeJSON.stringify({
            steps: [
                ...steps.slice(0, depth),
                {
                    before: first.before,
                    afterRevision: last.afterRevision,
                    ops: added.flatMap((step) => step.ops ?? []),
                },
            ],
        })
    );
}

/**
 * Puts the edit back as it was before its last change made through `apply`, the REPL or this undo's door. Refused
 * when the edit changed since (the editor window saved it, which has its own ⌘Z), so an undo never throws away
 * someone else's work.
 */
export async function undoEdit(value: string): Promise<OpenedProject> {
    const owned = ownedEdit(editPathOf(value));

    if (owned) {
        const answer = await owned.undo({ by: "agent" });
        owned.flush();
        return { path: editPathOf(value), project: answer.project, fresh: false, undone: answer.undone };
    }

    const opened = await openProject(value);
    const { steps, redo } = readJournal(opened.path);
    const last = steps.at(-1);

    if (!last) {
        throw new Error(
            "nothing to undo: no change was made to this edit through apply or the REPL since it was opened"
        );
    }

    if (last.afterRevision !== opened.project.revision) {
        throw new Error(
            `the edit changed since the last change made here (revision ${opened.project.revision}${opened.project.updatedBy ? ` by ${opened.project.updatedBy}` : ""}, not ${last.afterRevision}); undo it where it was made, for example ⌘Z in the editor window`
        );
    }

    const attempt = saveIfAt(opened.path, opened.project.revision, () => {
        const saved = writeProject(opened.path, { ...last.before, revision: opened.project.revision });
        // The edit now reads as it did after the step before; that step's revision is the one just saved, so a second
        // undo goes one step further back.
        const rest = steps.slice(0, -1);

        if (rest.length) {
            rest[rest.length - 1] = { ...rest[rest.length - 1], afterRevision: saved.revision };
        }

        // The edit as this undo found it, so `redo` can write it back while nothing changed after the undo.
        const redone = [...redo, { after: opened.project, undoneRevision: saved.revision, ops: last.ops }];
        atomicWriteFileSync(
            undoPath(opened.path),
            SafeJSON.stringify({ steps: rest, redo: redone.slice(-UNDO_STEPS) })
        );
        log.debug({ path: opened.path, revision: saved.revision, left: rest.length, ops: last.ops }, "edit undone");
        return {
            path: opened.path,
            project: saved,
            fresh: false as const,
            undone: last.ops ?? [],
            saved: true as const,
        };
    });
    if (attempt.outcome !== "saved") {
        throw new Error(
            `undo refused: the edit ${attempt.outcome === "busy" ? "is being saved by another writer" : "changed since it was read"}`
        );
    }
    return attempt.value;
}

/**
 * Makes the last change `undoEdit` took back again. Refused when the edit changed since that undo: a new change drops
 * the steps to redo, as ⇧⌘Z in the window does.
 */
export async function redoEdit(value: string): Promise<OpenedProject> {
    const owned = ownedEdit(editPathOf(value));

    if (owned) {
        const answer = await owned.redo({ by: "agent" });
        owned.flush();
        return { path: editPathOf(value), project: answer.project, fresh: false, redone: answer.redone };
    }

    const opened = await openProject(value);
    const { steps, redo } = readJournal(opened.path);
    const last = redo.at(-1);

    if (!last || last.undoneRevision !== opened.project.revision) {
        throw new Error(
            last
                ? `nothing to redo: the edit changed since the undo (revision ${opened.project.revision}, not ${last.undoneRevision})`
                : "nothing to redo: no undo was made here since the last change"
        );
    }

    const attempt = saveIfAt(opened.path, opened.project.revision, () => {
        const saved = writeProject(opened.path, { ...last.after, revision: opened.project.revision });
        const rest = redo.slice(0, -1);

        // The next step to redo was undone before this one; it may run once this redo is the edit's newest revision.
        if (rest.length) {
            rest[rest.length - 1] = { ...rest[rest.length - 1], undoneRevision: saved.revision };
        }

        const again = [...steps, { before: opened.project, afterRevision: saved.revision, ops: last.ops }];
        atomicWriteFileSync(undoPath(opened.path), SafeJSON.stringify({ steps: again.slice(-UNDO_STEPS), redo: rest }));
        log.debug({ path: opened.path, revision: saved.revision, left: rest.length, ops: last.ops }, "edit redone");
        return {
            path: opened.path,
            project: saved,
            fresh: false as const,
            redone: last.ops ?? [],
            saved: true as const,
        };
    });

    if (attempt.outcome !== "saved") {
        throw new Error(
            `redo refused: the edit ${attempt.outcome === "busy" ? "is being saved by another writer" : "changed since it was read"}`
        );
    }

    return attempt.value;
}

export { EXPORT_FORMATS, type ExportFormat };

function isExportFormat(value: string): value is ExportFormat {
    return EXPORT_FORMATS.some((format) => format === value);
}

/**
 * The default export name, the same rule as the editor's: the recording's title made safe for a file name ("cursor
 * test 1"), else `<movie>-edited` for a plain movie.
 */
export function defaultExportName(video: string): string {
    const title = (() => {
        try {
            return readRecordingManifest(dirname(video))?.title;
        } catch (error) {
            log.debug(
                { error, video },
                "the manifest beside the movie does not read; the export keeps the movie's name"
            );
            return undefined;
        }
    })();
    const safe = (title ?? "")
        .replace(/[/:]/g, "-")
        .trim()
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 80);
    return safe || `${basename(video, extname(video))}-edited`;
}

// R5 3 export overwrite, progress, size
/** The export's own settings for one run, beside where it goes. */
export interface ExportRun {
    /** Replace the file at the target instead of refusing it; the new movie is written beside it and moved over it. */
    overwrite?: boolean;
    /** The exported picture's exact size in pixels: one side, the other follows the movie's (or the frame's) shape. */
    size?: { width?: number; height?: number };
    /** The share done (0 to 1), about once a percent while the movie renders. */
    onProgress?: (fraction: number) => void;
}

/** "1920x1080", "1920x" (a width) or "x1080" (a height), as `--size` takes it. */
export function parseExportSize(raw: string): { width?: number; height?: number } {
    const match = /^\s*(\d*)\s*[xX×]\s*(\d*)\s*$/.exec(raw);
    const width = match?.[1] ? Number(match[1]) : undefined;
    const height = match?.[2] ? Number(match[2]) : undefined;

    if (!match || (width === undefined && height === undefined)) {
        throw new Error(`--size takes WIDTHxHEIGHT, WIDTHx or xHEIGHT in pixels (got "${raw}")`);
    }

    for (const side of [width, height]) {
        if (side !== undefined && (side < 16 || side > 8192)) {
            throw new Error(`a --size side is 16 to 8192 pixels (got "${raw}")`);
        }
    }

    return { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

/** An onProgress that hands `print` one line per 10 % ("export 30%"). */
export function exportProgressPrinter(print: (line: string) => void): (fraction: number) => void {
    let shown = -1;
    return (fraction) => {
        const tenth = Math.floor(Math.min(1, Math.max(0, fraction)) * 10);

        if (tenth > shown) {
            shown = tenth;
            print(`export ${tenth * 10}%`);
        }
    };
}

/** `<default name>.<ext>` beside the source movie: the name an overwriting export replaces. */
function defaultOutput(video: string, extension: string): string {
    return `${join(dirname(video), defaultExportName(video))}.${extension}`;
}

/**
 * Renders into `target`. Without `overwrite` an existing target is refused before any work. With it the movie is
 * rendered into a hidden file beside the target and moved over it in one step, so a failed render leaves the old file.
 */
export async function renderInto({
    target,
    overwrite,
    render,
}: {
    target: string;
    overwrite?: boolean;
    render: (out: string) => Promise<ExportAnswer>;
}): Promise<ExportAnswer & { replaced?: boolean }> {
    const exists = existsSync(target);

    if (exists && !overwrite) {
        return {
            ok: false,
            error: `${target} exists already; the export never overwrites a file unless asked (overwrite: true, --overwrite)`,
        };
    }

    if (!overwrite) {
        return render(target);
    }

    const staging = join(dirname(target), `.${basename(target, extname(target))}.rendering${extname(target)}`);
    // A staging file is only ever this function's own leftover from a run that died before its move.
    await rm(staging, { force: true });
    const answer = await render(staging);

    if (!answer.ok || !answer.path) {
        await rm(staging, { force: true });
        return answer;
    }

    await rename(answer.path, target);
    log.debug({ target, replaced: exists }, "the export moved over its target");
    return { ...answer, path: target, ...(exists ? { replaced: true } : {}) };
}

/** `<default name>.<ext>` beside the source movie, or `-2`, `-3`…: an export never overwrites a file. */
function freeOutput(video: string, extension: string): string {
    const stem = join(dirname(video), defaultExportName(video));

    for (let index = 1; ; index++) {
        const candidate = `${stem}${index === 1 ? "" : `-${index}`}.${extension}`;

        if (!existsSync(candidate)) {
            return candidate;
        }
    }
}

/**
 * Renders the edit with the editor's renderer; a GIF or WebM is made from that movie by ffmpeg (10 fps and at most
 * 960 wide for a GIF). The intermediate movie lives in a temporary folder and is removed.
 */
/**
 * Writes the edit's subtitles (the cached transcript with its fixes, in output time) to `out` as SubRip or WebVTT.
 * `part` keeps the lines of an exported part, moved to start at 0.
 */
export async function writeSubtitles({
    value,
    format,
    out,
    part,
    leadUs,
}: {
    value: string;
    format: SubtitleFormat;
    out?: string;
    part?: { fromUs: number; toUs: number };
    /** R4 9 intro card: the export's time before the movie; every cue moves by it. */
    leadUs?: number;
}): Promise<{ path: string; cues: number; format: SubtitleFormat }> {
    const opened = await openProject(value);
    const cache = transcriptCachePath(opened.project.source.video);

    if (!existsSync(cache)) {
        throw new Error(
            "this movie has no transcript yet; run movie.transcript() or the Captions tab's Transcribe first"
        );
    }

    const lines = transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project);
    const shift = leadUs ?? 0;
    const cues = subtitleCues(lines, opened.project, part).map((cue) =>
        shift ? { ...cue, fromUs: cue.fromUs + shift, toUs: cue.toUs + shift } : cue
    );
    const path = out
        ? resolve(out)
        : join(dirname(opened.project.source.video), `${defaultExportName(opened.project.source.video)}.${format}`);
    atomicWriteFileSync(path, formatSubtitles(cues, format));
    log.debug({ path, cues: cues.length, format, part }, "subtitles written");
    return { path, cues: cues.length, format };
}

/**
 * Puts the recording's markers into an MP4 as chapters (players list them; QuickTime under View → Chapters): a
 * stream copy through ffmpeg into a file beside it, then moved over it. Answers how many it wrote; 0 leaves the movie.
 */
export async function embedChapters({
    value,
    movie,
    part,
    leadUs,
}: {
    value: string;
    movie: string;
    part?: { fromUs: number; toUs: number };
    /** R4 9 intro card: the export's time before the movie; the intro becomes its own first chapter. */
    leadUs?: number;
}): Promise<number> {
    const opened = await openProject(value);
    const whole = chapterPoints(markersOf(opened), { minSeconds: 1 });
    const inPart = part ? chaptersOfPart(whole, { from: part.fromUs / 1_000_000, to: part.toUs / 1_000_000 }) : whole;
    const lead = (leadUs ?? 0) / 1_000_000;
    const chapters =
        lead > 0 && inPart.length > 0
            ? [
                  { at: 0, label: opened.project.cards?.intro?.title ?? "Intro" },
                  ...inPart.map((chapter) => ({ ...chapter, at: chapter.at + lead })),
              ]
            : inPart;

    if (chapters.length === 0) {
        return 0;
    }

    const info = await probeVideo({ input: movie, limits: EDITOR_VIDEO_LIMITS });
    const scratch = await mkdtemp(join(tmpdir(), "recorder-chapters-"));

    try {
        const metadata = join(scratch, "chapters.txt");
        const withChapters = join(dirname(movie), `.${basename(movie)}.chapters${extname(movie)}`);
        atomicWriteFileSync(metadata, chapterMetadata(chapters, info.durationUs / 1_000_000));
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                movie,
                "-f",
                "ffmetadata",
                "-i",
                metadata,
                "-map",
                "0",
                "-map_metadata",
                "1",
                "-map_chapters",
                "1",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                withChapters,
            ],
            timeoutMs: 10 * 60_000,
        });
        await rename(withChapters, movie);
        log.debug({ movie, chapters: chapters.length, part }, "chapters put into the movie");
        return chapters.length;
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

/**
 * What an export does after the movie is written, by the edit's settings: the subtitle file beside it and the
 * markers as chapters in an MP4. A missing transcript or a failed chapter step is a warning, never a failed export.
 * `part`: the movie holds only that part of the edit (the window's I and O).
 */
export async function finishExport({
    value,
    answer,
    subtitles,
    part,
}: {
    value: string;
    answer: ExportAnswer;
    subtitles?: SubtitleFormat;
    part?: { fromUs: number; toUs: number };
}): Promise<ExportAnswer & { subtitles?: string; chapters?: number; warnings?: string[] }> {
    if (!answer.ok || !answer.path) {
        return answer;
    }

    const movie = answer.path;

    // Nothing to add subtitles or chapters to: said as an error, not as warnings under a success.
    if (!existsSync(movie)) {
        throw new Error(`${movie} does not exist; export the movie first (${toolCommand("recorder export", value)})`);
    }

    const { project } = await openProject(value);
    const format = subtitles ?? project.export.subtitles;
    const warnings: string[] = [];
    // R4 9 intro card: the renderer plays it before the movie, so subtitles and chapters move by its length.
    const leadUs = cardsLeadUs(project);
    const extras: { subtitles?: string; chapters?: number } = {};

    if (format) {
        const out = join(dirname(movie), `${basename(movie, extname(movie))}.${format}`);

        try {
            extras.subtitles = (await writeSubtitles({ value, format, out, part, leadUs })).path;
        } catch (error) {
            log.debug({ error, value }, "no subtitles beside the export");
            warnings.push(`no subtitles: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (extname(movie).toLowerCase() === ".mp4" && project.export.chapters !== false) {
        try {
            const count = await embedChapters({ value, movie, part, leadUs });

            if (count) {
                extras.chapters = count;
            }
        } catch (error) {
            log.warn({ error, movie }, "the chapters could not be put into the movie");
            warnings.push(`no chapters: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return { ...answer, ...extras, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Runs `render` on the edit as it should export: the edit itself, or with `audio.denoise` a copy in a scratch folder
 * whose source is the cleaned movie (`ensureDenoisedSource`, cached beside the source) and which has no denoise left.
 * The transcript cache goes beside the cleaned movie too, so captions and ducking still find it.
 */
async function withDenoisedSource<T>(opened: OpenedProject, render: (editPath: string) => Promise<T>): Promise<T> {
    const settings = opened.project.audio.denoise;

    if (!settings) {
        return render(opened.path);
    }

    const source = opened.project.source.video;
    const started = performance.now();
    const cleaned = await ensureDenoisedSource({ source, settings });
    log.info(
        { source, cleaned: cleaned.path, made: cleaned.made, ms: Math.round(performance.now() - started) },
        "the export renders from the cleaned sound"
    );
    const transcript = transcriptCachePath(source);

    if (existsSync(transcript) && !existsSync(transcriptCachePath(cleaned.path))) {
        await copyFile(transcript, transcriptCachePath(cleaned.path));
    }

    const scratch = await mkdtemp(join(tmpdir(), "recorder-denoise-"));

    try {
        const copy = join(scratch, "denoised.edit.json");
        const { denoise: _denoise, ...audio } = opened.project.audio;
        const camera = opened.project.camera;
        writeProject(copy, {
            ...opened.project,
            source: { ...opened.project.source, video: cleaned.path },
            ...(camera ? { camera: { ...camera, file: resolve(dirname(source), camera.file) } } : {}),
            audio,
        });
        return await render(copy);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

export async function exportAs(
    value: string,
    options: {
        out?: string;
        format?: ExportFormat;
        part?: { fromUs: number; toUs: number };
        /** A subtitle file beside the export; absent is the edit's export.subtitles. */
        subtitles?: SubtitleFormat;
    } & ExportRun = {}
): Promise<ExportAnswer & { subtitles?: string; chapters?: number; warnings?: string[]; replaced?: boolean }> {
    if (options.part) {
        // A part is a trimmed copy of the edit in a scratch folder; the edit on disk stays as it is.
        const whole = await openProject(value);
        const scratch = await mkdtemp(join(tmpdir(), "recorder-part-"));

        try {
            const copy = join(scratch, "part.edit.json");
            // R4 9 intro and end cards: a part is a clip of the movie, without the cards around it.
            const { cards: _cards, ...trimmed } = partOf(whole.project, options.part.fromUs, options.part.toUs);
            writeProject(copy, { ...trimmed, export: { ...trimmed.export, output: "" } });
            log.debug({ value, part: options.part, clips: trimmed.clips.length }, "exporting a part of the edit");
            return await exportAs(copy, {
                out: options.out,
                format: options.format ?? whole.project.export.format,
                subtitles: options.subtitles ?? whole.project.export.subtitles,
                overwrite: options.overwrite,
                size: options.size,
                onProgress: options.onProgress,
            });
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    }

    const opened = await openProject(value);
    const asked =
        options.format ??
        (options.out ? extname(options.out).slice(1).toLowerCase() : (opened.project.export.format ?? "mp4"));

    if (!isExportFormat(asked)) {
        return { ok: false, error: `the format is one of ${EXPORT_FORMATS.join(", ")} (got "${asked}")` };
    }

    const subtitles = options.subtitles ?? opened.project.export.subtitles;

    const host = { size: options.size, onProgress: options.onProgress };

    if (asked === "mp4") {
        const chosenMp4 = opened.project.export.output;
        const chosenTarget = chosenMp4
            ? join(dirname(chosenMp4), `${basename(chosenMp4, extname(chosenMp4))}.mp4`)
            : "";
        // Without out or overwrite the renderer picks a free name ("-2", "-3"); overwrite replaces the usual one.
        const target = options.out
            ? resolve(options.out)
            : options.overwrite
              ? chosenTarget || defaultOutput(opened.project.source.video, "mp4")
              : undefined;

        if (opened.project.audio.denoise) {
            return finishExport({
                value,
                answer: await renderInto({
                    target: target ?? (chosenTarget || freeOutput(opened.project.source.video, "mp4")),
                    overwrite: options.overwrite,
                    render: (to) => withDenoisedSource(opened, (edit) => hostExport({ path: edit, out: to, ...host })),
                }),
                subtitles,
            });
        }

        const recording = resolveRecording(value);
        const answer = target
            ? await renderInto({
                  target,
                  overwrite: options.overwrite,
                  render: (to) => hostExport({ path: recording, out: to, ...host }),
              })
            : await hostExport({ path: recording, ...host });
        return finishExport({ value, answer, subtitles });
    }

    const format = asked;

    if (opened.fresh) {
        writeProject(opened.path, opened.project);
    }

    // A file chosen in the editor (export.output) keeps its name with this format's extension.
    const chosen = opened.project.export.output;
    const output = options.out
        ? resolve(options.out)
        : chosen
          ? join(dirname(chosen), `${basename(chosen, extname(chosen))}.${format}`)
          : freeOutput(opened.project.source.video, format);

    if (existsSync(output) && !options.overwrite) {
        return {
            ok: false,
            error: `${output} exists already; the export never overwrites a file unless asked (overwrite: true, --overwrite)`,
        };
    }

    const started = performance.now();
    const scratch = await mkdtemp(join(tmpdir(), "recorder-export-"));

    try {
        const movie = await withDenoisedSource(opened, (render) =>
            hostExport({ path: render, out: join(scratch, "render.mp4"), ...host })
        );
        const rendered = movie.path;

        if (!movie.ok || !rendered) {
            return movie;
        }

        const answer = await renderInto({
            target: output,
            overwrite: options.overwrite,
            render: async (to) => {
                await runVideoCommand({
                    command: exportVideoArgv({ input: rendered, output: to, format }),
                    timeoutMs: 30 * 60_000,
                });
                const bytes = (await stat(to)).size;
                log.debug({ output: to, format, bytes }, "converted the export");
                return { ok: true, path: to, bytes, seconds: Math.round((performance.now() - started) / 10) / 100 };
            },
        });
        return finishExport({ value, answer, subtitles });
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
