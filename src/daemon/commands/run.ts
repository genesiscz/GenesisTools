import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { getLogsBaseDir, getTask } from "../lib/config";
import { priorityOf } from "../lib/missed-run";
import { runTask } from "../lib/runner";

export function registerRunCommand(program: Command): void {
    program
        .command("run <name>")
        .description(
            "Run one task now, once, with its timeout and priority; the run log and stats record it with reason manual"
        )
        .option("--json", "print the run (id, exit code, duration, log file) as JSON")
        .action(async (name: string, opts: { json?: boolean }) => {
            const task = await getTask(name);

            if (!task) {
                out.log.error(`Task "${name}" not found. ${toolCommand("daemon config list")} shows the tasks.`);
                process.exitCode = 1;
                return;
            }

            if (!opts.json) {
                out.log.info(`Running ${name}: ${task.command}`);
            }

            const result = await runTask(task, 1, getLogsBaseDir(), { reason: "manual", priority: priorityOf(task) });
            const ok = result.exitCode === 0;

            if (opts.json) {
                out.result({ task: name, ok, ...result });
            } else {
                out.log[ok ? "success" : "error"](
                    `${name} ${ok ? "finished" : result.exitCode === null ? "timed out" : `exited ${result.exitCode}`} in ${result.duration_ms} ms · run ${result.runId}`
                );
                out.log.info(`Output: ${toolCommand("daemon stats", "--view", "run", "--run", String(result.runId))}`);
            }

            process.exitCode = ok ? 0 : 1;
        });
}
