import type { ClarityMapping } from "@app/clarity/config";
import type { AddRowsResult, DesiredTask, RemoveRowsResult } from "@app/clarity/lib/timesheet-rows";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export interface Receipt {
    /** Counted outcomes, most important first. Empty when the command changed nothing. */
    summary: string[];
    /** argv words for `suggestCommand({ replaceCommand })` that reverses the change. */
    undo?: string[];
    /** Several commands that together reverse the change; each one must run. */
    undoEach?: string[][];
}

/** Render a receipt: the counted summary, then the exact command that reverses it. */
export function renderReceipt(receipt: Receipt, toolName = "tools clarity"): void {
    if (receipt.summary.length === 0) {
        out.println(pc.dim("  Nothing changed."));
        return;
    }

    out.println(pc.bold(`\n  ${receipt.summary.join(" · ")}`));

    if (receipt.undo) {
        out.println(pc.dim(`  Undo: ${suggestCommand(toolName, { replaceCommand: receipt.undo })}`));
    }

    if (receipt.undoEach) {
        out.println(pc.dim("  Undo, run every line:"));

        for (const argv of receipt.undoEach) {
            out.println(pc.dim(`    ${suggestCommand(toolName, { replaceCommand: argv })}`));
        }
    }
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface RowWriteOutcome {
    timesheetId?: number;
    added?: DesiredTask[];
    skipped?: DesiredTask[];
    removed?: DesiredTask[];
    blocked?: RemoveRowsResult["blocked"];
    missing?: number[];
    failed?: AddRowsResult["failed"] | RemoveRowsResult["failed"];
    unopened?: boolean;
}

function uniqueTaskIds(outcomes: RowWriteOutcome[], pick: (outcome: RowWriteOutcome) => DesiredTask[]) {
    return [...new Set(outcomes.flatMap((outcome) => pick(outcome).map((task) => task.taskId)))];
}

/**
 * The reversing command(s) for one direction of a row write. One `--date` command is exact only
 * when every opened week changed exactly the same task set; otherwise a week that already had a
 * task (or never had it) would be touched by the undo, so each changed week gets its own
 * `--timesheet` command.
 *
 * `date` is absent when `--timesheet` chose the week. A `--date` undo would then resolve the
 * weeks of that date (today by default), not the week that was written, so every undo names
 * its timesheet.
 */
function rowUndo(
    outcomes: RowWriteOutcome[],
    date: string | undefined,
    pick: (outcome: RowWriteOutcome) => DesiredTask[],
    flag: "--remove" | "--add"
): Pick<Receipt, "undo" | "undoEach"> {
    const ids = uniqueTaskIds(outcomes, pick);

    if (ids.length === 0) {
        return {};
    }

    const key = (outcome: RowWriteOutcome) => [...new Set(pick(outcome).map((t) => t.taskId))].sort().join(",");
    const wanted = [...ids].sort().join(",");
    const opened = outcomes.filter((o) => !o.unopened);

    if (date !== undefined && opened.every((o) => key(o) === wanted)) {
        return { undo: ["tasks", "--date", date, flag, ...ids.map(String)] };
    }

    const changed = opened.filter((o) => pick(o).length > 0);

    if (date !== undefined && changed.some((o) => o.timesheetId === undefined)) {
        return { undo: ["tasks", "--date", date, flag, ...ids.map(String)] };
    }

    return {
        undoEach: changed.map((o) => [
            "tasks",
            "--timesheet",
            String(o.timesheetId),
            flag,
            ...[...new Set(pick(o).map((t) => t.taskId))].map(String),
        ]),
    };
}

/**
 * What `tasks --add` / `--add-from` / `--remove` did across every week in scope, and the exact
 * reverse: it touches only the weeks and rows this run changed.
 */
export function rowWriteReceipt({ outcomes, date }: { outcomes: RowWriteOutcome[]; date?: string }): Receipt {
    const added = uniqueTaskIds(outcomes, (o) => o.added ?? []);
    const removed = uniqueTaskIds(outcomes, (o) => o.removed ?? []);
    const counts: Array<[number, string]> = [
        [outcomes.flatMap((o) => o.added ?? []).length, "row%s added"],
        [outcomes.flatMap((o) => o.removed ?? []).length, "row%s removed"],
        [outcomes.flatMap((o) => o.skipped ?? []).length, "row%s already there"],
        [outcomes.flatMap((o) => o.blocked ?? []).length, "row%s kept because it carries hours"],
        [outcomes.flatMap((o) => o.missing ?? []).length, "row%s not on the week"],
        [outcomes.flatMap((o) => o.failed ?? []).length, "row%s failed"],
        [outcomes.filter((o) => o.unopened).length, "week%s not opened yet"],
    ];

    const summary = counts
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label.replace("%s", count === 1 ? "" : "s")}`);

    if (added.length > 0) {
        return { summary, ...rowUndo(outcomes, date, (o) => o.added ?? [], "--remove") };
    }

    if (removed.length > 0) {
        return { summary, ...rowUndo(outcomes, date, (o) => o.removed ?? [], "--add") };
    }

    return { summary };
}

export interface AssignedMapping {
    workItemId: number;
    clarityTaskId: number;
}

export interface ReplacedMapping extends AssignedMapping {
    previousClarityTaskId: number;
}

/**
 * What `mappings --assign` did. A created mapping is undone by unlinking it; a replaced one by
 * restoring the task it billed before, because unlinking it would drop a mapping the run did not
 * create.
 */
export function assignReceipt({
    created,
    replaced,
    refreshed = [],
}: {
    created: AssignedMapping[];
    replaced: ReplacedMapping[];
    /** Re-assigned to the task they already had: only the stored title changed, nothing to undo. */
    refreshed?: AssignedMapping[];
}): Receipt {
    const summary: string[] = [];

    if (created.length > 0) {
        summary.push(`${plural(created.length, "mapping")} created`);
    }

    if (replaced.length > 0) {
        summary.push(`${plural(replaced.length, "mapping")} replaced`);
    }

    if (refreshed.length > 0) {
        summary.push(`${plural(refreshed.length, "mapping")} refreshed`);
    }

    if (created.length === 0 && replaced.length === 0) {
        return { summary };
    }

    const undo = ["mappings"];

    if (replaced.length > 0) {
        undo.push("--assign", ...replaced.map((m) => `${m.workItemId}:${m.previousClarityTaskId}`));
    }

    if (created.length > 0) {
        undo.push("--unlink", ...created.map((m) => String(m.workItemId)));
    }

    return { summary, undo };
}

/** What `mappings --unlink` did, and the exact `--assign` pairs that put it back. */
export function unlinkReceipt(removed: ClarityMapping[]): Receipt {
    if (removed.length === 0) {
        return { summary: [] };
    }

    return {
        summary: [`${plural(removed.length, "mapping")} removed`],
        undo: ["mappings", "--assign", ...removed.map((m) => `${m.adoWorkItemId}:${m.clarityTaskId}`)],
    };
}
