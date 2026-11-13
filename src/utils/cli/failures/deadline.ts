import { basename } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { currentTraceId } from "@genesiscz/utils/trace";
import { appendFailure, type DeadlineExpiry, type FailureCaller, failuresDir, type ToolFailure } from "./record";
import { currentRunFacts, TOOLS_ROOT } from "./watch";

/*
 * The record of a command deadline: an `Executor` call that outlived its bound. executor.ts loads this module with a
 * dynamic import in its expiry branch only, so no tool pays for it at startup, and bounds the whole step.
 */

/**
 * Who ran the tool, asked in a worker thread (deadline-caller-worker.ts): the identity read is synchronous, and a
 * thread is the only way to stop waiting for it. Null when it is not there in `boundMs`.
 */
function callerFromWorker(boundMs: number): Promise<FailureCaller | null> {
    return new Promise((resolve) => {
        let worker: Worker;

        try {
            worker = new Worker(new URL("./deadline-caller-worker.ts", import.meta.url));
        } catch (error) {
            logger.debug({ error }, "failures: the caller worker did not start");
            resolve(null);
            return;
        }

        const done = (caller: FailureCaller | null) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(caller);
        };
        const timer = setTimeout(() => done(null), boundMs);
        worker.onmessage = (event: MessageEvent<unknown>) => {
            const found = event.data;
            done(typeof found === "object" && found !== null && "agent" in found ? (found as FailureCaller) : null);
        };
        worker.onerror = (event) => {
            logger.debug({ error: event.message }, "failures: the caller worker failed");
            done(null);
        };
    });
}

/**
 * How the caller is found and how long the record waits for it, below executor.ts's bound of the whole step
 * (`deadlineRecording.boundMs`). Tests replace `lookup` with a stub that answers or hangs.
 */
export const deadlineCaller: { boundMs: number; lookup: (boundMs: number) => Promise<FailureCaller | null> } = {
    boundMs: 1_500,
    lookup: callerFromWorker,
};

let sequence = 0;

/** Writes one `deadline` record and returns it; a caller that does not arrive in time is null. */
export async function recordDeadline(expiry: DeadlineExpiry, dir = failuresDir()): Promise<ToolFailure> {
    const boundMs = deadlineCaller.boundMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const caller = await Promise.race([
        deadlineCaller.lookup(boundMs).catch((error: unknown) => {
            logger.debug({ error }, "failures: no caller context for a command deadline");
            return null;
        }),
        new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), boundMs);
        }),
    ]);
    clearTimeout(timer);

    const run = currentRunFacts();
    const now = new Date();
    // No `runId`: the launchers read a record that carries the run's id as "the tool recorded its own end"
    // (launcher.ts `childRecorded`, LauncherFailures.swift `recorded`), and a deadline is not the end of the run.
    const failure: ToolFailure = {
        v: 1,
        id: `${now.getTime().toString(36)}-${process.pid}-d${++sequence}`,
        at: now.toISOString(),
        kind: "deadline",
        tool: run?.tool ?? basename(process.argv[1] ?? "unknown"),
        command: run?.command ?? null,
        argv: run?.argv ?? [],
        exitCode: null,
        message: expiry.message.slice(0, 2000),
        errorName: "Error",
        stack: expiry.stack?.slice(0, 8000) ?? null,
        stderrTail: null,
        fatal: false,
        durationMs: Math.round(expiry.durationMs),
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        traceId: currentTraceId() ?? null,
        toolsRoot: TOOLS_ROOT,
        caller,
        child: expiry.child,
    };
    appendFailure(failure, dir);
    return failure;
}
