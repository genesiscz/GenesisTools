import { requireConfig } from "@app/clarity/config";
import { parseMonthArg } from "@app/clarity/lib/assignment-view";
import { renderReceipt, rowWriteReceipt } from "@app/clarity/lib/receipts";
import { listClarityTasks } from "@app/clarity/lib/tasks";
import {
    type AddRowsResult,
    addTaskRows,
    type DesiredTask,
    type RemoveRowsResult,
    removeTaskRows,
} from "@app/clarity/lib/timesheet-rows";
import {
    findPeriodForDate,
    getTimesheetWeeks,
    hasTimesheetId,
    parseTimesheetArg,
    selectWeeksForDateArg,
    type TimesheetWeek,
} from "@app/clarity/lib/timesheet-weeks";
import * as p from "@clack/prompts";
import { ClarityApi } from "@genesiscz/utils/clarity";
import { isInteractive } from "@genesiscz/utils/cli";
import { addDay, formatLocalDate } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface TasksOptions {
    date?: string;
    timesheet?: string;
    add?: string[];
    addFrom?: string;
    remove?: string[];
    yes?: boolean;
    format: string;
}

const DATE_ARG = /^\d{4}-\d{2}-\d{2}$/;

export function registerTasksCommand(parent: Command): void {
    parent
        .command("tasks")
        .description("The Clarity task rows on a timesheet week")
        .option("--date <date>", "Day (YYYY-MM-DD) or month (YYYY-MM), default: today")
        .option("--timesheet <id>", "Timesheet ID, skips the date lookup")
        .option("--add <ids...>", "Add these Clarity task ids as rows on the week(s) in scope")
        .option("--add-from <source>", "Copy the catalogue of another week (YYYY-MM-DD or a timesheet id)")
        .option("--remove <ids...>", "Remove these task ids, if their rows carry no hours")
        .option("--yes", "Skip confirmation prompts")
        .option("--format <format>", "Output format: table|json", "table")
        .addHelpText(
            "after",
            [
                "",
                "Examples:",
                "  tools clarity tasks --date 2026-08                 catalogue for every week of August",
                "  tools clarity tasks --timesheet 9115177            catalogue of one timesheet",
                "  tools clarity tasks --date 2026-09 --add-from 2026-08-25 --yes",
                "  tools clarity tasks --date 2026-09-01 --add 8902005 8902008 --yes",
                "  tools clarity tasks --date 2026-09-01 --remove 8902008 --yes",
                "",
                "Mappings between ADO work items and Clarity tasks live in: tools clarity mappings",
                "",
            ].join("\n")
        )
        .action(async (options: TasksOptions) => {
            const date = options.date ?? formatLocalDate(new Date());
            const timesheet = parseTimesheetArg(options.timesheet);

            if (timesheet.supplied && timesheet.id === undefined) {
                out.error(`Invalid --timesheet '${options.timesheet}': expected a positive timesheet id`);
                process.exit(1);
            }

            const writing = Boolean(options.add || options.addFrom || options.remove);

            if (writing && options.remove && (options.add || options.addFrom)) {
                out.error("--remove cannot be combined with --add or --add-from; run them one at a time");
                process.exit(1);
            }

            const api = await connect();
            const selected = await resolveWeeks({ api, date, timesheetId: timesheet.id });

            if (writing) {
                await runWrite({ api, selected, date, options });
                return;
            }

            await runCatalogue({ api, selected, date, options });
        });
}

async function connect(): Promise<ClarityApi> {
    const config = await requireConfig();

    return new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
        cookies: config.cookies,
    });
}

/**
 * The periods a `--date` or `--timesheet` argument puts in scope. Periods Clarity has not opened
 * yet are KEPT here, so a write can report them as skipped instead of silently doing less than the
 * month the user asked for.
 */
