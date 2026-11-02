import { logger } from "@genesiscz/utils/logger";

interface StdinSink {
    write(chunk: string): unknown;
    flush(): unknown;
    end(): unknown;
}

/**
 * Copies the host's stdin to the child line by line through `rewrite`, then closes the child's stdin. `signal` stops
 * the copy: it cancels the pending read, so a host that keeps its end of stdin open cannot hold this process alive,
 * and it drops a partial last line, because the child that would read it is gone.
 */
export async function pumpLines(input: {
    source: ReadableStream<Uint8Array>;
    sink: StdinSink;
    rewrite: (line: string) => string;
    signal?: AbortSignal;
}): Promise<void> {
    const { sink, rewrite, signal } = input;
    const reader = input.source.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const stop = () => {
        reader.cancel().catch((error: unknown) => logger.debug({ error }, "[embed] stdin cancel failed"));
    };

    signal?.addEventListener("abort", stop, { once: true });

    if (signal?.aborted) {
        stop();
    }

    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf("\n");

            while (newline !== -1) {
                sink.write(rewrite(buffer.slice(0, newline + 1)));
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf("\n");
            }

            sink.flush();
        }

        buffer += decoder.decode();

        if (buffer && !signal?.aborted) {
            sink.write(rewrite(buffer));
            sink.flush();
        }
    } finally {
        signal?.removeEventListener("abort", stop);
        reader.releaseLock();
        sink.end();
    }
}

interface DirectChild {
    exitCode: number | null;
    exited: Promise<number>;
    kill(signal: NodeJS.Signals): void;
    stdin?: unknown;
    stdout?: unknown;
}

/** Where a relayed child's stdout goes: this process's stdout, which queues a write the pipe cannot take yet. */
export interface ByteSink {
    write(chunk: Uint8Array): unknown;
    flush(): unknown;
}

/** Copies a child's stdout to `sink` chunk by chunk, in order, until the child closes it. */
export async function relayBytes(source: ReadableStream<Uint8Array>, sink: ByteSink): Promise<void> {
    for await (const chunk of source) {
        sink.write(chunk);
        await sink.flush();
    }
}

export interface DirectRunDeps {
    spawn(options: {
        cmd: string[];
        stdio: ["inherit" | "pipe", "inherit" | "pipe", "inherit"];
        env: Record<string, string | undefined>;
    }): DirectChild;
    signals: Pick<NodeJS.Process, "on" | "off">;
    stdin(): ReadableStream<Uint8Array>;
    stdout(): ByteSink;
}

const defaultDeps: DirectRunDeps = {
    spawn: (options) => Bun.spawn(options),
    signals: process,
    stdin: () => Bun.stdin.stream(),
    stdout: () => Bun.stdout.writer(),
};

function isStdinSink(value: unknown): value is StdinSink {
    return (
        typeof value === "object" &&
        value !== null &&
        "write" in value &&
        typeof value.write === "function" &&
        "flush" in value &&
        "end" in value
    );
}

/**
 * Runs a native agent binary for an embedding app with no shell between: a user's shell wrapper (`ccc`, a zsh
 * `codex` function) could add flags over the ones the app chose. The app stops a session by signalling the process
 * it spawned (this one), so each signal is passed on, or the agent would keep running after the app let it go.
 * With `stdinLines` the host's stdin goes to the child line by line through that rewrite; without it the child
 * inherits stdin untouched.
 *
 * With `relayStdout` the child writes into a pipe of its own, which this process copies to its stdout. An inherited
 * stdout is the file description every Bun process above shares, and Bun puts it in non-blocking mode; a child that
 * does not retry a short write then loses the rest of a long line whenever the host reads slower than it writes.
 * Grok cut an ACP message at 64 KB that way, and T3 Code failed the turn with `AcpProtocolParseError` (2026-11-01).
 */
export async function runBinaryDirect(
    input: {
        argv: string[];
        env: Record<string, string | undefined>;
        stdinLines?: (line: string) => string;
        relayStdout?: boolean;
    },
    deps: DirectRunDeps = defaultDeps
): Promise<number> {
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    let proc: DirectChild | undefined;
    let pendingSignal: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals) => {
        if (!proc) {
            pendingSignal ??= signal;
            return;
        }

        if (proc.exitCode === null) {
            proc.kill(signal);
        }
    };

    for (const signal of signals) {
        deps.signals.on(signal, forward);
    }

    try {
        proc = deps.spawn({
            cmd: input.argv,
            stdio: [input.stdinLines ? "pipe" : "inherit", input.relayStdout ? "pipe" : "inherit", "inherit"],
            env: input.env,
        });

        if (pendingSignal && proc.exitCode === null) {
            proc.kill(pendingSignal);
        }

        const stopPump = new AbortController();
        const pump =
            input.stdinLines && isStdinSink(proc.stdin)
                ? pumpLines({
                      source: deps.stdin(),
                      sink: proc.stdin,
                      rewrite: input.stdinLines,
                      signal: stopPump.signal,
                  }).catch((error) => {
                      logger.warn({ error }, "[embed] stdin pump failed");
                  })
                : undefined;
        const relay =
            input.relayStdout && proc.stdout instanceof ReadableStream
                ? relayBytes(proc.stdout, deps.stdout()).catch((error) => {
                      logger.warn({ error }, "[embed] stdout relay failed");
                  })
                : undefined;
        const code = await proc.exited;
        // The host may keep its end of stdin open after the child is gone, and a read left pending on it would keep
        // this launcher alive (the Codex embed cancels its host reader for the same reason).
        stopPump.abort();
        await pump;
        await relay;
        return code;
    } finally {
        for (const signal of signals) {
            deps.signals.off(signal, forward);
        }
    }
}
