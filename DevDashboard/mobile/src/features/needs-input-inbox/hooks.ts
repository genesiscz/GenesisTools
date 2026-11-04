import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { attentionKeys, attentionQuery } from "@/features/needs-input-inbox/queries";
import { useLiveRefetchInterval } from "@/live/provider";

/**
 * Component-facing Needs-Input Inbox hooks (D32). Components import THESE — never raw `useQuery`/
 * `useMutation`. `useAttention` is the query over the active client; `useResolveAttention` wraps the
 * existing `client.qa.read` (no new mutation route) and invalidates the attention list on success so
 * a resolved question drops out of the queue on the next fetch.
 *
 * ► REFERENCE SHAPE: `useX = () => useQuery(xQuery(useDashboardClient()))`.
 */

/** The attention list. A `qa` entry refetches it while the stream is up; else it polls. */
export function useAttention() {
    const refetchInterval = useLiveRefetchInterval("qa");
    return useQuery({ ...attentionQuery(useDashboardClient()), refetchInterval });
}

export function useResolveAttention() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (qaId: string) => client.qa.read([qaId], false),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: attentionKeys.list });
        },
    });
}
