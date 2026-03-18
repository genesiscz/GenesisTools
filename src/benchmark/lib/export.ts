import { formatDuration } from "@app/utils/format";
import type { HyperfineResult } from "@app/benchmark/types";

export function formatResultsMarkdown(results: HyperfineResult[], suiteName: string): string {
    const lines = [
        `## Benchmark Results: ${suiteName}`,
        "",
        "| Command | Mean | Stddev | Min | Max |",
        "| --- | ---: | ---: | ---: | ---: |",
    ];

    for (const r of results) {
        lines.push(
            `| ${r.command} | ${formatDuration(r.mean * 1000)} | \u00B1 ${formatDuration(r.stddev * 1000)} | ${formatDuration(r.min * 1000)} | ${formatDuration(r.max * 1000)} |`
        );
    }

    return lines.join("\n");
}

export function formatResultsCsv(results: HyperfineResult[]): string {
    const lines = ["command,mean_s,stddev_s,min_s,max_s,median_s,user_s,system_s"];

    for (const r of results) {
        lines.push(
            [r.command, r.mean, r.stddev, r.min, r.max, r.median, r.user, r.system]
                .map((v) => (typeof v === "string" ? `"${v}"` : v.toFixed(6)))
                .join(",")
        );
    }

    return lines.join("\n");
}

export function formatResultsJson(results: HyperfineResult[], suiteName: string): string {
    return JSON.stringify(
        {
            suite: suiteName,
            date: new Date().toISOString(),
            results: results.map((r) => ({
                command: r.command,
                mean: r.mean,
                stddev: r.stddev,
                min: r.min,
                max: r.max,
                median: r.median,
                user: r.user,
                system: r.system,
            })),
        },
        null,
        2
    );
}
