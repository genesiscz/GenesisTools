#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { clearRejectedPackages, listRejectedPackages, removeRejectedPackage } from "@genesiscz/utils/packages";
import chalk from "chalk";
import { Command } from "commander";
import { registerProfilingCommand } from "./commands/profiling";

export function buildConfigProgram(): Command {
    const program = new Command().name("config").description("Manage GenesisTools configuration");

    registerProfilingCommand(program);

    program
        .command("packages")
        .description("Manage optional package installation preferences")
        .addHelpText(
            "after",
            "\nRun with no flags for an interactive prompt: re-enable specific rejected packages, or clear every rejection so each one prompts again on next use."
        )
        .action(async () => {
            const rejected = await listRejectedPackages();

            if (rejected.length === 0) {
                p.log.info("No packages are rejected. All optional packages will prompt on first use.");
                return;
            }

            p.log.info(`${rejected.length} package(s) currently rejected:`);

            for (const pkg of rejected) {
                out.println(`  ${chalk.red("✗")} ${pkg}`);
            }

            const action = await p.select({
                message: "What would you like to do?",
                options: [
                    { value: "re-enable", label: "Re-enable specific packages" },
                    { value: "clear-all", label: "Clear all rejections (re-prompt everything)" },
                    { value: "exit", label: "Exit" },
                ],
            });

            if (p.isCancel(action) || action === "exit") {
                return;
            }

            if (action === "clear-all") {
                await clearRejectedPackages();
                p.log.success("All package rejections cleared. You'll be prompted again on next use.");
                return;
            }

            if (action === "re-enable") {
                const toEnable = await p.multiselect({
                    message: "Select packages to re-enable",
                    options: rejected.map((pkg) => ({ value: pkg, label: pkg })),
                });

                if (p.isCancel(toEnable)) {
                    return;
                }

                for (const pkg of toEnable as string[]) {
                    await removeRejectedPackage(pkg);
                }

                p.log.success(`Re-enabled ${(toEnable as string[]).length} package(s).`);
            }
        });

    return program;
}

// Only run the CLI when executed directly, never on import: a test that pulls a helper out of
// this module (`buildConfigProgram`) would otherwise launch the whole program while bun is
// still collecting the suite.
if (import.meta.main) {
    const program = buildConfigProgram();

    // A bare `tools config` has no action handler at the root, so commander's own default
    // ("probably missing subcommand", command.js _parseCommand) prints this same help and then
    // exits 1 — fine for a genuine usage error, wrong for "just show me what's here" (#453.3).
    if (process.argv.slice(2).length === 0) {
        program.outputHelp();
        process.exit(0);
    }

    await runTool(program, { tool: "config" });
}
