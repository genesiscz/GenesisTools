import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { loadTaskToolConfig, saveTaskToolConfig } from "@app/task/lib/config";

export function registerConfigCommand(program: Command): void {
    program
        .command("config")
        .description("Read/update task retention and GC settings")
        .option("--session-retention-days <n>", "Delete sessions older than N days on GC")
        .option("--gc-on-run-start <onoff>", "Run GC at the start of each tools task run (on|off)")
        .action((opts: { sessionRetentionDays?: string; gcOnRunStart?: string }) => {
            let next = loadTaskToolConfig();

            if (opts.sessionRetentionDays !== undefined) {
                const days = Number.parseInt(opts.sessionRetentionDays, 10);
                if (Number.isNaN(days) || days < 0) {
                    out.printlnErr("error: --session-retention-days requires a non-negative number");
                    process.exit(1);
                }

                next = saveTaskToolConfig({ sessionRetentionDays: days });
            }

            if (opts.gcOnRunStart !== undefined) {
                if (opts.gcOnRunStart !== "on" && opts.gcOnRunStart !== "off") {
                    out.printlnErr("error: --gc-on-run-start expects on|off");
                    process.exit(1);
                }

                next = saveTaskToolConfig({ gcOnRunStart: opts.gcOnRunStart === "on" });
            }

            out.print(`${SafeJSON.stringify(next, null, 2)}\n`);
        });
}
