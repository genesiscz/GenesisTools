#!/usr/bin/env bun
/**
 * Worktree or unified? Prints free disk, the estimated cost of the worker worktrees, and a recommendation.
 * Read-only. Measured 2026-10-14: a GenesisTools worktree plus `bun install --ignore-scripts` costs about 0.12 GB
 * (APFS clones), and a GenesisKit Swift test build adds about 1 GB.
 *
 * Unified mode still needs one scratch worktree per PR for the cherry-picks, so it is counted too.
 * `--free-gb <n>` replaces the measured free space, to rehearse a low-disk run.
 *
 * Usage: bun .claude/skills/babysit/scripts/mode.ts --workers 3 [--swift 1] [--reserve-gb 10] [--free-gb 4] [--json]
 */
import { statfsSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";

const PER_WORKTREE_GB = 0.12;
const SWIFT_BUILD_GB = 1.0;

const args = process.argv.slice(2);
const value = (flag: string, fallback: number) => {
    const index = args.indexOf(flag);
    const parsed = index >= 0 ? Number(args[index + 1]) : Number.NaN;

    return Number.isFinite(parsed) ? parsed : fallback;
};

const workers = value("--workers", 1);
const swift = value("--swift", 0);
const reserveGb = value("--reserve-gb", 10);
const stats = statfsSync("/System/Volumes/Data");
const freeGb = value("--free-gb", (stats.bavail * stats.bsize) / 1024 ** 3);
const neededGb = workers * PER_WORKTREE_GB + swift * SWIFT_BUILD_GB;
const leftGb = freeGb - neededGb;
const mode = leftGb >= reserveGb ? "worktree" : "unified";
// Unified mode integrates through one scratch worktree of each PR branch, built one after another.
const unifiedNeedGb = PER_WORKTREE_GB + swift * SWIFT_BUILD_GB;
const result = {
    freeGb: +freeGb.toFixed(1),
    workers,
    swiftWorkers: swift,
    neededGb: +neededGb.toFixed(2),
    leftAfterGb: +leftGb.toFixed(1),
    unifiedNeedGb: +unifiedNeedGb.toFixed(2),
    reserveGb,
    mode,
    why:
        mode === "worktree"
            ? `${leftGb.toFixed(1)} GB stays free after ${workers} worktree(s), above the ${reserveGb} GB reserve`
            : `only ${leftGb.toFixed(1)} GB would stay free, below the ${reserveGb} GB reserve: workers share the unified checkout, and the integration needs ~${unifiedNeedGb.toFixed(2)} GB at a time`,
};

if (args.includes("--json")) {
    process.stdout.write(`${SafeJSON.stringify(result)}\n`);
} else {
    console.log(
        `free ${result.freeGb} GB · ${workers} worktree(s), ${swift} with a Swift build · need ~${result.neededGb} GB`
    );
    console.log(`recommendation: ${mode} (${result.why})`);
}
