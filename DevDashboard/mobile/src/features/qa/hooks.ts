import type { QaRow } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { type QaLogParams, qaLogQuery } from "@/features/qa/queries";
import {
    openQaSubscription,
    type QaLiveStatus,
    type QaSubscriptionHandle,
} from "@/features/qa/subscription";

/**
 * Component-facing QA hooks (D32). Components import THESE — never raw `useQuery`/`useMutation` or
 * raw `client.qa.subscribe`. The mock↔real swap lives in the `ClientProvider`, so a screen renders
 * fixtures or live data unchanged.
 *
 * ► REFERENCE SHAPE every feature copies: `export const useX = () => useQuery(xQuery(useDashboardClient()));`
 */

/** Persisted Q&A log (TanStack v5 query over the injected client). */
export function useQaLog(params: QaLogParams = {}) {
    return useQuery(qaLogQuery(useDashboardClient(), params));
}

/**
 * Mark entries read / unread (`POST /api/qa/read`) and refresh the persisted log so the
 * `readAt`-derived unread state stays consistent. Best-effort, mirrors the web flush.
 */
export function useMarkRead() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ ids, unread = false }: { ids: string[]; unread?: boolean }) =>
            client.qa.read(ids, unread),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["qa", "log"] });
        },
    });
}

export interface UseQaStreamResult {
    /** Rows received live over SSE this session, newest-first (deduped by id). */
    live: QaRow[];
    /** Coarse liveness: "connecting" until the first row, then "live" (see subscription.ts note). */
    status: QaLiveStatus;
}

/**
 * Wraps the contract's QA SSE subscription with proper React lifecycle: it opens a deduped
 * subscription on mount, tears it down on unmount, and on AppState `active` re-opens the stream and
 * refetches the persisted log (the web resync model — server/tmux hold state; we re-merge + dedupe
 * by id on resume; no `Last-Event-ID` since the server emits no `id:` lines). Backgrounding closes
 * the stream so a suspended app holds no open socket.
 *
 * `onResume` lets the screen trigger the persisted-log refetch (so the merge re-reconciles); the
 * live buffer is preserved across a resume (only the connection is re-established).
 */
export function useQaStream(options: { onResume?: () => void } = {}): UseQaStreamResult {
    const client = useDashboardClient();
    const [live, setLive] = useState<QaRow[]>([]);
    const [status, setStatus] = useState<QaLiveStatus>("connecting");
    const handleRef = useRef<QaSubscriptionHandle | null>(null);
    const onResumeRef = useRef(options.onResume);
    onResumeRef.current = options.onResume;

    const pushLive = useCallback((entry: QaRow) => {
        setLive((prev) => {
            if (entry.id != null && prev.some((r) => r.id === entry.id)) {
                return prev;
            }

            return [entry, ...prev];
        });
    }, []);

    useEffect(() => {
        function open(): void {
            handleRef.current?.close();
            setStatus("connecting");
            handleRef.current = openQaSubscription(client, { onRow: pushLive, onStatus: setStatus });
        }

        function close(): void {
            handleRef.current?.close();
            handleRef.current = null;
        }

        open();

        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            if (next === "active") {
                open();
                onResumeRef.current?.();
            } else {
                close();
            }
        });

        return () => {
            sub.remove();
            close();
        };
    }, [client, pushLive]);

    return { live, status };
}
