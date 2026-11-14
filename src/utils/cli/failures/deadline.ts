import { basename } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { type DeadlineExpiry, type FailureCaller, failuresDir, type ToolFailure } from "./record";
import { currentRunFacts, FAILURE_MESSAGE_CHARS, FAILURE_STACK_CHARS, processFailureFields } from "./watch";

/*
 * The record of a command deadline: an `Executor` call that outlived its bound. executor.ts loads this module with a
 * dynamic import in its expiry branch only, so no tool pays for it at startup, and bounds the whole step.
 */

/**
 * One answer from a worker thread, or `missing` when it does not come in `boundMs`; the worker is terminated either
 * way. The record step's synchronous parts run there, because a thread is the only way to stop waiting for them.
 */
function askWorker<T>(input: {
    script: string;
    message?: unknown;
    boundMs: number;
    parse: (data: unknown) => T;
    missing: T;
}): Promise<T> {
    const name = input.script.replace(/^\.\//, "");

    return new Promise((resolve) => {
        let worker: Worker;

        try {
            worker = new Worker(new URL(input.script, import.meta.url));
        } catch (error) {
            logger.debug({ error, worker: name }, "failures: a deadline worker did not start");
            resolve(input.missing);
            return;
        }

        const done = (answer: T) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(answer);
        };
        const timer = setTimeout(() => {
            logger.debug(
                { worker: name, boundMs: input.boundMs },
                "failures: a deadline worker did not answer in time"
            );
            done(input.missing);
        }, input.boundMs);
        worker.onmessage = (event: MessageEvent<unknown>) => done(input.parse(event.data));
        worker.onerror = (event) => {
            logger.debug({ error: event.message, worker: name }, "failures: a deadline worker failed");
            done(input.missing);
        };

        if (input.message !== undefined) {
            worker.postMessage(input.message);
        }
    });
}

function isFailureCaller(value: unknown): value is FailureCaller {
    return typeof value === "object" && value !== null && "agent" in value;
}

/** Who ran the tool (deadline-caller-worker.ts): the identity read is synchronous. Null when it is not there in time. */
function callerFromWorker(boundMs: number): Promise<FailureCaller | null> {
    return askWorker({
        script: "./deadline-caller-worker.ts",
        boundMs,
        parse: (data) => (isFailureCaller(data) ? data : null),
        missing: null,
    });
}

/** Appends the record (deadline-record-worker.ts): `appendFailure` is synchronous file I/O. False when not written. */
function writeInWorker(failure: ToolFailure, dir: string, boundMs: number): Promise<boolean> {
    return askWorker({
        script: "./deadline-record-worker.ts",
        message: { failure, dir },
        boundMs,
        parse: (data) => data === true,
        missing: false,
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

/**
 * How the record is written and how long the write may take. A log filesystem that blocks must not freeze the thread
 * whose call expired, so the default write runs in a worker that is terminated at `boundMs`.
 */
export const deadlineWrite: {
    boundMs: number;
    write: (failure: ToolFailure, dir: string, boundMs: number) => Promise<boolean>;
} = {
    boundMs: 1_500,
    write: writeInWorker,
};

let sequence = 0;

/** Writes one `deadline` record and returns it; a caller that does not arrive in time is null. */
export async function recordDeadline(expiry: DeadlineExpiry, dir = failuresDir()): Promise<ToolFailure> {
    const boundMs = deadlineCaller.boundMs;
    // The worker lookup ends itself at `boundMs`; the bound here also holds a replaced `lookup` that never answers.
    const caller = await withTimeout(deadlineCaller.lookup(boundMs), boundMs).catch((error: unknown) => {
        logger.debug({ error }, "failures: no caller context for a command deadline");
        return null;
    });

    const run = currentRunFacts();
    const now = new Date();
    // No `runId`: the launchers read a record that carries the run's id as "the tool recorded its own end"
    // (launcher.ts `childRecorded`, LauncherFailures.swift `recorded`), and a deadline is not the end of the run.
    const failure: ToolFailure = {
        ...processFailureFields(now),
        id: `${now.getTime().toString(36)}-${process.pid}-d${++sequence}`,
        kind: "deadline",
        tool: run?.tool ?? basename(process.argv[1] ?? "unknown"),
        command: run?.command ?? null,
        argv: run?.argv ?? [],
        exitCode: null,
        message: expiry.message.slice(0, FAILURE_MESSAGE_CHARS),
        errorName: "Error",
        stack: expiry.stack?.slice(0, FAILURE_STACK_CHARS) ?? null,
        stderrTail: null,
        fatal: false,
        durationMs: Math.round(expiry.durationMs),
        caller,
        child: expiry.child,
    };
    await deadlineWrite.write(failure, dir, deadlineWrite.boundMs);
    return failure;
}
