import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { WorkerBackend } from "./capabilities";

/** What every backend knows about a finished turn; the printer needs nothing else. */
export interface WorkerTurnReport {
    backend: WorkerBackend;
    name: string;
    turn: number;
    /** A clean terminal event was seen (grok `end`, claude `result`). */
    ended: boolean;
    exitCode: number | null;
    /** The worker's final message, printed verbatim on stdout. */
    report: string;
    stderr: string;
    errPath?: string;
    toolCalls: ReadonlyArray<{ tool: string }>;
    /** Absent when the turn was read-only, replayed, or the cwd is not a git repo. */
    worktree?: { cwd: string; changedThisTurn: number; dirtyTotal: number } | null;
    logPath: string;
    /** The command that renders the transcript, e.g. `tools grok read --name x --format compact`. */
    transcriptHint: string;
}

const STDERR_CHARS = 600;
const TOP_TOOLS = 6;

/** `65 tool calls (read_file 44, grep 12, run_terminal_command 5, +2 more)` */
export function summarizeToolCalls(calls: ReadonlyArray<{ tool: string }>): string {
    if (calls.length === 0) {
        return "no tool calls";
    }

    const counts = new Map<string, number>();
    for (const call of calls) {
        counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = ranked.slice(0, TOP_TOOLS).map(([tool, count]) => `${tool} ${count}`);
    const rest = ranked.length - shown.length;
    return `${calls.length} tool call${calls.length === 1 ? "" : "s"} (${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""})`;
}

/** The `RESULT: …` line of a worker report that follows the shared contract, if any. */
export function resultLineOf(report: string): string | null {
    for (const line of report.split("\n")) {
        const trimmed = line.trim();
        if (/^RESULT:/i.test(trimmed)) {
            return trimmed;
        }
    }

    return null;
}

export interface FormattedWorkerTurn {
    /** Status lines for stderr, in order; each tagged with how to print it. */
    status: Array<{ level: "ok" | "info" | "warn" | "err" | "dim"; text: string }>;
    /** The report body for stdout, or "" when the worker said nothing. */
    body: string;
    exitCode: number;
}

export function formatWorkerTurn(report: WorkerTurnReport): FormattedWorkerTurn {
    const status: FormattedWorkerTurn["status"] = [];
    const outcome = report.ended ? "completed" : `DIED (no end event, exit ${report.exitCode ?? "?"})`;
    const result = resultLineOf(report.report);
    status.push({
        level: report.ended ? "ok" : "err",
        text:
            `${report.backend} ${report.name} · turn ${report.turn} · ${outcome} · ${summarizeToolCalls(report.toolCalls)}` +
            (result ? ` · ${result}` : ""),
    });

    const stderr = report.stderr.trim();
    if (stderr) {
        const clipped =
            stderr.length > STDERR_CHARS
                ? `${stderr.slice(0, STDERR_CHARS)}… (${stderr.length - STDERR_CHARS} more chars${report.errPath ? ` in ${report.errPath}` : ""})`
                : stderr;
        status.push({ level: report.ended ? "warn" : "err", text: `stderr: ${clipped}` });
    }

    // "The turn ended" is not "the task got done": a worker that stops cleanly
    // having written nothing prints the same success line as one that finished.
    if (report.worktree) {
        if (report.worktree.changedThisTurn === 0) {
            status.push({
                level: "warn",
                text: `turn ${report.turn} changed NOTHING in ${report.worktree.cwd} — the turn ended, but the task may be unfinished. Check, then steer to continue.`,
            });
        } else {
            status.push({
                level: "info",
                text: `turn ${report.turn} changed ${report.worktree.changedThisTurn} path(s); ${report.worktree.dirtyTotal} dirty in total`,
            });
        }
    }

    status.push({ level: "dim", text: `transcript: ${report.transcriptHint}` });
    if (report.ended) {
        status.push({
            level: "ok",
            text: `turn ${report.turn} completed — verify yourself before trusting this report (log: ${report.logPath})`,
        });
    }

    return { status, body: report.report.trim(), exitCode: report.ended ? 0 : 1 };
}

/**
 * The one finished-turn printer for grok and claude workers (codex prints
 * JSON snapshots from its control channel). Status goes to stderr through `ui`,
 * the report body to stdout through `out.print`, so `tools grok run … > report.md`
 * captures exactly what the worker said. Tool calls are counted, never listed:
 * the transcript door is one command away.
 */
export function printWorkerTurn(report: WorkerTurnReport): void {
    const formatted = formatWorkerTurn(report);
    const [header, ...rest] = formatted.status;
    if (header) {
        ui[header.level](header.text);
    }

    if (formatted.body) {
        out.print(`${formatted.body}\n`);
    }

    for (const line of rest) {
        ui[line.level](line.text);
    }

    if (formatted.exitCode !== 0) {
        process.exitCode = formatted.exitCode;
    }
}
