import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getResultPath } from "./results";
import type {
    BenchmarkCommand,
    BenchmarkSuite,
    HyperfineOutput,
    HyperfineResult,
    RunOptions,
    SavedResult,
} from "./types";

export async function ensureHyperfine(): Promise<boolean> {
    const proc = Bun.spawn(["which", "hyperfine"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    if (proc.exitCode === 0) {
        return true;
    }

    p.log.error("hyperfine is required but not installed.");
    p.log.info(`Install with: ${pc.bold("brew install hyperfine")}`);
    return false;
}

export function shellEscape(s: string): string {
    if (/^[a-zA-Z0-9_/.:=-]+$/.test(s)) {
        return s;
    }

    return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildCommandWithEnv(cmd: BenchmarkCommand, suiteEnv?: Record<string, string>): string {
    const merged = { ...suiteEnv, ...cmd.env };
    const envEntries = Object.entries(merged);

    if (envEntries.length === 0) {
        return cmd.cmd;
    }

    const prefix = envEntries.map(([k, v]) => `${k}=${shellEscape(v)}`).join(" ");
    return `${prefix} ${cmd.cmd}`;
}

export async function runBenchmark(suite: BenchmarkSuite, opts: RunOptions = {}): Promise<HyperfineResult[] | null> {
    if (!(await ensureHyperfine())) {
        return null;
    }

    let commands = suite.commands;

    if (opts.only) {
        commands = commands.filter((c) => c.label === opts.only);

        if (commands.length === 0) {
            p.log.error(`No command with label "${opts.only}" in suite "${suite.name}"`);
            process.exit(1);
        }
    }

    const resultPath = getResultPath(suite.name, opts.only);

    const args = ["hyperfine"];

    const warmup = opts.warmup === false || opts.noWarmup ? 0 : (opts.warmup ?? suite.warmup ?? 3);
    args.push("--warmup", String(warmup));

    const runs = opts.runs ?? suite.runs;

    if (runs) {
        args.push("--runs", String(runs));
    }

    const setup = opts.setup ?? suite.setup;

    if (setup) {
        args.push("--setup", setup);
    }

    const suitePrepare = opts.prepare ?? suite.prepare;
    const hasPerCmdPrepare = commands.some((c) => c.prepare);

    if (hasPerCmdPrepare) {
        for (const cmd of commands) {
            args.push("--prepare", cmd.prepare ?? suitePrepare ?? "true");
        }
    } else if (suitePrepare) {
        args.push("--prepare", suitePrepare);
    }

    const suiteConclude = opts.conclude ?? suite.conclude;
    const hasPerCmdConclude = commands.some((c) => c.conclude);

    if (hasPerCmdConclude) {
        for (const cmd of commands) {
            args.push("--conclude", cmd.conclude ?? suiteConclude ?? "true");
        }
    } else if (suiteConclude) {
        args.push("--conclude", suiteConclude);
    }

    const suiteCleanup = opts.cleanup ?? suite.cleanup;
    const hasPerCmdCleanup = commands.some((c) => c.cleanup);

    if (hasPerCmdCleanup) {
        for (const cmd of commands) {
            args.push("--cleanup", cmd.cleanup ?? suiteCleanup ?? "true");
        }
    } else if (suiteCleanup) {
        args.push("--cleanup", suiteCleanup);
    }

    args.push("--ignore-failure");

    args.push("--export-json", resultPath);

    for (const cmd of commands) {
        args.push("--command-name", cmd.label, buildCommandWithEnv(cmd, suite.env));
    }

    p.log.info(`Running benchmark: ${pc.bold(suite.name)}${opts.only ? pc.dim(` (only: ${opts.only})`) : ""}`);
    p.log.step(pc.dim(commands.map((c) => `  ${c.label}: ${c.cmd}`).join("\n")));

    if (warmup !== 3 || runs) {
        p.log.step(pc.dim(`  warmup: ${warmup}, runs: ${runs ?? "auto"}`));
    }

    const cwd = opts.cwd ?? suite.cwd;
    const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
        stdout: "inherit",
        stderr: "inherit",
    };

    if (cwd) {
        const resolved = resolve(cwd);

        if (!existsSync(resolved)) {
            p.log.error(`Working directory does not exist: ${resolved}`);
            return null;
        }

        spawnOpts.cwd = resolved;
        p.log.step(pc.dim(`  cwd: ${resolved}`));
    }

    const proc = Bun.spawn(args, spawnOpts);

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
    const output = SafeJSON.parse(content, { strict: true }) as HyperfineOutput;

    const saved: SavedResult = {
        suite: suite.name,
        date: new Date().toISOString(),
        results: output.results,
    };
    await Bun.write(resultPath, SafeJSON.stringify(saved, null, 2));

    return output.results;
}
