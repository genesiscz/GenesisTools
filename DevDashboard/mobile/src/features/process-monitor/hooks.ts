import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import {
    DEFAULT_LIMIT,
    type KillProcessInput,
    killProcess,
    processesQuery,
} from "@/features/process-monitor/queries";
import type { ProcessSort } from "@/features/process-monitor/types";

/**
 * Component-facing Process Monitor hooks (D32). Components import THESE — never raw `useQuery`/
 * `useMutation`. The query hook is a one-liner over the active client; the kill mutation wraps
 * `useMutation` over the same client and invalidates the `["process-monitor"]` PREFIX on success so
 * BOTH sort caches refetch (mirrors `useCompleteTodo` invalidating `["todos", "list"]`).
 */

export function useProcesses(sort: ProcessSort, limit = DEFAULT_LIMIT) {
    return useQuery(processesQuery(useDashboardClient(), sort, limit));
}

export function useKillProcess() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: KillProcessInput) => killProcess(client, input),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["process-monitor"] });
        },
    });
}
