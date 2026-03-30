#!/usr/bin/env bun

import { clearRejectedPackages, listRejectedPackages, removeRejectedPackage } from "@app/utils/packages";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";

const program = new Command()
    .name("config")
    .description("Manage GenesisTools configuration");

program
    .command("packages")
    .description("Manage optional package installation preferences")
    .action(async () => {
        const rejected = await listRejectedPackages();

        if (rejected.length === 0) {
            p.log.info("No packages are rejected. All optional packages will prompt on first use.");
            return;
        }

        p.log.info(`${rejected.length} package(s) currently rejected:`);

        for (const pkg of rejected) {
            console.log(`  ${chalk.red("✗")} ${pkg}`);
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

program.parse();
