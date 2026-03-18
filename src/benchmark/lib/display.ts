import { formatDuration } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { HyperfineResult, SavedResult } from "@app/benchmark/types";

export function displayResults(results: HyperfineResult[]): void {
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

export function displayComparison(current: HyperfineResult[], previous: SavedResult): void {
    const rows: string[][] = [];

    for (const cur of current) {
        const prev = previous.results.find((r) => r.command === cur.command);

        if (!prev) {
            rows.push([cur.command, formatDuration(cur.mean * 1000), "\u2014", "\u2014"]);
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
