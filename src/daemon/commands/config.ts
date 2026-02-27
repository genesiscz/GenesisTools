import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { loadConfig, removeTask, setTaskEnabled, upsertTask } from "../lib/config";
import { formatInterval } from "../lib/interval";
import { runTaskEditor } from "../interactive/task-editor";

export function registerConfigCommand(program: Command): void {
    const config = program.command("config").description("Manage daemon tasks");

    config
        .command("list")
        .description("List all configured tasks")
        .action(async () => {
            const cfg = await loadConfig();

            if (cfg.tasks.length === 0) {
                p.log.info("No tasks configured.");
                return;
            }

            for (const task of cfg.tasks) {
                const state = task.enabled ? pc.green("enabled") : pc.dim("disabled");
                const retries = task.retries > 0 ? pc.dim(` retries:${task.retries}`) : "";
                p.log.step(
                    `${pc.bold(task.name)} [${state}] ${pc.dim(formatInterval(task.every))}${retries}\n  ${pc.cyan(task.command)}${task.description ? `\n  ${pc.dim(task.description)}` : ""}`
                );
            }
        });

    config
        .command("add")
        .description("Add a new task interactively")
        .action(async () => {
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
