import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { withMeetingsClient } from "../lib/service/client";
import type { ThresholdResult } from "../lib/threshold-schema";
import { readOrSetThresholds } from "../lib/thresholds";
import { windowJson } from "../lib/window-reads";

interface Options {
    set?: string[];
    preview?: boolean;
    json?: boolean;
}

function parseAssignments(assignments: string[] = []) {
    const values: Record<string, number> = Object.create(null);
    for (const assignment of assignments) {
        const match = /^([^=]+)=(.+)$/.exec(assignment);
        if (!match || !match[2]!.trim()) {
            throw new Error(`Expected --set name=value, got "${assignment}"`);
        }
        const name = match[1]!;
        if (Object.hasOwn(values, name)) {
            throw new Error(`Threshold "${name}" was given twice`);
        }
        values[name] = Number(match[2]);
    }
    return values;
}

function printResult(result: ThresholdResult, opts: Options) {
    if (opts.json) {
        out.result(windowJson(result));
        return;
    }
    const table = createBoxTable(["THRESHOLD", "EFFECTIVE", "GLOBAL", "DEFAULT", "SOURCE"]);
    for (const row of result.thresholds) {
        table.push([row.name, row.value, row.globalValue, row.defaultValue, row.source]);
    }
    out.println(table.toString());
    for (const warning of result.warnings) {
        out.println(warning);
    }
    if (opts.preview) {
        out.println(
            result.changes.length
                ? result.counts
                      .map((count) => `${count.kind}: +${count.added}, −${count.removed}, ${count.changed} changed`)
                      .join("\n")
                : "No changes."
        );
    }
    for (const row of result.changes) {
        const state = (item: typeof row.before) =>
            item
                ? `${item.description} [${item.status}${item.confidence === undefined ? "" : `, ${item.confidence}`}]`
                : "—";
        out.println(
            `${row.atSec === undefined ? "Untimed" : formatClock(row.atSec)}  ${row.change} ${row.kind}: ${row.text}\n  ${state(row.before)} → ${state(row.after)}\n  ${row.reason}`
        );
    }
}

export function registerThresholdsCommand(program: Command, connect = withMeetingsClient): void {
    program
        .command("thresholds [meeting]")
        .description("Show automatic suggestion thresholds, preview a change on this meeting, or save it globally")
        .option("--set <name=value...>", "one or more global thresholds to change")
        .option("--preview", "compare the draft with the saved settings without writing")
        .option("--json", "print the thresholds and item differences as JSON")
        .action(async (meeting: string | undefined, opts: Options) => {
            const set = parseAssignments(opts.set);
            printResult(
                await connect((client) => readOrSetThresholds({ client, meeting, set, preview: opts.preview })),
                opts
            );
        });
}
