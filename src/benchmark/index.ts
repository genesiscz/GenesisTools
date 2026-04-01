#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { Storage } from "@app/utils/storage/storage";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

// ============================================
// Types
// ============================================

interface BenchmarkCommand {
    label: string;
    cmd: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    env?: Record<string, string>;
}

interface BenchmarkSuite {
    name: string;
    commands: BenchmarkCommand[];
    builtIn?: boolean;
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
    env?: Record<string, string>;
}

interface HyperfineResult {
    command: string;
    mean: number;
    stddev: number;
    median: number;
    user: number;
    system: number;
    min: number;
    max: number;
    times: number[];
}

interface HyperfineOutput {
    results: HyperfineResult[];
}

interface SavedResult {
    suite: string;
    date: string;
    results: HyperfineResult[];
}

interface RunOptions {
    compare?: boolean;
    runs?: number;
    warmup?: number | false;
    noWarmup?: boolean;
    only?: string;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
}

interface AddOptions {
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
    prepareFor?: string[];
    concludeFor?: string[];
    cleanupFor?: string[];
    env?: string[];
    envFor?: string[];
}

interface EditOptions {
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    conclude?: string;
    cleanup?: string;
    cwd?: string;
    env?: string[];
    clearSetup?: boolean;
    clearPrepare?: boolean;
    clearConclude?: boolean;
    clearCleanup?: boolean;
    clearCwd?: boolean;
    clearEnv?: boolean;
    addCmd?: string[];
    removeCmd?: string[];
    prepareFor?: string[];
    concludeFor?: string[];
    cleanupFor?: string[];
    envFor?: string[];
}

interface HistoryOptions {
    limit?: number;
    compare?: string;
}

// ============================================
// Constants
// ============================================

const storage = new Storage("benchmark");
const RESULTS_DIR = join(homedir(), ".genesis-tools", "benchmarks");

const BUILTIN_SUITES: BenchmarkSuite[] = [
    {
        name: "startup",
        builtIn: true,
        commands: [
            { label: "tools --help", cmd: "tools --help" },
            { label: "tools port 99999", cmd: "tools port 99999" },
            { label: "tools notify test", cmd: "tools notify test --sound default" },
        ],
    },
    {
        name: "notify",
        builtIn: true,
        commands: [
            { label: "osascript", cmd: "osascript -e 'display notification \"bench\"'" },
            { label: "terminal-notifier", cmd: "terminal-notifier -message bench -title bench" },
        ],
    },
];

// ============================================
// Hyperfine check
// ============================================

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

// ============================================
// Helpers
// ============================================

function collectKeyValue(value: string, prev: string[]): string[] {
    return [...prev, value];
}

function parseKeyValuePairs(pairs: string[], flagName: string): Map<string, string> {
    const map = new Map<string, string>();

    for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid ${flagName} format: "${pair}". Expected "label=command".`);
            process.exit(1);
        }

        map.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }

    return map;
}

function shellEscape(s: string): string {
    if (/^[a-zA-Z0-9_/.:=-]+$/.test(s)) {
        return s;
    }

    return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildCommandWithEnv(cmd: BenchmarkCommand, suiteEnv?: Record<string, string>): string {
    const merged = { ...suiteEnv, ...cmd.env };
    const envEntries = Object.entries(merged);

    if (envEntries.length === 0) {
        return cmd.cmd;
    }

    const prefix = envEntries.map(([k, v]) => `${k}=${shellEscape(v)}`).join(" ");
    return `${prefix} ${cmd.cmd}`;
}

// ============================================
// Suite management
// ============================================

async function getAllSuites(): Promise<BenchmarkSuite[]> {
    const custom = await storage.getConfig<{ suites: BenchmarkSuite[] }>();
    const customSuites = custom?.suites ?? [];
    return [...BUILTIN_SUITES, ...customSuites];
}

async function getCustomSuites(): Promise<BenchmarkSuite[]> {
    const custom = await storage.getConfig<{ suites: BenchmarkSuite[] }>();
    return custom?.suites ?? [];
}

async function saveCustomSuites(suites: BenchmarkSuite[]): Promise<void> {
    await storage.setConfig({ suites });
}

async function findSuite(name: string): Promise<BenchmarkSuite | undefined> {
    const allSuites = await getAllSuites();
    return allSuites.find((s) => s.name === name);
}

// ============================================
// Results persistence
// ============================================

function ensureResultsDir(): void {
    if (!existsSync(RESULTS_DIR)) {
        mkdirSync(RESULTS_DIR, { recursive: true });
    }
}

function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getResultPath(suiteName: string, label?: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const suffix = label ? `-${sanitizeFilename(label)}` : "";
    return join(RESULTS_DIR, `${suiteName}${suffix}-${date}.json`);
}

async function getLastResult(suiteName: string): Promise<SavedResult | null> {
    ensureResultsDir();

    const pattern = new RegExp(`^${suiteName}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    const files = readdirSync(RESULTS_DIR)
        .filter((f) => pattern.test(f))
        .sort()
        .reverse();

    if (files.length === 0) {
        return null;
    }

    const content = await Bun.file(join(RESULTS_DIR, files[0])).text();
    return SafeJSON.parse(content) as SavedResult;
}

