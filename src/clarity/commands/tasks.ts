import { formatMinutes } from "@app/azure-devops/timelog-api";
import { requireConfig, saveConfig } from "@app/clarity/config";
import { type AssignmentView, buildAssignmentView, parseMonthArg } from "@app/clarity/lib/assignment-view";
import { type AssignmentRow, applyAssignments, removeAssignments } from "@app/clarity/lib/assignments";
import { listClarityTasks } from "@app/clarity/lib/tasks";
import { getTimesheetWeeks, selectWeeksForDateArg, type TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import * as p from "@clack/prompts";
import { ClarityApi } from "@genesiscz/utils/clarity";
import { isInteractive } from "@genesiscz/utils/cli";
import { formatDate } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface TasksOptions {
    date?: string;
    timesheet?: string;
    format: string;
    assigned?: boolean;
    unassigned?: boolean;
    assign?: string[];
    applyRecommended?: boolean;
    unlink?: string[];
    yes?: boolean;
}

export function registerTasksCommand(parent: Command): void {
    parent
        .command("tasks")
        .description("Clarity task catalogue, and the ADO work items assigned to it")
        .option("--date <date>", "Day (YYYY-MM-DD) or month (YYYY-MM), default: today")
        .option("--timesheet <id>", "Timesheet ID, skips the date lookup")
        .option("--assigned", "ADO work items that already map to a Clarity task")
        .option("--unassigned", "ADO work items with logged time and no Clarity mapping")
        .option("--assign <pairs...>", "Create mappings as <workItemId>:<clarityTaskId>")
        .option("--apply-recommended", "Assign every unmapped work item that has a tree recommendation")
        .option("--unlink <ids...>", "Remove the mapping for these ADO work item ids")
        .option("--yes", "Skip confirmation prompts")
        .option("--format <format>", "Output format: table|json", "table")
        .addHelpText(
            "after",
            [
                "",
                "Examples:",
                "  tools clarity tasks --date 2026-08              catalogue for every week of August",
                "  tools clarity tasks --date 2026-08 --unassigned  work items still missing a mapping",
                "  tools clarity tasks --date 2026-08 --assigned    mappings, with drift against the tree",
                "  tools clarity tasks --date 2026-08 --apply-recommended",
                "  tools clarity tasks --date 2026-08 --assign 302920:8898018",
                "  tools clarity tasks --unlink 298326 --yes",
                "",
            ].join("\n")
        )
        .action(async (options: TasksOptions) => {
            if (options.unlink) {
                await runUnlink(options);
                return;
            }

            const date = options.date ?? formatDate(new Date());

            if (options.assign || options.applyRecommended) {
                await runAssign(date, options);
                return;
            }

            if (options.assigned || options.unassigned) {
                await runListing(date, options);
                return;
            }

            await runCatalogue(date, options);
        });
}

async function runCatalogue(date: string, options: TasksOptions): Promise<void> {
    const config = await requireConfig();
    const api = new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
        cookies: config.cookies,
    });

    let selected: TimesheetWeek[];

    if (options.timesheet) {
        const timesheetId = Number.parseInt(options.timesheet, 10);
        selected = [{ timesheetId, timePeriodId: 0, startDate: date, finishDate: date, totalHours: 0, status: "" }];
    } else {
        let month: number;
        let year: number;

        try {
            ({ month, year } = parseMonthArg(date));
        } catch (err) {
            out.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }

        const { weeks } = await getTimesheetWeeks(api, config.mappings, month, year);
        selected = selectWeeksForDateArg(weeks, date);

        if (selected.length === 0) {
            out.error(`No Clarity period covers ${date}`);
            process.exit(1);
        }
    }

    const sections = await Promise.all(
        selected.map(async (week) => ({ week, tasks: await listClarityTasks({ api, timesheetId: week.timesheetId }) }))
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

function serialiseRow(row: AssignmentRow) {
    return {
        workItemId: row.workItemId,
        title: row.title,
        type: row.type,
        hours: row.minutes / 60,
        clarityTaskId: row.mapping?.clarityTaskId,
        clarityTaskName: row.mapping?.clarityTaskName,
        drifted: row.drifted,
        recommendation: row.recommendation
            ? {
                  clarityTaskId: row.recommendation.task.taskId,
                  clarityTaskName: row.recommendation.task.taskName,
                  matchedWorkItemId: row.recommendation.matched.id,
                  matchedWorkItemTitle: row.recommendation.matched.title,
              }
            : undefined,
    };
}

async function runListing(date: string, options: TasksOptions): Promise<void> {
    const view = await buildAssignmentView(date);
    const wantAssigned = Boolean(options.assigned);
    const rows = wantAssigned ? view.assigned : view.unassigned;

    if (options.format === "json") {
        out.result(rows.map(serialiseRow));
        return;
    }

    renderCliHeader("Clarity", `${wantAssigned ? "assigned" : "unassigned"} · ${date}`);
    const table = createBoxTable(
        wantAssigned ? ["WI", "HOURS", "MAPPED TO", "RECOMMENDED"] : ["WI", "HOURS", "WORK ITEM", "RECOMMENDED"]
    );

    for (const row of rows) {
        const rec = row.recommendation
            ? `${row.drifted ? pc.yellow("⚠ ") : ""}${truncateDisplay(row.recommendation.task.taskName, 38)} ${pc.dim(`(#${row.recommendation.matched.id})`)}`
            : pc.dim("—");

        table.push([
            pc.white(`#${row.workItemId}`),
            formatMinutes(row.minutes),
            wantAssigned
                ? truncateDisplay(row.mapping?.clarityTaskName ?? "—", 40)
                : truncateDisplay(row.title ?? "", 40),
            rec,
        ]);
    }

    out.println(table.toString());
    out.println(pc.dim(`  ${rows.length} work item(s)`));
}

function collectPairs(view: AssignmentView, options: TasksOptions) {
    const pairs: Array<{ workItemId: number; task: (typeof view.tasks)[number]; title?: string; type?: string }> = [];

    for (const raw of options.assign ?? []) {
        const parts = raw.split(":");
        const workItemId = Number(parts[0]);
        const taskId = Number(parts[1]);

        if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
            out.error(`Invalid --assign pair '${raw}': expected <workItemId>:<clarityTaskId>`);
            process.exit(1);
        }

        if (!Number.isInteger(workItemId) || !Number.isInteger(taskId)) {
            out.error(`Invalid --assign pair '${raw}': expected <workItemId>:<clarityTaskId>`);
            process.exit(1);
        }

        const task = view.tasks.find((t) => t.taskId === taskId);

        if (!task) {
            out.error(`No Clarity task ${taskId} in the catalogue for this month`);
            process.exit(1);
        }

        const row = [...view.assigned, ...view.unassigned].find((r) => r.workItemId === workItemId);
        pairs.push({ workItemId, task, title: row?.title, type: row?.type });
    }

    if (options.applyRecommended) {
        for (const row of view.unassigned) {
            if (row.recommendation && !pairs.some((pair) => pair.workItemId === row.workItemId)) {
                pairs.push({
                    workItemId: row.workItemId,
                    task: row.recommendation.task,
                    title: row.title,
                    type: row.type,
                });
            }
        }
    }

    return pairs;
}

async function runAssign(date: string, options: TasksOptions): Promise<void> {
    const view = await buildAssignmentView(date);
    const pairs = collectPairs(view, options);

    if (pairs.length === 0) {
        out.println("Nothing to assign.");
        return;
    }

    const config = await requireConfig();
    config.mappings = applyAssignments({ mappings: config.mappings, pairs });
    await saveConfig(config);

    if (options.format === "json") {
        out.result(
            pairs.map((pair) => ({
                workItemId: pair.workItemId,
                clarityTaskId: pair.task.taskId,
                clarityTaskName: pair.task.taskName,
            }))
        );
        return;
    }

    for (const pair of pairs) {
        out.println(`${pc.green("✔")} #${pair.workItemId} → ${pair.task.taskName}`);
    }

    out.println(pc.dim(`  ${pairs.length} mapping(s) saved`));
}

async function runUnlink(options: TasksOptions): Promise<void> {
    const config = await requireConfig();
    const workItemIds = (options.unlink ?? []).map((raw) => {
        const id = Number(raw);

        if (!Number.isInteger(id) || raw.trim() === "") {
            out.error(`Invalid --unlink id '${raw}': expected a work item id`);
            process.exit(1);
        }

        return id;
    });
    const { mappings, removed } = removeAssignments({ mappings: config.mappings, workItemIds });

    if (removed.length === 0) {
        out.println("No mappings match those work item ids.");
        return;
    }

    if (options.format !== "json") {
        for (const mapping of removed) {
            out.println(`  #${mapping.adoWorkItemId} → ${mapping.clarityTaskName}`);
        }
    }

    if (!options.yes) {
        if (!isInteractive()) {
            out.error("Refusing to remove mappings without --yes in a non-interactive shell");
            process.exit(1);
        }

        const confirmed = await p.confirm({ message: `Remove ${removed.length} mapping(s)?` });

        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel("Cancelled");
            return;
        }
    }

    config.mappings = mappings;
    await saveConfig(config);

    if (options.format === "json") {
        out.result(
            removed.map((m) => ({
                workItemId: m.adoWorkItemId,
                clarityTaskId: m.clarityTaskId,
                clarityTaskName: m.clarityTaskName,
            }))
        );
        return;
    }

    out.println(`${pc.green("✔")} removed ${removed.length} mapping(s)`);
}
