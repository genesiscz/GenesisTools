import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { bubbleFromSidecar, readCameraSidecar } from "@genesiscz/utils/recording-editor/camera";
import { checkProject } from "@genesiscz/utils/recording-editor/check";
import { ensureDenoisedSource } from "@genesiscz/utils/recording-editor/denoise";
import { exportVideoArgv } from "@genesiscz/utils/recording-editor/ffmpeg";
import { findIdle } from "@genesiscz/utils/recording-editor/idle";
import { integratedLoudness } from "@genesiscz/utils/recording-editor/loudness";
import { type TimeValue, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    applyOp,
    type EditOp,
    type EditProject,
    EXPORT_FORMATS,
    type ExportFormat,
    editProjectSchema,
    type OpFacts,
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
import { formatSubtitles, type SubtitleFormat, subtitleCues } from "@genesiscz/utils/recording-editor/subtitles";
import {
    type CutMatch,
    fillerCuts,
    fillerList,
    foldWord,
    lineAt,
    type TranscriptSegment,
    transcriptFileSchema,
    wordCuts,
    wordSpans,
} from "@genesiscz/utils/recording-editor/transcript-cuts";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { probeVideo, type VideoProbeLimits } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { type ExportAnswer, exportEdit, movieOf, resolveRecording } from "./library";
import { chapterMetadata, chapterPoints, chaptersOfPart, markersOf } from "./moments";

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
}