function getAllResults(suiteName: string): string[] {
    ensureResultsDir();

    const pattern = new RegExp(`^${suiteName}(-[a-zA-Z0-9_-]+)?-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    return readdirSync(RESULTS_DIR)
        .filter((f) => pattern.test(f))
        .sort()
        .reverse();
}

async function loadResult(filename: string): Promise<SavedResult> {
    const content = await Bun.file(join(RESULTS_DIR, filename)).text();
    return SafeJSON.parse(content) as SavedResult;
}

// ============================================
// Run benchmark
// ============================================

async function runBenchmark(suite: BenchmarkSuite, opts: RunOptions = {}): Promise<HyperfineResult[] | null> {
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
    const output = SafeJSON.parse(content) as HyperfineOutput;

    const saved: SavedResult = {
        suite: suite.name,
        date: new Date().toISOString(),
        results: output.results,
    };
    await Bun.write(resultPath, SafeJSON.stringify(saved, null, 2));

    return output.results;
}

// ============================================
// Display
// ============================================

function displayResults(results: HyperfineResult[]): void {
    const rows = results.map((r) => [
        r.command,
        formatDuration(r.mean * 1000),
        `± ${formatDuration(r.stddev * 1000)}`,
        formatDuration(r.min * 1000),
        formatDuration(r.max * 1000),
    ]);

    const table = formatTable(rows, ["Command", "Mean", "Stddev", "Min", "Max"], {
        alignRight: [1, 2, 3, 4],
    });

    p.note(table, "Results");
}

function displayComparison(current: HyperfineResult[], previous: SavedResult): void {
    const rows: string[][] = [];

    for (const cur of current) {
        const prev = previous.results.find((r) => r.command === cur.command);

        if (!prev) {
            rows.push([cur.command, formatDuration(cur.mean * 1000), "—", "—"]);
            continue;
        }

        const diff = cur.mean - prev.mean;
        const pct = (diff / prev.mean) * 100;
        const sign = diff > 0 ? "+" : "";
        const color = diff > 0 ? pc.red : pc.green;

        rows.push([
            cur.command,
            formatDuration(cur.mean * 1000),
            formatDuration(prev.mean * 1000),
            color(`${sign}${pct.toFixed(1)}%`),
        ]);
    }

    const table = formatTable(rows, ["Command", "Current", "Previous", "Delta"], {
        alignRight: [1, 2, 3],
    });

    p.note(table, `Comparison (previous: ${previous.date.slice(0, 10)})`);
}

// ============================================
// Commands
// ============================================

async function cmdRun(suiteName: string, opts: RunOptions): Promise<void> {
    const suite = await findSuite(suiteName);

    if (!suite) {
        p.log.error(`Suite "${suiteName}" not found. Use ${pc.bold("tools benchmark list")} to see available suites.`);
        process.exit(1);
    }

    const previous = opts.compare ? await getLastResult(suiteName) : null;
    const results = await runBenchmark(suite, opts);

    if (!results) {
        process.exit(1);
    }

    displayResults(results);

    if (opts.compare && previous) {
        displayComparison(results, previous);
    } else if (opts.compare) {
        p.log.warn("No previous results to compare against.");
    }
}

async function cmdAdd(name: string, commandPairs: string[], opts: AddOptions = {}): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot overwrite built-in suite "${name}".`);
        process.exit(1);
    }

    const prepareForMap = parseKeyValuePairs(opts.prepareFor ?? [], "--prepare-for");
    const concludeForMap = parseKeyValuePairs(opts.concludeFor ?? [], "--conclude-for");
    const cleanupForMap = parseKeyValuePairs(opts.cleanupFor ?? [], "--cleanup-for");

    // Parse per-command env: "label:KEY=val"
    const envForMap = new Map<string, Record<string, string>>();

    for (const entry of opts.envFor ?? []) {
        const colonIdx = entry.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid --env-for format: "${entry}". Expected "label:KEY=value".`);
            process.exit(1);
        }

        const label = entry.slice(0, colonIdx);
        const rest = entry.slice(colonIdx + 1);
        const eqIdx = rest.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --env-for format: "${entry}". Expected "label:KEY=value".`);
            process.exit(1);
        }

        const existing = envForMap.get(label) ?? {};
        existing[rest.slice(0, eqIdx)] = rest.slice(eqIdx + 1);
        envForMap.set(label, existing);
    }

    const commands: BenchmarkCommand[] = [];

    for (const pair of commandPairs) {
        const colonIdx = pair.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid format: "${pair}". Expected "label:command".`);
            process.exit(1);
        }

        const label = pair.slice(0, colonIdx);
        const cmd: BenchmarkCommand = {
            label,
            cmd: pair.slice(colonIdx + 1),
        };

        const perCmdPrepare = prepareForMap.get(label);

        if (perCmdPrepare) {
            cmd.prepare = perCmdPrepare;
        }

        const perCmdConclude = concludeForMap.get(label);

        if (perCmdConclude) {
            cmd.conclude = perCmdConclude;
        }

        const perCmdCleanup = cleanupForMap.get(label);

        if (perCmdCleanup) {
            cmd.cleanup = perCmdCleanup;
        }

        const perCmdEnv = envForMap.get(label);

        if (perCmdEnv) {
            cmd.env = perCmdEnv;
        }

        commands.push(cmd);
    }

    if (commands.length < 2) {
        p.log.error("A benchmark suite needs at least 2 commands to compare.");
        process.exit(1);
    }

    const suite: BenchmarkSuite = { name, commands };

    if (opts.runs) {
        suite.runs = opts.runs;
    }

    if (opts.warmup !== undefined) {
        suite.warmup = opts.warmup;
    }

    if (opts.setup) {
        suite.setup = opts.setup;
    }

    if (opts.prepare) {
        suite.prepare = opts.prepare;
    }

    if (opts.conclude) {
        suite.conclude = opts.conclude;
    }

    if (opts.cleanup) {
        suite.cleanup = opts.cleanup;
    }

    if (opts.cwd) {
        suite.cwd = opts.cwd;
    }

    // Parse suite-level env
    const suiteEnv: Record<string, string> = {};

    for (const pair of opts.env ?? []) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --env format: "${pair}". Expected "KEY=value".`);
            process.exit(1);
        }

        suiteEnv[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }

    if (Object.keys(suiteEnv).length > 0) {
        suite.env = suiteEnv;
    }

    const custom = await getCustomSuites();
    const existing = custom.findIndex((s) => s.name === name);

    if (existing >= 0) {
        custom[existing] = suite;
    } else {
        custom.push(suite);
    }

    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" saved with ${commands.length} commands.`);
}

