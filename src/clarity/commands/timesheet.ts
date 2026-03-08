import type { TimeEntryRecord, TimesheetRecord } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";
import * as clack from "@clack/prompts";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";
import { requireConfig } from "../config.js";

function formatSeconds(seconds: number): string {
    const hours = seconds / 3600;
    return `${hours.toFixed(2)}h`;
}

function statusLabel(statusId: string): string {
    const labels: Record<string, string> = {
        "0": "Open",
        "1": "Submitted",
        "2": "Reverted",
        "3": "Approved",
        "4": "Posted",
    };
    return labels[statusId] ?? `Unknown(${statusId})`;
}

function statusColor(statusId: string): string {
    switch (statusId) {
        case "0":
            return pc.green("Open");
        case "1":
            return pc.yellow("Submitted");
        case "2":
            return pc.red("Reverted");
        case "3":
            return pc.cyan("Approved");
        case "4":
            return pc.dim("Posted");
        default:
            return statusId;
    }
}

function renderTimesheetTable(ts: TimesheetRecord, entries: TimeEntryRecord[]): void {
    const start = ts.timePeriodStart.split("T")[0];
    const finish = ts.timePeriodFinish.split("T")[0];

    console.log(`\n${pc.bold(`Timesheet ${ts._internalId}`)} (${start} to ${finish})`);
    console.log(
        `Status: ${statusColor(ts.status.id)} | Entries: ${entries.length} | Total: ${formatSeconds(ts.actualsTotal)}`
    );

    if (entries.length === 0) {
        console.log(pc.dim("  No time entries"));
        return;
    }

    // Build day columns from first entry's actuals period
    const periodStart = new Date(ts.timePeriodStart);
    const dayLabels: string[] = [];
    const dayDates: string[] = [];
    const dayNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    for (let d = 0; d < 7; d++) {
        const date = new Date(periodStart);
        date.setDate(date.getDate() + d);
        const iso = date.toISOString().split("T")[0];
        dayDates.push(iso);
        dayLabels.push(`${dayNames[date.getDay()]} ${date.getDate()}`);
    }

    const table = new Table({
        head: ["Task", ...dayLabels, "Total"],
        style: { head: ["cyan"] },
        colWidths: [32, 8, 8, 8, 8, 8, 8, 8, 8],
    });

    for (const entry of entries) {
        const dayValues: string[] = [];
        let entryTotal = 0;

        for (const dayDate of dayDates) {
            const dayIso = `${dayDate}T00:00:00`;
            const seg = entry.actuals.segmentList.segments.find(
                (s) => s.start === dayIso || s.start.startsWith(dayDate)
            );
            const val = seg?.value ?? 0;
            entryTotal += val;
            dayValues.push(val > 0 ? formatSeconds(val) : pc.dim("-"));
        }

        const name = entry.taskName.length > 30 ? `${entry.taskName.slice(0, 27)}...` : entry.taskName;

        table.push([name, ...dayValues, pc.bold(formatSeconds(entryTotal))]);
    }

    console.log(table.toString());
}

export function registerTimesheetCommand(program: Command): void {
    const ts = program.command("timesheet").description("View and manage Clarity timesheets");

    ts.command("show <timesheetId>")
        .description("Show timesheet with time entries")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (timesheetIdStr: string, options: { format: string }) => {
            const config = await requireConfig();
            const api = new ClarityApi({
                baseUrl: config.baseUrl,
                authToken: config.authToken,
                sessionId: config.sessionId,
                cookies: config.cookies,
            });

            const timesheetId = parseInt(timesheetIdStr, 10);

            if (Number.isNaN(timesheetId)) {
                console.error("Invalid timesheet ID");
                process.exit(1);
            }

            const data = await api.getTimesheet(timesheetId);
            const ts = data.timesheets._results[0];

            if (!ts) {
                console.error(`Timesheet ${timesheetId} not found`);
                process.exit(1);
            }

            if (options.format === "json") {
                console.log(JSON.stringify(data, null, 2));
                return;
            }

            renderTimesheetTable(ts, ts.timeentries._results);
        });

    ts.command("list")
        .description("List timesheets for a time period")
        .option("--period <id>", "Time period ID", parseInt)
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (options: { period?: number; format: string }) => {
            const config = await requireConfig();
            const api = new ClarityApi({
                baseUrl: config.baseUrl,
                authToken: config.authToken,
                sessionId: config.sessionId,
                cookies: config.cookies,
            });

            if (!options.period) {
                console.error("--period <timePeriodId> is required. Find it via the Clarity web UI.");
                process.exit(1);
            }

            const data = await api.getTimesheetApp(options.period);

            if (options.format === "json") {
                console.log(JSON.stringify(data, null, 2));
                return;
            }

            console.log(pc.bold("\nTimesheet Carousel:"));

            const table = new Table({
                head: ["Period ID", "Timesheet ID", "Start", "End", "Total", "Status"],
                style: { head: ["cyan"] },
            });

            for (const entry of data.tscarousel._results) {
                table.push([
                    String(entry.id),
                    String(entry.timesheet_id),
                    entry.start_date.split("T")[0],
                    entry.finish_date.split("T")[0],
                    `${entry.total}h`,
                    statusLabel(entry.prstatus.id),
                ]);
            }

            console.log(table.toString());
        });

    ts.command("submit <timesheetId>")
        .description("Submit a timesheet for approval")
        .action(async (timesheetIdStr: string) => {
            const config = await requireConfig();
            const api = new ClarityApi({
                baseUrl: config.baseUrl,
                authToken: config.authToken,
                sessionId: config.sessionId,
                cookies: config.cookies,
            });

            const timesheetId = parseInt(timesheetIdStr, 10);

            clack.intro(pc.bgYellow(pc.black(" Submit Timesheet ")));

            const confirm = await clack.confirm({
                message: `Submit timesheet ${timesheetId}?`,
                initialValue: false,
            });

            if (clack.isCancel(confirm) || !confirm) {
                clack.cancel("Cancelled.");
                return;
            }

            const spinner = clack.spinner();
            spinner.start("Submitting timesheet...");

            try {
                await api.submitTimesheet(timesheetId);
                spinner.stop("Timesheet submitted!");
                clack.outro(pc.green(`Timesheet ${timesheetId} submitted successfully.`));
            } catch (err) {
                spinner.stop("Failed to submit");
                clack.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });

    ts.command("revert <timesheetId>")
        .description("Revert a submitted timesheet to allow edits")
        .action(async (timesheetIdStr: string) => {
            const config = await requireConfig();
            const api = new ClarityApi({
                baseUrl: config.baseUrl,
                authToken: config.authToken,
                sessionId: config.sessionId,
                cookies: config.cookies,
            });

            const timesheetId = parseInt(timesheetIdStr, 10);

            clack.intro(pc.bgRed(pc.white(" Revert Timesheet ")));

            const confirm = await clack.confirm({
                message: `Revert timesheet ${timesheetId} to allow edits?`,
                initialValue: false,
            });

            if (clack.isCancel(confirm) || !confirm) {
                clack.cancel("Cancelled.");
                return;
            }

            const spinner = clack.spinner();
            spinner.start("Reverting timesheet...");

            try {
                await api.revertTimesheet(timesheetId);
                spinner.stop("Timesheet reverted!");
                clack.outro(pc.green(`Timesheet ${timesheetId} reverted successfully.`));
            } catch (err) {
                spinner.stop("Failed to revert");
                clack.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}
