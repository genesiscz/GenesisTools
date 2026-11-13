import { formatMinutes } from "@app/azure-devops/timelog-api";
import {
    executeMonthFill,
    type FillRefusal,
    type FillResult,
    liveMonthFillDeps,
    type MonthFillInput,
    previewMonthFill,
} from "@app/clarity/lib/month-fill";
import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { getDaysInPeriodInclusive } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import Table from "cli-table3";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type FillMonth,
    type FillPlan,
    type FillWriteOutcome,
    type PlannedFillEntry,
    type ReadyFillWeek,
    readyWeeks,
    weekNote,
} from "../lib/fill.js";

/** The rows a week books or leaves as they are; the other tasks have nothing to do there. */
function shownEntries(week: ReadyFillWeek): PlannedFillEntry[] {
    return week.entries.filter((entry) => entry.action === "write" || entry.action === "unchanged");
}

function renderWeekPreview(week: ReadyFillWeek, noteText: string): void {
    const start = week.periodStart.split("T")[0];
    const end = week.periodFinishInclusive.split("T")[0];
    const entries = shownEntries(week);

    out.println(`\n${pc.bold(`Week: ${start} to ${end}`)} (Timesheet: ${week.timesheetId})`);

    if (entries.length === 0 && week.unmappedWorkItems.length === 0) {
        out.println(pc.dim("  No entries for this week"));
        return;
    }

    // timePeriodFinish names the LAST day of the period, so the range is inclusive. The shared
    // helper parses as UTC; building Dates locally and then reading getUTCDay() shifted every day
    // back one in CEST, which turned a one-day period into a Sunday and dropped it entirely.
    const workDays = getDaysInPeriodInclusive(week.periodStart, week.periodFinishInclusive).filter(
        (day) => day.dow >= 1 && day.dow <= 5
    );
    const workLabels = workDays.map((day) => day.label);

    const table = new Table({
        head: ["Clarity Task", ...workLabels, "Total"],
        style: { head: ["cyan"] },
    });

    for (const entry of entries) {
        const dayValues: string[] = [];
        let total = 0;

        for (const day of workDays) {
            const mins = entry.fill.dayMinutes[day.date] ?? 0;
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

    if (week.unmappedWorkItems.length > 0) {
        out.println(pc.yellow("\n  Unmapped work items (skipped):"));

        for (const wi of week.unmappedWorkItems) {
            out.println(pc.yellow(`    #${wi.workItemId}: ${formatMinutes(wi.minutes)}`));
        }

        out.println(pc.yellow(`  Run '${toolCommand("clarity mappings")}' to create mappings`));
    }

    if (noteText) {
        out.println(pc.dim("\n  Timesheet note:"));

        for (const line of noteText.split("\n")) {
            out.println(pc.dim(`    ${line}`));
        }

        if (week.existingNotes > 0) {
            out.println(pc.yellow(`  Not posted: the timesheet already carries ${week.existingNotes} note(s).`));
        }
    }
}

function shortTaskName(entry: PlannedFillEntry): string {
    const name = entry.fill.mapping.clarityTaskName;

    return name.length > 40 ? `${name.slice(0, 37)}...` : name;
}

function renderMonthSummary(fill: FillMonth): void {
    out.println(`  Found ${fill.adoExport.entries.length} ADO entries (${fill.adoExport.summary.totalHours}h total)`);

    const { unmapped } = fill;

    if (unmapped.items.length === 0) {
        return;
    }

    out.println(pc.yellow(`\n${unmapped.items.length} work item(s) have no Clarity mapping:`));

    for (const item of unmapped.items) {
        out.println(pc.yellow(`    #${item.workItemId}: ${formatMinutes(item.minutes)}`));
    }

    out.println(pc.yellow(`  ${formatMinutes(unmapped.totalMinutes)} would be left out of Clarity.`));
}

function renderRefusal(refusal: FillRefusal): void {
    switch (refusal.reason) {
        case "no_ado_entries":
            out.println("No ADO timelog entries found for this month.");
            return;
        case "all_unmapped":
            out.println(pc.yellow(`\nAll entries are unmapped. Run '${toolCommand("clarity mappings")}' first.`));
            return;
        case "no_mappings":
            out.error(`No ADO-to-Clarity mappings configured. Run '${toolCommand("clarity mappings")}' first.`);
            process.exit(1);
            return;
        case "unmapped_work_items":
            out.error("Refusing to fill an incomplete month. Map these work items first:");
            out.error(`  ${toolCommand("clarity mappings", "--date", "<YYYY-MM>", "--unassigned")}`);
            out.error(
                `  ${toolCommand("clarity mappings", "--date", "<YYYY-MM>", "--assign", "<workItemId>:<clarityTaskId>")}`
            );
            out.error("Pass --allow-unmapped to fill the mapped work items anyway.");
            process.exit(1);
            return;
        case "no_timesheet_weeks":
        case "unresolved_dates":
            for (const date of refusal.unresolvedDates) {
                out.error(pc.red(`  No Clarity period covers ${date}`));
            }

            out.error("Refusing to fill: those hours would be silently dropped.");
            process.exit(1);
    }
}

/** Reports the weeks and rows the plan cannot book. Returns their counts for the results line. */
function renderPlanProblems(plan: FillPlan): { missingRowCount: number; unreadableWeeks: number } {
    let missingRowCount = 0;
    let unreadableWeeks = 0;

    for (const week of plan.weeks) {
        if (week.status === "unreadable") {
            out.error(
                pc.red(`  Could not read timesheet ${week.timesheetId} for week ${week.startDate}: ${week.error}`)
            );
            unreadableWeeks++;
            continue;
        }

        if (week.status === "missing") {
            out.error(pc.red(`  Timesheet ${week.timesheetId} for week ${week.startDate} came back empty`));
            unreadableWeeks++;
            continue;
        }

        if (week.status === "idle") {
            continue;
        }

        for (const entry of week.entries.filter((planned) => planned.action !== "nothing-to-clear")) {
            for (const taskId of entry.replacedTaskIds) {
                out.warn(
                    pc.yellow(
                        `  ${entry.fill.mapping.clarityTaskName}: timesheet ${week.timesheetId} has no row for task ${taskId}, so its hours go on task ${entry.row?.taskId}, the task with the same name`
                    )
                );
            }
        }

        for (const entry of week.entries.filter((planned) => planned.action === "no-row")) {
            out.error(
                pc.red(
                    `  No time entry row for task ${entry.fill.mapping.clarityTaskName} in timesheet ${week.timesheetId}; its hours cannot be booked`
                )
            );
            missingRowCount++;
        }
    }

    return { missingRowCount, unreadableWeeks };
}

function renderWrite(entry: PlannedFillEntry, outcome: FillWriteOutcome, verbose: boolean): void {
    const taskName = shortTaskName(entry);

    if (outcome.status === "error") {
        out.error(pc.red(`  ${pc.bold("FAIL")} ${taskName}: ${outcome.error}`));

        if (verbose && outcome.debug) {
            out.println(pc.dim(`     Debug: ${SafeJSON.stringify(outcome.debug)}`));
        }

        return;
    }

    const dayBreakdown = entry.segments
        .filter((s) => s.value > 0)
        .map((s) => `${s.start.slice(5, 10)}=${(s.value / 3600).toFixed(1)}h`)
        .join(" ");
    out.println(
        pc.green(`  ${pc.bold("OK")} ${taskName}: ${(outcome.totalSeconds / 3600).toFixed(2)}h [${dayBreakdown}]`)
    );

    if (verbose && outcome.debug) {
        out.println(pc.dim(`     PUT ${outcome.debug.url}`));
        out.println(pc.dim(`     Status: ${outcome.debug.responseStatus}`));
        out.println(pc.dim(`     Request:  ${SafeJSON.stringify(outcome.debug.requestBody)}`));
        out.println(pc.dim(`     Response: ${SafeJSON.stringify(outcome.debug.responseBody)}`));
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

            const month = options.month;
            const year = options.year ?? new Date().getFullYear();

            if (options.confirm && options.dryRun) {
                out.error("Cannot use --confirm and --dry-run together");
                process.exit(1);
            }

            const isDryRun = Boolean(options.dryRun) || !options.confirm;
            const verbose = options.verbose ?? false;

            if (month < 1 || month > 12) {
                out.error("Month must be between 1 and 12");
                process.exit(1);
            }

            const deps = liveMonthFillDeps();
            const input: MonthFillInput = { month, year, allowUnmapped: Boolean(options.allowUnmapped) };
            let missingRowCount = 0;
            let unreadableWeeks = 0;
            let successCount = 0;
            let errorCount = 0;
            let noteCount = 0;
            let noteErrorCount = 0;

            const renderPlan = (plan: FillPlan) => {
                renderMonthSummary(plan.fill);
                ({ missingRowCount, unreadableWeeks } = renderPlanProblems(plan));

                for (const week of readyWeeks(plan)) {
                    renderWeekPreview(week, options.comments === false ? "" : weekNote(week, shownEntries(week)));
                }
            };

            out.println(pc.bold(`\nFilling Clarity for ${month}/${year}${isDryRun ? " (DRY RUN)" : ""}`));
            out.println("Exporting ADO timelog data and loading the Clarity timesheets...");

            const result: FillResult = isDryRun
                ? await previewMonthFill(input, deps)
                : await executeMonthFill(
                      {
                          ...input,
                          postNotes: options.comments !== false,
                          progress: {
                              onPlan: (plan) => {
                                  renderPlan(plan);
                                  out.println(pc.bold("\nExecuting fill..."));
                              },
                              onWeek: (week) => {
                                  const weekLabel = `${week.periodStart.split("T")[0]} to ${week.periodFinishInclusive.split("T")[0]}`;
                                  out.println(`\n${pc.dim(`TS#${week.timesheetId} (${weekLabel})`)}`);
                              },
                              onWrite: (_week, entry, outcome) => {
                                  if (outcome.status === "error") {
                                      errorCount++;
                                  } else {
                                      successCount++;
                                  }

                                  renderWrite(entry, outcome, verbose);
                              },
                          },
                      },
                      deps
                  );

            if (result.refusal) {
                renderMonthSummary(result.plan.fill);
                renderRefusal(result.refusal);
                return;
            }

            if (isDryRun) {
                renderPlan(result.plan);
                out.println(pc.cyan("\n  This is a DRY RUN. Use --confirm to execute."));
                return;
            }

            const { execution } = result;

            if (execution?.notes?.missingUserId) {
                noteErrorCount++;
                out.error(pc.red("  No Clarity user id resolved, the timesheet notes were not posted"));
            }

            for (const note of execution?.notes?.weeks ?? []) {
                if (note.status === "kept-existing") {
                    out.warn(
                        pc.yellow(
                            `  Timesheet ${note.timesheetId} already carries ${note.existingNotes} note(s), not adding another`
                        )
                    );
                } else if (note.status === "failed") {
                    noteErrorCount++;
                    out.error(pc.red(`  Note failed for timesheet ${note.timesheetId}: ${note.error}`));
                } else {
                    noteCount++;
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

            out.println(
                pc.dim(
                    `  A fill REPLACES the hours on each row, so there is no undo. Review with: ${suggestCommand(
                        "tools clarity",
                        { replaceCommand: ["timesheet", "--month", String(month), "--year", String(year)] }
                    )}`
                )
            );

            if (missingRowCount > 0) {
                out.println(
                    pc.dim(
                        `  Add the missing rows with: ${suggestCommand("tools clarity", {
                            replaceCommand: [
                                "tasks",
                                "--date",
                                `${year}-${String(month).padStart(2, "0")}`,
                                "--add-from",
                                "<a week that has them>",
                            ],
                        })}`
                    )
                );
            }

            if (errorCount + missingRowCount + unreadableWeeks > 0) {
                out.error("Some hours were not booked. Fix the causes above and re-run.");
                process.exit(1);
            }
        }
    );
}
