import type { UsageDatabase, UsageScope } from "@app/ask/output/UsageDatabase";
import { formatDateTime } from "@genesiscz/utils/date";
import { formatCost, formatTokens } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import chalk from "chalk";
import Table from "cli-table3";

function formatDate(dateStr: string): string {
    return formatDateTime(dateStr, { absolute: "date" });
}

export async function showSummary(db: UsageDatabase, scope: UsageScope) {
    const total = await db.getTotalUsage(scope);

    out.println(chalk.bold.cyan("\n📊 USAGE SUMMARY\n"));
    out.println(chalk.white(`Period: ${scope.days === undefined ? "All history" : `Last ${scope.days} days`}`));
    out.println(chalk.white(`Total Cost: ${chalk.green.bold(formatCost(total.totalCost))}`));
    out.println(chalk.white(`Total Tokens: ${chalk.yellow(formatTokens(total.totalTokens))}`));
    out.println(chalk.white(`Messages: ${chalk.blue(total.messageCount.toLocaleString())}`));
    out.println(chalk.white(`Sessions: ${chalk.magenta(total.sessionCount.toLocaleString())}`));

    if (total.messageCount > 0) {
        const avgCostPerMessage = total.totalCost / total.messageCount;
        const avgTokensPerMessage = total.totalTokens / total.messageCount;
        out.println(chalk.white(`Avg Cost/Message: ${chalk.green(formatCost(avgCostPerMessage))}`));
        out.println(chalk.white(`Avg Tokens/Message: ${chalk.yellow(formatTokens(avgTokensPerMessage))}`));
    }
}

export async function showDailyUsage(db: UsageDatabase, scope: UsageScope) {
    const dailyUsage = await db.getDailyUsage(scope);

    if (dailyUsage.length === 0) {
        out.println(chalk.yellow("\nNo usage data found for the specified period."));
        return;
    }

    out.println(chalk.bold.cyan("\n📅 DAILY USAGE\n"));

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

    out.println(table.toString());
}

export async function showProviderUsage(db: UsageDatabase, scope: UsageScope) {
    const providerUsage = await db.getProviderUsage(scope);

    if (providerUsage.length === 0) {
        return;
    }

    out.println(chalk.bold.cyan("\n🏢 BY PROVIDER\n"));

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

    out.println(table.toString());
}

export async function showModelUsage(db: UsageDatabase, scope: UsageScope) {
    const modelUsage = await db.getModelUsage(scope);

    if (modelUsage.length === 0) {
        return;
    }

    out.println(chalk.bold.cyan("\n🤖 BY MODEL\n"));

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

    out.println(table.toString());

    if (modelUsage.length > 10) {
        out.println(chalk.gray(`\n... and ${modelUsage.length - 10} more models`));
    }
}

export async function showCostTrend(db: UsageDatabase, scope: UsageScope) {
    const trend = await db.getCostTrend({ ...scope, days: Math.min(scope.days ?? 7, 7) });

    if (trend.length === 0) {
        return;
    }

    out.println(chalk.bold.cyan("\n📈 COST TREND (Last 7 Days)\n"));

    const maxCost = Math.max(...trend.map((t) => t.cost));
    const barLength = 40;

    for (const day of trend) {
        // A slice of free or local models costs 0 every day; 0 / 0 would make the bar NaN.
        const barFill = maxCost > 0 ? Math.round((day.cost / maxCost) * barLength) : 0;
        const bar = chalk.green("█".repeat(barFill)) + chalk.gray("░".repeat(barLength - barFill));
        out.println(`${formatDate(day.date).padEnd(15)} ${bar} ${chalk.green(formatCost(day.cost))}`);
    }
}

export async function showJSON(db: UsageDatabase, scope: UsageScope) {
    const total = await db.getTotalUsage(scope);
    const dailyUsage = await db.getDailyUsage(scope);
    const providerUsage = await db.getProviderUsage(scope);
    const modelUsage = await db.getModelUsage(scope);

    const output = {
        period: {
            days: scope.days,
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

    out.println(SafeJSON.stringify(output, null, 2));
}
