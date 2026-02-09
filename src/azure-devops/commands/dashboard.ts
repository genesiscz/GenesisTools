/**
 * Azure DevOps CLI Tool - Dashboard Command
 *
 * Fetches a dashboard and lists its queries.
 */

import { Api } from "@app/azure-devops/api";
import { formatJSON, saveGlobalCache } from "@app/azure-devops/cache";
import type { OutputFormat } from "@app/azure-devops/types";
import { extractDashboardId, requireConfig } from "@app/azure-devops/utils";
import logger from "@app/logger";
import type { Command } from "commander";

/**
 * Handle dashboard command - fetch dashboard and list queries
 */
async function handleDashboard(input: string, format: OutputFormat): Promise<void> {
    logger.debug(`[dashboard] Starting with input: ${input}`);
    const config = requireConfig();
    logger.debug(`[dashboard] Config loaded: org=${config.org}, project=${config.project}`);
    const api = new Api(config);
    const dashboardId = extractDashboardId(input);
    logger.debug(`[dashboard] Extracted dashboard ID: ${dashboardId}`);

    logger.debug("[dashboard] Fetching dashboard from API...");
    const dashboard = await api.getDashboard(dashboardId);
    logger.debug(`[dashboard] Got dashboard "${dashboard.name}" with ${dashboard.queries.length} queries`);

    // Save to global cache
    logger.debug(`[dashboard] Saving to global cache...`);
    await saveGlobalCache("dashboard", dashboardId, dashboard);

    const lines: string[] = [];
    lines.push(`# Dashboard: ${dashboard.name}`);
    lines.push("");
    lines.push(`Found ${dashboard.queries.length} queries:`);
    lines.push("");

    for (const q of dashboard.queries) {
        lines.push(`- **${q.name}**: \`${q.queryId}\``);
    }

    lines.push("");
    lines.push("To fetch a query, run:");
    for (const q of dashboard.queries) {
        lines.push(`  tools azure-devops --query ${q.queryId}`);
    }

    switch (format) {
        case "ai":
        case "md":
            console.log(lines.join("\n"));
            break;
        case "json":
            console.log(formatJSON(dashboard));
            break;
    }
}

/**
 * Register the dashboard command on the program
 */
export function registerDashboardCommand(program: Command): void {
    program
        .command("dashboard <input>")
        .description("Fetch dashboard and list its queries")
        .option("-f, --format <format>", "Output format (ai, md, json)", "ai")
        .action(async (input: string, options: { format: OutputFormat }) => {
            await handleDashboard(input, options.format);
        });
}
