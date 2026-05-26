import { logger } from "@app/logger";
import { JsonlWriter } from "@app/utils/log-session/jsonl-writer";
import { OrderedCaptureWriter } from "@app/utils/log-session/ordered-capture-writer";
import type { RunTaskOptions, RunTaskResult, ResolvedRunSession } from "@app/task/types";
import { jsonlPath, sessionFilePaths, stderrLogPath, stdoutLogPath, uiJsonlPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";

const log = logger.child({ component: "task:runner" });

async function multiplexPipeStreams(
    stdout: ReadableStream<Uint8Array>,
    stderr: ReadableStream<Uint8Array>,
    writer: OrderedCaptureWriter,
    signal: AbortSignal
): Promise<void> {
    const stdoutReader = stdout.getReader();
    const stderrReader = stderr.getReader();
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    type ReadResult = { out: "stdout" | "stderr"; done: boolean; value?: Uint8Array };

    const onAbort = (): void => {
        stdoutReader.cancel().catch((err) => {
            log.debug({ err }, "stdout reader cancel failed");
        });
        stderrReader.cancel().catch((err) => {
            log.debug({ err }, "stderr reader cancel failed");
        });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    let stdoutDone = false;
    let stderrDone = false;

    const nextRead = (
        out: "stdout" | "stderr",
        reader: ReadableStreamDefaultReader<Uint8Array>
    ): Promise<ReadResult> => {
        return reader.read().then((result) => ({ out, done: result.done, value: result.value }));
    };

    let stdoutPending = nextRead("stdout", stdoutReader);
    let stderrPending = nextRead("stderr", stderrReader);

    try {
        while (!stdoutDone || !stderrDone) {
            const pending: Promise<ReadResult>[] = [];
            if (!stdoutDone) {
                pending.push(stdoutPending);
            }

            if (!stderrDone) {
                pending.push(stderrPending);
            }

            if (pending.length === 0) {
                break;
            }

            const result = await Promise.race(pending);

            if (result.done) {
                const decoder = result.out === "stdout" ? stdoutDecoder : stderrDecoder;
                const tail = decoder.decode();
                if (tail) {
                    const mirror = result.out === "stdout" ? process.stdout : process.stderr;
                    mirror.write(tail);
                    writer.enqueue(result.out, tail);
                }

                if (result.out === "stdout") {
                    stdoutDone = true;
                } else {
                    stderrDone = true;
                }

                continue;
            }

            const decoder = result.out === "stdout" ? stdoutDecoder : stderrDecoder;
            const chunk = decoder.decode(result.value, { stream: true });
            const mirror = result.out === "stdout" ? process.stdout : process.stderr;
            mirror.write(chunk);
            writer.enqueue(result.out, chunk);

            if (result.out === "stdout") {
                stdoutPending = nextRead("stdout", stdoutReader);
            } else {
                stderrPending = nextRead("stderr", stderrReader);
            }
        }
    } finally {
        signal.removeEventListener("abort", onAbort);
        stdoutReader.releaseLock();
        stderrReader.releaseLock();
    }
}

async function runPipeMode(opts: RunTaskOptions, writer: OrderedCaptureWriter): Promise<number> {
    const proc = Bun.spawn(opts.command, {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "inherit",
        env: process.env,
    });

    const store = new TaskSessionStore();
    await store.updatePid(opts.session, proc.pid);

    const drainAbort = new AbortController();
    const streamsDone = multiplexPipeStreams(proc.stdout, proc.stderr, writer, drainAbort.signal);

    const onSigInt = (): void => {
        drainAbort.abort();
    };

    process.on("SIGINT", onSigInt);

    let exitCode = 1;

    try {
        exitCode = await proc.exited;
        await streamsDone;
        await writer.flush();
    } finally {
        process.off("SIGINT", onSigInt);
    }

    return exitCode;
}

async function runPtyMode(opts: RunTaskOptions, writer: OrderedCaptureWriter): Promise<number> {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const proc = Bun.spawn(opts.command, {
        cwd: opts.cwd,
        env: process.env,
        terminal: {
            cols,
            rows,
            data(_term, data) {
                const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
                process.stdout.write(text);
                writer.enqueue("stdout", text);
            },
        },
    });

    const store = new TaskSessionStore();
    await store.updatePid(opts.session, proc.pid);

    const onResize = (): void => {
        const term = proc.terminal;
        if (term && process.stdout.columns && process.stdout.rows) {
            term.resize(process.stdout.columns, process.stdout.rows);
        }
    };

    process.stdout.on("resize", onResize);

    if (process.stdin.isTTY && proc.terminal) {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on("data", (chunk: Buffer) => {
            proc.terminal?.write(chunk);
        });
    }

    const exitCode = await proc.exited;
    process.stdout.off("resize", onResize);

    if (process.stdin.isTTY) {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
    }

    proc.terminal?.close();
    await writer.flush();

    return exitCode;
}

export async function runTask(opts: RunTaskOptions): Promise<RunTaskResult> {
    const cwd = opts.cwd ?? process.cwd();
    const store = new TaskSessionStore();
    const resolved: ResolvedRunSession = opts.resolved ?? {
        session: opts.session,
        requested: opts.session,
        renamed: false,
    };

    const prepareInput = {
        name: resolved.session,
        command: opts.command.join(" "),
        mode: opts.mode,
        cwd,
        requestedAs: resolved.renamed ? resolved.requested : undefined,
    };

    if (resolved.reuse === "reuse-clear") {
        await store.clearSessionLogs(resolved.session);
        await store.prepareSession(prepareInput);
    } else if (resolved.reuse === "reuse-continue") {
        await store.prepareSessionReuseContinue(prepareInput);
    } else {
        await store.prepareSession(prepareInput);
    }

    const session = resolved.session;
    const paths = sessionFilePaths(session);
    const jsonl = new JsonlWriter(paths.jsonl);
    jsonl.append({
        type: "meta",
        session,
        requestedAs: resolved.renamed ? resolved.requested : undefined,
        command: opts.command.join(" "),
        mode: opts.mode,
        cwd,
        startedAt: new Date().toISOString(),
    });

    const initialSeq =
        resolved.reuse === "reuse-continue" && resolved.previousLastSeq !== undefined
            ? resolved.previousLastSeq
            : undefined;

    const writer = new OrderedCaptureWriter({
        jsonlPath: jsonlPath(session),
        uiJsonlPath: uiJsonlPath(session),
        stdoutPath: stdoutLogPath(session),
        stderrPath: stderrLogPath(session),
        mode: opts.mode,
        initialSeq,
    });

    const startMs = Date.now();
    let exitCode = 1;

    try {
        if (opts.mode === "pty") {
            exitCode = await runPtyMode({ ...opts, session }, writer);
        } else {
            exitCode = await runPipeMode({ ...opts, session }, writer);
        }
    } catch (err) {
        log.warn({ err, session }, "task run failed");
        throw err;
    }

    const durationMs = Date.now() - startMs;
    jsonl.append({
        type: "exit",
        code: exitCode,
        durationMs,
        ts: new Date().toISOString(),
    });

    await store.markExited({ name: session, exitCode, durationMs });

    return { exitCode, durationMs, session, requestedSession: resolved.requested, renamed: resolved.renamed };
}
