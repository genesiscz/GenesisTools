import {
    showCostTrend,
    showDailyUsage,
    showJSON,
    showModelUsage,
    showProviderUsage,
    showSummary,
} from "@app/ask/lib/usage-report";
import { UsageDatabase } from "@app/ask/output/UsageDatabase";
import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";

interface UsageOptions {
    days?: number | string;
    provider?: string;
    model?: string;
    format?: "table" | "json" | "summary";
    helpFull?: boolean;
}

function showHelp(): void {
    out.println(`
Usage: ${toolCommand("ask usage")} [options]

Display usage statistics and analytics for the ask tool.

Options:
  -d, --days <number>     Number of days to analyze (default: 30)
  -p, --provider <name>  Filter by provider name
  -m, --model <name>      Filter by model name
  -f, --format <format>   Output format: table, json, summary (default: table)
  -?, --help-full         Show this detailed help message

Examples:
  ${toolCommand("ask usage")}                    # Show last 30 days usage
  ${toolCommand("ask usage")} --days 7           # Show last 7 days usage
  ${toolCommand("ask usage")} --provider openai   # Filter by provider
  ${toolCommand("ask usage")} --format summary    # Show summary only
  ${toolCommand("ask usage")} --format json       # Output as JSON
`);
}

/** `tools ask usage [options]`: the ask tool dispatches here before its own argument parser runs. */
export async function runUsageCommand(args: string[]): Promise<void> {
    const program = new Command()
        .name("usage")
        .description("Display usage statistics and analytics for the ask tool")
        .option("-d, --days <number>", "Number of days to analyze", "30")
        .option("-p, --provider <name>", "Filter by provider name")
        .option("-m, --model <name>", "Filter by model name")
        .option("-f, --format <format>", "Output format: table, json, summary", "table")
        .option("-?, --help-full", "Show detailed help message");

    await runTool(program, { tool: "ask" }, [process.argv[0], process.argv[1], ...args]);

    const options = program.opts<UsageOptions>();

    if (options.helpFull) {
        showHelp();
        return;
    }

    try {
        const db = new UsageDatabase();
        const days = Number.parseInt(options.days?.toString() || "30", 10);

        if (Number.isNaN(days) || days < 1) {
            logger.error("Invalid days value. Must be a positive number.");
            process.exitCode = 1;
            return;
        }

        if (options.format === "json") {
            await showJSON(db, days, options.provider, options.model);
        } else if (options.format === "summary") {
            await showSummary(db, days);
        } else {
            await showSummary(db, days);
            await showDailyUsage(db, days);
            await showProviderUsage(db, days);
            await showModelUsage(db, days);
            await showCostTrend(db, days);
        }

        db.close();
    } catch (error) {
        logger.error(`Usage statistics failed: ${error}`);
        process.exitCode = 1;
    }
}
