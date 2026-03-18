import { readdirSync } from "node:fs";
import { join } from "node:path";
import { formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { formatTable } from "@app/utils/table";
import type { SavedResult } from "@app/benchmark/types";
import { ensureResultsDir, RESULTS_DIR } from "@app/benchmark/lib/results";

export async function getHistory(suiteName: string, limit = 20): Promise<SavedResult[]> {
    ensureResultsDir();

    // Match full-suite results: {suite}-{YYYY-MM-DD}.json
    const pattern = new RegExp(`^${suiteName}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    const files = readdirSync(RESULTS_DIR)
        .filter((f) => pattern.test(f))
        .sort()
        .reverse()
        .slice(0, limit);

    const results: SavedResult[] = [];

    for (const file of files) {
        const content = await Bun.file(join(RESULTS_DIR, file)).text();
        const parsed = SafeJSON.parse(content) as SavedResult | null;

        if (parsed) {
            results.push(parsed);
        }
    }

    return results;
}

export function formatHistory(results: SavedResult[]): string {
    if (results.length === 0) {
        return "No history found.";
    }

    const rows: string[][] = [];

    for (const result of results) {
        const date = result.date.slice(0, 10);

        for (const r of result.results) {
            rows.push([
                date,
                r.command,
                formatDuration(r.mean * 1000),
                `\u00B1 ${formatDuration(r.stddev * 1000)}`,
                formatDuration(r.min * 1000),
                formatDuration(r.max * 1000),
            ]);
        }
    }

    return formatTable(rows, ["Date", "Command", "Mean", "Stddev", "Min", "Max"], {
        alignRight: [2, 3, 4, 5],
    });
}
