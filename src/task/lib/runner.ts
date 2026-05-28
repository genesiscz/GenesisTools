import { logger } from "@app/logger";
import { jsonlPath, sessionFilePaths, stderrLogPath, stdoutLogPath, uiJsonlPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import type { ResolvedRunSession, RunTaskOptions, RunTaskResult } from "@app/task/types";
import { JsonlWriter } from "@app/utils/log-session/jsonl-writer";
import { OrderedCaptureWriter } from "@app/utils/log-session/ordered-capture-writer";

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

    // Forward our SIGINT to the child. In an interactive terminal the kernel
    // signals the whole foreground process group so this is redundant, but
    // when the wrapper is signaled out-of-band (`kill -INT <wrapper-pid>`
    // from a supervisor, an orphaned/reparented child, etc.) `proc.exited`
    // would otherwise wait forever while we sit holding the JSONL/meta lock.
    const onSigInt = (): void => {
        drainAbort.abort();
        try {
            proc.kill("SIGINT");
        } catch (err) {
            log.debug({ err, pid: proc.pid }, "forwarding SIGINT to child failed");
        }
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
    const ptyDecoder = new TextDecoder();

    const proc = Bun.spawn(opts.command, {
        cwd: opts.cwd,
        env: process.env,
        terminal: {
            cols,
            rows,
            data(_term, data) {
                const text = typeof data === "string" ? data : ptyDecoder.decode(data, { stream: true });
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

    const stdinHandler = (chunk: Buffer): void => {
        proc.terminal?.write(chunk);
    };

    process.stdout.on("resize", onResize);

    const ownsRawMode = process.stdin.isTTY && proc.terminal;
    if (ownsRawMode) {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on("data", stdinHandler);
    }

    // Wrap in try/finally so any throw (decoder error, terminal close, etc.)
    // still restores cooked-mode stdin and detaches the listener — otherwise
    // the user's shell is left in raw mode and a stray `data` handler stays
    // attached, accumulating across runs.
    let exitCode = 1;
    try {
        exitCode = await proc.exited;
    } finally {
        process.stdout.off("resize", onResize);
        if (ownsRawMode) {
            process.stdin.off("data", stdinHandler);
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
        }

        proc.terminal?.close();

        const ptyTail = ptyDecoder.decode();
        if (ptyTail) {
            process.stdout.write(ptyTail);
            writer.enqueue("stdout", ptyTail);
        }

        await writer.flush();
    }

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

    // reuse-continue preserves the original meta record at the top of the
    // jsonl (only the `exit` record was trimmed in prepareSessionReuseContinue).
    // Appending a fresh meta would leave [old meta][lines][new meta][new lines]
    // — and downstream `records.find(meta)` always returns the FIRST hit, so
    // the dashboard listing + fallback meta synthesis would show the original
    // command/cwd/mode forever. Skip the append in that case.
    if (resolved.reuse !== "reuse-continue") {
        jsonl.append({
            type: "meta",
            session,
            requestedAs: resolved.renamed ? resolved.requested : undefined,
            command: opts.command.join(" "),
            mode: opts.mode,
            cwd,
            startedAt: new Date().toISOString(),
        });
    }

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
    let spawnFailed = false;

    try {
        if (opts.mode === "pty") {
            exitCode = await runPtyMode({ ...opts, session }, writer);
        } else {
            exitCode = await runPipeMode({ ...opts, session }, writer);
        }
    } catch (err) {
        spawnFailed = true;
        log.warn({ err, session }, "task run failed");
        throw err;
    } finally {
        // Always record an exit + mark the session exited, even when the spawn
        // / runtime throws — otherwise the session is stuck in "active" forever
        // on disk and downstream readers can't tell it's dead. On a throw the
        // exit code stays at 1 (the initial value) which matches the rethrown
        // error path the caller will see.
        const durationMs = Date.now() - startMs;
        try {
            jsonl.append({
                type: "exit",
                code: exitCode,
                durationMs,
                ts: new Date().toISOString(),
            });
        } catch (err) {
            log.warn({ err, session }, "failed to append exit record to jsonl");
        }

        try {
            await store.markExited({ name: session, exitCode, durationMs });
        } catch (err) {
            log.warn({ err, session }, "failed to mark session exited");
        }

        if (spawnFailed) {
            log.debug({ session, exitCode, durationMs }, "exit record persisted despite runner throw");
        }
    }

    return {
        exitCode,
        durationMs: Date.now() - startMs,
        session,
        requestedSession: resolved.requested,
        renamed: resolved.renamed,
    };
}
