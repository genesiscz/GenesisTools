import { openSync } from "node:fs";
import { readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord } from "@app/utils/log-session/types";
import { jsonlPath, stdoutLogPath } from "@app/task/lib/paths";
import type { TaskRunMode } from "@app/task/types";

const WORKER_ENV = "TASK_RUN_WORKER";

export function isDetachedRunWorker(): boolean {
    return process.env[WORKER_ENV] === "1";
}

export function shouldSuperviseDetachedRun(): boolean {
    // Foreground CI/agents: stdin may be piped but stdout is still a TTY — run
    // in-process so output streams through. Background `tools task run &` with
    // redirects typically has neither stdin nor stdout attached to a TTY.
    return !process.stdin.isTTY && !process.stdout.isTTY && !isDetachedRunWorker();
}

function findExitRecord(records: Awaited<ReturnType<typeof readJsonlFile>>): JsonlExitRecord | undefined {
    return records.find(
        (record): record is JsonlExitRecord =>
            record.type === "exit" && typeof (record as JsonlExitRecord).code === "number"
    );
}

export async function pollSessionExitCode(session: string, pollMs = 50): Promise<number> {
    const path = jsonlPath(session);

    for (;;) {
        const records = await readJsonlFile(path);
        const exit = findExitRecord(records);
        if (exit) {
            return exit.code;
        }

        await Bun.sleep(pollMs);
    }
}

function buildWorkerCmdPrefix(toolsEntry: string): string[] {
    if (/[/\\]task[/\\]index\.tsx?$/i.test(toolsEntry)) {
        return [process.execPath, toolsEntry];
    }

    return [process.execPath, toolsEntry, "task"];
}

export function spawnDetachedRunWorker(opts: {
    toolsEntry: string;
    session: string;
    command: string[];
    mode: TaskRunMode;
    forceTty?: boolean;
    forceNoTty?: boolean;
}): ReturnType<typeof Bun.spawn> {
    const cmd = [...buildWorkerCmdPrefix(opts.toolsEntry), "run", "--session", opts.session];

    if (opts.forceTty) {
        cmd.push("--tty");
    } else if (opts.forceNoTty || opts.mode === "pipe") {
        cmd.push("--no-tty");
    }

    cmd.push("--", ...opts.command);

    const logFd = openSync(stdoutLogPath(opts.session), "a");

    return Bun.spawn({
        cmd,
        env: { ...process.env, [WORKER_ENV]: "1" },
        cwd: process.cwd(),
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
        detached: true,
    });
}
