import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { displayComparison, displayResults } from "../lib/display";
import { getLastResult } from "../lib/results";
import { runBenchmark } from "../lib/runner";
import { findSuite } from "../lib/suites";
import type { RunOptions } from "../lib/types";
import { interactiveMode } from "./interactive";

export async function cmdRun(suiteName: string, opts: RunOptions): Promise<void> {
    const suite = await findSuite(suiteName);

    if (!suite) {
        p.log.error(`Suite "${suiteName}" not found. Use ${pc.bold("tools benchmark list")} to see available suites.`);
        process.exit(1);
    }

    const previous = opts.compare ? await getLastResult(suiteName, opts.only) : null;
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

export function registerRunCommand(program: Command): void {
    program
        .name("benchmark")
        .description("Benchmark tool commands with hyperfine")
        .argument("[suite]", "Suite name to run directly")
        .option("--compare", "Compare results with the last saved run")
        .option("--runs <n>", "Exact number of timing runs (default: auto-detect by hyperfine)", (v) => parseInt(v, 10))
        .option("--warmup <n>", "Number of warmup runs before timing (default: 3)", (v) => parseInt(v, 10))
        .option(
            "--no-warmup",
            "Skip warmup runs entirely — useful for long-running benchmarks (e.g. --runs 1 --no-warmup)"
        )
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
}
