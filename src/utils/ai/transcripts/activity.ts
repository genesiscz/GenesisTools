/**
 * Is a coding agent still working, finished, waiting for a person, or stuck?
 *
 * This file only decides. It reads no clock and no file: the time, the file's modification time, a
 * recorded pid's liveness and the events all arrive as arguments, so every branch is a plain unit test.
 * Each harness dialect (`src/utils/agent-sessions/readers/<harness>-turn-state.ts`) turns its transcript records
 * into these events, and `readTurnState` (`turn-state.ts`) is the one place that reads a transcript from disk.
 *
 * `listSubagents` (`subagents.ts`) answers the same question for a sub-agent with a fixed 15 minute silence
 * limit and no waiting-for-input state. This one takes the limit as an argument.
 */
export type ActivityState = "RUNNING" | "FINISHED" | "STALLED" | "AWAITING-INPUT";

export type ActivityEventKind = "start" | "output" | "exit" | "question";

/** One thing an agent did, whatever the source recorded it as. */
export interface ActivityEvent {
    /** Epoch ms when the event happened. */
    ts: number;
    kind: ActivityEventKind;
    /** Exit status when `kind` is `exit`. */
    exitCode?: number;
    /** A line of output or the question text, for a preview. */
    text?: string;
}

export interface ClassifyActivityInput {
    /** Oldest first. May be empty. */
    events: ActivityEvent[];
    /** Epoch ms the log file or directory was last written. */
    lastModified: number;
    /** The current time in epoch ms. A caller passes it in, so a test can fix it. */
    now: number;
    /** Silence longer than this is a stall. */
    stallTimeoutMs: number;
    /**
     * Whether the agent's process is alive, resolved by the caller:
     * `true` is confirmed alive, `false` is confirmed gone (the agent is `FINISHED` even without an exit
     * event), `undefined` means no pid is known and only the events and the timing count.
     */
    pidAlive?: boolean;
}

/**
 * The decision order is the contract:
 * 1. An exit event is `FINISHED`, and outranks everything.
 * 2. A latest event that is a question is `AWAITING-INPUT`. A prompt is not a stall, however long it waits.
 * 3. A process confirmed gone is `FINISHED`.
 * 4. Silence past `stallTimeoutMs` is `STALLED`. Silence is the newer of the last event and `lastModified`.
 * 5. Anything else is `RUNNING`.
 */
export function classifyActivity(input: ClassifyActivityInput): ActivityState {
    const { events, lastModified, now, stallTimeoutMs, pidAlive } = input;
    const last = events.at(-1);

    if (events.some((event) => event.kind === "exit")) {
        return "FINISHED";
    }

    if (last?.kind === "question") {
        return "AWAITING-INPUT";
    }

    if (pidAlive === false) {
        return "FINISHED";
    }

    const lastActivity = last ? Math.max(last.ts, lastModified) : lastModified;

    if (now - lastActivity > stallTimeoutMs) {
        return "STALLED";
    }

    return "RUNNING";
}
