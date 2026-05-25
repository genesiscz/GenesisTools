import { logger } from "@app/logger";
import { JsonlWriter } from "@app/utils/log-session/jsonl-writer";
import { OrderedCaptureWriter } from "@app/utils/log-session/ordered-capture-writer";
import type { RunTaskOptions, RunTaskResult } from "../types";
import { jsonlPath, sessionFilePaths, stderrLogPath, stdoutLogPath } from "./paths";
import { TaskSessionStore } from "./session-store";

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

    const exitCode = await proc.exited;
    drainAbort.abort();
    await streamsDone;
    await writer.flush();

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
    await store.prepareSession(opts.session, opts.command.join(" "), opts.mode, cwd);

    const paths = sessionFilePaths(opts.session);
    const jsonl = new JsonlWriter(paths.jsonl);
    jsonl.append({
        type: "meta",
        session: opts.session,
        command: opts.command.join(" "),
        mode: opts.mode,
        cwd,
        startedAt: new Date().toISOString(),
    });

    const writer = new OrderedCaptureWriter({
        jsonlPath: jsonlPath(opts.session),
        stdoutPath: stdoutLogPath(opts.session),
        stderrPath: stderrLogPath(opts.session),
        mode: opts.mode,
    });

    const startMs = Date.now();
    let exitCode = 1;

    try {
        if (opts.mode === "pty") {
            exitCode = await runPtyMode(opts, writer);
        } else {
            exitCode = await runPipeMode(opts, writer);
        }
    } catch (err) {
        log.warn({ err, session: opts.session }, "task run failed");
        throw err;
    }

    const durationMs = Date.now() - startMs;
    jsonl.append({
        type: "exit",
        code: exitCode,
        durationMs,
        ts: new Date().toISOString(),
    });

    await store.markExited(opts.session, exitCode, durationMs);

    return { exitCode, durationMs, session: opts.session };
}
