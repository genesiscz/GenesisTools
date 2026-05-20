import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { out } from "@app/logger";
import type { TimeEntryRecord, TimeSeriesValue } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";
import { addDay, formatDate, getWeekRange, subtractDay } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";
import { requireConfig } from "../config.js";
import { buildFillMap, buildTimeSegments, type FillEntry } from "../lib/fill-utils.js";

interface WeekPlan {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    entries: Array<{
        fill: FillEntry;
        timeEntryId: number;
        taskId: number;
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
}

function renderWeekPreview(plan: WeekPlan): void {
    const start = plan.periodStart.split("T")[0];
    const end = subtractDay(plan.periodFinish.split("T")[0]);

    out.println(`\n${pc.bold(`Week: ${start} to ${end}`)} (Timesheet: ${plan.timesheetId})`);

    if (plan.entries.length === 0 && plan.unmappedWorkItems.length === 0) {
        out.println(pc.dim("  No entries for this week"));
        return;
    }

    // Build day columns (periodFinish is exclusive)
    const periodStart = new Date(plan.periodStart);
    const periodEnd = new Date(plan.periodFinish);
    const dayLabels: string[] = [];
    const dayDates: string[] = [];
    const dayNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    const current = new Date(periodStart);

    while (current < periodEnd) {
        dayDates.push(formatDate(current));
        dayLabels.push(`${dayNames[current.getUTCDay()]} ${current.getUTCDate()}`);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    // Only show Mon-Fri
    const workDayIndices = dayDates
        .map((_, i) => i)
        .filter((i) => {
            const d = new Date(periodStart);
            d.setUTCDate(d.getUTCDate() + i);
            const dow = d.getUTCDay();
            return dow >= 1 && dow <= 5;
        });

    const workLabels = workDayIndices.map((i) => dayLabels[i]);

    const table = new Table({
        head: ["Clarity Task", ...workLabels, "Total"],
        style: { head: ["cyan"] },
    });

    for (const entry of plan.entries) {
        const dayValues: string[] = [];
        let total = 0;

        for (const idx of workDayIndices) {
            const date = dayDates[idx];
            const mins = entry.fill.dayMinutes[date] ?? 0;
            total += mins;
            dayValues.push(mins > 0 ? `${(mins / 60).toFixed(2)}h` : pc.dim("-"));
        }

        const name =
            entry.fill.mapping.clarityTaskName.length > 30
                ? `${entry.fill.mapping.clarityTaskName.slice(0, 27)}...`
                : entry.fill.mapping.clarityTaskName;

        table.push([name, ...dayValues, pc.bold(`${(total / 60).toFixed(2)}h`)]);
    }

    out.println(table.toString());

    if (plan.unmappedWorkItems.length > 0) {
        out.println(pc.yellow("\n  Unmapped work items (skipped):"));

        for (const wi of plan.unmappedWorkItems) {
            out.println(pc.yellow(`    #${wi.workItemId}: ${formatMinutes(wi.minutes)}`));
        }

        out.println(pc.yellow("  Run 'tools clarity link-workitems' to create mappings"));
    }
}

export function registerFillCommand(program: Command): void {
    const fillCmd = program
        .command("fill")
        .description("Fill Clarity timesheets from ADO timelog data")
        .option("--month <n>", "Month number (1-12)", parseInt)
        .option("--year <n>", "Year (default: current)", parseInt)
        .option("--confirm", "Actually execute the fill (default: dry-run)")
        .option("--dry-run", "Preview only, do not write (default)")
        .option("--verbose", "Show HTTP request/response debug info");

    fillCmd.action(
        async (options: { month?: number; year?: number; confirm?: boolean; dryRun?: boolean; verbose?: boolean }) => {
            if (!options.month) {
                fillCmd.help();
                return;
            }

            const year = options.year ?? new Date().getFullYear();

            if (options.confirm && options.dryRun) {
                out.error("Cannot use --confirm and --dry-run together");
                process.exit(1);
            }

            const isDryRun = Boolean(options.dryRun) || !options.confirm;
            const verbose = options.verbose ?? false;

            if (options.month < 1 || options.month > 12) {
                out.error("Month must be between 1 and 12");
                process.exit(1);
            }

            const clarityConfig = await requireConfig();
            const adoConfig = requireTimeLogConfig();
            const adoUser = requireTimeLogUser(adoConfig);
            const adoApi = new TimeLogApi(
                adoConfig.orgId!,
                adoConfig.projectId,
                adoConfig.timelog!.functionsKey,
                adoUser
            );
            const clarityApi = new ClarityApi({
                baseUrl: clarityConfig.baseUrl,
                authToken: clarityConfig.authToken,
                sessionId: clarityConfig.sessionId,
                cookies: clarityConfig.cookies,
            });

            out.println(pc.bold(`\nFilling Clarity for ${options.month}/${year}${isDryRun ? " (DRY RUN)" : ""}`));

            out.println("Exporting ADO timelog data...");
            const adoExport = await exportMonth(adoApi, options.month, year, adoUser.userId);
            out.println(`  Found ${adoExport.entries.length} ADO entries (${adoExport.summary.totalHours}h total)`);

            if (adoExport.entries.length === 0) {
                out.println("No ADO timelog entries found for this month.");
                return;
            }

            const { fillMap, unmappedByWi } = buildFillMap(adoExport.entries, clarityConfig.mappings);

            const allDatesSet = new Set<string>();

            for (const fill of fillMap.values()) {
                for (const date of Object.keys(fill.dayMinutes)) {
                    allDatesSet.add(date);
                }
            }

            const allDates = [...allDatesSet].sort();

            if (allDates.length === 0 && unmappedByWi.size > 0) {
                out.println(pc.yellow("\nAll entries are unmapped. Run 'tools clarity link-workitems' first."));
                return;
            }

            const weeksSeen = new Set<string>();
            const weeks: Array<{ start: Date; end: Date }> = [];

            for (const date of allDates) {
                const d = new Date(date);
                const { start } = getWeekRange(d);
                const key = formatDate(start);

                if (!weeksSeen.has(key)) {
                    weeksSeen.add(key);
                    weeks.push(getWeekRange(d));
                }
            }

            const firstMapping = clarityConfig.mappings[0];

            if (!firstMapping?.clarityTimesheetId) {
                out.error(
                    "No cached timesheet ID in mappings. Run 'tools clarity link-workitems' with a valid timesheet first."
                );
                process.exit(1);
            }

            out.println("Loading Clarity timesheet data...");

            const weekPlans: WeekPlan[] = [];

            for (const week of weeks) {
                const carouselEntry = await clarityApi.findTimesheetForDate(
                    firstMapping.clarityTimesheetId,
                    week.start
                );

                if (!carouselEntry) {
                    out.warn(pc.yellow(`  Could not find timesheet for week ${formatDate(week.start)}`));
                    continue;
                }

                const tsData = await clarityApi.getTimesheet(carouselEntry.timesheet_id);
                const ts = tsData.timesheets._results[0];

                if (!ts) {
                    out.warn(
                        pc.yellow(
                            `  Could not load timesheet ${carouselEntry.timesheet_id} for week ${formatDate(week.start)}`
                        )
                    );
                    continue;
                }

                const plan: WeekPlan = {
                    timesheetId: ts._internalId,
                    periodStart: ts.timePeriodStart,
                    periodFinish: ts.timePeriodFinish,
                    entries: [],
                    unmappedWorkItems: [...unmappedByWi.entries()].map(([workItemId, minutes]) => ({
                        workItemId,
                        minutes,
                    })),
                };

                for (const fill of fillMap.values()) {
                    const timeEntry = ts.timeentries._results.find(
                        (e: TimeEntryRecord) => e.taskId === fill.mapping.clarityTaskId
                    );

                    if (!timeEntry) {
                        out.warn(
                            pc.yellow(
                                `  No time entry found for task ${fill.mapping.clarityTaskName} in timesheet ${ts._internalId}`
                            )
                        );
                        continue;
                    }

                    plan.entries.push({
                        fill,
                        timeEntryId: timeEntry._internalId,
                        taskId: timeEntry.taskId,
                    });
                }

                weekPlans.push(plan);
            }

            // Preview
            for (const plan of weekPlans) {
                renderWeekPreview(plan);
            }

            if (isDryRun) {
                out.println(pc.cyan("\n  This is a DRY RUN. Use --confirm to execute."));
                return;
            }

            // Execute
            out.println(pc.bold("\nExecuting fill..."));
            let successCount = 0;
            let errorCount = 0;

            for (const plan of weekPlans) {
                const weekLabel = `${plan.periodStart.split("T")[0]} to ${subtractDay(plan.periodFinish.split("T")[0])}`;
                out.println(`\n${pc.dim(`TS#${plan.timesheetId} (${weekLabel})`)}`);

                for (const entry of plan.entries) {
                    // periodFinish is inclusive (last day) — add 1 day for exclusive loop bound
                    const exclusiveEnd = `${addDay(plan.periodFinish.split("T")[0])}T00:00:00`;
                    const segments = buildTimeSegments(plan.periodStart, exclusiveEnd, entry.fill.dayMinutes);
                    const totalSeconds = segments.reduce((sum, s) => sum + s.value, 0);

                    if (totalSeconds === 0) {
                        continue;
                    }

                    const totalHours = totalSeconds / 3600;

                    const actuals: TimeSeriesValue = {
                        isFiscal: false,
                        curveType: "value",
                        dataType: "numeric",
                        _type: "tsv",
                        start: plan.periodStart,
                        finish: plan.periodFinish,
                        segmentList: {
                            total: totalSeconds,
                            defaultValue: 0,
                            segments,
                        },
                    };

                    const taskName =
                        entry.fill.mapping.clarityTaskName.length > 40
                            ? `${entry.fill.mapping.clarityTaskName.slice(0, 37)}...`
                            : entry.fill.mapping.clarityTaskName;

                    const dayBreakdown = segments
                        .filter((s) => s.value > 0)
                        .map((s) => `${s.start.slice(5, 10)}=${(s.value / 3600).toFixed(1)}h`)
                        .join(" ");

                    try {
                        const { debug } = await clarityApi.updateTimeEntryVerbose(plan.timesheetId, entry.timeEntryId, {
                            taskId: entry.taskId,
                            actuals,
                        });
                        successCount++;
                        out.println(
                            pc.green(`  ${pc.bold("OK")} ${taskName}: ${totalHours.toFixed(2)}h [${dayBreakdown}]`)
                        );

                        if (verbose) {
                            out.println(pc.dim(`     PUT ${debug.url}`));
                            out.println(pc.dim(`     Status: ${debug.responseStatus}`));
                            out.println(pc.dim(`     Request:  ${SafeJSON.stringify(debug.requestBody)}`));
                            out.println(pc.dim(`     Response: ${SafeJSON.stringify(debug.responseBody)}`));
                        }
                    } catch (err) {
                        errorCount++;
                        const msg = err instanceof Error ? err.message : String(err);
                        out.error(pc.red(`  ${pc.bold("FAIL")} ${taskName}: ${msg}`));

                        if (verbose) {
                            const debug = (err as Error & { debug?: unknown }).debug;

                            if (debug) {
                                out.println(pc.dim(`     Debug: ${SafeJSON.stringify(debug)}`));
                            }
                        }
                    }
                }
            }

            out.println(
                `\n${pc.bold("Results:")} ${pc.green(`${successCount} updated`)}` +
                    `${errorCount > 0 ? `, ${pc.red(`${errorCount} failed`)}` : ""}`
            );
        }
    );
}
