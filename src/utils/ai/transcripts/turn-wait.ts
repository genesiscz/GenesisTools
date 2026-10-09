/**
 * Wait until a session's current turn ends.
 *
 * - `done`:    the turn ended (the session is at its prompt, or finished).
 * - `stalled`: the turn is running but nothing has been written for longer than the stall limit.
 * - `timeout`: the caller's deadline passed first.
 *
 * `next` waits for a turn that ENDS AFTER the call started: a session already idle at the start is not
 * a finished turn. A turn that starts and ends between two reads still counts, because the marker that
 * moves is the time of the newest turn-level record, not the state. That time can be whole seconds (Grok), so
 * a RUNNING state seen after the call started also marks the turn that ends next as new.
 *
 * Questions come from the agents' question tools, never from the wording of a message. A blocking one
 * (Claude `AskUserQuestion`, Codex `request_user_input`, Grok `ask_user_question`) ends the wait with
 * `asksQuestion`. One asked while the turn keeps running (Codex `request_user_input_async` before more work)
 * does not end it; it is collected in `questions`, so the caller still sees it when the turn ends.
 *
 * `TurnJudge` decides from one snapshot at a time. `waitForTurn` drives it with an injected clock and
 * sleep (the unit tests); `watchTurn` drives it with the shared file watcher, so a write to the transcript
 * wakes it at once and the slow poll only exists to notice silence (a stall) and the deadline.
 */
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { logger } from "@genesiscz/utils/logger";
import type { TurnSnapshot } from "./turn-state";

export type TurnWaitOutcome = "done" | "stalled" | "timeout";

/**
 * Off: a question is what the agent's question tool says (`snapshot.question`). On: a message whose last
 * paragraph ends in `?` or holds `❓` also counts. That wording is one user's prompt convention, so it is a
 * hint at most and never the detector.
 */
export const DECISION_HEURISTICS = false;

/** True when the text's last paragraph asks something: it ends in `?`, or it carries a `❓` marker. */
export function looksLikeQuestion(text: string): boolean {
    const last =
        text
            .trim()
            .split(/\n\s*\n/)
            .at(-1)
            ?.trim() ?? "";

    return last.endsWith("?") || last.includes("❓");
}

/** The question a snapshot carries: the tool call's, else (only with `DECISION_HEURISTICS`) the wording's. */
export function questionOf(snapshot: TurnSnapshot, heuristics: boolean = DECISION_HEURISTICS): string | null {
    if (snapshot.question) {
        return snapshot.question;
    }

    return heuristics && snapshot.lastText && looksLikeQuestion(snapshot.lastText) ? snapshot.lastText.trim() : null;
}

export interface TurnWaitResult {
    outcome: TurnWaitOutcome;
    /** The last snapshot read. Null when the transcript never held a record. */
    snapshot: TurnSnapshot | null;
    /** How long this call waited. */
    waitedMs: number;
    /** Questions the agent asked while the turn ran and then went on working, oldest first. */
    questions: string[];
}

function endedTurn(snapshot: TurnSnapshot): boolean {
    return snapshot.state === "AWAITING-INPUT" || snapshot.state === "FINISHED";
}

/** A transcript that was read and then stays unreadable this long (Codex moved it to `archived_sessions`,
 *  the file was deleted) ends the wait as `stalled`: no write can ever wake it again. */
export const TRANSCRIPT_GONE_MS = 30_000;

export class TurnJudge {
    readonly questions: string[] = [];
    private snapshot: TurnSnapshot | null = null;
    private missingSince: number | null = null;
    private sawRunning = false;

    constructor(
        private readonly options: {
            next: boolean;
            baselineEnd: number | null;
            startedAt: number;
            now: () => number;
            /** Only a turn that began at or after this instant counts (see `WaitForTurnOptions.turnStartedAfter`). */
            turnStartedAfter?: number;
            /** See `WaitForTurnOptions.turnNewerThan`. */
            turnNewerThan?: number;
            /** See `WaitForTurnOptions.openedFromByte`. */
            openedFromByte?: number;
        }
    ) {}