/** The movie a recording argument names: the folder's movie, or the movie an edit file points at. */
function movieFor(path: string): string {
    if (path.endsWith(".json")) {
        return readProject(path).source.video;
    }

    if (existsSync(path) && statSync(path).isDirectory()) {
        const movie = movieOf(path);

        if (!movie) {
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

export async function openProject(value: string): Promise<OpenedProject> {
    const resolved = resolveRecording(value);
    const path = resolved.endsWith(".json") ? resolved : projectPathFor(movieFor(resolved));

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

/**
 * Applies ops in order to the file as it is now (the window may have saved since the last read) and saves once. One
 * op that fails leaves the file as it was and names the op.
 */
export async function editProject(value: string, ops: readonly EditOp[]): Promise<OpenedProject> {
    const opened = await openProject(value);
    let next = opened.project;
    const removedIdleUs: Array<[number, number]> = [];
    let loudness: { measuredLufs: number | null; volume: number } | undefined;
    const warnings = ops.flatMap((op) => opTimeWarnings(op, opened.project.source.durationUs));

    for (const [index, op] of ops.entries()) {
        try {
            const facts = await probeFacts(next, op);
            next = applyOp(next, op, facts);
            removedIdleUs.push(...(facts.idleUs ?? []).map(([from, to]): [number, number] => [from, to]));

            if (facts.loudnessLufs !== undefined) {
                loudness = { measuredLufs: facts.loudnessLufs, volume: next.audio.volume };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.debug({ error, op, index }, "edit op refused");
            const which = ops.length > 1 ? `op ${index + 1} (${op.op})` : op.op;
            throw new Error(`${which} refused, nothing was saved: ${message}`);
        }
    }

    // Ops that change nothing (a second annotateClicks, a fix to the same words) save no revision and no undo step.
    if (!opened.fresh && SafeJSON.stringify(next) === SafeJSON.stringify(opened.project)) {
        log.debug({ path: opened.path, ops: ops.map((op) => op.op) }, "edit changed nothing, not saved");
        return {
            path: opened.path,
            project: opened.project,
            fresh: false,
            warnings: [...warnings, "nothing changed, so nothing was saved"],
        };
    }

    // An item whose whole time this edit cut never shows any more: say so now, not only in check().
    const hiddenBefore = new Set(neverShown(opened.project).map((issue) => issue.item));
    warnings.push(
        ...neverShown(next)
            .filter((issue) => !hiddenBefore.has(issue.item))
            .map((issue) => `${issue.message}${issue.fix ? `; ${issue.fix} removes it` : ""}`)
    );

    const saved = writeProject(opened.path, next);
    pushUndo({
        editPath: opened.path,
        before: opened.project,
        afterRevision: saved.revision,
        ops: ops.map((op) => op.op),
    });
    log.debug({ path: opened.path, ops: ops.map((op) => op.op), warnings }, "edit applied");
    return {
        path: opened.path,
        project: saved,
        fresh: false,
        ...(removedIdleUs.length ? { removedIdleUs } : {}),
        ...(loudness ? { loudness } : {}),
        ...(warnings.length ? { warnings } : {}),
    };
}

/** The items of an edit that never show because their whole time is cut (check()'s first kind of issue). */
function neverShown(project: EditProject) {
    return checkProject(project, { hasTranscript: true, hasCursorTrack: true, musicFileExists: true }).filter(
        (issue) => issue.severity === "fix" && issue.target
    );
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
 * What `cutWords` or `cutFillers` would cut, without saving: each cut with its source range, the line it is in, whether
 * its time is estimated, and where it plays in the edit now (null when that part is cut already).
 */
export async function previewTranscriptCuts(
    value: string,
    op: Extract<EditOp, { op: "cutWords" | "cutFillers" }>
): Promise<Array<CutMatch & { plays: number | null }>> {
    const { project } = await openProject(value);
    const segments = readTranscriptSegments(project);
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
                  fillers: fillerList({ language: op.language, words: op.words, level: op.level }),
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

    if (op.op === "cutWords" || op.op === "cutFillers") {
        return { transcript: readTranscriptSegments(project) };
    }

    return {};
}

/** At most this many steps are kept to undo; the oldest goes first. */
const UNDO_STEPS = 30;

const undoFileSchema = z.object({
    steps: z
        .array(
            z.object({
                before: editProjectSchema,
                afterRevision: z.number().int().nonnegative(),
                /** The ops of the change; absent in a file from before it was kept. */
                ops: z.array(z.string()).optional(),
            })
        )
        .default([]),
});

/** `<edit>.undo.json` beside the edit: the agent's and the CLI's undo steps, so an undo outlives one process. */
function undoPath(editPath: string): string {
    return editPath.replace(/\.json$/, ".undo.json");
}

function readUndo(editPath: string): z.infer<typeof undoFileSchema>["steps"] {
    const path = undoPath(editPath);

    if (!existsSync(path)) {
        return [];
    }

    try {
        return undoFileSchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true })).steps;
    } catch (error) {
        log.debug({ error, path }, "the undo file does not read; it starts again empty");
        return [];
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
    return readUndo(editPath).length;
}

/** Makes every step pushed since the undo had `depth` steps into one, so a multi-step change undoes at once. */
export function collapseUndo(editPath: string, depth: number): void {
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
    const opened = await openProject(value);
    const steps = readUndo(opened.path);
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

    const saved = writeProject(opened.path, { ...last.before, revision: opened.project.revision });
    // The edit now reads as it did after the step before; that step's revision is the one just saved, so a second
    // undo goes one step further back.
    const rest = steps.slice(0, -1);

    if (rest.length) {
        rest[rest.length - 1] = { ...rest[rest.length - 1], afterRevision: saved.revision };
    }

    atomicWriteFileSync(undoPath(opened.path), SafeJSON.stringify({ steps: rest }));
    log.debug({ path: opened.path, revision: saved.revision, left: rest.length, ops: last.ops }, "edit undone");
    return { path: opened.path, project: saved, fresh: false, undone: last.ops ?? [] };
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
}: {
    value: string;
    format: SubtitleFormat;
    out?: string;
    part?: { fromUs: number; toUs: number };
}): Promise<{ path: string; cues: number; format: SubtitleFormat }> {
    const opened = await openProject(value);
    const cache = transcriptCachePath(opened.project.source.video);

    if (!existsSync(cache)) {
        throw new Error(
            "this movie has no transcript yet; run movie.transcript() or the Captions tab's Transcribe first"
        );
    }

    const lines = transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project);
    const cues = subtitleCues(lines, opened.project, part);
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
}: {
    value: string;
    movie: string;
    part?: { fromUs: number; toUs: number };
}): Promise<number> {
    const opened = await openProject(value);
    const whole = chapterPoints(markersOf(opened), { minSeconds: 1 });
    const chapters = part ? chaptersOfPart(whole, { from: part.fromUs / 1_000_000, to: part.toUs / 1_000_000 }) : whole;

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
    const { project } = await openProject(value);
    const format = subtitles ?? project.export.subtitles;
    const warnings: string[] = [];
    const extras: { subtitles?: string; chapters?: number } = {};

    if (format) {
        const out = join(dirname(movie), `${basename(movie, extname(movie))}.${format}`);

        try {
            extras.subtitles = (await writeSubtitles({ value, format, out, part })).path;
        } catch (error) {
            log.debug({ error, value }, "no subtitles beside the export");
            warnings.push(`no subtitles: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (extname(movie).toLowerCase() === ".mp4" && project.export.chapters !== false) {
        try {
            const count = await embedChapters({ value, movie, part });

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
        writeProject(copy, { ...opened.project, source: { ...opened.project.source, video: cleaned.path }, audio });
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
    } = {}
): Promise<ExportAnswer & { subtitles?: string; chapters?: number; warnings?: string[] }> {
    if (options.part) {
        // A part is a trimmed copy of the edit in a scratch folder; the edit on disk stays as it is.
        const whole = await openProject(value);
        const scratch = await mkdtemp(join(tmpdir(), "recorder-part-"));

        try {
            const copy = join(scratch, "part.edit.json");
            const trimmed = partOf(whole.project, options.part.fromUs, options.part.toUs);
            writeProject(copy, { ...trimmed, export: { ...trimmed.export, output: "" } });
            log.debug({ value, part: options.part, clips: trimmed.clips.length }, "exporting a part of the edit");
            return await exportAs(copy, {
                out: options.out,
                format: options.format ?? whole.project.export.format,
                subtitles: options.subtitles ?? whole.project.export.subtitles,
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

    if (asked === "mp4") {
        if (opened.project.audio.denoise) {
            const chosenMp4 = opened.project.export.output;
            const out = options.out
                ? resolve(options.out)
                : chosenMp4 || freeOutput(opened.project.source.video, "mp4");
            return finishExport({
                value,
                answer: await withDenoisedSource(opened, (render) => exportEdit(render, out)),
                subtitles,
            });
        }

        return finishExport({ value, answer: await exportEdit(resolveRecording(value), options.out), subtitles });
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

    if (existsSync(output)) {
        return { ok: false, error: `${output} exists already; the export never overwrites a file` };
    }

    const started = performance.now();
    const scratch = await mkdtemp(join(tmpdir(), "recorder-export-"));

    try {
        const movie = await withDenoisedSource(opened, (render) => exportEdit(render, join(scratch, "render.mp4")));

        if (!movie.ok || !movie.path) {
            return movie;
        }

        await runVideoCommand({
            command: exportVideoArgv({ input: movie.path, output, format }),
            timeoutMs: 30 * 60_000,
        });
        const bytes = (await stat(output)).size;
        log.debug({ output, format, bytes }, "converted the export");
        return finishExport({
            value,
            answer: { ok: true, path: output, bytes, seconds: Math.round((performance.now() - started) / 10) / 100 },
            subtitles,
        });
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
