import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallerCore } from "@genesiscz/utils/agent/context";
import type { RecordedCallerFacts } from "@genesiscz/utils/agent/identity/record-facts";
import { formatLocalDate } from "@genesiscz/utils/date";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { dayLogName, dayLogPath, listDayLogs } from "@genesiscz/utils/logger/day-logs";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * - `usage`: commander refused the command line (unknown option, missing argument).
 * - `error`: the tool's action threw and runTool printed `ERROR: …`.
 * - `crash`: an uncaught exception or an unhandled rejection; `fatal` says whether it ended the process.
 * - `exit`: a non-zero exit with none of the above (the tool printed its own message and exited 1).
 * - `interrupt`: Ctrl-C or SIGTERM (130 / 143); often a harness timeout rather than a bug. The `tools` wrapper also
 *   writes it for a spawned tool a signal killed (launcher.ts), and `crash` for one that died of a fault signal.
 * - `deadline`: a command the tool ran through `Executor` outlived its bound and was killed (deadline.ts). It is not
 *   the end of the run (`fatal: false`): the tool may catch the error and go on. `child` names the command.
 */
export const FAILURE_KINDS = ["usage", "error", "crash", "exit", "interrupt", "deadline"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * Who ran the tool. Model and effort come from the agent's own transcript and env, never guessed. The identity facts
 * (`RecordedCallerFacts`: transcript, tool call, subagent, turn, account, T3 Code host) are optional and absent in
 * records written before 2026-11-05; `isToolFailure` never checks the caller's keys, so both shapes read.
 */
export interface FailureCaller extends CallerCore, RecordedCallerFacts {
    sessionTitle: string | null;
    model: string | null;
    effort: string | null;
    /** `AI_AGENT` as the harness sets it, e.g. `claude-code_2-1-296_agent`. */
    aiAgent: string | null;
    project: string;
    repoRoot: string;
    /** The session's cwd (the live one an agent moved to); absent in records written before 2026-11-04. */
    cwd?: string;
    branch: string | null;
    commitSha: string | null;
    worktreePath: string | null;
}

export interface ToolFailure {
    v: 1;
    id: string;
    at: string;
    kind: FailureKind;
    tool: string;
    /** The command path, `ai usage sessions`: names only, never argument values. */
    command: string | null;
    /** The arguments after the tool name, secrets masked. */
    argv: string[];
    exitCode: number | null;
    message: string | null;
    errorName: string | null;
    stack: string | null;
    /** The last stderr the process wrote, ANSI stripped and secrets masked. */
    stderrTail: string | null;
    fatal: boolean;
    durationMs: number;
    pid: number;
    ppid: number;
    cwd: string;
    /** Set when GenesisTools.app started the command. */
    traceId: string | null;
    /** The GenesisTools checkout that ran the tool: the main one or a worktree. */
    toolsRoot: string;
    caller: FailureCaller | null;
    /** The `tools` wrapper's id for a run it spawned (run-id.ts); absent when the wrapper exec'd into the tool. */
    runId?: string;
}

/** The child command a `deadline` record is about. */
export interface DeadlineChild {
    /** Its argv, credentials hidden. */
    command: string[];
    cwd: string;
    timeoutMs: number;
    /** True when the call and its Executor named no bound and the default applied. */
    defaulted: boolean;
    /** The reason the call or its Executor gave with the bound; null for a bare number or the default. */
    reason: string | null;
}

/**
 * What executor.ts hands deadline.ts on an expiry. Declared here, beside the record, because executor.ts must not name
 * deadline.ts at all: that module is loaded only in the expiry branch.
 */
export interface DeadlineExpiry {
    child: DeadlineChild;
    /** The sentence the call throws. */
    message: string;
    /** How long the child ran before it was killed. */
    durationMs: number;
    /** The stack of the `exec` call, taken before the spawn, so it names the call site and not the timer. */
    stack: string | null;
}

/**
 * The fields only some kinds write. They are declared apart from the interface above on purpose: the app launcher
 * writes every field of that block (LauncherFailures.swift, pinned by LauncherFailuresTests), and it never writes a
 * `deadline` record.
 */
export interface ToolFailure {
    /** Only on a `deadline` record. */
    child?: DeadlineChild;
}

export function failuresDir(): string {
    return genesisToolsDir("logs");
}

/**
 * The plain day file a failure of `day` is appended to. Once the daily pass compressed a day it is
 * `<day>-failures.jsonl.zst`: read through {@link readFailures}, which finds either form.
 */
export function failureLogPath(day: string, dir = failuresDir()): string {
    return join(dir, dayLogName(day, "failures"));
}

/** One line per failure, appended with a single write so concurrent tools never interleave a record. */
export function appendFailure(failure: ToolFailure, dir = failuresDir()): void {
    const path = failureLogPath(formatLocalDate(new Date(failure.at)), dir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${SafeJSON.stringify(failure)}\n`);
}

/** The days that have a failure log, plain or compressed, oldest first. */
export function failureDays(dir = failuresDir()): string[] {
    return listDayLogs({ kind: "failures", dir })
        .map((file) => file.day)
        .reverse();
}

export function isToolFailure(value: unknown): value is ToolFailure {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;
    return (
        record.v === 1 &&
        typeof record.tool === "string" &&
        typeof record.at === "string" &&
        FAILURE_KINDS.includes(record.kind as FailureKind)
    );
}

/** Every failure recorded on `fromDay` through `toDay` (inclusive, `YYYY-MM-DD`), oldest first. */
export function* readFailures({
    fromDay,
    toDay,
    dir = failuresDir(),
}: {
    fromDay: string;
    toDay: string;
    dir?: string;
}): Generator<ToolFailure> {
    for (const day of failureDays(dir)) {
        if (day < fromDay || day > toDay) {
            continue;
        }

        // Resolved just before the read: the daily pass may have replaced the plain file since the listing.
        const path = dayLogPath(day, { kind: "failures", dir });

        if (!path) {
            continue;
        }

        for (const line of readLinesSync(path)) {
            if (!line.trim()) {
                continue;
            }

            let parsed: unknown;
            try {
                parsed = SafeJSON.parse(line, { strict: true });
            } catch (error) {
                // A line cut by a full disk or a killed writer; the rest of the day still reads.
                logger.debug({ error, day }, "failures: skipped an unreadable line");
                continue;
            }

            if (isToolFailure(parsed)) {
                yield parsed;
            }
        }
    }
}
