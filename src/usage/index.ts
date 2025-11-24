#!/usr/bin/env bun

import minimist from "minimist";
import chalk from "chalk";
import Table from "cli-table3";
import logger from "../logger";
import { UsageDatabase } from "../ask/output/UsageDatabase";
import { dynamicPricingManager } from "../ask/providers/DynamicPricing";

interface Options {
    days?: number;
    provider?: string;
    model?: string;
    format?: "table" | "json" | "summary";
    help?: boolean;
}

interface Args extends Options {
    _: string[];
}

function showHelp() {
    console.log(`
Usage: tools usage [options]

Display usage statistics and analytics for ASK tool.

Options:
  -d, --days <number>     Number of days to analyze (default: 30)
  -p, --provider <name>  Filter by provider name
  -m, --model <name>      Filter by model name
  -f, --format <format>   Output format: table, json, summary (default: table)
  -h, --help              Show this help message

Examples:
  tools usage                    # Show last 30 days usage
  tools usage --days 7           # Show last 7 days usage
  tools usage --provider openai   # Filter by provider
  tools usage --format summary    # Show summary only
  tools usage --format json       # Output as JSON
`);
}

function formatCost(cost: number): string {
    // Show more precision for very small costs
    if (cost > 0 && cost < 0.0001) {
        return `$${cost.toExponential(2)}`;
    }
    return dynamicPricingManager.formatCost(cost);
}

function formatTokens(tokens: number): string {
    return dynamicPricingManager.formatTokens(tokens);
}

function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function showSummary(db: UsageDatabase, days: number) {
    const total = db.getTotalUsage(days);

    console.log(chalk.bold.cyan("\n📊 USAGE SUMMARY\n"));
    console.log(chalk.white(`Period: Last ${days} days`));
    console.log(chalk.white(`Total Cost: ${chalk.green.bold(formatCost(total.totalCost))}`));
    console.log(chalk.white(`Total Tokens: ${chalk.yellow(formatTokens(total.totalTokens))}`));
    console.log(chalk.white(`Messages: ${chalk.blue(total.messageCount.toLocaleString())}`));
    console.log(chalk.white(`Sessions: ${chalk.magenta(total.sessionCount.toLocaleString())}`));

    if (total.messageCount > 0) {
        const avgCostPerMessage = total.totalCost / total.messageCount;
        const avgTokensPerMessage = total.totalTokens / total.messageCount;
        console.log(chalk.white(`Avg Cost/Message: ${chalk.green(formatCost(avgCostPerMessage))}`));
        console.log(chalk.white(`Avg Tokens/Message: ${chalk.yellow(formatTokens(avgTokensPerMessage))}`));
    }
}

async function showDailyUsage(db: UsageDatabase, days: number) {
    const dailyUsage = db.getDailyUsage(days);

    if (dailyUsage.length === 0) {
        console.log(chalk.yellow("\nNo usage data found for the specified period."));
        return;
    }

    console.log(chalk.bold.cyan("\n📅 DAILY USAGE\n"));

    const table = new Table({
        head: ["Date", "Cost", "Tokens", "Messages", "Providers"],
        style: { head: ["cyan"] },
    });

    for (const day of dailyUsage) {
        table.push([
            formatDate(day.date),
            chalk.green(formatCost(day.totalCost)),
            formatTokens(day.totalTokens),
            day.messageCount.toLocaleString(),
            day.providerCount.toString(),
        ]);
    }

    console.log(table.toString());
}

async function showProviderUsage(db: UsageDatabase, days: number) {
    const providerUsage = db.getProviderUsage(days);

    if (providerUsage.length === 0) {
        return;
    }

    console.log(chalk.bold.cyan("\n🏢 BY PROVIDER\n"));

    const table = new Table({
        head: ["Provider", "Total Cost", "Total Tokens", "Messages", "Avg Cost/Message"],
        style: { head: ["cyan"] },
    });

    for (const provider of providerUsage) {
        table.push([
            chalk.blue(provider.provider),
            chalk.green(formatCost(provider.totalCost)),
            formatTokens(provider.totalTokens),
            provider.messageCount.toLocaleString(),
            formatCost(provider.avgCostPerMessage),
        ]);
    }

    console.log(table.toString());
}