async function cmdRemove(name: string): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot delete built-in suite "${name}".`);
        process.exit(1);
    }

    const custom = await getCustomSuites();
    const idx = custom.findIndex((s) => s.name === name);

    if (idx === -1) {
        p.log.error(`Suite "${name}" not found.`);
        process.exit(1);
    }

    custom.splice(idx, 1);
    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" removed.`);
}

async function cmdList(): Promise<void> {
    const allSuites = await getAllSuites();

    if (allSuites.length === 0) {
        p.log.info("No benchmark suites defined.");
        return;
    }

    const rows = allSuites.map((s) => [
        s.name,
        s.builtIn ? pc.dim("built-in") : "custom",
        String(s.commands.length),
        s.commands.map((c) => c.label).join(", "),
    ]);

    const table = formatTable(rows, ["Name", "Type", "Cmds", "Labels"], { alignRight: [2] });
    p.note(table, "Benchmark Suites");
}

async function cmdShow(name: string): Promise<void> {
    const suite = await findSuite(name);

    if (!suite) {
        p.log.error(`Suite "${name}" not found. Use ${pc.bold("tools benchmark list")} to see available suites.`);
        process.exit(1);
    }

    const lines: string[] = [];
    lines.push(`${pc.bold("Name:")} ${suite.name}`);
    lines.push(`${pc.bold("Type:")} ${suite.builtIn ? "built-in" : "custom"}`);

    if (suite.runs) {
        lines.push(`${pc.bold("Runs:")} ${suite.runs}`);
    }

    if (suite.warmup !== undefined) {
        lines.push(`${pc.bold("Warmup:")} ${suite.warmup}`);
    }

    if (suite.cwd) {
        lines.push(`${pc.bold("CWD:")} ${suite.cwd}`);
    }

    if (suite.env) {
        const envStr = Object.entries(suite.env).map(([k, v]) => `${k}=${v}`).join(" ");
        lines.push(`${pc.bold("Env:")} ${envStr}`);
    }

    const hooks: string[] = [];

    if (suite.setup) {
        hooks.push(`setup: ${pc.dim(suite.setup)}`);
    }

    if (suite.prepare) {
        hooks.push(`prepare: ${pc.dim(suite.prepare)}`);
    }

    if (suite.conclude) {
        hooks.push(`conclude: ${pc.dim(suite.conclude)}`);
    }

    if (suite.cleanup) {
        hooks.push(`cleanup: ${pc.dim(suite.cleanup)}`);
    }

    if (hooks.length > 0) {
        lines.push("");
        lines.push(pc.bold("Suite Hooks:"));
        for (const h of hooks) {
            lines.push(`  ${h}`);
        }
    }

    lines.push("");
    lines.push(pc.bold("Commands:"));

    for (const cmd of suite.commands) {
        lines.push(`  ${pc.cyan(cmd.label)}: ${cmd.cmd}`);

        const cmdHooks: string[] = [];

        if (cmd.prepare) {
            cmdHooks.push(`prepare: ${cmd.prepare}`);
        }

        if (cmd.conclude) {
            cmdHooks.push(`conclude: ${cmd.conclude}`);
        }

        if (cmd.cleanup) {
            cmdHooks.push(`cleanup: ${cmd.cleanup}`);
        }

        if (cmd.env) {
            const envStr = Object.entries(cmd.env).map(([k, v]) => `${k}=${v}`).join(" ");
            cmdHooks.push(`env: ${envStr}`);
        }

        for (const h of cmdHooks) {
            lines.push(`    ${pc.dim(h)}`);
        }
    }

    const lastResult = await getLastResult(suite.name);

    if (lastResult) {
        lines.push("");
        lines.push(`${pc.bold("Last run:")} ${lastResult.date.slice(0, 10)}`);
        for (const r of lastResult.results) {
            lines.push(`  ${r.command}: ${formatDuration(r.mean * 1000)}`);
        }
    }

    p.note(lines.join("\n"), `Suite: ${suite.name}`);
}