    /** The outcome this snapshot settles, or null to keep waiting. */
    step(snapshot: TurnSnapshot | null): TurnWaitResult | null {
        if (!snapshot) {
            if (this.snapshot === null) {
                return null;
            }

            // Keep the last snapshot read, so the report still names the state the session was in.
            this.missingSince ??= this.options.now();

            return this.options.now() - this.missingSince >= TRANSCRIPT_GONE_MS ? this.result("stalled") : null;
        }

        this.snapshot = snapshot;
        this.missingSince = null;

        const ended = endedTurn(snapshot);

        // Grok stamps records in whole seconds, so a turn that ends in the baseline's second has the same time.
        // A running turn seen since the call started is a turn that ends after it, whatever its time.
        if (snapshot.state === "RUNNING") {
            this.sawRunning = true;
        }

        const isNew =
            !this.options.next || this.sawRunning || (snapshot.lastEventAt ?? 0) > (this.options.baselineEnd ?? 0);
        // A turn whose start is outside the tail (null) cannot be told apart, so it counts, as it did before.
        // This also keeps the running-turn rule above honest for `message --wait`: seeing the turn that was
        // already running when the message was sent makes its end "new", but it did not begin after the send.
        const answering =
            snapshot.turnStartedAt === null ||
            turnAnswers(snapshot.turnStartedAt, this.options, snapshot.turnStartOffset);

        if (ended && isNew && answering) {
            return this.result("done");
        }

        const question = ended ? null : questionOf(snapshot);

        if (question && this.questions.at(-1) !== question) {
            this.questions.push(question);
        }

        return snapshot.state === "STALLED" ? this.result("stalled") : null;
    }

    result(outcome: TurnWaitOutcome): TurnWaitResult {
        return {
            outcome,
            snapshot: this.snapshot,
            waitedMs: this.options.now() - this.options.startedAt,
            questions: [...this.questions],
        };
    }
}

/**
 * Does a turn that began at `turnStartedAt` answer a sent message? It must begin at or after `turnStartedAfter`, and
 * after `turnNewerThan` (the start of the turn that was current before the send): that turn, ended or still
 * running, was not started by the message, even when it began within the timestamp tolerance. A turn that began in
 * the very same instant (Grok stamps whole seconds) counts only when its opening record lies at or past
 * `openedFromByte`, the transcript's size before the send: the file only grows, so it opened after the send.
 * Equal prompt text proves nothing, since the same message can be sent twice.
 */
export function turnAnswers(
    turnStartedAt: number,
    window: { turnStartedAfter?: number; turnNewerThan?: number; openedFromByte?: number },
    turnStartOffset?: number
): boolean {
    if (window.turnStartedAfter !== undefined && turnStartedAt < window.turnStartedAfter) {
        return false;
    }

    if (window.turnNewerThan === undefined || turnStartedAt > window.turnNewerThan) {
        return true;
    }

    return (
        turnStartedAt === window.turnNewerThan &&
        window.openedFromByte !== undefined &&
        turnStartOffset !== undefined &&
        turnStartOffset >= window.openedFromByte
    );
}

export interface WaitForTurnOptions {
    read: () => TurnSnapshot | null;
    /** Ignore an already finished turn; wait for the next one to finish. */
    next?: boolean;
    /**
     * Only a turn that began at or after this instant (epoch ms) ends the wait: `message --wait` on a busy session
     * must not take the end of the turn that was running when its message was queued as the answer.
     */
    turnStartedAfter?: number;
    /** Only a turn that began strictly after this instant ends the wait (see `turnAnswers`). */
    turnNewerThan?: number;
    /** The transcript's byte size before the send: a turn that began in the same instant as `turnNewerThan` counts
     *  when it opened at or past it (see `turnAnswers`). */
    openedFromByte?: number;
    /** Give up after this long. Undefined waits for ever. */
    timeoutMs?: number;
    /** Time between two reads. */
    pollMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    /** Called with every snapshot read, including the last one. One that throws is logged, and the
     *  snapshot is judged anyway. */
    onSnapshot?: (snapshot: TurnSnapshot) => void | Promise<void>;
}