async function showModelUsage(db: UsageDatabase, days: number) {
    const modelUsage = db.getModelUsage(days);

    if (modelUsage.length === 0) {
        return;
    }

    console.log(chalk.bold.cyan("\n🤖 BY MODEL\n"));

    const table = new Table({
        head: ["Provider", "Model", "Total Cost", "Total Tokens", "Messages", "Avg Cost/Message"],
        style: { head: ["cyan"] },
        colWidths: [12, 30, 12, 12, 10, 15],
    });

    // Show top 10 models
    const topModels = modelUsage.slice(0, 10);
    for (const model of topModels) {
        table.push([
            chalk.blue(model.provider),
            model.model,
            chalk.green(formatCost(model.totalCost)),
            formatTokens(model.totalTokens),
            model.messageCount.toLocaleString(),
            formatCost(model.avgCostPerMessage),
        ]);
    }

    console.log(table.toString());

    if (modelUsage.length > 10) {
        console.log(chalk.gray(`\n... and ${modelUsage.length - 10} more models`));
    }
}

async function showCostTrend(db: UsageDatabase, days: number) {
    const trend = db.getCostTrend(Math.min(days, 7)); // Show last 7 days for trend

    if (trend.length === 0) {
        return;
    }

    console.log(chalk.bold.cyan("\n📈 COST TREND (Last 7 Days)\n"));

    const maxCost = Math.max(...trend.map((t) => t.cost));
    const barLength = 40;

    for (const day of trend) {
        const barFill = Math.round((day.cost / maxCost) * barLength);
        const bar = chalk.green("█".repeat(barFill)) + chalk.gray("░".repeat(barLength - barFill));
        console.log(`${formatDate(day.date).padEnd(15)} ${bar} ${chalk.green(formatCost(day.cost))}`);
    }
}

async function showJSON(db: UsageDatabase, days: number, _provider?: string, _model?: string) {
    const total = db.getTotalUsage(days);
    const dailyUsage = db.getDailyUsage(days);
    const providerUsage = db.getProviderUsage(days);
    const modelUsage = db.getModelUsage(days);

    const output = {
        period: {
            days,
            startDate: dailyUsage.length > 0 ? dailyUsage[dailyUsage.length - 1].date : null,
            endDate: dailyUsage.length > 0 ? dailyUsage[0].date : null,
        },
        summary: {
            totalCost: total.totalCost,
            totalTokens: total.totalTokens,
            messageCount: total.messageCount,
            sessionCount: total.sessionCount,
            avgCostPerMessage: total.messageCount > 0 ? total.totalCost / total.messageCount : 0,
            avgTokensPerMessage: total.messageCount > 0 ? total.totalTokens / total.messageCount : 0,
        },
        daily: dailyUsage,
        byProvider: providerUsage,
        byModel: modelUsage,
    };

    console.log(JSON.stringify(output, null, 2));
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            d: "days",
            p: "provider",
            m: "model",
            f: "format",
            h: "help",
        },
        default: {
            days: 30,
            format: "table",
        },
        boolean: ["help"],
        string: ["days", "provider", "model", "format"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    try {
        const db = new UsageDatabase();
        const days = parseInt(argv.days?.toString() || "30", 10);

        if (isNaN(days) || days < 1) {
            logger.error("Invalid days value. Must be a positive number.");
            process.exit(1);
        }

        if (argv.format === "json") {
            await showJSON(db, days, argv.provider, argv.model);
        } else if (argv.format === "summary") {
            await showSummary(db, days);
        } else {
            // Default table format
            await showSummary(db, days);
            await showDailyUsage(db, days);
            await showProviderUsage(db, days);
            await showModelUsage(db, days);
            await showCostTrend(db, days);
        }

        db.close();
    } catch (error) {
        logger.error(`Usage statistics failed: ${error}`);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
