import * as p from "@clack/prompts";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { runTaskEditor } from "../interactive/task-editor";
import {
    getConfigPath,
    loadConfig,
    removeTask,
    setTaskEnabled,
    type TaskPatch,
    updateTask,
    upsertTask,
} from "../lib/config";
import { formatInterval } from "../lib/interval";
import { missedRunOf, priorityOf } from "../lib/missed-run";
import { DEFAULT_TASK_TIMEOUT_MS } from "../lib/runner";
import {
    type DaemonTask,
    MISSED_RUN_MODES,
    type MissedRunMode,
    TASK_PRIORITIES,
    type TaskPriority,
} from "../lib/types";

const ON_OFF = ["on", "off"] as const;
const NOTIFY_VALUES = ["on", "off", "failure"] as const;

/** A task as `--json` prints it: the stored fields plus the defaults a missing field means. */
export function effectiveTask(task: DaemonTask) {
    return {
        ...task,
        timeoutMs: task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        notify: task.notify ?? true,
        priority: priorityOf(task),
        missedRun: missedRunOf(task),
        schedule: formatInterval(task.every),
    };
}

interface SetFlags {
    every?: string;
    timeoutMs?: string;
    retries?: string;
    enabled?: string | true;
    notify?: string | true;
    priority?: string | true;
    missedRun?: string | true;
    retryAt?: string;
    description?: string;
    json?: boolean;
}

/** Turns the flags into a patch, or prints what is wrong (with the possible values) and returns null. */
function patchFromFlags(name: string, flags: SetFlags): TaskPatch | null {
    const patch: TaskPatch = {};
    const enumValue = <T extends string>(flag: string, given: string | true | undefined, values: readonly T[]) => {
        if (given === undefined) {
            return undefined;
        }

        const value = values.find((v) => v === given);
        if (value === undefined) {
            out.log.error(
                suggestEnumFlag(`tools daemon config set ${name}`, flag, values, {
                    subcommand: ["config", "set", name],
                    given: given === true ? undefined : given,
                })
            );
            return null;
        }

        return value;
    };

    const enabled = enumValue("--enabled", flags.enabled, ON_OFF);
    const notify = enumValue("--notify", flags.notify, NOTIFY_VALUES);
    const priority = enumValue<TaskPriority>("--priority", flags.priority, TASK_PRIORITIES);
    const missedRun = enumValue<MissedRunMode>("--missed-run", flags.missedRun, MISSED_RUN_MODES);

    if (enabled === null || notify === null || priority === null || missedRun === null) {
        return null;
    }

    if (flags.every !== undefined) {
        patch.every = flags.every;
    }

    if (flags.timeoutMs !== undefined) {
        patch.timeoutMs = flags.timeoutMs === "default" ? null : Number(flags.timeoutMs);
    }

    if (flags.retries !== undefined) {
        patch.retries = Number(flags.retries);
    }

    if (enabled !== undefined) {
        patch.enabled = enabled === "on";
    }

    if (notify !== undefined) {
        patch.notify = notify === "failure" ? "failure" : notify === "on";
    }

    if (priority !== undefined) {
        patch.priority = priority;
    }

    const times = flags.retryAt
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean);

    if (missedRun !== undefined) {
        patch.missedRun = missedRun === "retry-at" ? { mode: missedRun, times } : { mode: missedRun };
    } else if (times !== undefined) {
        patch.missedRun = { mode: "retry-at", times };
    }

    if (flags.description !== undefined) {
        patch.description = flags.description;
    }

    return patch;
}