/** Hands the snapshot to the caller's callback. A callback that fails (a `--stream` read) must not stop
 *  the judge: a RUNNING turn has to reach STALLED, and the deadline still has to end the wait. */
async function observe(
    onSnapshot: ((snapshot: TurnSnapshot) => void | Promise<void>) | undefined,
    snapshot: TurnSnapshot | null
): Promise<void> {
    if (!snapshot || !onSnapshot) {
        return;
    }

    try {
        await onSnapshot(snapshot);
    } catch (err) {
        logger.warn({ err, state: snapshot.state }, "[transcripts] turn wait: the snapshot callback threw");
    }
}

function judgeFor(options: {
    read: () => TurnSnapshot | null;
    next?: boolean;
    turnStartedAfter?: number;
    turnNewerThan?: number;
    openedFromByte?: number;
    now: () => number;
}): TurnJudge {
    return new TurnJudge({
        next: options.next === true,
        baselineEnd: options.next ? (options.read()?.lastEventAt ?? 0) : null,
        startedAt: options.now(),
        now: options.now,
        turnStartedAfter: options.turnStartedAfter,
        turnNewerThan: options.turnNewerThan,
        openedFromByte: options.openedFromByte,
    });
}

/** The polling form, with an injected clock and sleep. */
export async function waitForTurn(options: WaitForTurnOptions): Promise<TurnWaitResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const judge = judgeFor({
        read: options.read,
        next: options.next,
        turnStartedAfter: options.turnStartedAfter,
        turnNewerThan: options.turnNewerThan,
        openedFromByte: options.openedFromByte,
        now,
    });
    const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : now() + options.timeoutMs;

    while (true) {
        const snapshot = options.read();
        await observe(options.onSnapshot, snapshot);
        const settled = judge.step(snapshot);

        if (settled) {
            return settled;
        }

        const remaining = deadline - now();

        if (remaining <= 0 || options.signal?.aborted) {
            return judge.result("timeout");
        }

        await sleep(Math.min(options.pollMs, remaining));
    }
}

export interface WatchTurnOptions {
    /** The transcript file to watch. */
    path: string;
    read: () => TurnSnapshot | null;
    next?: boolean;
    /** See `WaitForTurnOptions.turnStartedAfter`. */
    turnStartedAfter?: number;
    /** See `WaitForTurnOptions.turnNewerThan`. */
    turnNewerThan?: number;
    /** See `WaitForTurnOptions.openedFromByte`. */
    openedFromByte?: number;
    timeoutMs?: number;
    /** The safety poll: how soon silence (a stall) and the deadline are noticed. Writes wake at once. */
    pollMs: number;
    signal?: AbortSignal;
    /** As in `waitForTurn`: one that throws is logged, and the snapshot is judged anyway. */
    onSnapshot?: (snapshot: TurnSnapshot) => void | Promise<void>;
}

/** The event-driven form: the shared file watcher wakes it on every write to the transcript. */
export async function watchTurn(options: WatchTurnOptions): Promise<TurnWaitResult> {
    const judge = judgeFor({
        read: options.read,
        next: options.next,
        turnStartedAfter: options.turnStartedAfter,
        turnNewerThan: options.turnNewerThan,
        openedFromByte: options.openedFromByte,
        now: Date.now,
    });
    let settled: TurnWaitResult | null = null;
    // The watcher checks its deadline only on a write or a poll, so a quiet transcript would overrun
    // `--timeout` by up to one poll. A timer aborts it on time instead.
    const deadline = new AbortController();
    const timer = options.timeoutMs === undefined ? null : setTimeout(() => deadline.abort(), options.timeoutMs);
    const signals = options.signal ? [deadline.signal, options.signal] : [deadline.signal];

    try {
        await watchFileFeed({
            path: options.path,
            debounceMs: 100,
            pollFallbackMs: options.pollMs,
            signal: AbortSignal.any(signals),
            onChange: async () => {
                const snapshot = options.read();
                await observe(options.onSnapshot, snapshot);
                settled = judge.step(snapshot);

                return settled ? { done: true } : undefined;
            },
        });
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }

    return settled ?? judge.result("timeout");
}
