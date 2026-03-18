#!/usr/bin/env bun

import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { cmdAdd } from "@app/benchmark/commands/add";
import { cmdList } from "@app/benchmark/commands/list";
import { cmdRemove } from "@app/benchmark/commands/remove";
import { cmdRun } from "@app/benchmark/commands/run";
import { displayComparison, displayResults } from "@app/benchmark/lib/display";
import { getLastResult } from "@app/benchmark/lib/results";
import { runBenchmark } from "@app/benchmark/lib/runner";
import { getAllSuites } from "@app/benchmark/lib/suites";
import type { AddOptions, RunOptions } from "@app/benchmark/types";

// ============================================
// Interactive mode
// ============================================

async function interactiveMode(): Promise<void> {
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

function collectPrepareFor(value: string, prev: string[]): string[] {
    return [...prev, value];
}

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
