import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * How an embedding app's steer reaches claude. `now` (Claude Code's default) aborts the running step, so a steer
 * during a long command kills it (`Error calling tool (Bash): interrupt`, 2026-11-01). `next` waits for the next
 * tool boundary, like a message typed into the Claude Code CLI.
 */
export type SteerMode = "now" | "next";

export const STEER_ENV = "TOOLS_CLAUDE_EMBED_STEER";

/** `TOOLS_CLAUDE_EMBED_STEER=next` turns the rewrite on; anything else leaves the host's stdin untouched. */
export function steerModeFromEnv(): SteerMode {
    return env.get(STEER_ENV)?.trim() === "next" ? "next" : "now";
}

/**
 * One stdin line with a `priority: "now"` user message turned into `"next"`. Every other line, a line that does not
 * parse, and a line's newline come back byte for byte.
 */
export function rewriteSteerLine(line: string): string {
    if (!line.includes('"now"')) {
        return line;
    }

    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = line.slice(0, line.length - newline.length);

    try {
        const message: unknown = SafeJSON.parse(body, { strict: true });

        if (
            typeof message === "object" &&
            message !== null &&
            !Array.isArray(message) &&
            "type" in message &&
            message.type === "user" &&
            "priority" in message &&
            message.priority === "now"
        ) {
            logger.info("[direct-run] steer priority now rewritten to next");
            return `${SafeJSON.stringify({ ...message, priority: "next" }, { strict: true })}${newline}`;
        }
    } catch (error) {
        logger.debug({ error }, "[direct-run] stdin line is not JSON; passed on unchanged");
    }

    return line;
}

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
 * Runs the real claude executable with no shell between: the user's `ccc`/`claude` wrappers add
 * `--dangerously-skip-permissions`, which would override the permission mode the embedding app chose. The app stops
 * a session by signalling the process it spawned (this one), so each signal is passed on, or claude would keep
 * running after the app let it go. With `steer: "next"` the host's stdin goes through {@link rewriteSteerLine}.
 */
export async function runClaudeBinaryDirect(
    input: { argv: string[]; env: Record<string, string | undefined>; steer?: SteerMode },
    deps: DirectRunDeps = defaultDeps
): Promise<number> {
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const steer = input.steer ?? "now";
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
            stdio: [steer === "next" ? "pipe" : "inherit", "inherit", "inherit"],
            env: input.env,
        });

        if (pendingSignal && proc.exitCode === null) {
            proc.kill(pendingSignal);
        }

        if (steer === "next" && isStdinSink(proc.stdin)) {
            logger.info("[direct-run] steer mode next: stdin goes through the priority rewrite");
            pumpLines(deps.stdin(), proc.stdin, rewriteSteerLine).catch((error) => {
                logger.warn({ error }, "[direct-run] stdin pump failed");
            });
        }

        return await proc.exited;
    } finally {
        for (const signal of signals) {
            deps.signals.off(signal, forward);
        }
    }
}
