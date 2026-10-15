import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask } from "@app/daemon/lib/config";
import { registerTask, unregisterTask } from "@app/daemon/lib/register";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { getMainRepoRootSync } from "@genesiscz/utils/git/worktree";
import { logger } from "@genesiscz/utils/logger";
import { escapeShellArg } from "@genesiscz/utils/string";
import type { ScheduleStatus } from "./types";

const log = logger.child({ component: "du:index:daemon-task" });

export const INDEX_TASK_NAME = "du-index-refresh";
/** Before the clones scan (03:00) and the cache prune (04:00), so the three never overlap. */
export const INDEX_TASK_EVERY = "every day at 02:15";
const SCRIPT = "index-daemon.ts";

/** The main checkout's copy when this file runs from a linked worktree that may be deleted later. */
function scriptPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const local = join(here, SCRIPT);
    const inMain = join(getMainRepoRootSync(here), "src/du/lib/index", SCRIPT);
    return existsSync(inMain) ? inMain : local;
}

export function resolveIndexDaemonCommand(): string {
    const absBun = Bun.which("bun") ?? process.execPath;
    return `${escapeShellArg(absBun)} run ${escapeShellArg(scriptPath())}`;
}

/** Registers the nightly full build with `tools daemon` (overwriting an older registration). */
export async function scheduleIndexTask(): Promise<boolean> {
    const command = resolveIndexDaemonCommand();
    const written = await registerTask({
        name: INDEX_TASK_NAME,
        command,
        every: INDEX_TASK_EVERY,
        overwrite: true,
        notify: "failure",
        // A $HOME build is estimated at 2 to 3.5 minutes; one huge flat directory can stretch it.
        timeoutMs: 45 * 60_000,
        retries: 1,
        retention: { maxAgeDays: 14, minRuns: 14 },
        // Background QoS: the walk is pure kernel work and must never compete with the user.
        priority: "low",
        description: `Nightly full build of the du directory-size index (${toolCommand("du index build")})`,
    });
    log.info({ command, written }, "du index task scheduled");
    return written;
}

export async function unscheduleIndexTask(): Promise<boolean> {
    return unregisterTask(INDEX_TASK_NAME);
}

export async function indexTaskStatus(): Promise<ScheduleStatus> {
    const task = await getTask(INDEX_TASK_NAME);
    return {
        task: INDEX_TASK_NAME,
        registered: task !== undefined,
        every: task?.every ?? null,
        command: task?.command ?? null,
    };
}
