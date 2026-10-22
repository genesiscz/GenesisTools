import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { formatLocalDate } from "@genesiscz/utils/date";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * - `usage`: commander refused the command line (unknown option, missing argument).
 * - `error`: the tool's action threw and runTool printed `ERROR: …`.
 * - `crash`: an uncaught exception or an unhandled rejection; `fatal` says whether it ended the process.
 * - `exit`: a non-zero exit with none of the above (the tool printed its own message and exited 1).
 * - `interrupt`: Ctrl-C or SIGTERM (130 / 143); often a harness timeout rather than a bug. The `tools` wrapper also
 *   writes it for a spawned tool a signal killed (launcher.ts), and `crash` for one that died of a fault signal.
 */
export const FAILURE_KINDS = ["usage", "error", "crash", "exit", "interrupt"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Who ran the tool. Model and effort come from the agent's own transcript and env, never guessed. */
export interface FailureCaller {
    agent: AgentRuntimeContext["agent"];
    sessionId: string | null;
    sessionTitle: string | null;
    model: string | null;
    effort: string | null;
    /** `AI_AGENT` as the harness sets it, e.g. `claude-code_2-1-296_agent`. */
    aiAgent: string | null;
    project: string;
    repoRoot: string;
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

const FILE = /^(\d{4}-\d{2}-\d{2})-failures\.jsonl$/;

export function failuresDir(): string {
    return genesisToolsDir("logs");
}

export function failureLogPath(day: string, dir = failuresDir()): string {
    return join(dir, `${day}-failures.jsonl`);
}

/** One line per failure, appended with a single write so concurrent tools never interleave a record. */
export function appendFailure(failure: ToolFailure, dir = failuresDir()): void {
    const path = failureLogPath(formatLocalDate(new Date(failure.at)), dir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${SafeJSON.stringify(failure)}\n`);
}

/** The days that have a failure log, oldest first. */
export function failureDays(dir = failuresDir()): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .flatMap((name) => FILE.exec(name)?.[1] ?? [])
        .sort();
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

        for (const line of readLinesSync(failureLogPath(day, dir))) {
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
