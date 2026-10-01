import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { transcriptEnvelope } from "./load";
import type { ResolvedTranscript } from "./resolve";
import { followTranscript } from "./tail";
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
 * change was sent. Unlike `--format jsonl -f` nothing is held back, and the follow does not stop when
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

export async function followTranscriptLive(resolved: ResolvedTranscript, options: LiveFollowOptions): Promise<void> {
    const stream = new LiveTurnStream(options.offset, options.write);
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

        while (!options.signal?.aborted) {
            const page = await transcriptEnvelope(resolved, { offset: at, limit: LIVE_WINDOW });
            stream.envelope(page, { advance: false });
            const start = page.nextOffset - page.turns.length;

            if (page.turns.length > 0) {
                const pageOpen = firstOpenTurn(start, page.turns);
                const lastTurn = page.nextOffset - 1;
                // An open tool before the page's last turn keeps its page re-readable; else only the last turn.
                open = open ?? (pageOpen < lastTurn ? pageOpen : null);
                drainedTo = open ?? lastTurn;
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

    await followTranscript(resolved, {
        slice,
        signal: options.signal,
        onEnvelope: (envelope) => {
            stream.envelope(envelope);
            slice.offset = stream.offset;

            if (envelope.turns.length > 0 && envelope.nextOffset < (envelope.turnCount ?? envelope.nextOffset)) {
                requestDrain(envelope.nextOffset);
            }
        },
    });
    await draining;
}
