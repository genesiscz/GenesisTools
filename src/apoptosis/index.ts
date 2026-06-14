#!/usr/bin/env bun

import { resolve } from "node:path";
import { out } from "@app/logger";
import { enhanceHelp, runTool } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";
import { renderHuman, renderJson, renderKillScript, renderPrBody } from "./lib/render";
import { runScan, type ScanOptions } from "./lib/scan";
import { ApoptosisStateStore } from "./lib/state";

interface RootOptions {
    days?: string;
    grace?: string;
    ext?: string;
    ignore?: string;
    coverage?: string;
    state?: boolean;
    json?: boolean;
}

const DEFAULT_EXTS = "ts,tsx,js,jsx";
const DEFAULT_IGNORE = "node_modules,dist,.git,build,coverage";

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function buildScanOptions(dirArg: string | undefined, options: RootOptions): ScanOptions {
    const churnDays = Number.parseInt(options.days ?? "90", 10);
    const graceDays = Number.parseInt(options.grace ?? "14", 10);

    if (Number.isNaN(churnDays) || churnDays <= 0) {
        throw new Error("Churn lookback window (--days) must be a positive integer.");
    }

    if (Number.isNaN(graceDays) || graceDays <= 0) {
        throw new Error("Grace period (--grace) must be a positive integer.");
    }

    return {
        dir: resolve(dirArg ?? process.cwd()),
        churnDays,
        graceDays,
        exts: splitList(options.ext ?? DEFAULT_EXTS),
        ignore: splitList(options.ignore ?? DEFAULT_IGNORE),
        coveragePath: options.coverage ? resolve(options.coverage) : undefined,
        useState: options.state !== false,
        now: Date.now(),
    };
}

const program = new Command();

program
    .name("apoptosis")
    .description("Programmed cell death for dead code — flag zero-signal files, suggest deletion after a grace window")
    .argument("[dir]", "Directory to scan", undefined)
    .option("-d, --days <n>", "Churn lookback window in days", "90")
    .option("-g, --grace <n>", "Grace period in days before a mark graduates", "14")
    .option("-e, --ext <list>", "Comma-separated extensions", DEFAULT_EXTS)
    .option("-i, --ignore <list>", "Comma-separated path substrings to skip", DEFAULT_IGNORE)
    .option("--coverage <file>", "lcov/json coverage file to treat as a survival signal")
    .option("--no-state", "Pure scan: do not read or write the state file")
    .option("--json", "Emit the full report as JSON")
    .action(async (dirArg: string | undefined, options: RootOptions) => {
        const report = await runScan(buildScanOptions(dirArg, options));

        if (options.json) {
            out.result(renderJson(report));
        } else {
            out.result(renderHuman(report));
        }

        if (report.counts.ready > 0 && !options.json) {
            out.log.step(
                `Run \`tools apoptosis kill\` to emit a deletion script for the ${report.counts.ready} ready-to-die file(s).`
            );
        }
    });

program
    .command("status")
    .description("Show the persisted state file (marked candidates), no scan")
    .argument("[dir]", "Directory whose marks to show", undefined)
    .action(async (dirArg: string | undefined) => {
        const dir = resolve(dirArg ?? process.cwd());
        const store = new ApoptosisStateStore();
        const marks = await store.getMarks(dir);
        out.result(SafeJSON.stringify({ dir, marks }, null, 2));
    });

program
    .command("kill")
    .description("Emit a deletion shell script (or --pr-body) for ready-to-die files. Deletes nothing.")
    .argument("[dir]", "Directory to scan", undefined)
    .option("-d, --days <n>", "Churn lookback window in days", "90")
    .option("-g, --grace <n>", "Grace period in days", "14")
    .option("-e, --ext <list>", "Comma-separated extensions", DEFAULT_EXTS)
    .option("-i, --ignore <list>", "Comma-separated path substrings to skip", DEFAULT_IGNORE)
    .option("--pr-body", "Emit a Markdown PR-body checklist instead of a shell script")
    .action(async (dirArg: string | undefined, options: RootOptions & { prBody?: boolean }) => {
        const report = await runScan(buildScanOptions(dirArg, options));
        out.result(options.prBody ? renderPrBody(report) : renderKillScript(report));
    });

program
    .command("rescue")
    .description("Manually clear the death mark on a file")
    .argument("<file>", "File path to rescue")
    .argument("[dir]", "Scan dir the mark belongs to", undefined)
    .action(async (file: string, dirArg: string | undefined) => {
        const dir = resolve(dirArg ?? process.cwd());
        const store = new ApoptosisStateStore();
        await store.clear(dir, resolve(file));
        out.log.success(`Rescued ${resolve(file)} — mark cleared.`);
    });

program
    .command("reset")
    .description("Clear the entire apoptosis state file")
    .action(async () => {
        const store = new ApoptosisStateStore();
        await store.resetAll();
        out.log.success("apoptosis state cleared.");
    });

enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "apoptosis" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.log.error(message);
        process.exit(1);
    }
}

main();
