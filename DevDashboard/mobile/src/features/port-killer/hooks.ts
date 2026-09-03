import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { type KillPortInput, killPort, portKillerKeys, portsQuery } from "@/features/port-killer/queries";

/**
 * Component-facing port-killer hooks (D32). Screens import THESE — never raw `useQuery`/`useMutation`.
 * The read hook feeds the `queryOptions` factory; the kill mutation invalidates the port list on
 * success so a reclaimed port disappears without a manual refetch. Mirrors the terminals feature.
 */

export function usePorts() {
    return useQuery(portsQuery(useDashboardClient()));
}

export function useKillPort() {
    const client = useDashboardClient();
    const qc = useQueryClient();

    return useMutation({
        mutationFn: (input: KillPortInput) => killPort(client, input),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: portKillerKeys.list });
        },
    });
}