export function registerConfigCommand(program: Command): void {
    const config = program.command("config").description("Manage daemon tasks");

    config
        .command("list")
        .description("List all configured tasks")
        .option("--json", "the tasks with their effective settings, as JSON")
        .action(async (opts: { json?: boolean }) => {
            const cfg = await loadConfig();

            if (opts.json) {
                out.result({ configPath: getConfigPath(), tasks: cfg.tasks.map(effectiveTask) });
                return;
            }

            if (cfg.tasks.length === 0) {
                p.log.info("No tasks configured.");
                return;
            }

            for (const task of cfg.tasks) {
                const state = task.enabled ? pc.green("enabled") : pc.dim("disabled");
                const retries = task.retries > 0 ? pc.dim(` retries:${task.retries}`) : "";
                const priority = task.priority ? pc.dim(` priority:${task.priority}`) : "";
                const missed = task.missedRun
                    ? pc.dim(
                          ` missed:${task.missedRun.mode}${task.missedRun.times ? `@${task.missedRun.times.join(",")}` : ""}`
                      )
                    : "";
                p.log.step(
                    `${pc.bold(task.name)} [${state}] ${pc.dim(formatInterval(task.every))}${retries}${priority}${missed}\n  ${pc.cyan(task.command)}${task.description ? `\n  ${pc.dim(task.description)}` : ""}`
                );
            }
        });

    config
        .command("set <name>")
        .description("Change a task's settings; the running daemon applies them on its next tick")
        .option("--every <expr>", 'the schedule: "every 5 minutes", "every day at 03:00"')
        .option("--timeout-ms <ms>", "kill a run after this many ms; default restores 10 minutes")
        .option("--retries <n>", "extra attempts after a failed run (0 to 10)")
        .option("--enabled [on|off]", "turn the task on or off")
        .option("--notify [on|off|failure]", "macOS banners: every run, never, or only failures")
        .option("--priority [high|normal|low]", "child QoS and start order: low is background, high is never throttled")
        .option(
            "--missed-run [asap|on-wake|retry-at|skip]",
            "time-of-day tasks: what a run missed while the Mac slept does"
        )
        .option("--retry-at <times>", "retry-at times, comma-separated HH:MM (implies --missed-run retry-at)")
        .option("--description <text>", "a one-line description")
        .option("--json", "print the updated task as JSON")
        .action(async (name: string, flags: SetFlags) => {
            const patch = patchFromFlags(name, flags);

            if (patch === null) {
                process.exitCode = 1;
                return;
            }

            if (Object.keys(patch).length === 0) {
                out.log.error(
                    `Nothing to change. Pass at least one setting, e.g. tools daemon config set ${name} --priority low`
                );
                process.exitCode = 1;
                return;
            }

            try {
                const task = await updateTask(name, patch);

                if (flags.json) {
                    out.result(effectiveTask(task));
                    return;
                }

                p.log.success(`Task "${name}" updated`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                if (flags.json) {
                    out.result({ error: message });
                } else {
                    p.log.error(message);
                }

                process.exitCode = 1;
            }
        });

    config
        .command("add")
        .description("Add a new task interactively")
        .action(async () => {
            if (!isInteractive()) {
                out.log.error(
                    "config add asks its questions in a terminal. Register a task from code with registerTask()."
                );
                process.exitCode = 1;
                return;
            }

            const task = await runTaskEditor();

            if (!task) {
                return;
            }

            await upsertTask(task);
            p.log.success(`Task "${task.name}" created`);
        });

    config
        .command("remove <name>")
        .description("Remove a task")
        .action(async (name: string) => {
            const removed = await removeTask(name);

            if (removed) {
                p.log.success(`Task "${name}" removed`);
            } else {
                p.log.warn(`Task "${name}" not found`);
            }
        });

    config
        .command("enable <name>")
        .description("Enable a task")
        .action(async (name: string) => {
            try {
                await setTaskEnabled(name, true);
                p.log.success(`Task "${name}" enabled`);
            } catch (err) {
                p.log.error(err instanceof Error ? err.message : String(err));
            }
        });

    config
        .command("disable <name>")
        .description("Disable a task")
        .action(async (name: string) => {
            try {
                await setTaskEnabled(name, false);
                p.log.success(`Task "${name}" disabled`);
            } catch (err) {
                p.log.error(err instanceof Error ? err.message : String(err));
            }
        });
}
