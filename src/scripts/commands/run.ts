import { suggestCommand } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { getEntry, recordRun } from "../lib/journal.ts";
import { ensureStoreDeps, ensureStoreScaffold } from "../lib/store.ts";

export function registerRun(program: Command): void {
    program
        .command("run <name> [args...]")
        .description("Run a persisted script with bun, recording the run. Pass script flags after '--'.")
        .allowExcessArguments(true)
        .action(async (name: string, args: string[]) => {
            const entry = await getEntry(name);

            if (!entry) {
                throw new Error(
                    `No script named '${name}'. Run '${suggestCommand("tools scripts", { replaceCommand: ["list"] })}'.`
                );
            }

            // Heals a moved repo (tsconfig alias) and a missing node_modules
            // before the script pays for either as an import error.
            await ensureStoreScaffold();
            await ensureStoreDeps();

            logger.debug({ name, file: entry.file, args }, "scripts run");
            const started = Date.now();
            const proc = Bun.spawn(["bun", entry.file, ...args], {
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
            });
            const exitCode = await proc.exited;

            await recordRun(name, {
                at: new Date().toISOString(),
                cwd: process.cwd(),
                exitCode,
                durationMs: Date.now() - started,
            });

            process.exitCode = exitCode;
        });
}
