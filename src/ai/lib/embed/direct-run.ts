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
}

export interface DirectRunDeps {
    spawn(options: {
        cmd: string[];
        stdio: ["inherit" | "pipe", "inherit", "inherit"];
        env: Record<string, string | undefined>;
    }): DirectChild;
    signals: Pick<NodeJS.Process, "on" | "off">;
    stdin(): ReadableStream<Uint8Array>;
}

const defaultDeps: DirectRunDeps = {
    spawn: (options) => Bun.spawn(options),
    signals: process,
    stdin: () => Bun.stdin.stream(),
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
 */
export async function runBinaryDirect(
    input: { argv: string[]; env: Record<string, string | undefined>; stdinLines?: (line: string) => string },
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
            stdio: [input.stdinLines ? "pipe" : "inherit", "inherit", "inherit"],
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

        return await proc.exited;
    } finally {
        for (const signal of signals) {
            deps.signals.off(signal, forward);
        }
    }
}
