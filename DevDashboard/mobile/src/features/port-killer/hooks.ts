import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { type KillPortInput, killPort, portKillerKeys, portsQuery } from "@/features/port-killer/queries";
import { useLiveRefetchInterval } from "@/live/provider";

/**
 * Component-facing port-killer hooks (D32). Screens import THESE — never raw `useQuery`/`useMutation`.
 * The read hook feeds the `queryOptions` factory; the kill mutation invalidates the port list on
 * success so a reclaimed port disappears without a manual refetch. Mirrors the terminals feature.
 */

/** The port list. The live `ports` channel writes it (scan plus classify) while the stream is up; else it polls. */
export function usePorts() {
    const refetchInterval = useLiveRefetchInterval("ports");
    return useQuery({ ...portsQuery(useDashboardClient()), refetchInterval });
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
