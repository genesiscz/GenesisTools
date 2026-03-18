import * as p from "@clack/prompts";
import pc from "picocolors";
import { displayResults } from "@app/benchmark/lib/display";
import { runBenchmark } from "@app/benchmark/lib/runner";
import { findSuite } from "@app/benchmark/lib/suites";
import type { RunOptions } from "@app/benchmark/types";

export async function cmdMultiRun(suiteNames: string[], opts: RunOptions): Promise<void> {
    if (suiteNames.length === 0) {
        p.log.error("Provide at least one suite name.");
        process.exit(1);
    }

    for (const name of suiteNames) {
        const suite = await findSuite(name);

        if (!suite) {
            p.log.error(`Suite "${name}" not found. Skipping.`);
            continue;
        }

        const results = await runBenchmark(suite, opts);

        if (!results) {
            p.log.error(`Benchmark "${name}" failed.`);
            continue;
        }

        displayResults(results);

        if (suiteNames.indexOf(name) < suiteNames.length - 1) {
            console.log();
        }
    }
}
