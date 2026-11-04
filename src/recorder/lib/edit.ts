import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { exportVideoArgv } from "@genesiscz/utils/recording-editor/ffmpeg";
import { findIdle } from "@genesiscz/utils/recording-editor/idle";
import {
    applyOp,
    type EditOp,
    type EditProject,
    projectPathFor,
    readProject,
    wholeProject,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { type ExportAnswer, exportEdit, movieOf, resolveRecording } from "./library";

const { log } = logger.scoped("recorder-edit");

export interface OpenedProject {
    path: string;
    project: EditProject;
    /** The file did not exist: this project keeps the whole movie and is not saved yet. */
    fresh: boolean;
    /** The source stretches a removeIdle op cut, in microseconds. */
    removedIdleUs?: Array<[number, number]>;
}

/** The movie a recording argument names: the folder's movie, or the movie an edit file points at. */
function movieFor(path: string): string {
    if (path.endsWith(".json")) {
        return readProject(path).source.video;
    }

    if (existsSync(path) && statSync(path).isDirectory()) {
        const movie = movieOf(path);

        if (!movie) {
            throw new Error(`${path} has no movie yet; make one with \`tools recorder proxy ${basename(path)}\``);
        }

        return movie;
    }

    return path;
}

/** Opens a recording's edit (a library id, `last`, a folder, a movie or an edit file), or a new one of the whole movie. */
export async function openProject(value: string): Promise<OpenedProject> {
    const resolved = resolveRecording(value);
    const path = resolved.endsWith(".json") ? resolved : projectPathFor(movieFor(resolved));

    if (existsSync(path)) {
        return { path, project: readProject(path), fresh: false };
    }

    const video = movieFor(resolved);
    const info = await probeVideo({ input: video });
    const folder = dirname(video);
    const manifest = readRecordingManifest(folder);
    const cursor = join(folder, "cursor.jsonl");
    log.debug({ video, path, durationUs: info.durationUs }, "new edit of a whole movie");
    return {
        path,
        project: wholeProject({
            video,
            durationUs: info.durationUs,
            width: info.displayWidth || info.width,
            height: info.displayHeight || info.height,
            ...(existsSync(cursor) ? { cursor } : {}),
            ...(manifest ? { recording: manifest.id } : {}),
        }),
        fresh: true,
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

    for (const [index, op] of ops.entries()) {
        try {
            const facts =
                op.op === "removeIdle"
                    ? {
                          idleUs: await findIdle({
                              video: next.source.video,
                              durationUs: next.source.durationUs,
                              minUs: op.minSeconds * 1_000_000,
                              keepUs: op.keepSeconds * 1_000_000,
                          }),
                      }
                    : {};
            next = applyOp(next, op, facts);
            removedIdleUs.push(...(facts.idleUs ?? []));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.debug({ error, op, index }, "edit op refused");
            const which = ops.length > 1 ? `op ${index + 1} (${op.op})` : op.op;
            throw new Error(`${which} refused, nothing was saved: ${message}`);
        }
    }

    const saved = writeProject(opened.path, next);
    log.debug({ path: opened.path, ops: ops.map((op) => op.op) }, "edit applied");
    return { path: opened.path, project: saved, fresh: false, ...(removedIdleUs.length ? { removedIdleUs } : {}) };
}

export const EXPORT_FORMATS = ["mp4", "gif", "webm"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

function isExportFormat(value: string): value is ExportFormat {
    return EXPORT_FORMATS.some((format) => format === value);
}

/** `<name>-edited.<ext>` beside the source movie, or `-edited-2`, `-3`…: an export never overwrites a file. */
function freeOutput(video: string, extension: string): string {
    const stem = join(dirname(video), `${basename(video, extname(video))}-edited`);

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
export async function exportAs(
    value: string,
    options: { out?: string; format?: ExportFormat } = {}
): Promise<ExportAnswer> {
    const asked = options.format ?? (options.out ? extname(options.out).slice(1).toLowerCase() : "mp4");

    if (!isExportFormat(asked)) {
        return { ok: false, error: `the format is one of ${EXPORT_FORMATS.join(", ")} (got "${asked}")` };
    }

    if (asked === "mp4") {
        return exportEdit(resolveRecording(value), options.out);
    }

    const format = asked;
    const opened = await openProject(value);

    if (opened.fresh) {
        writeProject(opened.path, opened.project);
    }

    const output = options.out ? resolve(options.out) : freeOutput(opened.project.source.video, format);

    if (existsSync(output)) {
        return { ok: false, error: `${output} exists already; the export never overwrites a file` };
    }

    const started = performance.now();
    const scratch = await mkdtemp(join(tmpdir(), "recorder-export-"));

    try {
        const movie = await exportEdit(opened.path, join(scratch, "render.mp4"));

        if (!movie.ok || !movie.path) {
            return movie;
        }

        await runVideoCommand({
            command: exportVideoArgv({ input: movie.path, output, format }),
            timeoutMs: 30 * 60_000,
        });
        const bytes = (await stat(output)).size;
        log.debug({ output, format, bytes }, "converted the export");
        return { ok: true, path: output, bytes, seconds: Math.round((performance.now() - started) / 10) / 100 };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
