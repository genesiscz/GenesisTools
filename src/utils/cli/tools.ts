import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { namedBunExecPath } from "./bun-link";
import { DETACHED_ENV } from "./detached";
import type { ExecResult } from "./executor";

function getToolsPath(): string {
    // import.meta.dir is Bun-specific; fall back to import.meta.url for Node/Vite SSR
    const dir = typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
    return resolve(dir, "../../../tools");
}

export interface RunToolOptions {
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    /** Written to the child's stdin, then closed. Without it stdin is closed from the start. */
    stdin?: string;
    /** Ends the child (its whole process group) the way the timeout does, with `timedOut` set. */
    signal?: AbortSignal;
    /** Keeps at most this many bytes of each stream; past it the child is stopped and `truncated` is set. */
    maxOutputBytes?: number;
}

export interface CollectedOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    /** Set when a stream passed `maxBytes`: the output is cut there and the child was stopped. */
    truncated?: boolean;
}

/** How long a killed child gets to close its pipes before its output is given up. */
const KILL_GRACE_MS = 1000;

/**
 * The work's value, or `"deadline"` once `ms` pass or `signal` aborts. The timer and the listener
 * are cleared however the race ends, a rejection included: a stream that errors must not leave a
 * timer holding the process open for the rest of the timeout.
 */
async function within<T>(work: Promise<T>, ms: number | undefined, signal?: AbortSignal): Promise<T | "deadline"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expired = new Promise<"deadline">((resolve) => {
        if (ms !== undefined) {
            timer = setTimeout(() => resolve("deadline"), ms);
        }

        if (signal) {
            onAbort = () => resolve("deadline");

            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        }
    });

    try {
        return await Promise.race([work, expired]);
    } finally {
        clearTimeout(timer);

        if (onAbort) {
            signal?.removeEventListener("abort", onAbort);
        }
    }
}

/**
 * A stream's text, keeping at most `maxBytes` of it. Past the cap it stops reading, cancels the
 * stream (the writer then gets EPIPE) and calls `onCap`, so a chatty child cannot grow memory.
 */
