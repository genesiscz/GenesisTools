/**
 * Is a background agent still working, finished, waiting for a person, or stuck?
 *
 * This file only decides. It reads no clock and no file: the time, the file's modification time, a
 * recorded pid's liveness and the parsed records all arrive as arguments, so every branch is a plain unit
 * test. `activity-tail.ts` is the one place that reads a Claude transcript from disk.
 *
 * - `classifyActivity`: the decision, from the events an agent produced and the silence since the last.
 * - `claudeRecordsToEvents`: turns Claude transcript records into those events.
 * - `taskLinesToEvents` and `taskPidAlive`: the same for a `tools task` session (its log lines and sidecar).
 * - `isNotableTransition`: the edge gate for an alert, so a stall is announced once and not on every poll.
 *
 * `listSubagents` (`subagents.ts`) answers the same question for a sub-agent with a fixed 15 minute silence
 * limit and no waiting-for-input state. This one takes the limit as an argument.
 */
import type { PidIdentityStatus } from "@genesiscz/utils/process-identity";

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

export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

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

/** The states worth telling a person about. `RUNNING` is the normal case and stays quiet. */
export const NOTABLE_STATES: ReadonlySet<ActivityState> = new Set<ActivityState>([
    "FINISHED",
    "STALLED",
    "AWAITING-INPUT",
]);

/**
 * True when an agent has just entered a notable state: moving from a different state, or being first seen
 * already in one. An unchanged state, a recovery into `RUNNING` and a first sighting of `RUNNING` are quiet.
 */
export function isNotableTransition(previous: ActivityState | undefined, next: ActivityState): boolean {
    if (!NOTABLE_STATES.has(next)) {
        return false;
    }

    return previous !== next;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEpochMs(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isNaN(value) ? undefined : value;
    }

    if (typeof value === "string") {
        const parsed = Date.parse(value);

        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
}

/** The record types that say where a Claude session is. Everything else is bookkeeping. */
const CONVERSATION_RECORDS: ReadonlySet<string> = new Set(["assistant", "user", "result"]);

function asksUser(record: JsonRecord): boolean {
    if (record.type !== "assistant") {
        return false;
    }

    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;

    if (
        Array.isArray(content) &&
        content.some((block) => isRecord(block) && block.type === "tool_use" && block.name === "AskUserQuestion")
    ) {
        return true;
    }

    // A completed turn means the session sits at its prompt, waiting for the user.
    return message?.stop_reason === "end_turn";
}

/**
 * Claude transcript records, oldest first, as events.
 *
 * Only the LAST conversation record (`assistant`, `user` or `result`) can mark a finish or a question.
 * `summary` records sit at the top of compacted sessions and a `result` in the middle belongs to a
 * sub-agent, so treating either as terminal would freeze a live session at `FINISHED`.
 *
 * Records after the last conversation record are bookkeeping (`cost-state`, `system`, `queue-operation`).
 * Measured 2026-10-05: 39 of the 40 most recent transcripts on one machine ended on one of those, so a
 * rule that read the final line saw an end of turn almost never. They produce no event: pass the file's
 * modification time as `lastModified`, which already covers their time. A record without a timestamp
 * produces none.
 */
export function claudeRecordsToEvents(records: ReadonlyArray<Record<string, unknown>>): ActivityEvent[] {
    const stamped = records.flatMap((record) => {
        const ts = toEpochMs(record.timestamp ?? record.ts);

        return ts === undefined ? [] : [{ record, ts }];
    });
    const lastConversation = stamped.findLastIndex(
        ({ record }) => typeof record.type === "string" && CONVERSATION_RECORDS.has(record.type)
    );
    const upTo = lastConversation === -1 ? stamped.length : lastConversation + 1;

    return stamped.slice(0, upTo).map(({ record, ts }, index): ActivityEvent => {
        if (index === lastConversation && record.type === "result") {
            return { kind: "exit", ts };
        }

        if (index === lastConversation && asksUser(record)) {
            return { kind: "question", ts };
        }

        return { kind: "output", ts };
    });
}

/** A line of a `tools task` session log (`~/.genesis-tools/task/sessions/<name>.jsonl`). */
export interface TaskSessionLine {
    type: "meta" | "line" | "exit";
    ts?: number | string;
    text?: string;
    code?: number;
}

/** The sidecar beside it (`<name>.meta.json`). */
export interface TaskSessionMeta {
    pid?: number;
    /** The command line captured when the pid was recorded, so a recycled pid is not mistaken for the session. */
    pidCommand?: string;
    exitCode?: number;
    lastActivityAt?: number;
}

/** Task log lines as events. An `exit` line is the finish; a `line` with a time is output; the rest are skipped. */
export function taskLinesToEvents(lines: ReadonlyArray<TaskSessionLine>): ActivityEvent[] {
    const events: ActivityEvent[] = [];

    for (const line of lines) {
        const ts = toEpochMs(line.ts);

        if (line.type === "exit") {
            events.push({ kind: "exit", ts: ts ?? 0, exitCode: line.code });
        } else if (line.type === "line" && ts !== undefined) {
            events.push({ kind: "output", ts, text: line.text });
        }
    }

    return events;
}

/**
 * Whether a task session's process is alive, as `classifyActivity` wants it.
 *
 * - A recorded `exitCode` means the run is over, whether or not the log has an exit line.
 * - A recorded pid is judged by `probe`, which a caller backs with `classifyPid`. `foreign` counts as gone:
 *   it is a recycled pid, the number now belongs to another program, and reading it as alive would show a
 *   long-dead session as running. `unverified` counts as alive, as the records written before identity
 *   capture existed are.
 * - No pid and no exit code is `undefined`: only the events and the timing decide.
 */
export function taskPidAlive(
    meta: TaskSessionMeta,
    probe: (pid: number, command: string | undefined) => PidIdentityStatus
): boolean | undefined {
    if (meta.exitCode !== undefined) {
        return false;
    }

    if (typeof meta.pid !== "number") {
        return undefined;
    }

    const status = probe(meta.pid, meta.pidCommand);

    return status === "live" || status === "unverified";
}
