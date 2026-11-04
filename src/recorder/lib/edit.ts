import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
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
import { movieOf, resolveRecording } from "./library";

const { log } = logger.scoped("recorder-edit");

export interface OpenedProject {
    path: string;
    project: EditProject;
    /** The file did not exist: this project keeps the whole movie and is not saved yet. */
    fresh: boolean;
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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.debug({ error, op, index }, "edit op refused");
            const which = ops.length > 1 ? `op ${index + 1} (${op.op})` : op.op;
            throw new Error(`${which} refused, nothing was saved: ${message}`);
        }
    }

    const saved = writeProject(opened.path, next);
    log.debug({ path: opened.path, ops: ops.map((op) => op.op) }, "edit applied");
    return { path: opened.path, project: saved, fresh: false };
}
