import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import {
    defaultFsmonitorDeps,
    disableFsmonitor,
    enableFsmonitor,
    FSMONITOR_KEYS,
    listMonitorDaemons,
    readFsmonitorState,
    readGlobal,
    recordMonitorDaemons,
} from "@app/git/lib/fsmonitor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes, formatDuration } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const RECORD_TASK = "git-fsmonitor-record";

/** An ISO time as local "YYYY-MM-DD HH:MM", the way every time is shown to the user. */
function localMinute(iso: string): string {
    return new Date(iso).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
}

function shown(value: string | null): string {
    return value === null ? pc.dim("not set") : value;
}

async function statusAction(options: { json?: boolean }): Promise<void> {
    const deps = defaultFsmonitorDeps();
    const [daemons, fsmonitor, untrackedCache, taskRegistered] = await Promise.all([
        listMonitorDaemons(deps),
        readGlobal(deps, "core.fsmonitor"),
        readGlobal(deps, "core.untrackedCache"),
        isTaskRegistered(RECORD_TASK),
    ]);
    const state = readFsmonitorState(deps.statePath);
    const byWorktree = new Map(daemons.flatMap((daemon) => (daemon.worktree ? [[daemon.worktree, daemon]] : [])));
    const worktrees = [...new Set([...Object.keys(state.worktrees), ...byWorktree.keys()])].sort();
    const totals = {
        daemons: daemons.length,
        rssBytes: daemons.reduce((sum, daemon) => sum + daemon.rssKb * 1024, 0),
        cpuMs: daemons.reduce((sum, daemon) => sum + (daemon.cpuMs ?? 0), 0),
        notRecorded: [...byWorktree.keys()].filter((worktree) => !state.worktrees[worktree]).length,
        unknownWorktree: daemons.filter((daemon) => !daemon.worktree).length,
    };

    if (options.json) {
        out.result({
            global: { "core.fsmonitor": fsmonitor, "core.untrackedCache": untrackedCache },
            enabledAt: state.enabledAt,
            previous: state.previous,
            recordTask: taskRegistered,
            worktrees: worktrees.map((worktree) => ({
                worktree,
                daemon: byWorktree.get(worktree) ?? null,
                recorded: state.worktrees[worktree] ?? null,
            })),
            totals,
        });
        return;
    }

    renderCliHeader("git fsmonitor", "the global setting, its daemons, and every worktree recorded");
    out.println(`  core.fsmonitor       ${shown(fsmonitor)}`);
    out.println(`  core.untrackedCache  ${shown(untrackedCache)}`);
    out.println(
        `  turned on by ${toolCommand("git fsmonitor")}: ${state.enabledAt ? localMinute(state.enabledAt) : pc.dim("no")}   record task: ${taskRegistered ? "registered" : pc.dim("not registered")}`
    );

    const table = createBoxTable(["WORKTREE", "DAEMON", "MEMORY", "CPU", "RECORDED SINCE"]);

    for (const worktree of worktrees) {
        const daemon = byWorktree.get(worktree);
        const recorded = state.worktrees[worktree];
        table.push([
            worktree,
            daemon ? formatDotStatus("ok", `pid ${daemon.pid}`) : formatDotStatus("dim", "none"),
            daemon ? formatBytes(daemon.rssKb * 1024) : "",
            daemon?.cpuMs != null ? formatDuration(daemon.cpuMs) : "",
            recorded ? localMinute(recorded.firstSeen) : pc.yellow("not recorded yet"),
        ]);
    }

    out.println(table.toString());
    renderCliSection("Totals");
    out.println(
        `  ${totals.daemons} daemon(s), ${formatBytes(totals.rssBytes)} of memory, ${formatDuration(totals.cpuMs)} of CPU since they started`
    );

    if (totals.unknownWorktree > 0) {
        out.println(pc.yellow(`  ${totals.unknownWorktree} daemon(s) whose socket could not be read`));
    }

    if (totals.notRecorded > 0) {
        out.println(`  Record them: ${toolCommand("git fsmonitor record")}`);
    }
}