async function resolveWeeks({
    api,
    date,
    timesheetId,
}: {
    api: ClarityApi;
    date: string;
    timesheetId?: number;
}): Promise<TimesheetWeek[]> {
    if (timesheetId !== undefined) {
        // Read the period off the timesheet itself; inventing a range from --date would label the
        // week with a day it does not contain.
        const record = (await api.getTimesheet(timesheetId)).timesheets._results[0];

        if (!record) {
            out.error(`Timesheet ${timesheetId} not found`);
            process.exit(1);
        }

        return [
            {
                timesheetId,
                timePeriodId: record.timePeriodId,
                startDate: record.timePeriodStart.split("T")[0],
                // timePeriodFinish names the LAST day of the period; a week's range is half-open.
                finishDate: addDay(record.timePeriodFinish.split("T")[0]),
                totalHours: record.actualsTotal ?? 0,
                status: record.status?.displayValue ?? "unknown",
            },
        ];
    }

    let month: number;
    let year: number;

    try {
        ({ month, year } = parseMonthArg(date));
    } catch (err) {
        out.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    const { weeks } = await getTimesheetWeeks(api, month, year);
    const selected = selectWeeksForDateArg(weeks, date);

    if (selected.length === 0) {
        out.error(`No Clarity period covers ${date}`);
        process.exit(1);
    }

    return selected;
}

async function runCatalogue({
    api,
    selected,
    date,
    options,
}: {
    api: ClarityApi;
    selected: TimesheetWeek[];
    date: string;
    options: TasksOptions;
}): Promise<void> {
    const readable = selected.filter(hasTimesheetId);

    if (readable.length === 0) {
        // The period exists, Clarity just has not opened a timesheet for it. Saying "no period
        // covers this date" would send the reader looking for the wrong problem.
        out.error(`Clarity has not opened a timesheet for ${date} yet, so it has no task rows`);
        process.exit(1);
    }

    const sections = await Promise.all(
        readable.map(async (week) => ({ week, tasks: await listClarityTasks({ api, timesheetId: week.timesheetId }) }))
    );

    if (options.format === "json") {
        out.result(
            sections.map((section) => ({
                timesheetId: section.week.timesheetId,
                startDate: section.week.startDate,
                finishDate: section.week.finishDate,
                tasks: section.tasks,
            }))
        );
        return;
    }

    for (const section of sections) {
        const period =
            sections.length > 1
                ? `${section.week.startDate} to ${section.week.finishDate}`
                : `timesheet ${section.week.timesheetId}`;

        renderCliHeader("Clarity Tasks", `${period} · timesheet ${section.week.timesheetId}`);
        const table = createBoxTable(["TASK ID", "TASK", "INVESTMENT", "CODE"]);

        for (const task of section.tasks) {
            table.push([
                pc.white(String(task.taskId)),
                truncateDisplay(task.taskName, 58),
                truncateDisplay(task.investmentName, 24),
                pc.dim(task.taskCode),
            ]);
        }

        out.println(table.toString());
        out.println(pc.dim(`  ${section.tasks.length} task(s)`));
    }
}

function parseTaskId(raw: string, flag: string): number {
    const id = Number(raw);

    if (!Number.isInteger(id) || id <= 0 || raw.trim() === "") {
        out.error(`Invalid ${flag} id '${raw}': expected a Clarity task id`);
        process.exit(1);
    }

    return id;
}

/** Resolve `--add-from`, which names either a day inside the source week or the timesheet itself. */
async function readSourceCatalogue({ api, source }: { api: ClarityApi; source: string }): Promise<DesiredTask[]> {
    let timesheetId: number;

    if (DATE_ARG.test(source)) {
        let month: number;
        let year: number;

        try {
            ({ month, year } = parseMonthArg(source));
        } catch (err) {
            out.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }

        const { weeks } = await getTimesheetWeeks(api, month, year);
        const week = findPeriodForDate(weeks, source);

        if (!week) {
            out.error(`No Clarity period covers --add-from ${source}`);
            process.exit(1);
        }

        if (!hasTimesheetId(week)) {
            out.error(`Clarity has not opened a timesheet for the week of ${source}, so it has no catalogue to copy`);
            process.exit(1);
        }

        timesheetId = week.timesheetId;
    } else {
        const parsed = parseTimesheetArg(source);

        if (parsed.id === undefined) {
            out.error(`Invalid --add-from '${source}': expected YYYY-MM-DD or a timesheet id`);
            process.exit(1);
        }

        timesheetId = parsed.id;
    }

    const tasks = await listClarityTasks({ api, timesheetId });

    if (tasks.length === 0) {
        out.error(`Timesheet ${timesheetId} carries no task rows, so there is nothing to copy`);
        process.exit(1);
    }

    return tasks.map((task) => ({ taskId: task.taskId, taskName: task.taskName }));
}

async function confirmWrite({ message, yes }: { message: string; yes?: boolean }): Promise<boolean> {
    if (yes) {
        return true;
    }

    if (!isInteractive()) {
        out.error(`Refusing to write to Clarity without --yes in a non-interactive shell (${message})`);
        process.exit(1);
    }

    const confirmed = await p.confirm({ message });

    if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Cancelled");
        return false;
    }

    return true;
}

