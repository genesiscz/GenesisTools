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
 * A question the agent asks in passing (a message that ends in `?` while the turn keeps running, which is
 * how Codex and Grok ask) does not end the wait. It is collected in `questions`, so the caller still sees
 * it when the turn ends. A blocking question (Claude `AskUserQuestion`) ends the turn and the wait.
 *
 * `TurnJudge` decides from one snapshot at a time. `waitForTurn` drives it with an injected clock and
 * sleep (the unit tests); `watchTurn` drives it with the shared file watcher, so a write to the transcript
 * wakes it at once and the slow poll only exists to notice silence (a stall) and the deadline.
 */
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { logger } from "@genesiscz/utils/logger";
import type { TurnSnapshot } from "./turn-state";

export type TurnWaitOutcome = "done" | "stalled" | "timeout";

export interface TurnWaitResult {
    outcome: TurnWaitOutcome;
    /** The last snapshot read. Null when the transcript never held a record. */
    snapshot: TurnSnapshot | null;
    /** How long this call waited. */
    waitedMs: number;
    /** Questions the agent asked while the turn ran and then went on working, oldest first. */
    questions: string[];
}

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
        private readonly options: { next: boolean; baselineEnd: number | null; startedAt: number; now: () => number }
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

        if (ended && isNew) {
            return this.result("done");
        }

        if (!ended && snapshot.lastText && looksLikeQuestion(snapshot.lastText)) {
            const question = snapshot.lastText.trim();

            if (this.questions.at(-1) !== question) {
                this.questions.push(question);
            }
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

function judgeFor(options: { read: () => TurnSnapshot | null; next?: boolean; now: () => number }): TurnJudge {
    return new TurnJudge({
        next: options.next === true,
        baselineEnd: options.next ? (options.read()?.lastEventAt ?? 0) : null,
        startedAt: options.now(),
        now: options.now,
    });
}

/** The polling form, with an injected clock and sleep. */
export async function waitForTurn(options: WaitForTurnOptions): Promise<TurnWaitResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const judge = judgeFor({ read: options.read, next: options.next, now });
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
    timeoutMs?: number;
    /** The safety poll: how soon silence (a stall) and the deadline are noticed. Writes wake at once. */
    pollMs: number;
    signal?: AbortSignal;
    /** As in `waitForTurn`: one that throws is logged, and the snapshot is judged anyway. */
    onSnapshot?: (snapshot: TurnSnapshot) => void | Promise<void>;
}

/** The event-driven form: the shared file watcher wakes it on every write to the transcript. */
export async function watchTurn(options: WatchTurnOptions): Promise<TurnWaitResult> {
    const judge = judgeFor({ read: options.read, next: options.next, now: Date.now });
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
