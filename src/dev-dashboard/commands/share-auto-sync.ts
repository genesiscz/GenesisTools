import { join } from "node:path";
import { getTask } from "@app/daemon/lib/config";
import { type RegisterTaskOptions, registerTask, unregisterTask } from "@app/daemon/lib/register";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { loadShareConfig, updateShareConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { getMainRepoRootSync } from "@genesiscz/utils/git/worktree";
import { logger, out } from "@genesiscz/utils/logger";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";

const { log } = logger.scoped("share-auto-sync");

/** The daemon task that sends edited published notes again. One task per kind; md is the only kind that syncs from a source. */
export const SHARE_AUTO_SYNC_TASK = "share-md-auto-sync";
export const DEFAULT_AUTO_SYNC_MINUTES = 10;

/** The task: the main checkout's `tools` (a worktree may be gone later), sending only notes edited since their last sync. */
export function autoSyncTaskOptions(input: { everyMinutes: number; repoRoot: string }): RegisterTaskOptions {
    return {
        name: SHARE_AUTO_SYNC_TASK,
        command: shellCommandLine([
            join(input.repoRoot, "tools"),
            "dev-dashboard",
            "share",
            "sync",
            "--all",
            "--changed",
        ]),
        every: `every ${input.everyMinutes} minutes`,
        overwrite: true,
        notify: "failure",
        retries: 0,
        timeoutMs: 5 * 60_000,
        priority: "low",
        retention: { maxAgeDays: 3, minRuns: 20 },
        description: `Send published notes edited since their last sync to their share targets (${toolCommand("dev-dashboard share sync --all --changed")})`,
    };
}

/** `share auto-sync on|off|status [--every <minutes>]`: the setting lives in the share config, the schedule in the daemon. */
export async function runShareAutoSync(input: {
    state: "on" | "off" | "status";
    everyMinutes?: number;
}): Promise<void> {
    if (input.state === "on") {
        const everyMinutes = input.everyMinutes ?? DEFAULT_AUTO_SYNC_MINUTES;
        await updateShareConfig((config) => ({
            ...config,
            kinds: { ...config.kinds, md: { ...config.kinds?.md, autoSync: { everyMinutes } } },
        }));
        const options = autoSyncTaskOptions({ everyMinutes, repoRoot: getMainRepoRootSync(import.meta.dirname) });
        await registerTask(options);
        log.info({ task: options.name, command: options.command, every: options.every }, "share auto-sync on");
        out.println(
            `auto-sync on: every ${everyMinutes} min the daemon task ${SHARE_AUTO_SYNC_TASK} sends notes edited since their last sync`
        );
        return;
    }

    if (input.state === "off") {
        await updateShareConfig((config) => {
            const md = { ...config.kinds?.md };
            delete md.autoSync;
            return { ...config, kinds: { ...config.kinds, md } };
        });
        const removed = await unregisterTask(SHARE_AUTO_SYNC_TASK);
        log.info({ task: SHARE_AUTO_SYNC_TASK, removed }, "share auto-sync off");
        out.println(
            removed ? "auto-sync off: the daemon task is removed" : "auto-sync off (no daemon task was registered)"
        );
        return;
    }

    const [config, task] = await Promise.all([loadShareConfig(), getTask(SHARE_AUTO_SYNC_TASK)]);
    const every = config.kinds?.md?.autoSync?.everyMinutes;
    out.println(every ? `auto-sync: on, every ${every} min` : "auto-sync: off");
    out.println(
        task
            ? `daemon task: ${task.name}, ${task.every}, ${task.enabled ? "enabled" : "disabled"}`
            : "daemon task: not registered"
    );
}
