import type { CallResult } from "../protocol";

/**
 * A door answers one CLI command inside the resident server. `match` returns null for any argv it
 * does not fully understand, so the client runs that argv as a process instead.
 */
export interface CallDoor<P = unknown> {
    kind: "call";
    name: string;
    /**
     * The words every argv this door answers starts with (`["hub", "nav", "record"]`). `match` never accepts an argv
     * without them, so the server can tell a client that no door answers anything under a shorter prefix.
     */
    command: readonly string[];
    match(argv: readonly string[]): P | null;
    run(parsed: P, ctx: { signal: AbortSignal }): Promise<CallResult>;
}

/** A follow: writes lines until the signal aborts or it ends by itself. */
export interface StreamDoor<P = unknown> {
    kind: "stream";
    name: string;
    /** As `CallDoor.command`. */
    command: readonly string[];
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

/**
 * The shortest prefix of `argv` that no door can answer, or null when a door shares every prefix. Any argv that
 * starts with it is a process, so a client may skip the server for it until this server goes away: a door-less call
 * then never waits for a busy server to say "unsupported" (up to 22 s on 2026-10-26).
 */
export function doorlessPrefix(argv: readonly string[], doors: readonly Door[]): string[] | null {
    for (let length = 1; length <= argv.length; length++) {
        const prefix = argv.slice(0, length);
        const shared = doors.some((door) => {
            const common = Math.min(door.command.length, prefix.length);
            return door.command.slice(0, common).every((word, index) => word === prefix[index]);
        });
        if (!shared) {
            return prefix;
        }
    }

    return null;
}