async function readCapped(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number | undefined,
    onCap: () => void
): Promise<string> {
    if (maxBytes === undefined) {
        return new Response(stream).text();
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            const room = maxBytes - size;

            if (value.byteLength > room) {
                chunks.push(value.subarray(0, room));
                onCap();
                reader.cancel().catch((error) => logger.debug({ error }, "cancelling a capped output stream failed"));
                break;
            }

            chunks.push(value);
            size += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Signals the process group our detached child leads; an ended group is logged, not an error. */
function signalGroup(groupId: number, signal: NodeJS.Signals): void {
    try {
        // pid-verified: the pid of our own retained child, spawned detached as its group's leader; a group id is not reissued while a member lives.
        process.kill(-groupId, signal);
    } catch (error) {
        logger.debug({ error, groupId, signal }, "timed-out child group already ended");
    }
}

/**
 * A piped child's output and exit code, bounded by `deadlineMs` when given. On the deadline (or
 * when `signal` aborts) the child is killed and its output is kept if the pipes close within a
 * short grace. They may never close: a grandchild the kill did not reach (the `tools` wrapper's
 * own child, `claude` under `tools claude run`) holds them for as long as it lives, so the call
 * returns anyway, with empty output, instead of waiting on it. With `maxBytes`, a stream that
 * passes the cap is cut there and the child is stopped; the result then says `truncated`.
 */
export async function collectOutput(
    proc: {
        stdout: ReadableStream<Uint8Array>;
        stderr: ReadableStream<Uint8Array>;
        exited: Promise<number>;
        kill(signal?: NodeJS.Signals): void;
        readonly pid?: number;
        readonly exitCode: number | null;
        readonly signalCode: NodeJS.Signals | null;
    },
    deadlineMs?: number,
    /**
     * `group`: the child was spawned `detached`, as the leader of its own process group, so the
     * deadline signals the WHOLE group. Killing the leader alone left a grandchild (the agent under
     * `tools claude run`) running and changing files after the caller had reported exit 124.
     * `graceMs`: how long the pipes get to close after each signal.
     */
    {
        group = false,
        graceMs = KILL_GRACE_MS,
        signal,
        maxBytes,
    }: { group?: boolean; graceMs?: number; signal?: AbortSignal; maxBytes?: number } = {}
): Promise<CollectedOutput> {
    // The group is signalled by its id even when the leader is gone: it may have exited before the
    // deadline or on the SIGTERM, while a member that still holds the pipes must not outlive the
    // deadline. The id stays ours while any member lives, and an ended group only logs.
    const terminate = (signal: NodeJS.Signals) => {
        if (group && proc.pid !== undefined) {
            signalGroup(proc.pid, signal);
            return;
        }

        proc.kill(signal);
    };
    let truncated = false;
    const onCap = () => {
        if (!truncated) {
            truncated = true;
            terminate("SIGTERM");
        }
    };
    const collected = Promise.all([
        readCapped(proc.stdout, maxBytes, onCap),
        readCapped(proc.stderr, maxBytes, onCap),
        proc.exited,
    ]);
    const finished = ([stdout, stderr, exitCode]: [string, string, number]): CollectedOutput => ({
        stdout,
        stderr,
        exitCode,
        timedOut: false,
        ...(truncated ? { truncated: true } : {}),
    });

    if (!deadlineMs && !signal) {
        return finished(await collected);
    }

    const first = await within(collected, deadlineMs || undefined, signal);

    if (first !== "deadline") {
        return finished(first);
    }

    terminate("SIGTERM");
    const late = await within(collected, graceMs);

    if (late === "deadline") {
        // Still holding the pipes after SIGTERM: escalate, and stop waiting on it either way.
        terminate("SIGKILL");
        return { stdout: "", stderr: "", exitCode: 124, timedOut: true };
    }

    return { stdout: late[0], stderr: late[1], exitCode: 124, timedOut: true };
}

/**
 * Spawn a GenesisTools tool and capture its output.
 * Usage: `execTool(["claude", "usage"])` runs `tools claude usage`
 */
export async function execTool(args: string[], options?: RunToolOptions): Promise<ExecResult> {
    // Only a bounded run gets its own process group, so its deadline (or abort) can end everything
    // it started. An unbounded run stays in the caller's group and still gets the caller's Ctrl-C.
    const bounded = options?.timeout !== undefined || options?.signal !== undefined;
    const proc = Bun.spawn([namedBunExecPath("tools"), "run", getToolsPath(), ...args], {
        cwd: options?.cwd ?? process.cwd(),
        stdin: options?.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...env.getProcessEnv(), ...options?.env },
        detached: bounded,
    });
    const { stdout, stderr, exitCode, timedOut, truncated } = await collectOutput(proc, options?.timeout, {
        group: bounded,
        signal: options?.signal,
        maxBytes: options?.maxOutputBytes,
    });

    return {
        success: exitCode === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        ...(truncated ? { truncated: true } : {}),
    };
}

/**
 * Start a GenesisTools tool detached and return at once, e.g. a dashboard server that must outlive
 * the caller. Resolved like `execTool`, so a worktree runs its own code, not the main checkout's.
 */
export function spawnToolDetached(args: string[], options?: Omit<RunToolOptions, "timeout">): number {
    const proc = Bun.spawn([namedBunExecPath("tools"), "run", getToolsPath(), ...args], {
        cwd: options?.cwd ?? process.cwd(),
        stdio: ["ignore", "ignore", "ignore"],
        // The `tools` wrapper skips its orphan watchdog for this start.
        env: { ...env.getProcessEnv(), ...options?.env, [DETACHED_ENV]: "1" },
        detached: true,
    });
    proc.unref();
    return proc.pid;
}

/**
 * Spawn a GenesisTools tool with inherited stdio (interactive).
 * Usage: `execToolInteractive(["telegram-bot", "configure"])`
 */
export async function execToolInteractive(
    args: string[],
    options?: Omit<RunToolOptions, "timeout">
): Promise<ExecResult> {
    const proc = Bun.spawn([namedBunExecPath("tools"), "run", getToolsPath(), ...args], {
        cwd: options?.cwd ?? process.cwd(),
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...env.getProcessEnv(), ...options?.env },
    });

    const exitCode = await proc.exited;

    return {
        success: exitCode === 0,
        stdout: "",
        stderr: "",
        exitCode,
    };
}
