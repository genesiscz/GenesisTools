import { existsSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { BenchmarkSuite, HyperfineOutput, HyperfineResult, RunOptions, SavedResult } from "@app/benchmark/types";
import { getResultPath } from "@app/benchmark/lib/results";

async function ensureHyperfine(): Promise<boolean> {
    const proc = Bun.spawn(["which", "hyperfine"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    if (proc.exitCode === 0) {
        return true;
    }

    p.log.error("hyperfine is required but not installed.");
    p.log.info(`Install with: ${pc.bold("brew install hyperfine")}`);
    return false;
}

export async function runBenchmark(suite: BenchmarkSuite, opts: RunOptions = {}): Promise<HyperfineResult[] | null> {
    if (!(await ensureHyperfine())) {
        return null;
    }

    // Filter commands if --only specified
    let commands = suite.commands;

    if (opts.only) {
        commands = commands.filter((c) => c.label === opts.only);

        if (commands.length === 0) {
            p.log.error(`No command with label "${opts.only}" in suite "${suite.name}"`);
            process.exit(1);
        }
    }

    // Result filename includes label when --only is used to avoid overwriting full-suite results
    const resultPath = getResultPath(suite.name, opts.only);

    const args = ["hyperfine"];

    // Warmup: CLI > suite default > 3
    // Commander's --no-warmup sets opts.warmup to false (boolean negation)
    const warmup = opts.warmup === false || opts.noWarmup
        ? 0
        : (opts.warmup ?? suite.warmup ?? 3);
    args.push("--warmup", String(warmup));

    // Runs: CLI > suite default > omit (let hyperfine auto-detect)
    const runs = opts.runs ?? suite.runs;

    if (runs) {
        args.push("--runs", String(runs));
    }

    // Setup: CLI > suite default (runs once before all timing runs)
    const setup = opts.setup ?? suite.setup;

    if (setup) {
        args.push("--setup", setup);
    }

    // Prepare: per-command (positional) or suite-level
    // Hyperfine: N --prepare flags match N commands positionally
    const suitePrepare = opts.prepare ?? suite.prepare;
    const hasPerCmdPrepare = commands.some((c) => c.prepare);

    if (hasPerCmdPrepare) {
        for (const cmd of commands) {
            args.push("--prepare", cmd.prepare ?? suitePrepare ?? "true");
        }
    } else if (suitePrepare) {
        args.push("--prepare", suitePrepare);
    }

    // Conclude: same positional logic as prepare
    const suiteConclude = suite.conclude;
    const hasPerCmdConclude = commands.some((c) => c.conclude);

    if (hasPerCmdConclude) {
        for (const cmd of commands) {
            args.push("--conclude", cmd.conclude ?? suiteConclude ?? "true");
        }
    } else if (suiteConclude) {
        args.push("--conclude", suiteConclude);
    }

    // Cleanup: same positional logic
    const suiteCleanup = opts.cleanup ?? suite.cleanup;
    const hasPerCmdCleanup = commands.some((c) => c.cleanup);

    if (hasPerCmdCleanup) {
        for (const cmd of commands) {
            args.push("--cleanup", cmd.cleanup ?? suiteCleanup ?? "true");
        }
    } else if (suiteCleanup) {
        args.push("--cleanup", suiteCleanup);
    }

    // Ignore non-zero exit codes — many benchmark commands fail intentionally
    // (e.g. tools --help exits 1, tools port 99999 exits 1) but we're measuring timing
    args.push("--ignore-failure");

    // Export + commands
    args.push("--export-json", resultPath);

    for (const cmd of commands) {
        args.push("--command-name", cmd.label, cmd.cmd);
    }

    p.log.info(`Running benchmark: ${pc.bold(suite.name)}${opts.only ? pc.dim(` (only: ${opts.only})`) : ""}`);
    p.log.step(pc.dim(commands.map((c) => `  ${c.label}: ${c.cmd}`).join("\n")));

    if (warmup !== 3 || runs) {
        p.log.step(pc.dim(`  warmup: ${warmup}, runs: ${runs ?? "auto"}`));
    }

    const proc = Bun.spawn(args, {
        stdout: "inherit",
        stderr: "inherit",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        p.log.error(`hyperfine exited with code ${exitCode}`);
        return null;
    }

    if (!existsSync(resultPath)) {
        p.log.error("No results file produced by hyperfine");
        return null;
    }

    const content = await Bun.file(resultPath).text();
    const output = SafeJSON.parse(content) as HyperfineOutput;

    const saved: SavedResult = {
        suite: suite.name,
        date: new Date().toISOString(),
        results: output.results,
    };
    await Bun.write(resultPath, SafeJSON.stringify(saved, null, 2));

    return output.results;
}