async function cmdEdit(name: string, opts: EditOptions): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot edit built-in suite "${name}".`);
        process.exit(1);
    }

    const custom = await getCustomSuites();
    const idx = custom.findIndex((s) => s.name === name);

    if (idx === -1) {
        p.log.error(`Suite "${name}" not found.`);
        process.exit(1);
    }

    const suite = custom[idx];

    if (opts.runs !== undefined) {
        suite.runs = opts.runs;
    }

    if (opts.warmup !== undefined) {
        suite.warmup = opts.warmup;
    }

    if (opts.setup) {
        suite.setup = opts.setup;
    }

    if (opts.prepare) {
        suite.prepare = opts.prepare;
    }

    if (opts.conclude) {
        suite.conclude = opts.conclude;
    }

    if (opts.cleanup) {
        suite.cleanup = opts.cleanup;
    }

    if (opts.cwd) {
        suite.cwd = opts.cwd;
    }

    if (opts.clearSetup) {
        delete suite.setup;
    }

    if (opts.clearPrepare) {
        delete suite.prepare;
    }

    if (opts.clearConclude) {
        delete suite.conclude;
    }

    if (opts.clearCleanup) {
        delete suite.cleanup;
    }

    if (opts.clearCwd) {
        delete suite.cwd;
    }

    if (opts.clearEnv) {
        delete suite.env;
    }

    if (opts.env && opts.env.length > 0) {
        const env: Record<string, string> = { ...suite.env };

        for (const pair of opts.env) {
            const eqIdx = pair.indexOf("=");

            if (eqIdx === -1) {
                p.log.error(`Invalid --env format: "${pair}". Expected "KEY=value".`);
                process.exit(1);
            }

            env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }

        suite.env = env;
    }

    for (const pair of opts.addCmd ?? []) {
        const colonIdx = pair.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid --add-cmd format: "${pair}". Expected "label:command".`);
            process.exit(1);
        }

        const label = pair.slice(0, colonIdx);
        const existingCmd = suite.commands.find((c) => c.label === label);

        if (existingCmd) {
            existingCmd.cmd = pair.slice(colonIdx + 1);
        } else {
            suite.commands.push({ label, cmd: pair.slice(colonIdx + 1) });
        }
    }

    for (const label of opts.removeCmd ?? []) {
        const cmdIdx = suite.commands.findIndex((c) => c.label === label);

        if (cmdIdx === -1) {
            p.log.warn(`Command "${label}" not found in suite, skipping.`);
            continue;
        }

        suite.commands.splice(cmdIdx, 1);
    }

    if (suite.commands.length < 2) {
        p.log.error("A suite must have at least 2 commands. Aborting edit.");
        process.exit(1);
    }

    const prepareForMap = parseKeyValuePairs(opts.prepareFor ?? [], "--prepare-for");
    const concludeForMap = parseKeyValuePairs(opts.concludeFor ?? [], "--conclude-for");
    const cleanupForMap = parseKeyValuePairs(opts.cleanupFor ?? [], "--cleanup-for");

    for (const cmd of suite.commands) {
        const prep = prepareForMap.get(cmd.label);

        if (prep) {
            cmd.prepare = prep;
        }

        const conc = concludeForMap.get(cmd.label);

        if (conc) {
            cmd.conclude = conc;
        }

        const clean = cleanupForMap.get(cmd.label);

        if (clean) {
            cmd.cleanup = clean;
        }
    }

    for (const entry of opts.envFor ?? []) {
        const colonIdx = entry.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid --env-for format: "${entry}". Expected "label:KEY=value".`);
            process.exit(1);
        }

        const label = entry.slice(0, colonIdx);
        const rest = entry.slice(colonIdx + 1);
        const eqIdx = rest.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --env-for format: "${entry}". Expected "label:KEY=value".`);
            process.exit(1);
        }

        const cmd = suite.commands.find((c) => c.label === label);

        if (!cmd) {
            p.log.warn(`Command "${label}" not found, skipping env-for.`);
            continue;
        }

        cmd.env = { ...cmd.env, [rest.slice(0, eqIdx)]: rest.slice(eqIdx + 1) };
    }

    custom[idx] = suite;
    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" updated.`);
}

