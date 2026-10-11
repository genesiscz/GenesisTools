import { statSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { transcriptEnvelope, transcriptSnapshot } from "./load";
import type { ResolvedTranscript } from "./resolve";
import { followTranscript } from "./tail";
import {
    isTurnProvider,
    LIVE_STALL_MS,
    type LiveActivity,
    liveActivityOf,
    readTurnState,
    type TurnProvider,
    type TurnSnapshot,
    toolSummaryOf,
} from "./turn-state";
import type { TranscriptEnvelope, TranscriptTurn } from "./types";

/**
 * Turns one live follow re-reads per change at most. The window starts at the oldest turn that can
 * still change, so it holds a handful of turns; this only bounds a burst.
 */
const LIVE_WINDOW = 1000;

export interface LiveFollowOptions {
    /** The first turn to send, 0-based: a UI passes its window's last turn, which may still grow. */
    offset: number;
    /** One JSON line of output. */
    write: (line: string) => void;
    signal?: AbortSignal;
}

/**
 * What a UI needs to follow a transcript with one process: every turn from `offset` on, sent again
 * each time it changes, with its session-wide `index` so the reader replaces the row it has; then a
 * `totals` line (the whole transcript's totals, `terminated`, `nextOffset`, `turnCount`) whenever a
 * change was sent. `followTranscriptLive` adds an `activity` line (`LiveActivityTracker`) after them.
 * Unlike `--format jsonl -f` nothing is held back, and the follow does not stop when
 * the transcript ends: a worker's next steer writes another turn file. The caller stops it.
 */
export class LiveTurnStream {
    private readonly sent = new Map<number, string>();
    private lastTotals = "";
    /** The re-read window starts here: the oldest turn that can still change. */
    offset: number;

    constructor(
        offset: number,
        private readonly write: (line: string) => void
    ) {
        this.offset = offset;
    }

    /** `advance: false` sends the turns without moving the re-read window (a page drained past it). */
    envelope(envelope: TranscriptEnvelope, { advance = true }: { advance?: boolean } = {}): void {
        const start = envelope.nextOffset - envelope.turns.length;
        let wrote = false;
        for (const [position, turn] of envelope.turns.entries()) {
            const index = start + position;
            const line = SafeJSON.stringify({ ...turn, index }, { strict: true });
            if (this.sent.get(index) === line) {
                continue;
            }

            this.sent.set(index, line);
            this.write(line);
            wrote = true;
        }

        const totals = SafeJSON.stringify(
            {
                kind: "totals",
                ...envelope.totals,
                terminated: envelope.terminated ?? null,
                nextOffset: envelope.nextOffset,
                turnCount: envelope.turnCount ?? envelope.nextOffset,
            },
            { strict: true }
        );
        if (wrote || totals !== this.lastTotals) {
            this.lastTotals = totals;
            this.write(totals);
        }

        if (advance) {
            this.settle(start, envelope.turns);
        }
    }

    /** A turn before the last one whose tools all have results no longer changes: stop re-reading it. */
    private settle(start: number, turns: readonly TranscriptTurn[]): void {
        if (turns.length === 0) {
            return;
        }

        const next = firstOpenTurn(start, turns);
        if (next <= this.offset) {
            return;
        }

        this.offset = next;
        for (const index of this.sent.keys()) {
            if (index < next) {
                this.sent.delete(index);
            }
        }
    }
}

/** The oldest turn of a page that can still change: one with a tool still waiting for its result, else the last. */
export function firstOpenTurn(start: number, turns: readonly TranscriptTurn[]): number {
    const open = turns.findIndex(
        (turn, position) => position === turns.length - 1 || turn.tools.some((tool) => tool.result === null)
    );
    return start + Math.max(open, 0);
}

/**
 * The drain high-water mark after one more page: the oldest turn that can still change. A turn with a
 * tool still waiting holds the mark, the page's last turn included, so no later page moves it past;
 * without one only the last turn read can still change. `open` carries a held turn across pages.
 */
export function drainMark(
    open: number | null,
    start: number,
    turns: readonly TranscriptTurn[]
): { open: number | null; mark: number } {
    const pageOpen = firstOpenTurn(start, turns);
    const lastTurn = start + turns.length - 1;
    const lastPending = turns[turns.length - 1]?.tools.some((tool) => tool.result === null) ?? false;
    const held = open ?? (pageOpen < lastTurn || lastPending ? pageOpen : null);
    return { open: held, mark: held ?? lastTurn };
}

/** With no write, the activity is looked at again this often, so a stall shows without one. */
export const ACTIVITY_TICK_MS = 5000;

/**
 * A write is read for the activity this long after it, unless the turn lines it causes come first: the activity line
 * then follows those lines in the same chunk, and the app applies both in one change.
 */
const GROWTH_SETTLE_MS = 250;

/**
 * The `activity` line of a live follow (`{"kind":"activity", …LiveActivity}`), written only when it differs from the
 * last one, so an unchanged activity costs the reader nothing.
 */
export class LiveActivityTracker {
    private last = "";

    constructor(private readonly write: (line: string) => void) {}

    /** True when the line went out. A null activity (an unreadable transcript) keeps the last one. */
    offer(activity: LiveActivity | null): boolean {
        if (!activity) {
            return false;
        }

        // One key order, whatever built the object: the line reads phase first and compares as text.
        const { phase, since, turnStartedAt, tool, openTools, question, stalled, lastEventAt } = activity;
        const line = SafeJSON.stringify(
            { kind: "activity", phase, since, turnStartedAt, tool, openTools, question, stalled, lastEventAt },
            { strict: true }
        );
        if (line === this.last) {
            return false;
        }

        this.last = line;
        this.write(line);
        return true;
    }
}

/** Where the activity comes from: the native transcript's turn state, or the envelope of a worker turn file. */
export interface ActivitySource {
    read(now: number): LiveActivity | null;
    /** The latest envelope of the follow, for a source that reads it. */
    observe?(envelope: TranscriptEnvelope): void;
}

/**
 * The turn state of a native transcript. The tail is read again only when the file's size or modification time moved;
 * otherwise the last snapshot only ages, which can turn a running turn into a stalled one.
 */
export class NativeActivitySource implements ActivitySource {
    private key = "";
    private snapshot: TurnSnapshot | null = null;

    constructor(
        private readonly provider: TurnProvider,
        private readonly filePath: () => string,
        private readonly stallMs = LIVE_STALL_MS
    ) {}

    read(now: number): LiveActivity | null {
        const path = this.filePath();
        let key: string;

        try {
            const stat = statSync(path);
            key = `${path}:${stat.size}:${stat.mtimeMs}`;
        } catch (err) {
            logger.debug({ err, path }, "live follow: the transcript cannot be read for its activity");
            return null;
        }

        if (key !== this.key || !this.snapshot) {
            this.snapshot = readTurnState(this.provider, path, { now, stallTimeoutMs: Number.POSITIVE_INFINITY });
            this.key = key;
        }

        if (!this.snapshot) {
            return null;
        }

        return liveActivityOf({ ...this.snapshot, silenceMs: now - this.snapshot.lastActivityAt }, this.stallMs);
    }
}

/**
 * A worker turn file (codex and grok events the turn-state readers do not parse): a terminal event ends the turn, a
 * call with no result in the last turn runs, anything else is the model at work.
 */
export function envelopeActivity(
    envelope: TranscriptEnvelope,
    lastModified: number,
    now: number,
    stallMs = LIVE_STALL_MS
): LiveActivity {
    const last = envelope.turns.at(-1);
    const parsed = last?.at ? Date.parse(last.at) : Number.NaN;
    const lastEventAt = Number.isNaN(parsed) ? null : parsed;
    const base = { turnStartedAt: null, lastEventAt, tool: null, openTools: 0, question: null, stalled: false };

    if (envelope.terminated) {
        return { ...base, phase: "idle", since: lastEventAt };
    }

    const lastWrite = Math.max(lastModified, lastEventAt ?? 0);
    const stalled = now - lastWrite > stallMs;
    const open = last?.tools.filter((tool) => tool.result === null) ?? [];
    const first = open[0];

    if (first) {
        const tool = {
            id: first.id,
            name: first.name,
            summary: toolSummaryOf(first.inputPreview),
            startedAt: lastEventAt,
        };
        return { ...base, phase: "tool", since: lastEventAt, tool, openTools: open.length, stalled };
    }

    return { ...base, phase: "thinking", since: lastWrite, stalled };
}

class EnvelopeActivitySource implements ActivitySource {
    private envelope: TranscriptEnvelope | null = null;

    constructor(private readonly filePath: () => string) {}

    observe(envelope: TranscriptEnvelope): void {
        this.envelope = envelope;
    }

    read(now: number): LiveActivity | null {
        if (!this.envelope) {
            return null;
        }

        try {
            return envelopeActivity(this.envelope, statSync(this.filePath()).mtimeMs, now);
        } catch (err) {
            logger.debug({ err, path: this.filePath() }, "live follow: the worker turn file cannot be read");
            return null;
        }
    }
}

export function activitySourceFor(resolved: ResolvedTranscript): ActivitySource | null {
    const filePath = () => resolved.filePath;

    if (resolved.source === "worker") {
        return new EnvelopeActivitySource(filePath);
    }

    return isTurnProvider(resolved.provider) ? new NativeActivitySource(resolved.provider, filePath) : null;
}

export async function followTranscriptLive(resolved: ResolvedTranscript, options: LiveFollowOptions): Promise<void> {
    const stream = new LiveTurnStream(options.offset, options.write);
    const activity = new LiveActivityTracker(options.write);
    const source = activitySourceFor(resolved);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const evaluate = (): void => {
        clearTimeout(settle);
        settle = undefined;

        if (source && !options.signal?.aborted) {
            activity.offer(source.read(Date.now()));
        }
    };
    // Not a poll of the transcript: one `stat` per tick, the tail only after a write the follow did not see.
    const tick = source ? setInterval(evaluate, ACTIVITY_TICK_MS) : undefined;
    // followTranscript reads this object on every change, so moving `offset` narrows the next read.
    const slice = { offset: options.offset, limit: LIVE_WINDOW };
    let draining: Promise<void> | null = null;
    let wanted: number | null = null;
    // Drained pages before this turn are settled: a later drain starts here, not at the window's end,
    // so a long run behind an open tool is not re-read on every write. It is the oldest drained turn
    // that can still change (an open tool's turn, else the last turn read).
    let drainedTo = 0;

    // A read is capped at LIVE_WINDOW turns. When more turns sit past it (the app was away while a
    // worker wrote thousands), the rest is read page by page now, not on the next file write. The pages
    // never move the re-read window: an open tool in the first page must stay re-read until it ends.
    const drain = async (from: number): Promise<void> => {
        let at = Math.max(from, drainedTo);
        let open: number | null = null;
        const snapshot = resolved.provider === "claude" ? null : await transcriptSnapshot(resolved);

        while (!options.signal?.aborted) {
            const opts = { offset: at, limit: LIVE_WINDOW };
            const page = snapshot ? snapshot(opts) : await transcriptEnvelope(resolved, opts);
            stream.envelope(page, { advance: false });
            const start = page.nextOffset - page.turns.length;

            if (page.turns.length > 0) {
                ({ open, mark: drainedTo } = drainMark(open, start, page.turns));
            }

            if (page.turns.length === 0 || page.nextOffset >= (page.turnCount ?? page.nextOffset)) {
                return;
            }

            at = page.nextOffset;
        }
    };

    // One drain at a time, and growth during a drain asks for ONE more, never a queue of catch-up scans.
    const requestDrain = (from: number): void => {
        wanted = wanted === null ? from : Math.min(wanted, from);

        if (draining) {
            return;
        }

        draining = (async () => {
            while (wanted !== null && !options.signal?.aborted) {
                const next = wanted;
                wanted = null;

                try {
                    await drain(next);
                } catch (error) {
                    logger.warn(
                        { error, file: resolved.filePath, from: next },
                        "live follow: draining capped pages failed"
                    );
                }
            }

            draining = null;
        })();
    };

    try {
        await followTranscript(resolved, {
            slice,
            signal: options.signal,
            onEnvelope: (envelope) => {
                stream.envelope(envelope);
                slice.offset = stream.offset;
                source?.observe?.(envelope);
                evaluate();

                if (envelope.turns.length > 0 && envelope.nextOffset < (envelope.turnCount ?? envelope.nextOffset)) {
                    requestDrain(envelope.nextOffset);
                }
            },
            // A write that changes no turn (Grok's `turn_completed`, Claude's bookkeeping) can still end a turn.
            onGrowth: () => {
                if (source && settle === undefined) {
                    settle = setTimeout(evaluate, GROWTH_SETTLE_MS);
                }
            },
        });
        await draining;
    } finally {
        clearInterval(tick);
        clearTimeout(settle);
    }
}
