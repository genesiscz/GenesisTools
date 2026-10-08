/**
 * Wait until a session's current turn ends. The clock, the sleep and the reader arrive as arguments, so
 * every branch is a unit test with no file and no real wait.
 *
 * - `done`:    the turn ended (the session is at its prompt, or finished).
 * - `stalled`: the turn is running but nothing has been written for longer than the stall limit.
 * - `timeout`: the caller's deadline passed first.
 *
 * `next` waits for a turn that ENDS AFTER the call started: a session already idle at the start is not
 * a finished turn. A turn that starts and ends between two polls still counts, because the marker that
 * moves is the time of the newest turn-level record, not the state.
 */
import type { TurnSnapshot } from "./turn-state";

export type TurnWaitOutcome = "done" | "stalled" | "timeout";

export interface WaitForTurnOptions {
    read: () => TurnSnapshot | null;
    /** Ignore an already finished turn; wait for the next one to finish. */
    next?: boolean;
    /** Give up after this long. Undefined waits for ever. */
    timeoutMs?: number;
    /** Time between two reads. */
    pollMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    /** Called with every snapshot read, including the last one. */
    onSnapshot?: (snapshot: TurnSnapshot) => void | Promise<void>;
}

export interface TurnWaitResult {
    outcome: TurnWaitOutcome;
    /** The last snapshot read. Null when the transcript never held a record. */
    snapshot: TurnSnapshot | null;
    /** How long this call waited. */
    waitedMs: number;
}

function endedTurn(snapshot: TurnSnapshot): boolean {
    return snapshot.state === "AWAITING-INPUT" || snapshot.state === "FINISHED";
}

export async function waitForTurn(options: WaitForTurnOptions): Promise<TurnWaitResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const startedAt = now();
    const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : startedAt + options.timeoutMs;
    const baselineEnd = options.next ? (options.read()?.lastEventAt ?? 0) : null;
    let snapshot: TurnSnapshot | null = null;

    while (true) {
        snapshot = options.read();

        if (snapshot) {
            await options.onSnapshot?.(snapshot);
        }

        const waitedMs = now() - startedAt;

        if (snapshot && endedTurn(snapshot) && (baselineEnd === null || (snapshot.lastEventAt ?? 0) > baselineEnd)) {
            return { outcome: "done", snapshot, waitedMs };
        }

        if (snapshot?.state === "STALLED") {
            return { outcome: "stalled", snapshot, waitedMs };
        }

        const remaining = deadline - now();

        if (remaining <= 0 || options.signal?.aborted) {
            return { outcome: "timeout", snapshot, waitedMs };
        }

        await sleep(Math.min(options.pollMs, remaining));
    }
}
