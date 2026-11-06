import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertReach } from "@genesiscz/utils/api-descriptor";
import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type RecordingStoreId, recordingStoreOf } from "@genesiscz/utils/screen-recorder/recording-stores";
import { z } from "zod";
import { exportAs } from "./edit";
import { movieOf, RECORDING_SOURCE_MOVIES } from "./library";

const { log } = logger.scoped("recorder-quick-actions");

/**
 * The quick actions of a recording that the menu bar's Recent list and the library window offer (Library/
 * RecordingActions.swift does the same for the window): copy the movie or a GIF to the clipboard, show it in Finder,
 * open its meeting, move it to the Trash. Rename is `renameRecording` (src/utils/screen-recorder/library.ts).
 */

const EXPORT_EXTENSIONS = new Set(["mp4", "gif", "webm", "mov"]);

function exportsIn(folder: string): Array<{ path: string; modified: number }> {
    return readdirSync(folder)
        .filter((name) => {
            const extension = name.split(".").pop()?.toLowerCase() ?? "";
            return (
                EXPORT_EXTENSIONS.has(extension) && !RECORDING_SOURCE_MOVIES.has(name) && !name.includes(".partial.")
            );
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
    assertReach("user", "replace the user's clipboard");
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
    const target = meeting ? recordingStoreOf(folder)?.recordOf?.(folder) : folder;

    if (!target) {
        throw new Error(`${folder} is not a meeting's recording, so it has no meeting to open`);
    }

    assertReach("user", "bring Finder to the front");
    await run(["open", "-R", target]);
    return { revealed: target };
}

const removalPlanSchema = z.array(
    z.object({ path: z.string(), verdict: z.string(), reason: z.string().optional() }).passthrough()
);

/**
 * Moves one library recording through the shared removal policy; `trashRecordings` for several at once. `tools rm trash`
 * lists its restore command. A kept meeting is refused. `roots` replaces a store's root, for a test.
 *
 * When the policy would need the user's confirmation, it refuses and asks no one, unless `askUser` (the CLI command a
 * person runs) lets `tools rm` file the request: an agent's call must never land in the user's inbox (NR40).
 */
export async function trashRecording(
    folder: string,
    options: { roots?: Partial<Record<RecordingStoreId, string>>; askUser?: boolean; aside?: boolean } = {}
) {
    await trashRecordings([folder], options);
    return { trashed: folder };
}

/**
 * Moves several library recordings through the removal policy in ONE `tools rm` call, so what needs the user is one
 * request, never one per recording (RC24: 20 recordings made 20 requests). `aside: false` keeps the folders in the
 * library while a request waits (`--no-aside`); absent, `tools rm` decides. Every folder is checked before anything
 * moves: a kept meeting refuses the whole call, and on an agent's call one that would ask refuses all of them.
 */
export async function trashRecordings(
    folders: readonly string[],
    {
        roots,
        askUser = false,
        aside,
    }: { roots?: Partial<Record<RecordingStoreId, string>>; askUser?: boolean; aside?: boolean } = {}
): Promise<{ trashed: string[] }> {
    const unique = [...new Set(folders)];

    if (unique.length === 0) {
        throw new Error("name at least one recording to trash");
    }

    for (const folder of unique) {
        const kept = recordingStoreOf(folder, roots)?.kept;

        if (kept) {
            throw new Error(
                `${folder} is ${kept.what}; ${kept.reason}, so it stays. Remove it with ${toolCommand(kept.tool)}. Nothing was moved.`
            );
        }
    }

    if (askUser) {
        assertReach("user", "ask the user to confirm a removal");
    } else {
        const plan = await execTool(["rm", "--dry-run", "--json", ...unique], { timeout: 30_000 });
        const verdicts = removalPlanSchema.safeParse(
            plan.success ? SafeJSON.parse(plan.stdout, { strict: true }) : null
        );
        const refused = verdicts.success
            ? verdicts.data.filter((entry) => entry.verdict !== "allow")
            : unique.map((path) => ({ path, reason: undefined }));

        if (refused.length > 0) {
            log.debug(
                { folders: unique, refused: refused.length, planned: plan.success },
                "trash refused: the removal policy would ask the user"
            );
            const named = refused
                .map(
                    (entry) =>
                        `${entry.path} needs the user's confirmation to remove (${entry.reason ?? "the removal policy did not allow it"})`
                )
                .join("; ");
            throw new Error(
                `${named}; nothing was moved and no one was asked. The user can run ${toolCommand("recorder trash")} ${unique.join(" ")}`
            );
        }
    }

    const flags = aside === undefined ? [] : [aside ? "--aside" : "--no-aside"];
    const result = await execTool(["rm", ...flags, ...unique], { timeout: 30_000 });
    if (!result.success) {
        // stdout carries the policy's own words (the request id); stderr only its log lines.
        throw new Error(
            result.stdout.trim() || result.stderr.trim() || "removal policy refused the recordings; no file was moved"
        );
    }
    log.debug({ folders: unique }, "moved recordings through the removal policy");
    return { trashed: unique };
}
