import * as p from "@clack/prompts";
import pc from "picocolors";
import { checkRegression, displayComparison, displayResults } from "@app/benchmark/lib/display";
import { formatResultsCsv, formatResultsJson, formatResultsMarkdown } from "@app/benchmark/lib/export";
import { getBaselineResult, getLastResult } from "@app/benchmark/lib/results";
import { runBenchmark } from "@app/benchmark/lib/runner";
import { findSuite } from "@app/benchmark/lib/suites";
import type { RunOptions } from "@app/benchmark/types";

export async function cmdRun(suiteName: string, opts: RunOptions): Promise<void> {
    // CI mode defaults: JSON output, --compare, --fail-threshold 10
    if (opts.ci) {
        opts.format = opts.format ?? "json";
        opts.compare = opts.compare ?? true;
        opts.failThreshold = opts.failThreshold ?? 10;
    }

    const suite = await findSuite(suiteName);

    if (!suite) {
        if (opts.ci) {
            console.error(JSON.stringify({ error: `Suite "${suiteName}" not found` }));
            process.exit(2);
        }

        p.log.error(`Suite "${suiteName}" not found. Use ${pc.bold("tools benchmark list")} to see available suites.`);
        process.exit(1);
    }

    // --fail-threshold or --baseline implies --compare
    const shouldCompare = opts.compare || opts.failThreshold !== undefined || opts.baseline !== undefined;

    let previous = null;

    if (opts.baseline) {
        previous = await getBaselineResult(suiteName, opts.baseline);

        if (!previous && !opts.ci) {
            p.log.warn(`No baseline result found for ref "${opts.baseline}".`);
        }
    } else if (shouldCompare) {
        previous = await getLastResult(suiteName);
    }

    // CI mode: suppress hyperfine terminal output
    const results = await runBenchmark(suite, opts);

    if (!results) {
        if (opts.ci) {
            process.exit(2);
        }

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
        if (!opts.ci) {
            p.log.warn("No previous results to compare against.");
        }
    }

    // Post to PR if requested
    if (opts.postToPr) {
        await postBenchmarkComment(suiteName, results, opts.postToPr);
    }
}

async function postBenchmarkComment(suiteName: string, results: import("@app/benchmark/types").HyperfineResult[], prNumber: number): Promise<void> {
    const { detectRepoFromGit } = await import("@app/utils/github/url-parser");
    const { postComment } = await import("@app/github/lib/post-comment");
    const { formatResultsMarkdown } = await import("@app/benchmark/lib/export");
    const { captureEnv, formatEnvSummary } = await import("@app/benchmark/lib/env-capture");

    const repoStr = await detectRepoFromGit();

    if (!repoStr) {
        p.log.error("Could not detect GitHub repo from git remote.");
        return;
    }

    const [owner, repo] = repoStr.split("/");
    const env = await captureEnv();
    const mdTable = formatResultsMarkdown(results, suiteName);
    const body = `${mdTable}\n\n**Environment:** ${formatEnvSummary(env)}`;

    try {
        const { htmlUrl } = await postComment(owner, repo, prNumber, body);
        p.log.success(`Posted benchmark results to PR #${prNumber}: ${htmlUrl}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.error(`Failed to post comment: ${msg}`);
    }
}