async function cmdHistory(suiteName: string, opts: HistoryOptions = {}): Promise<void> {
    const suite = await findSuite(suiteName);

    if (!suite) {
        p.log.error(`Suite "${suiteName}" not found.`);
        process.exit(1);
    }

    const files = getAllResults(suiteName);

    if (files.length === 0) {
        p.log.info(`No results found for suite "${suiteName}".`);
        return;
    }

    if (opts.compare) {
        const parts = opts.compare.split("..");
        const dateA = parts[0];
        const dateB = parts[1];

        const fileA = files.find((f) => f.includes(dateA));

        if (!fileA) {
            p.log.error(`No result found for date "${dateA}".`);
            return;
        }

        const resultA = await loadResult(fileA);
        let resultB: SavedResult;

        if (dateB) {
            const fileBMatch = files.find((f) => f.includes(dateB));

            if (!fileBMatch) {
                p.log.error(`No result found for date "${dateB}".`);
                return;
            }

            resultB = await loadResult(fileBMatch);
        } else {
            resultB = await loadResult(files[0]);
        }

        displayComparison(resultB.results, resultA);
        return;
    }

    const limit = opts.limit ?? 10;
    const shown = files.slice(0, limit);
    const rows: string[][] = [];

    for (const file of shown) {
        const result = await loadResult(file);
        const summary = result.results
            .map((r) => `${r.command}: ${formatDuration(r.mean * 1000)}`)
            .join(", ");
        const isPartial = file.replace(`${suiteName}-`, "").split("-").length > 3;

        rows.push([
            result.date.slice(0, 10),
            isPartial ? pc.dim("partial") : "full",
            summary,
        ]);
    }

    const table = formatTable(rows, ["Date", "Type", "Results"], {});
    p.note(table, `History: ${suiteName} (${files.length} total, showing ${shown.length})`);
}

