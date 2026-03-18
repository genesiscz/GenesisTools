import { existsSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { BenchmarkCommand, BenchmarkSuite, HyperfineOutput, HyperfineResult, RunOptions, SavedResult } from "@app/benchmark/types";
import { captureEnv, formatEnvSummary } from "@app/benchmark/lib/env-capture";
import { getResultPath } from "@app/benchmark/lib/results";

/**
 * Expand parameterized commands. For each command with {param} in cmd/label,
 * generate one BenchmarkCommand per param value combination.
 * CLI --param overrides filter to specific values.
 */
function expandParams(suite: BenchmarkSuite, paramOverrides?: string[]): BenchmarkCommand[] {
    if (!suite.params || Object.keys(suite.params).length === 0) {
        return suite.commands;
    }

    // Parse CLI overrides: ["variant=on", "size=small"] → { variant: ["on"], size: ["small"] }
    const overrides = new Map<string, string[]>();

    for (const p of paramOverrides ?? []) {
        const eqIdx = p.indexOf("=");

        if (eqIdx !== -1) {
            const key = p.slice(0, eqIdx);
            const val = p.slice(eqIdx + 1);
            const existing = overrides.get(key) ?? [];
            existing.push(val);
            overrides.set(key, existing);
        }
    }

    // Build effective param values: override > suite default
    const paramEntries: Array<[string, string[]]> = [];

    for (const [key, values] of Object.entries(suite.params)) {
        const effective = overrides.get(key) ?? values;
        paramEntries.push([key, effective]);
    }

    // Generate cartesian product of all param values
    const combinations = cartesian(paramEntries);
    const expanded: BenchmarkCommand[] = [];

    for (const cmd of suite.commands) {
        const hasParam = paramEntries.some(([key]) => cmd.cmd.includes(`{${key}}`));

        if (!hasParam) {
            expanded.push(cmd);
            continue;
        }

        for (const combo of combinations) {
            let label = cmd.label;
            let cmdStr = cmd.cmd;
            let prepare = cmd.prepare;

            for (const [key, val] of combo) {
                label = label.replaceAll(`{${key}}`, val);
                cmdStr = cmdStr.replaceAll(`{${key}}`, val);

                if (prepare) {
                    prepare = prepare.replaceAll(`{${key}}`, val);
                }
            }

            expanded.push({ ...cmd, label, cmd: cmdStr, prepare });
        }
    }

    return expanded;
}

function cartesian(entries: Array<[string, string[]]>): Array<Array<[string, string]>> {
    if (entries.length === 0) {
        return [[]];
    }

    const [first, ...rest] = entries;
    const [key, values] = first;
    const restCombos = cartesian(rest);
    const result: Array<Array<[string, string]>> = [];

    for (const val of values) {
        for (const combo of restCombos) {
            result.push([[key, val], ...combo]);
        }
    }

    return result;
}

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

    // Expand parameterized commands: {param} placeholders → one command per value
    let commands = expandParams(suite, opts.param);

    // Filter commands if --only specified
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
    const warmup = opts.noWarmup ? 0 : (opts.warmup ?? suite.warmup ?? 3);
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

    const env = await captureEnv();

    const saved: SavedResult = {
        suite: suite.name,
        date: new Date().toISOString(),
        results: output.results,
        env,
    };
    await Bun.write(resultPath, SafeJSON.stringify(saved, null, 2));

    p.log.step(pc.dim(formatEnvSummary(env)));

    return output.results;
}
