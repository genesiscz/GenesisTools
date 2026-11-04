import type { AgentNewInput, AgentNewReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { agentsKeys } from "@/features/agents/queries";
import { launchQuery, startAgent } from "@/features/launch/queries";

export function useLaunchOptions() {
    return useQuery(launchQuery(useDashboardClient()));
}

/** Starts an agent on the Mac; the agents board refetches so the new session shows. */
export function useStartAgent(onReceipt: (receipt: AgentNewReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: AgentNewInput & { idempotencyKey: string }) => startAgent(client, input),
        onSuccess: onReceipt,
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentsKeys.board });
        },
    });
}
