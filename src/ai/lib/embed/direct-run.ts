import { logger } from "@genesiscz/utils/logger";

interface StdinSink {
    write(chunk: string): unknown;
    flush(): unknown;
    end(): unknown;
}

/** Copies the host's stdin to claude line by line through `rewrite`, then closes claude's stdin. */
export async function pumpLines(
    source: ReadableStream<Uint8Array>,
    sink: StdinSink,
    rewrite: (line: string) => string
): Promise<void> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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

        if (buffer) {
            sink.write(rewrite(buffer));
            sink.flush();
        }
    } finally {
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

        if (input.stdinLines && isStdinSink(proc.stdin)) {
            pumpLines(deps.stdin(), proc.stdin, input.stdinLines).catch((error) => {
                logger.warn({ error }, "[embed] stdin pump failed");
            });
        }

        const relay =
            input.relayStdout && proc.stdout instanceof ReadableStream
                ? relayBytes(proc.stdout, deps.stdout()).catch((error) => {
                      logger.warn({ error }, "[embed] stdout relay failed");
                  })
                : undefined;
        const code = await proc.exited;
        await relay;
        return code;
    } finally {
        for (const signal of signals) {
            deps.signals.off(signal, forward);
        }
    }
}
