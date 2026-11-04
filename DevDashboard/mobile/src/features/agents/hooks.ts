import type { AgentBoardSession, AgentStopReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useDashboardClient } from "@/api/client-provider";
import { agentsKeys, boardQuery, stopSession, transcriptQuery } from "@/features/agents/queries";
import { useLiveRefetchInterval } from "@/live/provider";

/**
 * Component-facing agents hooks (D32). The board is written by the live `agents` channel while the stream is up
 * (phase frames patch it, a start or an end refetches it) and polls only while it is not.
 */
export function useAgentsBoard() {
    const refetchInterval = useLiveRefetchInterval("agents");
    return useQuery({ ...boardQuery(useDashboardClient()), refetchInterval });
}

/** One session's row from the board cache, so the session view follows the same live phase. */
export function useBoardSession(key: string): AgentBoardSession | undefined {
    const board = useAgentsBoard();
    return board.data?.sessions.find((session) => session.key === key);
}

/** The newest turns of a session, tailed while its screen is focused. */
export function useAgentTranscript(session: Pick<AgentBoardSession, "key" | "sessionId" | "provider">) {
    const focused = useIsFocused();
    const options = transcriptQuery(useDashboardClient(), session);
    return useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
}

/** Ends a session's process tree on the Mac. The board refetches after, so a stopped session leaves it. */
export function useStopSession(onReceipt?: (receipt: AgentStopReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { key: string; pid: number; idempotencyKey: string }) => stopSession(client, input),
        onSuccess: (receipt) => onReceipt?.(receipt),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentsKeys.board });
        },
    });
}
