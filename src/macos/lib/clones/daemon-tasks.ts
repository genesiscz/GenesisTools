import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask } from "@app/daemon/lib/config";
import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import { logger } from "@genesiscz/utils/logger";
import { escapeShellArg } from "@genesiscz/utils/string";

const log = logger.child({ component: "clones:daemon-tasks" });

export const SCAN_TASK_NAME = "macos-clones-scan";
export const PRUNE_TASK_NAME = "macos-clones-cache-prune";

export interface ClonesDaemonTasks {
    /** True when the task was written (new, or overwritten). */
    scan: boolean;
    prune: boolean;
}

/** The checkout whose scripts the daemon should run. A plan can run from a
 *  git worktree that is deleted a week later, so the registered path points
 *  at the MAIN checkout whenever this file lives in a linked worktree (the
 *  common git dir's parent) and the script exists there; otherwise at this
 *  checkout. */
function scriptPath(fileName: string): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const local = join(here, fileName);
    const res = spawnSync("git", ["-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
    });
    if (res.status !== 0) {
        log.debug({ status: res.status, stderr: res.stderr }, "git-common-dir lookup failed, using this checkout");
        return local;
    }

    const inMain = join(dirname(res.stdout.trim()), "src/macos/lib/clones", fileName);
    return existsSync(inMain) ? inMain : local;
}

function resolveScriptCommand(fileName: string): string {
    const absBun = Bun.which("bun") ?? process.execPath;
    const absScript = scriptPath(fileName);
    // The registered command is run via shell by `tools daemon`. Quote BOTH
    // paths so spaces / quotes / shell metachars in absBun or absScript
    // can't inject. macOS dev paths often contain spaces (e.g. ~/Library/...).
    return `${escapeShellArg(absBun)} run ${escapeShellArg(absScript)}`;
}

export function resolveScanCommand(): string {
    return resolveScriptCommand("scan-daemon.ts");
}

export function resolvePruneCommand(): string {
    return resolveScriptCommand("cache-prune-daemon.ts");
}

/** The script path inside a registered command (`'<bun>' run '<script>'`),
 *  undoing `escapeShellArg`: the token is one single-quoted string in which
 *  an apostrophe appears as `'"'"'` (or the `'\''` form). */
export function scriptOfCommand(command: string): string | null {
    const m = /^.* run ('(?:[^']|'"'"'|'\\'')*')$/.exec(command);
    if (m === null) {
        return null;
    }

    return m[1].slice(1, -1).replace(/'"'"'/g, "'").replace(/'\\''/g, "'");
}

/** With `overwrite: false` an existing registration is left alone, whatever
 *  its command, with one exception: a task whose script file no longer exists
 *  (a deleted worktree) can only fail at run time, so it is repaired. A
 *  finished plan can therefore call this on every run. */
async function shouldWrite(name: string, command: string, overwrite: boolean): Promise<boolean> {
    if (overwrite) {
        return true;
    }

    const existing = await getTask(name);
    if (existing === undefined) {
        return true;
    }

    const script = scriptOfCommand(existing.command);
    if (script !== null && !existsSync(script)) {
        log.info({ name, script, command }, "daemon task points at a script that is gone; repairing");
        return true;
    }

    return false;
}

/** Register the daily scan (03:00) and cache reconciliation (04:00) with
 *  `tools daemon`. Returns which tasks were written. */
export async function ensureClonesDaemonTasks(opts: { overwrite: boolean }): Promise<ClonesDaemonTasks> {
    const scanCommand = resolveScanCommand();
    const pruneCommand = resolvePruneCommand();
    const scan =
        (await shouldWrite(SCAN_TASK_NAME, scanCommand, opts.overwrite)) &&
        (await registerTask({
            name: SCAN_TASK_NAME,
            command: scanCommand,
            every: "every day at 03:00",
            overwrite: true,
            notify: true,
            timeoutMs: 30 * 60_000,
            retries: 1,
            retention: { maxAgeDays: 14, minRuns: 14 },
            description: "Clone-aware dry-run scan of watched dirs; notify reclaimable",
        }));
    const prune =
        (await shouldWrite(PRUNE_TASK_NAME, pruneCommand, opts.overwrite)) &&
        (await registerTask({
            name: PRUNE_TASK_NAME,
            command: pruneCommand,
            every: "every day at 04:00",
            overwrite: true,
            notify: false,
            timeoutMs: 30 * 60_000,
            retries: 1,
            retention: { maxAgeDays: 14, minRuns: 14 },
            description: "Drop file-meta cache rows that are stale or whose paths are gone; VACUUM when it pays",
        }));
    log.info({ scan, prune, overwrite: opts.overwrite }, "clones daemon tasks ensured");
    return { scan, prune };
}

export async function removeClonesDaemonTasks(): Promise<ClonesDaemonTasks> {
    const scan = await unregisterTask(SCAN_TASK_NAME);
    const prune = await unregisterTask(PRUNE_TASK_NAME);
    return { scan, prune };
}

export async function clonesDaemonTasksRegistered(): Promise<ClonesDaemonTasks> {
    return { scan: await isTaskRegistered(SCAN_TASK_NAME), prune: await isTaskRegistered(PRUNE_TASK_NAME) };
}
