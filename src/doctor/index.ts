#!/usr/bin/env bun

import logger from "@app/logger";
import { enhanceHelp } from "@app/utils/cli";
import { ensureDirs, makeRunId } from "@app/doctor/lib/paths";
import { Command } from "commander";

interface RootOpts {
    plain?: boolean;
    thorough?: boolean;
    quick?: boolean;
    fresh?: boolean;
    debug?: boolean;
    dryRun?: boolean;
    json?: boolean;
    only?: string;
}

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
    .action(async (opts: RootOpts) => {
        const runId = makeRunId();
        ensureDirs(runId);
        logger.debug({ opts, runId }, "doctor starting");
        logger.info("tools doctor — phase 1 scaffold complete; UI arrives in phase 2");
    });

enhanceHelp(program);

async function main(): Promise<void> {
    await program.parseAsync(process.argv);
}

main();
