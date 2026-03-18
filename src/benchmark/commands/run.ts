import * as p from "@clack/prompts";
import pc from "picocolors";
import { displayComparison, displayResults } from "@app/benchmark/lib/display";
import { getLastResult } from "@app/benchmark/lib/results";
import { runBenchmark } from "@app/benchmark/lib/runner";
import { findSuite } from "@app/benchmark/lib/suites";
import type { RunOptions } from "@app/benchmark/types";

export async function cmdRun(suiteName: string, opts: RunOptions): Promise<void> {
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
