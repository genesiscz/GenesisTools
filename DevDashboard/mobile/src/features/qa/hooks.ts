import type { QaRow } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { EMPTY_QA_LIVE_WINDOW, type QaLiveStatus, type QaLiveWindow, qaLiveStatus } from "@/features/qa/live-feed";
import { type QaLogParams, qaKeys, qaLogQuery } from "@/features/qa/queries";
import { useLiveChannel, useLiveRefetchInterval, useLiveStatus } from "@/live/provider";

/**
 * Component-facing QA hooks (D32). Components import THESE — never raw `useQuery`/`useMutation` or
 * a raw stream. The mock↔real swap lives in the `ClientProvider`, so a screen renders
 * fixtures or live data unchanged.
 *
 * ► REFERENCE SHAPE every feature copies: `export const useX = () => useQuery(xQuery(useDashboardClient()));`
 */

/** Persisted Q&A log (TanStack v5 query over the injected client). */
export function useQaLog(params: QaLogParams = {}) {
    const refetchInterval = useLiveRefetchInterval("qa");
    return useQuery({ ...qaLogQuery(useDashboardClient(), params), refetchInterval });
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

export interface UseQaLiveResult {
    /** Rows the live `qa` channel delivered this session, newest-first (deduped by id). */
    live: QaRow[];
    /** Coarse liveness of the phone's one live stream for the `qa` channel. */
    status: QaLiveStatus;
}

/**
 * The QA screen's live window. The phone's one live stream (`LiveCacheProvider`) carries the `qa` channel while this
 * hook is mounted, and its cache table prepends each entry to the window (`qaKeys.live`). The stream owns the
 * foreground lifecycle, and its connect resync refetches the persisted log, so a resume needs nothing here.
 */
export function useQaLive(): UseQaLiveResult {
    const queryClient = useQueryClient();
    const streamsQa = useLiveChannel("qa");
    const stream = useLiveStatus();
    // No request: the cache table writes the window. The query function returns what is there, so a refetch is a
    // no-op instead of wiping it.
    const { data } = useQuery({
        queryKey: qaKeys.live,
        queryFn: () => queryClient.getQueryData<QaLiveWindow>(qaKeys.live) ?? EMPTY_QA_LIVE_WINDOW,
        initialData: EMPTY_QA_LIVE_WINDOW,
        staleTime: Number.POSITIVE_INFINITY,
    });

    return { live: data.rows, status: qaLiveStatus(stream, streamsQa, data.rows.length) };
}
