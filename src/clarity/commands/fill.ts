import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import type { TimeEntryRecord, TimeSegment, TimeSeriesValue } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";
import type { ClarityMapping } from "../config.js";
import { getMappingForWorkItem, requireConfig } from "../config.js";

interface FillEntry {
    mapping: ClarityMapping;
    dayMinutes: Record<string, number>; // date -> ADO minutes
    totalMinutes: number;
}

interface WeekPlan {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    entries: Array<{
        fill: FillEntry;
        timeEntryId: number;
        taskId: number;
        segments: TimeSegment[];
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
}

function getWeekRange(date: Date): { start: Date; end: Date } {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const start = new Date(d);
    start.setDate(diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
}

function formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minutesToSeconds(minutes: number): number {
    return minutes * 60;
}

function renderWeekPreview(plan: WeekPlan): void {
    const start = plan.periodStart.split("T")[0];
    const end = plan.periodFinish.split("T")[0];

    console.log(`\n${pc.bold(`Week: ${start} to ${end}`)} (Timesheet: ${plan.timesheetId})`);

    if (plan.entries.length === 0 && plan.unmappedWorkItems.length === 0) {
        console.log(pc.dim("  No entries for this week"));
        return;
    }

    // Build day columns
    const periodStart = new Date(plan.periodStart);
    const dayLabels: string[] = [];
    const dayDates: string[] = [];
    const dayNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    for (let d = 0; d < 7; d++) {
        const date = new Date(periodStart);
        date.setDate(date.getDate() + d);
        dayDates.push(formatDate(date));
        dayLabels.push(`${dayNames[date.getDay()]} ${date.getDate()}`);
    }

    // Only show Mon-Fri
    const workDayIndices = dayDates
        .map((_, i) => i)
        .filter((i) => {
            const d = new Date(periodStart);
            d.setDate(d.getDate() + i);
            const dow = d.getDay();
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

    console.log(table.toString());

    if (plan.unmappedWorkItems.length > 0) {
        console.log(pc.yellow("\n  Unmapped work items (skipped):"));

        for (const wi of plan.unmappedWorkItems) {
            console.log(pc.yellow(`    #${wi.workItemId}: ${formatMinutes(wi.minutes)}`));
        }

        console.log(pc.yellow("  Run 'tools clarity link-workitems' to create mappings"));
    }
}

export function registerFillCommand(program: Command): void {
    const fillCmd = program
        .command("fill")
        .description("Fill Clarity timesheets from ADO timelog data")
        .option("--month <n>", "Month number (1-12)", parseInt)
        .option("--year <n>", "Year (default: current)", parseInt)
        .option("--confirm", "Actually execute the fill (default: dry-run)")
        .option("--dry-run", "Preview only, do not write (default)");

    fillCmd.action(async (options: { month?: number; year?: number; confirm?: boolean; dryRun?: boolean }) => {
        if (!options.month) {
            fillCmd.help();
            return;
        }

        const year = options.year ?? new Date().getFullYear();
        const isDryRun = !options.confirm;

        if (options.month < 1 || options.month > 12) {
            console.error("Month must be between 1 and 12");
            process.exit(1);
        }

        // Load configs
        const clarityConfig = await requireConfig();
        const adoConfig = requireTimeLogConfig();
        const adoUser = requireTimeLogUser(adoConfig);
        const adoApi = new TimeLogApi(adoConfig.orgId!, adoConfig.projectId, adoConfig.timelog!.functionsKey, adoUser);
        const clarityApi = new ClarityApi({
            baseUrl: clarityConfig.baseUrl,
            authToken: clarityConfig.authToken,
            sessionId: clarityConfig.sessionId,
            cookies: clarityConfig.cookies,
        });

        console.log(pc.bold(`\nFilling Clarity for ${options.month}/${year}${isDryRun ? " (DRY RUN)" : ""}`));

        // Step 1: Export ADO timelog
        console.log("Exporting ADO timelog data...");
        const adoExport = await exportMonth(adoApi, options.month, year, adoUser.userId);
        console.log(`  Found ${adoExport.entries.length} ADO entries (${adoExport.summary.totalHours}h total)`);

        if (adoExport.entries.length === 0) {
            console.log("No ADO timelog entries found for this month.");
            return;
        }

        // Step 2: Group by Clarity mapping and day
        const fillMap = new Map<number, FillEntry>(); // clarityTaskId -> FillEntry
        const unmappedByWi = new Map<number, number>(); // workItemId -> total minutes

        for (const entry of adoExport.entries) {
            const mapping = getMappingForWorkItem(clarityConfig.mappings, entry.workItemId);

            if (!mapping) {
                unmappedByWi.set(entry.workItemId, (unmappedByWi.get(entry.workItemId) ?? 0) + entry.minutes);
                continue;
            }

            let fill = fillMap.get(mapping.clarityTaskId);

            if (!fill) {
                fill = { mapping, dayMinutes: {}, totalMinutes: 0 };
                fillMap.set(mapping.clarityTaskId, fill);
            }

            fill.dayMinutes[entry.date] = (fill.dayMinutes[entry.date] ?? 0) + entry.minutes;
            fill.totalMinutes += entry.minutes;
        }

        // Step 3: Build week plans
        // Find all unique weeks in the month
        const allDatesSet = new Set<string>();
        for (const fill of fillMap.values()) {
            for (const date of Object.keys(fill.dayMinutes)) {
                allDatesSet.add(date);
            }
        }
        const allDates = [...allDatesSet].sort();

        if (allDates.length === 0 && unmappedByWi.size > 0) {
            console.log(pc.yellow("\nAll entries are unmapped. Run 'tools clarity link-workitems' first."));
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

        // For each week, we need to find the timesheet
        // We'll use a known timePeriodId from the first mapping or config
        const firstMapping = clarityConfig.mappings[0];

        if (!firstMapping?.clarityTimesheetId) {
            console.error(
                "No cached timesheet ID in mappings. Run 'tools clarity link-workitems' with a valid timesheet first."
            );
            process.exit(1);
        }

        // Load the timesheet to get time entry details
        console.log("Loading Clarity timesheet data...");

        const weekPlans: WeekPlan[] = [];

        for (const week of weeks) {
            // For now, try each known timesheet ID
            // In a full implementation, we'd navigate the carousel
            const tsData = await clarityApi.getTimesheet(firstMapping.clarityTimesheetId);
            const ts = tsData.timesheets._results[0];

            if (!ts) {
                console.warn(pc.yellow(`  Could not find timesheet for week ${formatDate(week.start)}`));
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
                // Find matching time entry in the timesheet
                const timeEntry = ts.timeentries._results.find(
                    (e: TimeEntryRecord) => e.taskId === fill.mapping.clarityTaskId
                );

                if (!timeEntry) {
                    console.warn(
                        pc.yellow(
                            `  No time entry found for task ${fill.mapping.clarityTaskName} in timesheet ${ts._internalId}`
                        )
                    );
                    continue;
                }

                // Build segments for this week
                const segments: TimeSegment[] = [];
                const periodStart = new Date(ts.timePeriodStart);

                for (let d = 0; d < 7; d++) {
                    const date = new Date(periodStart);
                    date.setDate(date.getDate() + d);
                    const dateStr = formatDate(date);
                    const mins = fill.dayMinutes[dateStr];

                    if (mins && mins > 0) {
                        const iso = `${dateStr}T00:00:00`;
                        segments.push({
                            start: iso,
                            finish: iso,
                            value: minutesToSeconds(mins),
                        });
                    }
                }

                plan.entries.push({
                    fill,
                    timeEntryId: timeEntry._internalId,
                    taskId: timeEntry.taskId,
                    segments,
                });
            }

            weekPlans.push(plan);
        }

        // Step 4: Preview
        for (const plan of weekPlans) {
            renderWeekPreview(plan);
        }

        if (isDryRun) {
            console.log(pc.cyan("\n  This is a DRY RUN. Use --confirm to execute."));
            return;
        }

        // Step 5: Execute
        console.log(pc.bold("\nExecuting fill..."));
        let successCount = 0;
        let errorCount = 0;

        for (const plan of weekPlans) {
            for (const entry of plan.entries) {
                const totalSeconds = entry.segments.reduce((sum, s) => sum + s.value, 0);
                const actuals: TimeSeriesValue = {
                    isFiscal: false,
                    curveType: "value",
                    total: totalSeconds,
                    dataType: "numeric",
                    _type: "tsv",
                    start: plan.periodStart,
                    finish: plan.periodFinish,
                    segmentList: {
                        total: totalSeconds,
                        defaultValue: 0,
                        segments: entry.segments,
                    },
                };

                try {
                    await clarityApi.updateTimeEntry(plan.timesheetId, entry.timeEntryId, {
                        taskId: entry.taskId,
                        actuals,
                    });
                    successCount++;
                    console.log(
                        pc.green(
                            `  Updated ${entry.fill.mapping.clarityTaskName}: ${(totalSeconds / 3600).toFixed(2)}h`
                        )
                    );
                } catch (err) {
                    errorCount++;
                    console.error(
                        pc.red(
                            `  Failed ${entry.fill.mapping.clarityTaskName}: ${err instanceof Error ? err.message : String(err)}`
                        )
                    );
                }
            }
        }

        console.log(
            `\n${pc.bold("Results:")} ${pc.green(`${successCount} updated`)}${errorCount > 0 ? `, ${pc.red(`${errorCount} failed`)}` : ""}`
        );
    });
}
