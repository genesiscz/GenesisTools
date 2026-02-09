import { formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";

function collectUsers(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

export function registerListSubcommand(parent: Command): void {
    parent
        .command("list")
        .description("List time logs (per work item or cross-WI query)")
        .option("-w, --workitem <id>", "Work item ID (optional with date filters)")
        .option("--from <date>", "Start date (YYYY-MM-DD)")
        .option("--to <date>", "End date (YYYY-MM-DD)")
        .option("--since <date>")
        .option("--upto <date>")
        .option("--day <date>", "Single day (YYYY-MM-DD)")
        .option("--user <name>", "Filter by user name (can repeat, use @me for self)", collectUsers, [])
        .option("--format <format>", "Output format: ai|md|json|table", "ai")
        .action(
            async (options: {
                workitem?: string;
                from?: string;
                to?: string;
                since?: string;
                upto?: string;
                day?: string;
                user?: string[];
                format?: string;
            }) => {
                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);
                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

                // Resolve --from/--to with --since/--upto as hidden aliases
                const resolvedFrom = options.day || options.from || options.since;
                const resolvedTo = options.day || options.to || options.upto;

                let entries: Array<{
                    timeLogId: string;
                    comment: string | null;
                    timeTypeDescription: string;
                    minutes: number;
                    date: string;
                    userName: string;
                    userEmail?: string | null;
                    workItemId?: number;
                    week?: string;
                }>;

                const hasDateFilter = !!(resolvedFrom || resolvedTo);
                const hasWorkItem = !!options.workitem;

                if (hasWorkItem && !hasDateFilter) {
                    // Backward compat: single work item query
                    const workItemId = parseInt(options.workitem!, 10);

                    if (isNaN(workItemId)) {
                        console.error("Invalid work item ID");
                        process.exit(1);
                    }

                    const raw = await api.getWorkItemTimeLogs(workItemId);
                    entries = raw.map((e) => ({ ...e, comment: e.comment || null, workItemId }));
                } else if (hasDateFilter || !hasWorkItem) {
                    // Cross-WI query
                    if (!hasDateFilter && !hasWorkItem) {
                        console.error("Provide --workitem, --day, --from/--to, or a combination");
                        process.exit(1);
                    }

                    const fromDate = resolvedFrom;
                    const toDate = resolvedTo;

                    if (!fromDate) {
                        console.error("--since or --day is required for date queries");
                        process.exit(1);
                    }

                    const raw = await api.queryTimeLogs({
                        FromDate: fromDate,
                        ToDate: toDate || fromDate,
                        projectId: config.projectId,
                        workitemId: hasWorkItem ? parseInt(options.workitem!, 10) : undefined,
                    });
                    entries = raw;
                } else {
                    entries = [];
                }

                // Post-filter by user name (@me resolves to configured defaultUser)
                if (options.user && options.user.length > 0) {
                    const defaultUserName = config.timelog?.defaultUser?.userName;
                    const resolvedUsers = options.user.map((u) =>
                        u === "@me" && defaultUserName ? defaultUserName : u
                    );
                    const userFilters = resolvedUsers.map((u) => u.toLowerCase());
                    entries = entries.filter((e) => userFilters.some((uf) => e.userName.toLowerCase().includes(uf)));
                }

                // Normalize date format (query returns "2026-01-30T00:00:00", per-WI returns "2026-01-30")
                for (const e of entries) {
                    if (e.date.includes("T")) {
                        e.date = e.date.split("T")[0];
                    }
                }

                // JSON output
                if (options.format === "json") {
                    console.log(JSON.stringify(entries, null, 2));
                    return;
                }

                if (entries.length === 0) {
                    console.log("No time logs found.");
                    return;
                }

                // Sort by date descending
                entries.sort((a, b) => b.date.localeCompare(a.date));

                // Calculate totals
                const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);
                const byType: Record<string, number> = {};

                for (const entry of entries) {
                    byType[entry.timeTypeDescription] = (byType[entry.timeTypeDescription] || 0) + entry.minutes;
                }

                if (options.format === "table") {
                    // Table output using cli-table3
                    const table = new Table({
                        head: ["ID", "Date", "WI", "Type", "Time", "User", "Comment"],
                        colWidths: [10, 12, 8, 16, 8, 22, 26],
                        wordWrap: true,
                        style: { head: ["cyan"] },
                    });

                    for (const e of entries) {
                        table.push([
                            e.timeLogId.substring(0, 8),
                            e.date,
                            e.workItemId ? `#${e.workItemId}` : "-",
                            e.timeTypeDescription,
                            formatMinutes(e.minutes),
                            e.userName,
                            (e.comment || "-").substring(0, 24),
                        ]);
                    }

                    console.log(table.toString());
                    console.log(`\n${pc.bold(`Total: ${formatMinutes(totalMinutes)}`)} (${entries.length} entries)`);
                    console.log("\nBy Type:");

                    for (const [type, mins] of Object.entries(byType)) {
                        console.log(`  ${type}: ${formatMinutes(mins)}`);
                    }

                    return;
                }

                if (options.format === "md") {
                    const title =
                        hasWorkItem && !hasDateFilter ? `## Time Logs for #${options.workitem}\n` : `## Time Logs\n`;
                    console.log(title);
                    console.log(`| ID | Date | WI | Type | Time | User | Comment |`);
                    console.log(`|----|------|-----|------|------|------|---------|`);

                    for (const e of entries) {
                        const wi = e.workItemId ? `#${e.workItemId}` : "-";
                        console.log(
                            `| ${e.timeLogId.substring(0, 8)} | ${e.date} | ${wi} | ${e.timeTypeDescription} | ${formatMinutes(e.minutes)} | ${e.userName} | ${e.comment || "-"} |`
                        );
                    }

                    console.log(`\n**Total: ${formatMinutes(totalMinutes)}**`);
                } else {
                    // AI format
                    const title =
                        hasWorkItem && !hasDateFilter ? `Time Logs for Work Item #${options.workitem}` : "Time Logs";
                    console.log(title);
                    console.log("=".repeat(40));

                    for (const e of entries) {
                        const wi = e.workItemId ? ` [#${e.workItemId}]` : "";
                        console.log(`\n${e.date} - ${formatMinutes(e.minutes)} (${e.timeTypeDescription})${wi}`);
                        console.log(`  ID: ${e.timeLogId}`);
                        console.log(`  User: ${e.userName}`);

                        if (e.comment) {
                            console.log(`  Comment: ${e.comment}`);
                        }
                    }

                    console.log(`\n${"=".repeat(40)}`);
                    console.log(`Total: ${formatMinutes(totalMinutes)}`);
                    console.log("\nBy Type:");

                    for (const [type, mins] of Object.entries(byType)) {
                        console.log(`  ${type}: ${formatMinutes(mins)}`);
                    }
                }
            }
        );
}
