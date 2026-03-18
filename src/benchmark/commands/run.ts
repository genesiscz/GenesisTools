import * as p from "@clack/prompts";
import pc from "picocolors";
import { checkRegression, displayComparison, displayResults } from "@app/benchmark/lib/display";
import { formatResultsCsv, formatResultsJson, formatResultsMarkdown } from "@app/benchmark/lib/export";
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

    // --fail-threshold implies --compare
    const shouldCompare = opts.compare || opts.failThreshold !== undefined;
    const previous = shouldCompare ? await getLastResult(suiteName) : null;
    const results = await runBenchmark(suite, opts);

    if (!results) {
        process.exit(1);
    }

    // Format output
    const format = opts.format ?? "table";

    if (format === "table") {
        displayResults(results);
    } else {
        let output: string;

        if (format === "md") {
            output = formatResultsMarkdown(results, suiteName);
        } else if (format === "csv") {
            output = formatResultsCsv(results);
        } else {
            output = formatResultsJson(results, suiteName);
        }

        if (opts.clipboard) {
            const clipboardy = await import("clipboardy");
            await clipboardy.default.write(output);
            p.log.success("Copied to clipboard.");
        } else {
            console.log(output);
        }
    }

    if (shouldCompare && previous) {
        const deltas = displayComparison(results, previous);

        if (opts.failThreshold !== undefined) {
            const regressed = checkRegression(deltas, opts.failThreshold);

            if (regressed) {
                process.exitCode = 1;
            }
        }
    } else if (shouldCompare) {
        p.log.warn("No previous results to compare against.");
    }
}
