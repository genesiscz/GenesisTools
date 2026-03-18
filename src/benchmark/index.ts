#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    prepare?: string;   // per-command: runs before each timing run
    conclude?: string;  // per-command: runs after each timing run
    cleanup?: string;   // per-command: runs after all runs for this command
}

interface BenchmarkSuite {
    name: string;
    commands: BenchmarkCommand[];
    builtIn?: boolean;
    runs?: number;       // --runs (exact count); omit = hyperfine auto-detect
    warmup?: number;     // --warmup (default: 3 if unset)
    setup?: string;      // --setup (once before all timing runs)
    prepare?: string;    // --prepare (before each timing run, all commands)
    conclude?: string;   // --conclude (after each timing run, all commands)
    cleanup?: string;    // --cleanup (after all runs per command)
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
    warmup?: number | false;  // false when Commander's --no-warmup is used
    noWarmup?: boolean;
    only?: string;
    setup?: string;
    prepare?: string;
    cleanup?: string;
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

    // Match only full-suite results: {suite}-{YYYY-MM-DD}.json
    // Exclude --only partial results: {suite}-{label}-{YYYY-MM-DD}.json
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

// ============================================
// Run benchmark
// ============================================

async function runBenchmark(suite: BenchmarkSuite, opts: RunOptions = {}): Promise<HyperfineResult[] | null> {
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

    // Parse --prepare-for pairs into a lookup: label → prepare command
    const prepareForMap = new Map<string, string>();

    for (const pair of opts.prepareFor ?? []) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --prepare-for format: "${pair}". Expected "label=command".`);
            process.exit(1);
        }

        prepareForMap.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
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

    if (opts.cleanup) {
        suite.cleanup = opts.cleanup;
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
    ];

    if (!suite.builtIn) {
        actionOptions.push({ value: "delete", label: pc.red("Delete suite") });
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
    .option("--cleanup <cmd>", "Shell command run after all runs complete for each command")
    .action(async (suiteName: string | undefined, opts: RunOptions) => {
        if (suiteName) {
            await cmdRun(suiteName, opts);
        } else {
            await interactiveMode();
        }
    });

interface AddOptions {
    runs?: number;
    warmup?: number;
    setup?: string;
    prepare?: string;
    cleanup?: string;
    prepareFor?: string[];
}

function collectPrepareFor(value: string, prev: string[]): string[] {
    return [...prev, value];
}

program
    .command("add")
    .description('Add a custom benchmark suite: tools benchmark add "name" "label:cmd" "label2:cmd2"')
    .argument("<name>", "Suite name")
    .argument("<commands...>", 'Commands in "label:command" format')
    .option("--runs <n>", "Default number of timing runs for this suite", (v) => parseInt(v, 10))
    .option("--warmup <n>", "Default warmup count for this suite (default: 3)", (v) => parseInt(v, 10))
    .option("--setup <cmd>", "Setup command run once before all timing runs")
    .option("--prepare <cmd>", "Prepare command run before each timing run (all commands)")
    .option("--cleanup <cmd>", "Cleanup command run after all runs per command")
    .option(
        "--prepare-for <label=cmd>",
        "Per-command prepare: runs before each timing run for that specific command (repeatable)",
        collectPrepareFor,
        []
    )
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