export function registerFsmonitorCommand(parent: Command): void {
    const fsmonitor = parent
        .command("fsmonitor")
        .description(
            "git's file system monitor on in the global config, with every worktree it ran in recorded so it can be cleaned up"
        );

    fsmonitor
        .command("status")
        .description("The global settings, every running monitor daemon and every recorded worktree. Changes nothing.")
        .option("--json", "Emit the status as JSON")
        .action(statusAction);

    fsmonitor
        .command("record")
        .description(`Add every worktree a daemon watches to the recorded list (the ${RECORD_TASK} task, every 10 min)`)
        .option("--json", "Emit the result as JSON")
        .action(async (options: { json?: boolean }) => {
            const result = await recordMonitorDaemons(defaultFsmonitorDeps());

            if (options.json) {
                out.result(result);
                return;
            }

            out.println(
                `${result.daemons.length} daemon(s) running, ${result.added.length} new worktree(s) recorded, ${result.recorded} recorded in all`
            );
        });

    fsmonitor
        .command("enable")
        .description(
            `Set ${FSMONITOR_KEYS.join(" and ")} to true in the global git config (earlier values kept for disable) and register the record task`
        )
        .action(async () => {
            const deps = defaultFsmonitorDeps();
            const { previous, alreadyEnabled } = await enableFsmonitor(deps);
            await registerTask({
                name: RECORD_TASK,
                command: toolCommand("git fsmonitor record"),
                every: "every 10 minutes",
                retries: 0,
                timeoutMs: 15_000,
                // No banner: a failed run is in the daemon's run log, and `status` marks every worktree not recorded
                // yet. A banner every 10 minutes would be noise, for example while `tools` on PATH is a checkout
                // that does not have this command yet.
                notify: false,
                description: "Record every worktree a git fsmonitor daemon watches, so disable can clean it up",
                overwrite: true,
            });
            const recorded = await recordMonitorDaemons(deps);
            logger.debug({ previous, alreadyEnabled, recorded: recorded.recorded }, "git fsmonitor: enable done");

            out.println(alreadyEnabled ? "Already on; settings written again." : "On globally.");
            out.println(
                `  Earlier values, restored by disable: core.fsmonitor ${shown(previous["core.fsmonitor"])}, core.untrackedCache ${shown(previous["core.untrackedCache"])}`
            );
            out.println(
                `  ${RECORD_TASK} registered (every 10 minutes). ${recorded.recorded} worktree(s) recorded now.`
            );
            out.println(
                `  Status: ${toolCommand("git fsmonitor status")}   Undo: ${toolCommand("git fsmonitor disable")}`
            );
        });

    fsmonitor
        .command("disable")
        .description(
            "Restore the earlier global values, stop every recorded or running daemon, remove the untracked cache it added, and remove the record task"
        )
        .option("--keep-cache", "Leave the untracked cache in each index")
        .option("--json", "Emit the report as JSON")
        .action(async (options: { keepCache?: boolean; json?: boolean }) => {
            const report = await disableFsmonitor(defaultFsmonitorDeps(), { keepCache: Boolean(options.keepCache) });
            const taskRemoved = report.restored ? await unregisterTask(RECORD_TASK) : false;

            if (report.failed.length > 0) {
                process.exitCode = 1;
            }

            if (options.json) {
                out.result({ ...report, taskRemoved });
                return;
            }

            if (!report.restored) {
                out.println(
                    `Nothing to restore: the monitor was not turned on by ${toolCommand("git fsmonitor enable")} (or it is already off), so the global config is left as it is.`
                );
                return;
            }

            out.println(
                `Restored: core.fsmonitor ${shown(report.restored["core.fsmonitor"])}, core.untrackedCache ${shown(report.restored["core.untrackedCache"])}`
            );
            out.println(
                `  ${report.stopped.length} daemon(s) stopped, ${report.cacheRemoved.length} untracked cache(s) removed, ${report.missing.length} worktree(s) already gone`
            );
            out.println(`  ${RECORD_TASK}: ${taskRemoved ? "removed" : "was not registered"}`);

            for (const failure of report.failed) {
                out.println(pc.red(`  ${failure.step} failed in ${failure.worktree}: ${failure.error}`));
            }

            if (report.failed.length > 0) {
                out.println(`  Run ${toolCommand("git fsmonitor disable")} again to retry; the saved values are kept.`);
            }
        });
}
