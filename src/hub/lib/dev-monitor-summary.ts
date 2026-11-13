import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFailures } from "@genesiscz/utils/cli/failures/record";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDate } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type devMonitorSources, isCrashReportName, isHangCaptureName, readMonitorState } from "./dev-monitor";

const log = logger.child({ component: "hub:dev-monitor" });

/** The window a first run covers: no monitor ever ran, so it looks back one day. */
export const FIRST_RUN_WINDOW_MS = 24 * 3_600_000;

/** The failure kinds that count as a failed tool run in the summary (a usage error is a refused command line). */
const FAILED_RUN_KINDS: ReadonlySet<string> = new Set(["error", "crash", "exit"]);

export interface DevSummaryCounts {
    deadlines: number;
    failedRuns: number;
    hangs: number;
    crashes: number;
}

/** What happened while no monitor ran: a count per kind, and for each non-zero count what lists the items. */
export interface DevSummary {
    kind: "summary";
    since: string;
    until: string;
    counts: DevSummaryCounts;
    commands: Partial<Record<keyof DevSummaryCounts, string>>;
}

type SummarySources = Pick<ReturnType<typeof devMonitorSources>, "failuresDir" | "hangs" | "genesisHangs" | "crashes">;

/** Every local calendar day from `since` to `until`, oldest first: the day files and file names the window touches. */
function daysBetween(since: Date, until: Date): string[] {
    const days: string[] = [];
    const cursor = new Date(since);
    cursor.setHours(12, 0, 0, 0);

    while (formatLocalDate(cursor) <= formatLocalDate(until)) {
        days.push(formatLocalDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }

    return days;
}

/**
 * The files of a folder that pass `accept`, carry a day of the window in their name (`hang-2026-11-10-…`,
 * `GenesisTools-2026-11-10-….ips`), and were written inside it. Only those names are stat'ed.
 */
function filesInWindow(dir: string, accept: (name: string) => boolean, since: Date, until: Date): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    const days = daysBetween(since, until);
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (error) {
        log.debug({ dir, error }, "dev monitor: folder not readable for the summary");
        return [];
    }

    return names
        .filter((name) => accept(name) && days.some((day) => name.includes(day)))
        .filter((name) => {
            try {
                const written = statSync(join(dir, name)).mtimeMs;
                return written >= since.getTime() && written <= until.getTime();
            } catch (error) {
                log.debug({ dir, name, error }, "dev monitor: a file went away before the summary read it");
                return false;
            }
        });
}

/** `2026-11-10T21:05`: a local time `--since` reads (`parseSince`). */
function sinceArgument(at: Date): string {
    return `${formatLocalDate(at)}T${at.toTimeString().slice(0, 5)}`;
}

/** Counts what happened from `since` to `until`, reading only the day files and names of that window. */
export function summarizeWindow({
    since,
    until,
    sources,
}: {
    since: Date;
    until: Date;
    sources: SummarySources;
}): DevSummary {
    const counts: DevSummaryCounts = { deadlines: 0, failedRuns: 0, hangs: 0, crashes: 0 };

    for (const failure of readFailures({
        fromDay: formatLocalDate(since),
        toDay: formatLocalDate(until),
        dir: sources.failuresDir,
    })) {
        const at = Date.parse(failure.at);

        if (at < since.getTime() || at > until.getTime()) {
            continue;
        }

        if (failure.kind === "deadline") {
            counts.deadlines++;
        } else if (FAILED_RUN_KINDS.has(failure.kind)) {
            counts.failedRuns++;
        }
    }

    const hangsPerFolder = [sources.hangs, sources.genesisHangs].map(
        (dir) => [dir, filesInWindow(dir, isHangCaptureName, since, until).length] as const
    );
    const hangFolders = hangsPerFolder.filter(([, count]) => count > 0).map(([dir]) => dir);
    counts.hangs = hangsPerFolder.reduce((sum, [, count]) => sum + count, 0);
    counts.crashes = filesInWindow(sources.crashes, isCrashReportName, since, until).length;

    const from = sinceArgument(since);
    const commands: DevSummary["commands"] = {};

    if (counts.deadlines > 0) {
        commands.deadlines = toolCommand("genesis-tools logs failures", "--kind", "deadline", "--since", from);
    }

    if (counts.failedRuns > 0) {
        commands.failedRuns = toolCommand(
            "genesis-tools logs failures",
            "--kind",
            "error",
            "crash",
            "exit",
            "--since",
            from
        );
    }

    if (counts.hangs > 0) {
        commands.hangs = hangFolders.join(", ");
    }

    if (counts.crashes > 0) {
        commands.crashes = toolCommand("genesis-tools logs crashes", "--since", from);
    }

    return { kind: "summary", since: since.toISOString(), until: until.toISOString(), counts, commands };
}

const COUNT_KEYS = [
    "deadlines",
    "failedRuns",
    "hangs",
    "crashes",
] as const satisfies readonly (keyof DevSummaryCounts)[];

const LABELS: Record<keyof DevSummaryCounts, [one: string, many: string]> = {
    deadlines: ["command deadline", "command deadlines"],
    failedRuns: ["failed tool run", "failed tool runs"],
    hangs: ["hang capture", "hang captures"],
    crashes: ["crash report", "crash reports"],
};

/** The text form: one line per non-zero count with its command under it, or one line that says nothing happened. */
export function formatSummary(summary: DevSummary): string {
    const since = new Date(summary.since);
    const head = `[${new Date(summary.until).toTimeString().slice(0, 8)}] summary since ${formatLocalDate(since)} ${since.toTimeString().slice(0, 5)}, while no monitor ran`;
    const lines: string[] = [];

    for (const key of COUNT_KEYS) {
        const count = summary.counts[key];

        if (count === 0) {
            continue;
        }

        lines.push(`  ${count} ${LABELS[key][count === 1 ? 0 : 1]}`, `    ${summary.commands[key] ?? ""}`);
    }

    return lines.length === 0
        ? `${head}: no command deadlines, failed runs, hangs or crashes`
        : [`${head}:`, ...lines].join("\n");
}

/**
 * What the monitor prints before its first event: the start line with the files it reads, then (unless `summary` is
 * false, `--no-summary`) the summary of the window since the last monitor run, or the last day on a first run.
 */
export function monitorPreamble({
    sources,
    json,
    summary,
    now,
}: {
    sources: ReturnType<typeof devMonitorSources>;
    json: boolean;
    summary: boolean;
    now: Date;
}): string {
    const start = `[${now.toTimeString().slice(0, 8)}] monitor watching ${sources.perfLog}, ${sources.genesisPerfLog}, ${sources.profileLog()}, ${sources.relayLog}, ${sources.failuresLog()}, ${sources.hangs}, ${sources.crashes}`;
    const lines = [json ? SafeJSON.stringify({ kind: "start", text: start }) : start];

    if (summary) {
        const last = readMonitorState(sources.state);
        const since = last ? new Date(last.lastRunAt) : new Date(now.getTime() - FIRST_RUN_WINDOW_MS);
        const counted = summarizeWindow({ since, until: now, sources });
        lines.push(json ? SafeJSON.stringify(counted) : formatSummary(counted));
    }

    return `${lines.join("\n")}\n`;
}