interface WeekOutcome {
    timesheetId?: number;
    startDate: string;
    finishDate: string;
    added?: DesiredTask[];
    skipped?: DesiredTask[];
    removed?: DesiredTask[];
    blocked?: RemoveRowsResult["blocked"];
    missing?: number[];
    failed?: Array<DesiredTask & { error: string }>;
    /** Set when Clarity has not opened a timesheet for the period, so nothing could be written. */
    unopened?: boolean;
}

async function runWrite({
    api,
    selected,
    date,
    options,
}: {
    api: ClarityApi;
    selected: TimesheetWeek[];
    date: string;
    options: TasksOptions;
}): Promise<void> {
    const want: DesiredTask[] = (options.add ?? []).map((raw) => ({ taskId: parseTaskId(raw, "--add") }));

    if (options.addFrom) {
        want.push(...(await readSourceCatalogue({ api, source: options.addFrom })));
    }

    const removeIds = (options.remove ?? []).map((raw) => parseTaskId(raw, "--remove"));
    const targets = selected.filter(hasTimesheetId);
    const verb = removeIds.length > 0 ? "Remove" : "Add";
    const count = removeIds.length > 0 ? removeIds.length : want.length;

    if (count === 0) {
        out.println("Nothing to do.");
        return;
    }

    if (targets.length === 0) {
        out.error(`Clarity has opened no timesheet for ${date}, so there is nowhere to write`);
        process.exit(1);
    }

    const ok = await confirmWrite({
        message: `${verb} ${count} task row(s) on ${targets.length} week(s)?`,
        yes: options.yes,
    });

    if (!ok) {
        return;
    }

    const outcomes: WeekOutcome[] = selected
        .filter((week) => !hasTimesheetId(week))
        .map((week) => ({ startDate: week.startDate, finishDate: week.finishDate, unopened: true }));

    let failures = 0;

    for (const week of targets) {
        const base = {
            timesheetId: week.timesheetId,
            startDate: week.startDate,
            finishDate: week.finishDate,
        };

        if (removeIds.length > 0) {
            const result = await removeTaskRows({ api, timesheetId: week.timesheetId, taskIds: removeIds });
            failures += result.failed.length + result.blocked.length;
            outcomes.push({ ...base, ...result });
            continue;
        }

        const result: AddRowsResult = await addTaskRows({ api, timesheetId: week.timesheetId, want });
        failures += result.failed.length;
        outcomes.push({ ...base, ...result });
    }

    if (options.format === "json") {
        out.result(outcomes);
    } else {
        renderOutcomes(outcomes);
        renderReceipt(rowWriteReceipt({ outcomes, date }));
    }

    if (failures > 0) {
        out.error("Some task rows were not written. Fix the causes above and re-run.");
        process.exit(1);
    }
}

function renderOutcomes(outcomes: WeekOutcome[]): void {
    for (const outcome of outcomes) {
        const label = `${outcome.startDate} to ${outcome.finishDate}`;

        if (outcome.unopened) {
            out.println(pc.dim(`\n${label}  Clarity has not opened this period yet, skipped`));
            continue;
        }

        out.println(`\n${pc.bold(label)} ${pc.dim(`(timesheet ${outcome.timesheetId})`)}`);

        for (const task of outcome.added ?? []) {
            out.println(`  ${pc.green("added ")} ${task.taskId}  ${task.taskName ?? ""}`);
        }

        for (const task of outcome.removed ?? []) {
            out.println(`  ${pc.green("removed")} ${task.taskId}  ${task.taskName ?? ""}`);
        }

        for (const task of outcome.skipped ?? []) {
            out.println(pc.dim(`  skip    ${task.taskId}  ${task.taskName ?? ""}`));
        }

        for (const task of outcome.blocked ?? []) {
            const carries = task.hours === undefined ? "an unknown number of hours" : `${task.hours.toFixed(2)}h`;
            out.warn(pc.yellow(`  kept    ${task.taskId}  ${task.taskName ?? ""} carries ${carries}`));
        }

        for (const taskId of outcome.missing ?? []) {
            out.println(pc.dim(`  absent  ${taskId}  no row on this week`));
        }

        for (const task of outcome.failed ?? []) {
            out.error(pc.red(`  FAILED  ${task.taskId}  ${task.error}`));
        }
    }
}
