import { relative } from "node:path";
import { formatLocalDate } from "@genesiscz/utils/date";
import { formatBytes } from "@genesiscz/utils/format";
import { isInside, ledgerAgent, type RmLedgerEntry } from "@genesiscz/utils/rm";
import pc from "picocolors";
import { displayContext, middleCut, shortRmPath } from "./display";

export interface LogViewOptions {
    cwd: string;
    /** One row per entry instead of one per run of entries that share action, batch and caller. */
    each?: boolean;
}

const PATH_MAX = 56;

/** Who an entry names, as its group header shows it; a person is `person`, never the operating-system account. */
function callerHeader(entry: RmLedgerEntry): string {
    const caller = entry.caller;
    // A person checked it from a shell an agent's session started (`! tools rm approve`): name both.
    const startedFrom = caller?.isInAgent
        ? [caller.agent, caller.sessionId?.slice(0, 8)].filter(Boolean).join(" ")
        : "";

    if (entry.person) {
        return `person via ${entry.person.via}${startedFrom ? ` (started from ${startedFrom})` : ""}`;
    }

    if (!caller?.isInAgent) {
        return `person${entry.via ? ` via ${entry.via}` : ""}`;
    }

    return [
        ledgerAgent(entry),
        caller.sessionId?.slice(0, 8),
        caller.sessionTitle ? `"${middleCut(caller.sessionTitle, 30)}"` : undefined,
        caller.model ?? undefined,
        caller.branch ? `on ${caller.branch}` : undefined,
        entry.via ? `via ${entry.via}` : undefined,
    ]
        .filter(Boolean)
        .join(" ");
}

function callerKey(entry: RmLedgerEntry): string {
    return `${callerHeader(entry)}|${entry.caller?.sessionId ?? ""}`;
}

function sameRun(a: RmLedgerEntry, b: RmLedgerEntry): boolean {
    return (
        a.action === b.action &&
        a.batchId === b.batchId &&
        a.requestId === b.requestId &&
        callerKey(a) === callerKey(b) &&
        formatLocalDate(new Date(a.at)) === formatLocalDate(new Date(b.at))
    );
}

function clock(at: string): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function pathCell(entry: RmLedgerEntry, cwd: string): string {
    if (!entry.path) {
        return entry.requestId ? `request ${entry.requestId}` : "";
    }

    return isInside(entry.path, cwd)
        ? middleCut(relative(cwd, entry.path) || ".", PATH_MAX)
        : shortRmPath(entry.path, displayContext(entry.caller ?? null), PATH_MAX);
}

function runRow(run: RmLedgerEntry[], cwd: string): string {
    const first = run[0];
    const sized = run.filter((entry) => entry.bytes !== undefined);
    const bytes = sized.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    const size = sized.length > 0 ? ` ${formatBytes(bytes)}` : "";
    const action = pc.bold(first.action.padEnd(8));

    if (run.length === 1) {
        const rule = first.rule ? pc.dim(` ${first.rule}`) : "";
        return `  ${pc.dim(clock(first.at))} ${action}${size} ${pathCell(first, cwd)}${rule}`;
    }

    const where = first.batchId
        ? `batch …${first.batchId.slice(-4)}`
        : first.requestId
          ? `request ${first.requestId}`
          : "";
    return `  ${pc.dim(clock(first.at))} ${action} ${run.length} items${size}${where ? ` ${pc.dim(where)}` : ""}`;
}

/**
 * The entry view of `tools rm log`: a day line when the day changes, the caller once as a header when it changes,
 * and one row per run of entries that share action, batch and caller (`15:27 drain 13 items 4.9 MB batch …fc7b`).
 */
export function renderLedger(entries: readonly RmLedgerEntry[], options: LogViewOptions): string[] {
    const runs: RmLedgerEntry[][] = [];

    for (const entry of entries) {
        const run = runs.at(-1);

        if (run && !options.each && sameRun(run[0], entry)) {
            run.push(entry);
        } else {
            runs.push([entry]);
        }
    }

    const lines: string[] = [];
    let day = "";
    let caller = "";

    for (const run of runs) {
        const first = run[0];
        const runDay = formatLocalDate(new Date(first.at));

        if (runDay !== day) {
            lines.push(pc.dim(`── ${runDay}`));
            day = runDay;
            caller = "";
        }

        if (callerKey(first) !== caller) {
            lines.push(callerHeader(first));
            caller = callerKey(first);
        }

        lines.push(runRow(run, options.cwd));
    }

    return lines;
}
