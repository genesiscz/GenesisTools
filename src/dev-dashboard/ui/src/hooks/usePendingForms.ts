import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import type { LiveAskForm } from "@app/dev-dashboard/contract/live";
import {
    applyPendingFrame,
    mergePendingSnapshot,
    nextPendingSequence,
    stampStreamSnapshot,
} from "@app/dev-dashboard/lib/qa-pending-merge";
import type { AskForm } from "@app/question/lib/pending/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLive } from "@/hooks/useLive";
import { dashboard } from "@/lib/dashboard-client";

/**
 * The live contract keeps `poster` and `transcriptAnchor` opaque for the phone's type check. The web reads its own
 * server, which sends the whole form.
 */
function asAskForm(form: LiveAskForm): AskForm {
    return form as AskForm;
}

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
    list: () => Promise<{ forms: AskForm[] }> = () =>
        dashboard.call(ENDPOINTS.qaPending, {}).then((answer) => ({ forms: answer.forms.map(asAskForm) }))
): Promise<PendingSnapshot> {
    const requestedAt = nextPendingSequence();

    return { forms: (await list()).forms, requestedAt };
}

/**
 * Merge a REST snapshot with the live `pending` channel so the section is right both on first
 * paint and afterwards. The channel's own snapshot frame (sent on connect) folds like a REST
 * snapshot taken the moment it arrives.
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

    useLive(["pending"], {
        onFrame: (frame) => {
            if (frame.channel !== "pending") {
                return;
            }

            if (frame.type === "snapshot") {
                const snapshot = frame.payload.forms.map(asAskForm);
                const fetchedAt = nextPendingSequence();
                stampStreamSnapshot(snapshot, lastSseAt.current, fetchedAt);

                setById((prev) =>
                    mergePendingSnapshot({
                        snapshot,
                        previous: prev,
                        resolved: resolved.current,
                        lastSseAt: lastSseAt.current,
                        fetchedAt,
                    })
                );
                return;
            }

            const { id, form } = frame.payload;
            lastSseAt.current.set(id, nextPendingSequence());
            setById((prev) => applyPendingFrame(prev, { id, form: asAskForm(form) }, resolved.current));
        },
    });

    // Memoized because consumers put this array in effect dependencies: a fresh identity on
    // every render re-ran the /qa deep-link effect, and that effect issues an HTTP GET.
    const forms = useMemo(
        () => [...byId.values()].filter((form) => form.status === "pending").sort((a, b) => b.createdAt - a.createdAt),
        [byId]
    );

    return { forms, isLoading: query.isLoading, refetch: () => void query.refetch() };
}
