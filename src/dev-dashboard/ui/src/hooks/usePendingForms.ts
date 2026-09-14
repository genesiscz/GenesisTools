import { applyPendingFrame, mergePendingSnapshot, nextPendingSequence } from "@app/dev-dashboard/lib/qa-pending-merge";
import type { AskForm } from "@app/question/lib/pending/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQaStream } from "@/hooks/useQaStream";
import { qaPendingApi } from "@/lib/api";

/** A snapshot travels with the sequence marker its REQUEST went out under, not a wall clock. */
export interface PendingSnapshot {
    forms: AskForm[];
    requestedAt: number;
}

/**
 * Read the pending snapshot, stamped with the marker the request was ISSUED under.
 *
 * `mergePendingSnapshot` drops a remembered form whose last stream frame is OLDER than this
 * stamp, because the server would have included it. React Query's `dataUpdatedAt` is the moment
 * the response was STORED, which is after every frame that arrived while the request was in
 * flight — so a form created mid-request looked older than its own snapshot and its card was
 * dropped until something else refetched. `Date.now()` is not precise enough either: a frame
 * recorded a moment after the request, in the same millisecond, would tie rather than win. The
 * marker is a monotonic sequence for exactly that reason — see `nextPendingSequence`.
 *
 * The fetcher is a parameter so the ordering can be tested without a browser or a server.
 */
export async function fetchPendingSnapshot(
    list: () => Promise<{ forms: AskForm[] }> = qaPendingApi.list
): Promise<PendingSnapshot> {
    const requestedAt = nextPendingSequence();

    return { forms: (await list()).forms, requestedAt };
}

/**
 * Merge a REST snapshot with the live SSE lifecycle so the section is right both on first
 * paint and afterwards.
 *
 * The map is keyed by form id and the SSE frame always wins, because it carries the newest
 * status. A form that leaves `pending` is dropped here — the answered copy reappears in the
 * history list as a normal QaEntry, so it never shows twice.
 */
export function usePendingForms(): { forms: AskForm[]; isLoading: boolean; refetch: () => void } {
    const [byId, setById] = useState<Map<string, AskForm>>(() => new Map());
    // Ids the stream already resolved. The snapshot is a REST read taken at request time, so
    // one issued before an answer can still land after it and re-add a card that is gone.
    const resolved = useRef<Set<string>>(new Set());
    // When each id last changed on the stream, so a snapshot cannot delete something it was
    // simply too early to know about.
    const lastSseAt = useRef<Map<string, number>>(new Map());
    const query = useQuery({
        queryKey: ["qa-pending"],
        queryFn: () => fetchPendingSnapshot(),
        retry: false,
        staleTime: 10_000,
    });

    useEffect(() => {
        if (!query.data) {
            return;
        }

        const { forms: snapshot, requestedAt } = query.data;

        setById((prev) =>
            mergePendingSnapshot({
                snapshot,
                previous: prev,
                resolved: resolved.current,
                lastSseAt: lastSseAt.current,
                fetchedAt: requestedAt,
            })
        );
    }, [query.data]);

    useQaStream(
        useCallback((frame) => {
            if (frame.type !== "pending") {
                return;
            }

            lastSseAt.current.set(frame.id, nextPendingSequence());
            setById((prev) => applyPendingFrame(prev, frame, resolved.current));
        }, [])
    );

    // Memoized because consumers put this array in effect dependencies: a fresh identity on
    // every render re-ran the /qa deep-link effect, and that effect issues an HTTP GET.
    const forms = useMemo(
        () => [...byId.values()].filter((form) => form.status === "pending").sort((a, b) => b.createdAt - a.createdAt),
        [byId]
    );

    return { forms, isLoading: query.isLoading, refetch: () => void query.refetch() };
}
