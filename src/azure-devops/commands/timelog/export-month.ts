import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";

export function registerExportMonthSubcommand(parent: Command): void {
    parent
        .command("export-month")
        .description("Export time logs for a full month with summary")
        .requiredOption("--month <n>", "Month number (1-12)", parseInt)
        .option("--year <n>", "Year (default: current)", parseInt)
        .option("--format <format>", "Output format: table|json", "table")
        .option("--output <file>", "Save output to file")
        .option("--user <id>", "Override user ID (default: configured user)")
        .action(async (options: { month: number; year?: number; format: string; output?: string; user?: string }) => {
            const config = requireTimeLogConfig();
            const user = requireTimeLogUser(config);
            const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

            const year = options.year ?? new Date().getFullYear();
            const userId = options.user ?? user.userId;

            if (options.month < 1 || options.month > 12) {
                console.error("Month must be between 1 and 12");
                process.exit(1);
            }

            const result = await exportMonth(api, options.month, year, userId);

            if (options.format === "json") {
                const jsonOutput = JSON.stringify(result, null, 2);

                if (options.output) {
                    await Bun.write(options.output, jsonOutput);
                    console.log(`Exported to ${options.output}`);
                } else {
                    console.log(jsonOutput);
                }
                return;
            }

            // Table format
            const monthNames = [
                "January",
                "February",
                "March",
                "April",
                "May",
                "June",
                "July",
                "August",
                "September",
                "October",
                "November",
                "December",
            ];
            const monthName = monthNames[options.month - 1];

            console.log(`\n${pc.bold(`${monthName} ${year} - Time Log Export`)}`);
            console.log(
                `Total: ${pc.bold(formatMinutes(result.summary.totalMinutes))} ` +
                    `(${result.summary.totalHours}h) across ${result.entries.length} entries`
            );
            console.log(`Period: ${result.fromDate} to ${result.toDate}\n`);

            // By Work Item table
            const wiEntries = Object.entries(result.summary.entriesByWorkItem).sort(
                ([, a], [, b]) => b.minutes - a.minutes
            );

            if (wiEntries.length > 0) {
                console.log(pc.bold("By Work Item:"));
                const wiTable = new Table({
                    head: ["ID", "Title", "Hours", "Entries"],
                    style: { head: ["cyan"] },
                });

                for (const [id, info] of wiEntries) {
                    wiTable.push([
                        `#${id}`,
                        info.title.length > 40 ? `${info.title.slice(0, 37)}...` : info.title,
                        formatMinutes(info.minutes),
                        String(info.count),
                    ]);
                }

                console.log(wiTable.toString());
            }

            // By Day table
            const dayEntries = Object.entries(result.summary.entriesByDay).sort(([a], [b]) => a.localeCompare(b));

            if (dayEntries.length > 0) {
                console.log(`\n${pc.bold("By Day:")}`);
                const dayTable = new Table({
                    head: ["Date", "Hours"],
                    style: { head: ["cyan"] },
                });

                for (const [date, minutes] of dayEntries) {
                    dayTable.push([date, formatMinutes(minutes)]);
                }

                console.log(dayTable.toString());
            }

            if (options.output) {
                await Bun.write(options.output, JSON.stringify(result, null, 2));
                console.log(`\nFull data exported to ${options.output}`);
            }
        });
}
