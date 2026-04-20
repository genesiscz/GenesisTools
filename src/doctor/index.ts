#!/usr/bin/env bun

import { homedir } from "node:os";
import { createDoctorAnalyzers } from "@app/doctor/analyzers";
import { DiskSpaceAnalyzer } from "@app/doctor/analyzers/disk-space";
import { wipeCache } from "@app/doctor/lib/cache";
import { ensureDirs, makeRunId } from "@app/doctor/lib/paths";
import { runJson } from "@app/doctor/ui/json";
import { runLog } from "@app/doctor/ui/log";
import { runPlain } from "@app/doctor/ui/plain";
import { runStats } from "@app/doctor/ui/stats";
import { runTui } from "@app/doctor/ui/tui";
import logger from "@app/logger";
import { enhanceHelp, isInteractive } from "@app/utils/cli";
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

        const analyzers = createDoctorAnalyzers();
        const only = opts.only
            ?.split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        const shared = {
            analyzers,
            runId,
            only,
            thorough: Boolean(opts.thorough),
            fresh: Boolean(opts.fresh),
            dryRun: Boolean(opts.dryRun),
        };

        if (opts.json) {
            await runJson(shared);
            return;
        }

        const forcePlain = Boolean(opts.plain) || !isInteractive();
        const columns = process.stdout.columns ?? 0;
        const rows = process.stdout.rows ?? 0;
        const tooSmall = columns < 80 || rows < 24;

        if (forcePlain || tooSmall) {
            if (tooSmall && !forcePlain) {
                logger.warn(`Terminal is ${columns}x${rows} - falling back to --plain (needs 80x24 minimum).`);
            }

            await runPlain(shared);
            return;
        }

        await runTui(shared);
    });

program
    .command("find")
    .description("Ad-hoc file finder: X files in last Y days bigger than Z MB")
    .option("--root <path>", "Root directory to scan", "$HOME")
    .option("--min-mb <n>", "Minimum file size in MB", "100")
    .option("--max-days <n>", "Modified in last N days", "30")
    .action(async (opts: { root: string; minMb: string; maxDays: string }) => {
        const runId = makeRunId();
        ensureDirs(runId);

        const analyzer = new DiskSpaceAnalyzer();
        const root = opts.root === "$HOME" ? homedir() : opts.root;
        const minMB = Number.parseInt(opts.minMb, 10);
        const maxDays = Number.parseInt(opts.maxDays, 10);

        if (!Number.isFinite(minMB) || minMB < 0 || !Number.isFinite(maxDays) || maxDays < 0) {
            throw new Error("--min-mb and --max-days must be non-negative integers");
        }

        const findings = await analyzer.findAdhoc({
            root,
            minMB,
            maxDays,
        });

        logger.info(`${findings.length} files matched`);

        for (const finding of findings) {
            logger.info(`  ${finding.title} - ${finding.detail ?? ""}`);
        }
    });

program
    .command("log")
    .description("Show recent action history")
    .option("--since <duration>", "e.g. 7d, 24h, 1w", "7d")
    .option("--analyzer <id>", "Filter by analyzer id")
    .option("--json", "JSON output")
    .action(async (opts: { since: string; analyzer?: string; json?: boolean }) => {
        await runLog(opts);
    });

program
    .command("stats")
    .description("Rolled-up reclaim totals")
    .option("--since <duration>", "7d, 30d, all", "7d")
    .option("--json", "JSON output")
    .action(async (opts: { since: string; json?: boolean }) => {
        await runStats(opts);
    });

program
    .command("wipe-cache")
    .description("Delete the analyzer cache so next run is fresh")
    .action(async () => {
        await wipeCache();
        console.log("Analyzer cache wiped.");
    });

enhanceHelp(program);

async function main(): Promise<void> {
    await program.parseAsync(process.argv);
}

main();
