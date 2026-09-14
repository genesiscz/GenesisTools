import { statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import { type OpenFilesQuery, type OpenFilesResult, openFiles } from "@genesiscz/utils/process/open-files";
import pc from "picocolors";

const { log } = logger.scoped("codex-active-writer");

/** Codex allows one writer per thread. The refusal text is the only signal the protocol gives. */
export function isActiveWriterError(error: unknown): boolean {
    return error instanceof Error && /already has an active writer/i.test(error.message);
}

export function threadLockPath(home: string, threadId: string): string {
    return join(home, "thread-writer-locks", `${threadId}.lock`);
}

export interface ActiveWriterHolder {
    pid: number;
    command: string;
    cwd?: string;
    startedAt?: string;
}

export interface ActiveWriterReport {
    threadId: string;
    lockPath: string;
    /**
     * `undefined` means the question could not be answered (no `lsof`), which is NOT the same as
     * an empty list. An empty list means the lock is genuinely free and the refusal was stale.
     */
    holders?: ActiveWriterHolder[];
    /** Last write to the thread's transcript. */
    lastActivity?: Date;
}

function startedAt(pid: number): string | undefined {
    try {
        const child = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
        const text = new TextDecoder().decode(child.stdout).trim();

        return text.length > 0 ? text : undefined;
    } catch (err) {
        log.debug({ pid, error: err }, "could not read the holder's start time");
        return undefined;
    }
}

export function inspectActiveWriter(input: {
    home: string;
    threadId: string;
    rolloutPath?: string;
    /** Injected by tests so a fixture can pretend a process holds the lock, or is unanswerable. */
    inspectOpenFiles?: (query: OpenFilesQuery) => OpenFilesResult;
    describeProcess?: (pid: number) => { cwd?: string; startedAt?: string };
}): ActiveWriterReport {
    const lockPath = threadLockPath(input.home, input.threadId);
    const inspect = input.inspectOpenFiles ?? openFiles;
    const describe =
        input.describeProcess ??
        ((pid: number) => ({ cwd: readProcessCwd(pid) ?? undefined, startedAt: startedAt(pid) }));
    const result = inspect({ files: [lockPath] });
    const report: ActiveWriterReport = { threadId: input.threadId, lockPath };

    if (result !== "unknown") {
        report.holders = result.map((handle) => ({
            pid: handle.pid,
            command: handle.command,
            ...describe(handle.pid),
        }));
    }

    if (input.rolloutPath) {
        try {
            report.lastActivity = statSync(input.rolloutPath).mtime;
        } catch (err) {
            log.debug({ path: input.rolloutPath, error: err }, "could not stat the thread transcript");
        }
    }

    return report;
}

function holderLine(holder: ActiveWriterHolder): string {
    const details = [
        holder.startedAt ? `started ${holder.startedAt}` : undefined,
        holder.cwd ? `cwd ${holder.cwd}` : undefined,
    ].filter(Boolean);

    return `    ${holder.command} (pid ${holder.pid})${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

/** Human lines, printed once the native TUI has released the screen. */
export function formatActiveWriter(report: ActiveWriterReport, resumeCommand?: string): string[] {
    const lines = [
        "",
        pc.yellow("Codex refused to resume that thread: another process is already writing to it."),
        "",
        `  thread        ${report.threadId}`,
        `  lock          ${report.lockPath}`,
    ];

    if (report.lastActivity) {
        lines.push(`  last message  ${report.lastActivity.toISOString().replace("T", " ").slice(0, 16)}`);
    }

    lines.push("");

    if (report.holders === undefined) {
        lines.push(
            "  Nothing could tell which process holds the lock: `lsof` is missing or refused to answer.",
            "  Close the other Codex window on this thread, or wait for it to exit."
        );

        return lines;
    }

    if (report.holders.length === 0) {
        lines.push(
            pc.green("  The lock is free now — no process holds it, so that refusal is already stale."),
            "  Run the same command again."
        );

        return lines;
    }

    lines.push("  Held by:", ...report.holders.map(holderLine), "");
    lines.push(
        "  One Codex process at a time may append to a thread, and the lock is released when that",
        "  process exits. You can:",
        "",
        "    · switch to that session and keep working there",
        `    · stop it, then retry:  kill ${report.holders.map((holder) => holder.pid).join(" ")}`,
        `    · start a new thread:   ${resumeCommand ?? "tools codex run <account>"}`
    );

    return lines;
}
