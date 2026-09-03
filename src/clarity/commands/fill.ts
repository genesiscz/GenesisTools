import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import type { TimeEntryRecord, TimeSeriesValue } from "@genesiscz/utils/clarity";
import { ClarityApi } from "@genesiscz/utils/clarity";
import { addDay, getDaysInPeriodInclusive, isDateInHalfOpenRange } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";
import { requireConfig } from "../config.js";
import { buildPeriodComment } from "../lib/comment-builder.js";
import { checkUnmapped } from "../lib/fill-guard.js";
import { buildFillMap, buildTimeSegments, type FillEntry } from "../lib/fill-utils.js";
import { resolveFillWeeks } from "../lib/fill-weeks.js";

type TimesheetRecordLike = Awaited<ReturnType<ClarityApi["getTimesheet"]>>["timesheets"]["_results"][number];

interface WeekPlan {
    timesheetId: number;
    periodStart: string;
    /** Clarity's timePeriodFinish: the LAST day of the period, inclusive. */
    periodFinish: string;
    /** Notes already on the timesheet, so a re-run does not append a duplicate. */
    existingNotes: number;
    entries: Array<{
        fill: FillEntry;
        timeEntryId: number;
        taskId: number;
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
}

function renderWeekPreview(plan: WeekPlan): void {
    const start = plan.periodStart.split("T")[0];
    const end = plan.periodFinish.split("T")[0];

    out.println(`\n${pc.bold(`Week: ${start} to ${end}`)} (Timesheet: ${plan.timesheetId})`);

    if (plan.entries.length === 0 && plan.unmappedWorkItems.length === 0) {
        out.println(pc.dim("  No entries for this week"));
        return;
    }

    // timePeriodFinish names the LAST day of the period, so the range is inclusive. The shared
    // helper parses as UTC; building Dates locally and then reading getUTCDay() shifted every day
    // back one in CEST, which turned a one-day period into a Sunday and dropped it entirely.
    const days = getDaysInPeriodInclusive(plan.periodStart, plan.periodFinish);
    const dayLabels = days.map((day) => day.label);
    const dayDates = days.map((day) => day.date);

    // Only show Mon-Fri
    const workDayIndices = dayDates
        .map((_, i) => i)
        .filter((i) => {
            const dow = new Date(`${dayDates[i]}T00:00:00Z`).getUTCDay();
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
        .option("--verbose", "Show HTTP request/response debug info")
        .option("--allow-unmapped", "Fill anyway and skip work items that have no Clarity mapping")
        .option("--no-comments", "Do not post the per-week timesheet note");

    fillCmd.action(
        async (options: {
            month?: number;
            year?: number;
            confirm?: boolean;
            dryRun?: boolean;
            verbose?: boolean;
            allowUnmapped?: boolean;
            comments?: boolean;
        }) => {
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

            const { fillMap, unmappedByWi, unmappedEntries } = buildFillMap(adoExport.entries, clarityConfig.mappings, {
                trackEntries: true,
            });
            const unmapped = checkUnmapped({ unmappedByWi, allowUnmapped: Boolean(options.allowUnmapped) });

            if (unmapped.items.length > 0) {
                out.println(pc.yellow(`\n${unmapped.items.length} work item(s) have no Clarity mapping:`));

                for (const item of unmapped.items) {
                    out.println(pc.yellow(`    #${item.workItemId}: ${formatMinutes(item.minutes)}`));
                }

                out.println(pc.yellow(`  ${formatMinutes(unmapped.totalMinutes)} would be left out of Clarity.`));
            }

            if (unmapped.blocked) {
                out.error("Refusing to fill an incomplete month. Map these work items first:");
                out.error("  tools clarity tasks --date <YYYY-MM>");
                out.error("  tools clarity link-workitems --azure-devops-workitem <id> --clarity-task-id <id>");
                out.error("Pass --allow-unmapped to fill the mapped work items anyway.");
                process.exit(1);
            }

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

            out.println("Loading Clarity timesheet data...");

            const { weeks, unresolvedDates, userId } = await resolveFillWeeks({
                api: clarityApi,
                mappings: clarityConfig.mappings,
                dates: allDates,
                month: options.month,
                year,
            });

            if (unresolvedDates.length > 0) {
                for (const date of unresolvedDates) {
                    out.error(pc.red(`  No Clarity period covers ${date}`));
                }

                out.error("Refusing to fill: those hours would be silently dropped.");
                process.exit(1);
            }

            const weekPlans: WeekPlan[] = [];
            let missingRowCount = 0;
            let unreadableWeeks = 0;
            const bookedEntries: Array<{
                timesheetId: number;
                workItemId: number;
                timeTypeDescription: string;
                comment: string | null;
                date: string;
            }> = [];

            for (const week of weeks) {
                let ts: TimesheetRecordLike | undefined;

                try {
                    ts = (await clarityApi.getTimesheet(week.timesheetId)).timesheets._results[0];
                } catch (err) {
                    out.error(
                        pc.red(`  Could not read timesheet ${week.timesheetId} for week ${week.startDate}: ${err}`)
                    );
                    unreadableWeeks++;
                    continue;
                }

                if (!ts) {
                    out.error(pc.red(`  Timesheet ${week.timesheetId} for week ${week.startDate} came back empty`));
                    unreadableWeeks++;
                    continue;
                }

                const plan: WeekPlan = {
                    timesheetId: ts._internalId,
                    periodStart: ts.timePeriodStart,
                    periodFinish: ts.timePeriodFinish,
                    existingNotes: ts.numberOfNotes ?? 0,
                    entries: [],
                    unmappedWorkItems: unmappedEntries
                        .filter((entry) =>
                            isDateInHalfOpenRange(
                                entry.date,
                                ts.timePeriodStart,
                                `${addDay(ts.timePeriodFinish.split("T")[0])}T00:00:00`
                            )
                        )
                        .reduce<Array<{ workItemId: number; minutes: number }>>((acc, entry) => {
                            const known = acc.find((item) => item.workItemId === entry.workItemId);

                            if (known) {
                                known.minutes += entry.minutes;
                            } else {
                                acc.push({ workItemId: entry.workItemId, minutes: entry.minutes });
                            }

                            return acc;
                        }, []),
                };

                for (const fill of fillMap.values()) {
                    const weekMinutes = Object.entries(fill.dayMinutes)
                        .filter(([date]) =>
                            isDateInHalfOpenRange(
                                date,
                                ts.timePeriodStart,
                                `${addDay(ts.timePeriodFinish.split("T")[0])}T00:00:00`
                            )
                        )
                        .reduce((sum, [, minutes]) => sum + minutes, 0);

                    if (weekMinutes === 0) {
                        continue;
                    }

                    const timeEntry = ts.timeentries._results.find(
                        (e: TimeEntryRecord) => e.taskId === fill.mapping.clarityTaskId
                    );

                    if (!timeEntry) {
                        out.error(
                            pc.red(
                                `  No time entry row for task ${fill.mapping.clarityTaskName} in timesheet ${ts._internalId}; its hours cannot be booked`
                            )
                        );
                        missingRowCount++;
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
            let noteCount = 0;
            let noteErrorCount = 0;

            for (const plan of weekPlans) {
                const weekLabel = `${plan.periodStart.split("T")[0]} to ${plan.periodFinish.split("T")[0]}`;
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

                        for (const source of entry.fill.timelogEntries ?? []) {
                            bookedEntries.push({
                                timesheetId: plan.timesheetId,
                                workItemId: source.workItemId,
                                timeTypeDescription: source.timeTypeDescription ?? "",
                                comment: source.comment ?? null,
                                date: source.date,
                            });
                        }
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

            if (options.comments !== false) {
                if (userId === undefined) {
                    noteErrorCount++;
                    out.error(pc.red("  No Clarity user id resolved, the timesheet notes were not posted"));
                }

                for (const plan of weekPlans) {
                    if (userId === undefined) {
                        break;
                    }

                    // The note documents what was booked, so it is built from the entries that
                    // actually wrote. Feeding it every ADO entry would describe unmapped work and
                    // failed writes as if they had landed.
                    const noteText = buildPeriodComment({
                        entries: bookedEntries.filter((entry) => entry.timesheetId === plan.timesheetId),
                        periodStart: plan.periodStart,
                        periodFinishInclusive: plan.periodFinish,
                    });

                    if (!noteText) {
                        continue;
                    }

                    if (plan.existingNotes > 0) {
                        out.warn(
                            pc.yellow(
                                `  Timesheet ${plan.timesheetId} already carries ${plan.existingNotes} note(s), not adding another`
                            )
                        );
                        continue;
                    }

                    try {
                        await clarityApi.createTimesheetNote(plan.timesheetId, noteText, userId);
                        noteCount++;
                    } catch (err) {
                        noteErrorCount++;
                        out.error(pc.red(`  Note failed for timesheet ${plan.timesheetId}: ${err}`));
                    }
                }
            }

            out.println(
                `\n${pc.bold("Results:")} ${pc.green(`${successCount} updated`)}` +
                    `${noteCount > 0 ? `, ${pc.green(`${noteCount} note(s)`)}` : ""}` +
                    `${errorCount > 0 ? `, ${pc.red(`${errorCount} failed`)}` : ""}` +
                    `${missingRowCount > 0 ? `, ${pc.red(`${missingRowCount} task(s) with no row`)}` : ""}` +
                    `${unreadableWeeks > 0 ? `, ${pc.red(`${unreadableWeeks} week(s) unreadable`)}` : ""}` +
                    `${noteErrorCount > 0 ? `, ${pc.red(`${noteErrorCount} note(s) failed`)}` : ""}`
            );

            if (errorCount + missingRowCount + unreadableWeeks > 0) {
                out.error("Some hours were not booked. Fix the causes above and re-run.");
                process.exit(1);
            }
        }
    );
}