// ============================================
// Interactive mode
// ============================================

async function interactiveMode(): Promise<void> {
    if (!(await ensureHyperfine())) {
        process.exit(1);
    }

    p.intro(pc.bgCyan(pc.black(" benchmark ")));

    const allSuites = await getAllSuites();

    if (allSuites.length === 0) {
        p.log.info("No suites available. Add one with:");
        p.log.info(pc.bold('tools benchmark add "name" "label1:cmd1" "label2:cmd2"'));
        p.outro(pc.dim("Done."));
        return;
    }

    const suiteName = await withCancel(
        p.select({
            message: "Select a benchmark suite",
            options: allSuites.map((s) => ({
                value: s.name,
                label: `${s.name} ${pc.dim(`(${s.commands.length} commands${s.builtIn ? ", built-in" : ""})`)}`,
            })),
        })
    );

    const suite = allSuites.find((s) => s.name === suiteName);

    if (!suite) {
        p.cancel("Suite not found.");
        process.exit(1);
    }

    const actionOptions: Array<{ value: string; label: string }> = [
        { value: "run", label: "Run benchmark" },
        { value: "compare", label: "Run and compare with last result" },
        { value: "show", label: "Show suite details" },
        { value: "history", label: "View result history" },
    ];

    if (!suite.builtIn) {
        actionOptions.push(
            { value: "edit", label: "Edit suite" },
            { value: "delete", label: pc.red("Delete suite") },
        );
    }

    const action = await withCancel(
        p.select({
            message: "What would you like to do?",
            options: actionOptions,
        })
    );

    if (action === "delete") {
        const confirmed = await withCancel(p.confirm({ message: `Delete suite "${suite.name}"?` }));

        if (confirmed) {
            await cmdRemove(suite.name);
        } else {
            p.cancel("Cancelled.");
        }

        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "show") {
        await cmdShow(suite.name);
        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "history") {
        await cmdHistory(suite.name);
        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "edit") {
        const editChoice = await withCancel(
            p.select({
                message: "What to edit?",
                options: [
                    { value: "hooks", label: "Suite hooks (setup/prepare/conclude/cleanup)" },
                    { value: "cwd", label: "Working directory" },
                    { value: "defaults", label: "Default runs/warmup" },
                    { value: "commands", label: "Add/remove commands" },
                ],
            })
        );

        if (editChoice === "hooks") {
            const hookType = await withCancel(
                p.select({
                    message: "Which hook?",
                    options: [
                        { value: "setup", label: `Setup${suite.setup ? pc.dim(` (current: ${suite.setup})`) : ""}` },
                        { value: "prepare", label: `Prepare${suite.prepare ? pc.dim(` (current: ${suite.prepare})`) : ""}` },
                        { value: "conclude", label: `Conclude${suite.conclude ? pc.dim(` (current: ${suite.conclude})`) : ""}` },
                        { value: "cleanup", label: `Cleanup${suite.cleanup ? pc.dim(` (current: ${suite.cleanup})`) : ""}` },
                    ],
                })
            );

            const hookAction = await withCancel(
                p.select({
                    message: "Action?",
                    options: [
                        { value: "set", label: "Set new value" },
                        { value: "clear", label: "Clear (remove)" },
                    ],
                })
            );

            if (hookAction === "set") {
                const hookKey = hookType as "setup" | "prepare" | "conclude" | "cleanup";
                const value = await withCancel(
                    p.text({
                        message: `Enter ${hookType} command:`,
                        placeholder: suite[hookKey] ?? "",
                    })
                );

                await cmdEdit(suite.name, { [hookKey]: value } as EditOptions);
            } else {
                const clearKey = `clear${hookType.charAt(0).toUpperCase()}${hookType.slice(1)}` as keyof EditOptions;
                await cmdEdit(suite.name, { [clearKey]: true } as EditOptions);
            }
        } else if (editChoice === "cwd") {
            const value = await withCancel(
                p.text({
                    message: "Working directory (empty to clear):",
                    placeholder: suite.cwd ?? "",
                    defaultValue: "",
                })
            );

            if (value) {
                await cmdEdit(suite.name, { cwd: value });
            } else {
                await cmdEdit(suite.name, { clearCwd: true });
            }
        } else if (editChoice === "defaults") {
            const runsInput = await withCancel(
                p.text({
                    message: "Default runs (empty for auto):",
                    placeholder: suite.runs?.toString() ?? "auto",
                    defaultValue: "",
                })
            );

            const warmupInput = await withCancel(
                p.text({
                    message: "Default warmup:",
                    placeholder: suite.warmup?.toString() ?? "3",
                    defaultValue: "",
                })
            );

            const editOpts: EditOptions = {};

            if (runsInput) {
                editOpts.runs = parseInt(runsInput, 10);
            }

            if (warmupInput) {
                editOpts.warmup = parseInt(warmupInput, 10);
            }

            if (editOpts.runs || editOpts.warmup) {
                await cmdEdit(suite.name, editOpts);
            }
        } else if (editChoice === "commands") {
            const cmdAction = await withCancel(
                p.select({
                    message: "Action?",
                    options: [
                        { value: "add", label: "Add a new command" },
                        { value: "remove", label: "Remove a command" },
                    ],
                })
            );

            if (cmdAction === "add") {
                const input = await withCancel(
                    p.text({
                        message: "New command (label:command):",
                        placeholder: "my-label:echo hello",
                    })
                );

                await cmdEdit(suite.name, { addCmd: [input] });
            } else {
                const label = await withCancel(
                    p.select({
                        message: "Remove which command?",
                        options: suite.commands.map((c) => ({
                            value: c.label,
                            label: `${c.label} ${pc.dim(`(${c.cmd})`)}`,
                        })),
                    })
                );

                await cmdEdit(suite.name, { removeCmd: [label] });
            }
        }

        p.outro(pc.green("Done."));
        return;
    }

    const runCountInput = await withCancel(
        p.text({
            message: "Number of runs (leave empty for auto)",
            placeholder: "auto",
            defaultValue: "",
        })
    );

    const warmupInput = await withCancel(
        p.text({
            message: "Warmup runs",
            placeholder: "3",
            defaultValue: "3",
        })
    );

    const runOpts: RunOptions = {
        compare: action === "compare",
        runs: runCountInput ? parseInt(runCountInput, 10) || undefined : undefined,
        warmup: warmupInput ? parseInt(warmupInput, 10) : undefined,
        noWarmup: warmupInput === "0",
    };

    const previous = runOpts.compare ? await getLastResult(suite.name) : null;
    const results = await runBenchmark(suite, runOpts);

    if (!results) {
        p.outro(pc.red("Benchmark failed."));
        return;
    }

    displayResults(results);

    if (runOpts.compare && previous) {
        displayComparison(results, previous);
    } else if (runOpts.compare) {
        p.log.warn("No previous results to compare against.");
    }

    p.outro(pc.green("Done."));
}

