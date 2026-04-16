#!/usr/bin/env bun

import logger from "@app/logger";
import { enhanceHelp } from "@app/utils/cli";
import { Command } from "commander";

const program = new Command();

program
    .name("doctor")
    .description("Diagnose and fix common macOS dev-machine problems")
    .option("--plain", "Use linear clack renderer instead of OpenTUI dashboard")
    .option("--thorough", "Deeper scans, no time caps")
    .option("--quick", "Shallow scan, < 2s budget")
    .option("--fresh", "Bypass analyzer cache")
    .option("--debug", "Show per-analyzer timings and logs")
    .option("--dry-run", "Never execute fixes, show what would run")
    .option("--json", "Machine-readable output (implies --plain)")
    .option("--only <ids>", "Comma-separated analyzer ids to run")
    .action(() => {
        logger.info("tools doctor — coming soon");
    });

enhanceHelp(program);

async function main(): Promise<void> {
    await program.parseAsync(process.argv);
}

main();
