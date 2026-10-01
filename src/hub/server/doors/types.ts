import type { CallResult } from "../protocol";

/**
 * A door answers one CLI command inside the resident server. `match` returns null for any argv it
 * does not fully understand, so the client runs that argv as a process instead.
 */
export interface CallDoor<P = unknown> {
    kind: "call";
    name: string;
    match(argv: readonly string[]): P | null;
    run(parsed: P, ctx: { signal: AbortSignal }): Promise<CallResult>;
}

/** A follow: writes lines until the signal aborts or it ends by itself. */
export interface StreamDoor<P = unknown> {
    kind: "stream";
    name: string;
    match(argv: readonly string[]): P | null;
    stream(parsed: P, ctx: { signal: AbortSignal; write: (line: string) => void }): Promise<CallResult>;
}

export type Door = CallDoor | StreamDoor;

export function ok(stdout: string): CallResult {
    return { stdout, stderr: "", exit: 0 };
}

/** What the CLI prints when its action throws: the message on stderr and exit 1. */
export function failed(error: unknown): CallResult {
    return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exit: 1 };
}