// ============================================
// CLI
// ============================================

const program = new Command();

program
    .name("benchmark")
    .description("Benchmark tool commands with hyperfine")
    .argument("[suite]", "Suite name to run directly")
    .option("--compare", "Compare results with the last saved run")
    .option("--runs <n>", "Exact number of timing runs (default: auto-detect by hyperfine)", (v) => parseInt(v, 10))
    .option("--warmup <n>", "Number of warmup runs before timing (default: 3)", (v) => parseInt(v, 10))
    .option("--no-warmup", "Skip warmup runs entirely — useful for long-running benchmarks (e.g. --runs 1 --no-warmup)")
    .option("--only <label>", "Run only the command with this label from the suite (results saved separately)")
    .option("--setup <cmd>", "Shell command run once before all timing runs begin")
    .option("--prepare <cmd>", "Shell command run before each timing run (all commands)")
    .option("--conclude <cmd>", "Shell command run after each timing run (all commands)")
    .option("--cleanup <cmd>", "Shell command run after all runs complete for each command")
    .option("--cwd <dir>", "Working directory for benchmark commands")
    .action(async (suiteName: string | undefined, opts: RunOptions) => {
        if (suiteName) {
            await cmdRun(suiteName, opts);
        } else {
            await interactiveMode();
        }
    });

