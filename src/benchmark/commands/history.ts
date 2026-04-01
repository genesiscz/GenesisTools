import { formatDuration } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { displayComparison } from "../lib/display";
import { getAllResults, loadResult } from "../lib/results";
import { findSuite } from "../lib/suites";
import type { HistoryOptions, SavedResult } from "../lib/types";

export async function cmdHistory(suiteName: string, opts: HistoryOptions = {}): Promise<void> {
    const suite = await findSuite(suiteName);

    if (!suite) {
        p.log.error(`Suite "${suiteName}" not found.`);
        process.exit(1);
    }

    const files = getAllResults(suiteName);

    if (files.length === 0) {
        p.log.info(`No results found for suite "${suiteName}".`);
        return;
    }

    if (opts.compare) {
        const parts = opts.compare.split("..");
        const dateA = parts[0];
        const dateB = parts[1];

        if (!dateA) {
            p.log.error('Invalid --compare format. Expected "YYYY-MM-DD..YYYY-MM-DD" or "YYYY-MM-DD".');
            process.exit(1);
        }

        const fileA = files.find((f) => f.includes(dateA));

        if (!fileA) {
            p.log.error(`No result found for date "${dateA}".`);
            process.exit(1);
        }

        const resultA = await loadResult(fileA);
        let resultB: SavedResult;

        if (dateB) {
            const fileBMatch = files.find((f) => f.includes(dateB));

            if (!fileBMatch) {
                p.log.error(`No result found for date "${dateB}".`);
                process.exit(1);
            }

            resultB = await loadResult(fileBMatch);
        } else {
            resultB = await loadResult(files[0]);
        }

        displayComparison(resultB.results, resultA);
        return;
    }

    const limit = opts.limit ?? 10;
    const shown = files.slice(0, limit);
    const rows: string[][] = [];

    for (const file of shown) {
        const result = await loadResult(file);
        const summary = result.results.map((r) => `${r.command}: ${formatDuration(r.mean * 1000)}`).join(", ");
        const isPartial = file.replace(`${suiteName}-`, "").split("-").length > 3;

        rows.push([result.date.slice(0, 10), isPartial ? pc.dim("partial") : "full", summary]);
    }

    const table = formatTable(rows, ["Date", "Type", "Results"], {});
    p.note(table, `History: ${suiteName} (${files.length} total, showing ${shown.length})`);
}

export function registerHistoryCommand(program: Command): void {
    program
        .command("history")
        .description("Browse past benchmark results for a suite")
        .argument("<suite>", "Suite name")
        .option("--limit <n>", "Number of results to show (default: 10)", (v) => parseInt(v, 10))
        .option("--compare <dates>", 'Compare two dates: "YYYY-MM-DD..YYYY-MM-DD" or "YYYY-MM-DD" (vs latest)')
        .action(async (suite: string, opts: HistoryOptions) => {
            await cmdHistory(suite, opts);
        });
}
