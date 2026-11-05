import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { exportAs } from "./edit";
import { movieOf } from "./library";

const { log } = logger.scoped("recorder-quick-actions");

/**
 * The quick actions of a recording that the menu bar's Recent list and the library window offer (Library/
 * RecordingActions.swift does the same for the window): copy the movie or a GIF to the clipboard, show it in Finder,
 * open its meeting, move it to the Trash. Rename is `renameRecording` (src/utils/screen-recorder/library.ts).
 */

const RAW_MOVIES = new Set(["screen.mp4", "screen.mov", "proxy.mp4"]);
const EXPORT_EXTENSIONS = new Set(["mp4", "gif", "webm", "mov"]);

function exportsIn(folder: string): Array<{ path: string; modified: number }> {
    return readdirSync(folder)
        .filter((name) => {
            const extension = name.split(".").pop()?.toLowerCase() ?? "";
            return EXPORT_EXTENSIONS.has(extension) && !RAW_MOVIES.has(name) && !name.includes(".partial.");
        })
        .map((name) => ({ path: join(folder, name), modified: statSync(join(folder, name)).mtimeMs }));
}

/** The file Copy Movie hands out: the newest export beside the recording, else its own movie. */
export function shareableMovie(folder: string): string | undefined {
    const newest = exportsIn(folder).sort((a, b) => b.modified - a.modified)[0];
    return newest?.path ?? movieOf(folder);
}

/**
 * A GIF export that still shows the edit: the newest `.gif` beside the recording, unless the edit or the movie
 * changed after it was written.
 */
export function currentGif(folder: string): string | undefined {
    const gif = exportsIn(folder)
        .filter((file) => file.path.toLowerCase().endsWith(".gif"))
        .sort((a, b) => b.modified - a.modified)[0];

    if (!gif) {
        return undefined;
    }

    const sources = [join(folder, "edit.json"), movieOf(folder)].filter(
        (path): path is string => path !== undefined && existsSync(path)
    );
    const changed = sources.some((path) => statSync(path).mtimeMs > gif.modified);
    return changed ? undefined : gif.path;
}

/** Whether the folder is a meeting's (`~/.genesis-tools/meetings/<id>/`): it holds the whole meeting. */
export function isMeetingFolder(folder: string, meetingsRoot = genesisToolsDir("meetings")): boolean {
    const root = resolve(meetingsRoot) + sep;
    return resolve(folder).startsWith(root);
}

/** The meeting record of a meeting's screen recording; undefined for a library recording. */
export function meetingOf(folder: string, meetingsRoot = genesisToolsDir("meetings")): string | undefined {
    const record = join(folder, "meeting.json");
    return isMeetingFolder(folder, meetingsRoot) && existsSync(record) ? record : undefined;
}

async function run(argv: string[]): Promise<void> {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    if (code !== 0) {
        throw new Error(`${argv[0]} exited ${code}: ${stderr.trim() || "no output"}`);
    }
}

/** Puts a file (not its path) on the clipboard, as Finder's Copy does: a paste in Finder, Slack or Mail gets it. */
export async function copyFileToClipboard(path: string): Promise<void> {
    const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await run(["osascript", "-e", `set the clipboard to (POSIX file "${escaped}")`]);
}

/**
 * Copies the recording's movie, or with `gif` a GIF of its edit (made by the export when none is current), to the
 * clipboard. Returns the file it copied.
 */
export async function copyRecording(folder: string, { gif = false }: { gif?: boolean } = {}) {
    let path = gif ? currentGif(folder) : shareableMovie(folder);
    let exported = false;

    if (gif && !path) {
        log.debug({ folder }, "no current GIF; exporting one");
        const answer = await exportAs(folder, { format: "gif" });

        if (!answer.ok || !answer.path) {
            throw new Error(`the GIF export failed: ${answer.error ?? "no file"}`);
        }

        path = answer.path;
        exported = true;
    }

    if (!path) {
        throw new Error(
            `${folder} has no movie to copy (a frames-only recording needs ${toolCommand("recorder proxy")} first)`
        );
    }

    await copyFileToClipboard(path);
    log.debug({ folder, path, gif, exported }, "copied a recording to the clipboard");
    return { path, kind: gif ? ("gif" as const) : ("movie" as const), exported };
}

/** Shows the recording's folder in Finder (its meeting's record for a meeting with `meeting`). */
export async function revealRecording(folder: string, { meeting = false }: { meeting?: boolean } = {}) {
    const target = meeting ? meetingOf(folder) : folder;

    if (!target) {
        throw new Error(`${folder} is not a meeting's recording, so it has no meeting to open`);
    }

    await run(["open", "-R", target]);
    return { revealed: target };
}

/** Moves a library recording to the Trash (Finder's Put Back undoes it). A meeting's folder is refused. */
export async function trashRecording(folder: string, { meetingsRoot }: { meetingsRoot?: string } = {}) {
    if (isMeetingFolder(folder, meetingsRoot)) {
        throw new Error(
            `${folder} is a meeting's screen recording; its folder holds the whole meeting, so it stays. Remove the meeting with ${toolCommand("meetings")}.`
        );
    }

    await run(["/usr/bin/trash", folder]);
    log.debug({ folder }, "moved a recording to the Trash");
    return { trashed: folder };
}
