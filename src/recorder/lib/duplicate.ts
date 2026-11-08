import { randomBytes } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { editProjectSchema } from "@genesiscz/utils/recording-editor/project";
import {
    RECORDING_MANIFEST,
    readRecordingManifest,
    recordingsLibraryDir,
} from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { openProject } from "./edit";
import { recordingFolderOf } from "./moments";

const { log } = logger.scoped("recorder-duplicate");

/**
 * A copy of a recording with its edit, so a before and an after can live side by side. Every file is an APFS clone
 * (copy-on-write: no disk until one side changes), the copy gets its own id and title, every absolute path in its
 * JSON that pointed into the old folder points into the new one, and the undo history stays behind.
 */

export interface DuplicateAnswer {
    /** The copy's edit file. */
    path: string;
    /** The copy's folder. */
    folder: string;
    /** The library id, when the copy is a library recording. */
    id?: string;
    title: string;
}

/** Clones a file or a folder; a file system without clones copies it (FICLONE, not FICLONE_FORCE). */
function clone(from: string, to: string, filter?: (path: string) => boolean): void {
    cpSync(from, to, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
        ...(filter ? { filter } : {}),
    });
}

/** Undo and redo steps belong to the original's history, not to the copy. */
const isUndoFile = (path: string): boolean => path.endsWith(".undo.json");

/** Every string in a JSON value that names a path inside `from`, moved to the same place inside `to`. */
export function movedPaths(value: unknown, from: string, to: string): unknown {
    if (typeof value === "string") {
        return value === from || value.startsWith(from + sep) ? to + value.slice(from.length) : value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => movedPaths(item, from, to));
    }

    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, movedPaths(item, from, to)]));
    }

    return value;
}

/** The absolute paths inside `folder` that a JSON value names and that exist. */
function pathsInside(value: unknown, folder: string, found = new Set<string>()): Set<string> {
    if (typeof value === "string" && value.startsWith(folder + sep) && existsSync(value)) {
        found.add(value);
    } else if (Array.isArray(value)) {
        for (const item of value) {
            pathsInside(item, folder, found);
        }
    } else if (typeof value === "object" && value !== null) {
        for (const item of Object.values(value)) {
            pathsInside(item, folder, found);
        }
    }

    return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rewrites the paths of one JSON file of the copy; a file that is not JSON is left as it is. */
function rewriteJson(path: string, from: string, to: string, change?: (value: Record<string, unknown>) => void): void {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    } catch (error) {
        log.debug({ error, path }, "not JSON; the copy keeps it as it is");
        return;
    }

    const moved = movedPaths(parsed, from, to);

    if (change && isRecord(moved)) {
        change(moved);
    }

    atomicWriteFileSync(path, `${SafeJSON.stringify(moved, null, 2)}\n`);
}

/** A library id in the recorder's own shape, so the library sorts the copy by when it was made. */
export function newLibraryId(now = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `video-${stamp}-${randomBytes(4).toString("hex")}`;
}

function checkTarget(target: string): void {
    if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
        throw new Error(`${target} already exists and is not an empty folder; name another --to`);
    }
}

/**
 * Duplicates a recording (a library id, `last`, a folder, a movie or an edit file). A recording folder is cloned
 * whole; a plain movie is cloned with its `<stem>.edit.json` and the files its edit names inside its folder. Without
 * `to` the copy is a new library recording; `title` names it ("<title> (copy)" by default).
 */
export async function duplicateRecording(
    value: string,
    options: { title?: string; to?: string; now?: Date } = {}
): Promise<DuplicateAnswer> {
    const opened = await openProject(value);
    const folder = recordingFolderOf(opened);
    const manifest = folder ? readRecordingManifest(folder) : undefined;
    const oldTitle = manifest?.title ?? basename(opened.project.source.video, extname(opened.project.source.video));
    const title = (options.title ?? `${oldTitle} (copy)`).trim();

    if (!title || title.length > 120) {
        throw new RangeError("a title is 1 to 120 characters");
    }

    const id = options.to ? undefined : newLibraryId(options.now);
    const target = resolve(options.to ?? recordingsLibraryDir(id ?? ""));
    checkTarget(target);

    if (folder) {
        if (target.startsWith(folder + sep)) {
            throw new Error(`the copy cannot go inside the recording it copies (${folder})`);
        }

        // The edit may not be saved yet: the copy then starts from the same whole movie.
        clone(folder, target, (path) => !isUndoFile(path));

        for (const name of readdirSync(target).filter((entry) => entry.endsWith(".json"))) {
            rewriteJson(join(target, name), folder, target, (root) => {
                if (name === RECORDING_MANIFEST) {
                    root.title = title;

                    if (id) {
                        root.id = id;
                    }
                }

                // An edit names its library recording by id: the copy's edit names the copy.
                if (id && manifest && isRecord(root.source) && root.source.recording === manifest.id) {
                    root.source.recording = id;
                }
            });
        }

        // An edit kept beside the recording but named for its movie's old folder (a copied library folder) moves too.
        const editPath = join(target, relative(folder, opened.path));
        log.debug({ from: folder, to: target, id }, "recording duplicated");
        const path = existsSync(editPath) ? editPath : join(target, "edit.json");
        return { path, folder: target, ...(id ? { id } : {}), title };
    }

    // A plain movie: its file, its edit and the files the edit names in its folder.
    const movie = opened.project.source.video;
    const movieFolder = dirname(movie);
    mkdirSync(target, { recursive: true });
    const movieName = id ? `screen${extname(movie)}` : basename(movie);
    clone(movie, join(target, movieName));

    for (const path of pathsInside(opened.project, movieFolder)) {
        if (path !== movie && !isUndoFile(path)) {
            clone(path, join(target, relative(movieFolder, path)));
        }
    }

    const project = editProjectSchema.parse(movedPaths(opened.project, movieFolder, target));
    project.source.video = join(target, movieName);
    const editPath = id
        ? join(target, "edit.json")
        : join(target, `${basename(movieName, extname(movieName))}.edit.json`);
    atomicWriteFileSync(editPath, `${SafeJSON.stringify(project, null, 2)}\n`);

    if (id) {
        const now = (options.now ?? new Date()).toISOString();
        atomicWriteFileSync(
            join(target, RECORDING_MANIFEST),
            `${SafeJSON.stringify(
                {
                    version: 1,
                    id,
                    title,
                    startedAt: now,
                    endedAt: now,
                    displays: [],
                    settings: {
                        kind: "video",
                        video: { file: movieName, durationMs: Math.round(project.source.durationUs / 1000) },
                        outcome: "done",
                        duplicatedFrom: movie,
                    },
                    frames: [],
                    warnings: [],
                },
                null,
                2
            )}\n`
        );
    }

    log.debug({ from: movie, to: target, id }, "movie duplicated");
    return { path: editPath, folder: target, ...(id ? { id } : {}), title };
}
