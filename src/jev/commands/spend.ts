import { type JevSpendTotal, jevSpend } from "@genesiscz/utils/ai/evaluation/spend";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatCost, formatNumber, formatTokens } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { failPlain, printResult } from "../lib/cli-output";

interface SpendCliOptions {
    from?: string;
    to?: string;
    days?: string;
    json?: boolean;
}

function totalRow(key: string, total: JevSpendTotal): string[] {
    return [
        pc.white(key),
        formatNumber(total.calls),
        formatTokens(total.inputTokens),
        formatCost(total.costUsd),
        total.unpricedCalls ? pc.yellow(String(total.unpricedCalls)) : pc.dim("0"),
    ];
}

function printTable(title: string, entries: Array<[string, JevSpendTotal]>): void {
    const table = createBoxTable([title, "CALLS", "INPUT", "COST", "UNPRICED"]);
    for (const [key, total] of entries) {
        table.push(totalRow(key, total));
    }

    out.println(table.toString());
}

function byCost(rows: Record<string, JevSpendTotal>): Array<[string, JevSpendTotal]> {
    return Object.entries(rows).sort(([, a], [, b]) => b.costUsd - a.costUsd || b.calls - a.calls);
}

export function registerSpend(program: Command): void {
    program
        .command("spend")
        .description("What Jev cost across every feature (grep, listen, route, ...), from the shared usage ledger")
        .option("--from <date>", "Start, ISO date or time (default: the oldest ledger day)")
        .option("--to <date>", "End, exclusive (default: now)")
        .option("--days <n>", "Days shown in the per-day table", "14")
        .option("--json", "Print the summary as JSON")
        .addHelpText(
            "after",
            `\nCosts are list price: $0.042 per million input tokens, output free. The same rows appear in\n\`${toolCommand("ai-spend")} jev daily|monthly|session\` and in the dev-dashboard spend block.`
        )
        .action((options: SpendCliOptions) => {
            try {
                const summary = jevSpend({ from: options.from, to: options.to });
                if (options.json) {
                    printResult(summary);
                    return;
                }

                renderCliHeader("Jev spend", `${summary.from.slice(0, 10)} to ${summary.to.slice(0, 10)}`);
                printTable("FEATURE", byCost(summary.byLabel));
                printTable("MODEL", byCost(summary.byModel));
                printTable(
                    "DAY (UTC)",
                    Object.entries(summary.byDay)
                        .sort(([a], [b]) => (a < b ? 1 : -1))
                        .slice(0, Number(options.days) || 14)
                );
                const { total } = summary;
                out.println(
                    `${formatCost(total.costUsd)} over ${formatNumber(total.calls)} calls and ${formatTokens(total.inputTokens)} input tokens${total.unpricedCalls ? `; ${total.unpricedCalls} call(s) unpriced` : ""}.`
                );
            } catch (error) {
                failPlain(error, { command: "spend" });
            }
        });
}
