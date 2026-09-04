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
 * What `tasks --add` / `--add-from` / `--remove` did across every week in scope. The undo works on
 * the same `--date`, so one command reverses every week the run touched.
 */
export function rowWriteReceipt({ outcomes, date }: { outcomes: RowWriteOutcome[]; date: string }): Receipt {
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
        return { summary, undo: ["tasks", "--date", date, "--remove", ...added.map(String)] };
    }

    if (removed.length > 0) {
        return { summary, undo: ["tasks", "--date", date, "--add", ...removed.map(String)] };
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
}: {
    created: AssignedMapping[];
    replaced: ReplacedMapping[];
}): Receipt {
    const summary: string[] = [];

    if (created.length > 0) {
        summary.push(`${plural(created.length, "mapping")} created`);
    }

    if (replaced.length > 0) {
        summary.push(`${plural(replaced.length, "mapping")} replaced`);
    }

    if (summary.length === 0) {
        return { summary: [] };
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