program
    .command("add")
    .description('Add a custom benchmark suite: tools benchmark add "name" "label:cmd" "label2:cmd2"')
    .argument("<name>", "Suite name")
    .argument("<commands...>", 'Commands in "label:command" format')
    .option("--runs <n>", "Default number of timing runs for this suite", (v) => parseInt(v, 10))
    .option("--warmup <n>", "Default warmup count for this suite (default: 3)", (v) => parseInt(v, 10))
    .option("--setup <cmd>", "Setup command run once before all timing runs")
    .option("--prepare <cmd>", "Prepare command run before each timing run (all commands)")
    .option("--conclude <cmd>", "Conclude command run after each timing run (all commands)")
    .option("--cleanup <cmd>", "Cleanup command run after all runs per command")
    .option("--cwd <dir>", "Working directory for benchmark commands")
    .option("--prepare-for <label=cmd>", "Per-command prepare (repeatable)", collectKeyValue, [])
    .option("--conclude-for <label=cmd>", "Per-command conclude (repeatable)", collectKeyValue, [])
    .option("--cleanup-for <label=cmd>", "Per-command cleanup (repeatable)", collectKeyValue, [])
    .option("--env <KEY=val>", "Environment variable for all commands (repeatable)", collectKeyValue, [])
    .option("--env-for <label:KEY=val>", "Per-command environment variable (repeatable)", collectKeyValue, [])
    .action(async (name: string, commands: string[], opts: AddOptions) => {
        await cmdAdd(name, commands, opts);
    });

program
    .command("remove")
    .description("Remove a custom benchmark suite")
    .argument("<name>", "Suite name to remove")
    .action(async (name: string) => {
        await cmdRemove(name);
    });

program
    .command("list")
    .description("List all benchmark suites")
    .action(async () => {
        await cmdList();
    });

program
    .command("show")
    .description("Show full details of a benchmark suite")
    .argument("<name>", "Suite name to inspect")
    .action(async (name: string) => {
        await cmdShow(name);
    });

program
    .command("edit")
    .description("Edit an existing custom benchmark suite")
    .argument("<name>", "Suite name to edit")
    .option("--runs <n>", "Update default run count", (v) => parseInt(v, 10))
    .option("--warmup <n>", "Update default warmup count", (v) => parseInt(v, 10))
    .option("--setup <cmd>", "Update setup command")
    .option("--prepare <cmd>", "Update prepare command")
    .option("--conclude <cmd>", "Update conclude command")
    .option("--cleanup <cmd>", "Update cleanup command")
    .option("--cwd <dir>", "Update working directory")
    .option("--env <KEY=val>", "Add/update suite-level env var (repeatable)", collectKeyValue, [])
    .option("--clear-setup", "Remove the setup command")
    .option("--clear-prepare", "Remove the suite-level prepare command")
    .option("--clear-conclude", "Remove the suite-level conclude command")
    .option("--clear-cleanup", "Remove the suite-level cleanup command")
    .option("--clear-cwd", "Remove the working directory")
    .option("--clear-env", "Remove all suite-level env vars")
    .option("--add-cmd <label:cmd>", "Add or replace a command (repeatable)", collectKeyValue, [])
    .option("--remove-cmd <label>", "Remove a command by label (repeatable)", collectKeyValue, [])
    .option("--prepare-for <label=cmd>", "Set per-command prepare (repeatable)", collectKeyValue, [])
    .option("--conclude-for <label=cmd>", "Set per-command conclude (repeatable)", collectKeyValue, [])
    .option("--cleanup-for <label=cmd>", "Set per-command cleanup (repeatable)", collectKeyValue, [])
    .option("--env-for <label:KEY=val>", "Set per-command env var (repeatable)", collectKeyValue, [])
    .action(async (name: string, opts: EditOptions) => {
        await cmdEdit(name, opts);
    });

program
    .command("history")
    .description("Browse past benchmark results for a suite")
    .argument("<suite>", "Suite name")
    .option("--limit <n>", "Number of results to show (default: 10)", (v) => parseInt(v, 10))
    .option("--compare <dates>", 'Compare two dates: "YYYY-MM-DD..YYYY-MM-DD" or "YYYY-MM-DD" (vs latest)')
    .action(async (suite: string, opts: HistoryOptions) => {
        await cmdHistory(suite, opts);
    });

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }
}

main();
