import type { AskForm } from "@app/question/lib/pending/types";

/**
 * How the /qa Pending section folds a REST snapshot together with the live SSE stream.
 *
 * Pure on purpose, and in `lib/` rather than in the hook, so the awkward cases can be tested
 * directly the way `qa-session-actions` is. The awkward cases are all orderings:
 *
 * - a snapshot taken BEFORE an answer can arrive AFTER it, and must not re-add the card;
 * - a form answered by ANOTHER client while this tab's stream was down disappears from every
 *   later snapshot, and must not stay on screen forever;
 * - a form created AFTER the snapshot was taken arrives only on the stream, and must survive
 *   the next snapshot that could not have known about it.
 */
export interface PendingMergeInput {
    /** Newest REST snapshot: the forms the server currently considers pending. */
    snapshot: AskForm[];
    /** What is on screen now. */
    previous: Map<string, AskForm>;
    /** Ids the stream has already reported as answered, cancelled or timed out. */
    resolved: ReadonlySet<string>;
    /** When each id last changed on the stream. */
    lastSseAt: ReadonlyMap<string, number>;
    /** When the snapshot was produced. */
    fetchedAt: number;
}

let sequence = 0;

/**
 * A strictly increasing marker for request/frame ordering, in place of `Date.now()`.
 *
 * `Date.now()`'s millisecond resolution can return the same value for a snapshot's `fetchedAt`
 * stamp and an SSE frame recorded a moment later, so `mergePendingSnapshot`'s strict `>` then
 * drops a form that should have survived. A counter can never tie: two calls in the same JS
 * turn still land in call order, regardless of what the clock reads.
 */
export function nextPendingSequence(): number {
    sequence += 1;

    return sequence;
}

export function mergePendingSnapshot(input: PendingMergeInput): Map<string, AskForm> {
    const next = new Map<string, AskForm>();

    for (const form of input.snapshot) {
        // A snapshot row must never resurrect a form the stream already resolved.
        if (!input.resolved.has(form.id)) {
            next.set(form.id, form);
        }
    }

    for (const [id, form] of input.previous) {
        // Keep only what the stream delivered AFTER this snapshot was taken; the server could
        // not have included it. Anything older is absent because it is genuinely gone.
        if (!next.has(id) && !input.resolved.has(id) && (input.lastSseAt.get(id) ?? 0) > input.fetchedAt) {
            next.set(id, form);
        }
    }

    return next;
}

/** Fold one lifecycle frame into the map. A resolved form leaves the section. */
export function applyPendingFrame(
    previous: Map<string, AskForm>,
    frame: { id: string; form: AskForm },
    resolved: Set<string>
): Map<string, AskForm> {
    const next = new Map(previous);

    if (frame.form.status !== "pending") {
        resolved.add(frame.id);
        next.delete(frame.id);

        return next;
    }

    // The server attaches its tailer before reading the snapshot, so a `created` frame can
    // arrive for a form that was resolved in between. The tombstone is what keeps that
    // duplicate from putting the card back.
    if (!resolved.has(frame.id)) {
        next.set(frame.id, frame.form);
    }

    return next;
}
