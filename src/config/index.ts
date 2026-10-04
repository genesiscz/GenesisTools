#!/usr/bin/env bun

import * as clack from "@clack/prompts";
import { isInteractive, runTool, suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { getProfilingConfig } from "@genesiscz/utils/GenesisTools";
import { out } from "@genesiscz/utils/logger";
import { clearRejectedPackages, listRejectedPackages, removeRejectedPackage } from "@genesiscz/utils/packages";
import * as p from "@genesiscz/utils/prompts/p";
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
                clack.log.info("No packages are rejected. All optional packages will prompt on first use.");
                return;
            }

            clack.log.info(`${rejected.length} package(s) currently rejected:`);

            for (const pkg of rejected) {
                out.println(`  ${chalk.red("✗")} ${pkg}`);
            }

            if (!isInteractive()) {
                clack.log.info(
                    `Run \`${toolCommand("config packages")}\` in a terminal to re-enable them or clear every rejection.`
                );
                return;
            }

            const action = await clack.select({
                message: "What would you like to do?",
                options: [
                    { value: "re-enable", label: "Re-enable specific packages" },
                    { value: "clear-all", label: "Clear all rejections (re-prompt everything)" },
                    { value: "exit", label: "Exit" },
                ],
            });

            if (clack.isCancel(action) || action === "exit") {
                return;
            }

            if (action === "clear-all") {
                await clearRejectedPackages();
                clack.log.success("All package rejections cleared. You'll be prompted again on next use.");
                return;
            }

            if (action === "re-enable") {
                const toEnable = await clack.multiselect({
                    message: "Select packages to re-enable",
                    options: rejected.map((pkg) => ({ value: pkg, label: pkg })),
                });

                if (clack.isCancel(toEnable)) {
                    return;
                }

                for (const pkg of toEnable as string[]) {
                    await removeRejectedPackage(pkg);
                }

                clack.log.success(`Re-enabled ${(toEnable as string[]).length} package(s).`);
            }
        });

    return program;
}

interface ConfigAreaStatus {
    /** Also the subcommand name, so a picked area dispatches by just re-parsing this id. */
    id: string;
    hint: string;
}

/**
 * One line per registered config area, DECISION 5's "profiling: off" / "packages: 2 rejected"
 * shape. Not derived from `program.commands` generically — each area's state comes from its
 * own store — but `buildConfigProgram` registering a THIRD area with no matching entry here is
 * exactly the drift the "stays in sync with the registered subcommands" test in
 * `profiling.test.ts` exists to catch.
 */
export async function configAreaStatuses(): Promise<ConfigAreaStatus[]> {
    const profiling = getProfilingConfig();
    const rejected = await listRejectedPackages();

    return [
        {
            id: "profiling",
            hint: profiling.enabled
                ? `on, scopes: ${profiling.scopes.length ? profiling.scopes.join(",") : "all"}`
                : "off",
        },
        {
            id: "packages",
            hint: rejected.length === 0 ? "nothing rejected" : `${rejected.length} rejected`,
        },
    ];
}

/**
 * Bare `tools config` without a TTY (DECISION 5): the same one-line-per-area state a picker
 * would show, then the exact command to run each area directly. Never prompts.
 */
export async function printConfigOverview(): Promise<void> {
    const areas = await configAreaStatuses();

    for (const area of areas) {
        out.println(`${area.id}: ${area.hint}`);
    }

    for (const area of areas) {
        out.println(suggestCommand("tools config", { add: [area.id] }));
    }
}

/**
 * Bare `tools config` in a terminal (DECISION 5): a TUI select of the registered areas, each
 * carrying a one-line summary of its current state. Picking one re-parses into THAT area's own
 * existing command — this never reimplements profiling's or packages' own flow.
 */
export async function runConfigAreaPicker(program: Command): Promise<void> {
    const areas = await configAreaStatuses();
    const picked = await p.select({
        message: "Which area?",
        options: areas.map((area) => ({ value: area.id, label: area.id, hint: area.hint })),
    });

    if (p.isCancel(picked)) {
        return;
    }

    await program.parseAsync(["node", "config", String(picked)]);
}

// Only run the CLI when executed directly, never on import: a test that pulls a helper out of
// this module (`buildConfigProgram`) would otherwise launch the whole program while bun is
// still collecting the suite.
if (import.meta.main) {
    const program = buildConfigProgram();

    // A bare `tools config` has no action handler at the root, so commander's own default
    // ("probably missing subcommand", command.js _parseCommand) prints this same help and then
    // exits 1 — fine for a genuine usage error, wrong for "just show me what's here" (#453.3).
    // DECISION 5: show the TUI area picker in a terminal, the plain overview otherwise.
    if (process.argv.slice(2).length === 0) {
        if (isInteractive()) {
            await runConfigAreaPicker(program);
        } else {
            await printConfigOverview();
        }

        process.exit(0);
    }

    await runTool(program, { tool: "config" });
}
