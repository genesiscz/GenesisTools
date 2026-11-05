import type { ApprovalAnswerInput, ApprovalReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useDashboardClient } from "@/api/client-provider";
import { answerApproval, approvalsKeys, approvalsQuery } from "@/features/approvals/queries";

/** Tool calls that wait for allow or deny; polled only while the screen is on screen. */
export function usePendingApprovals() {
    const focused = useIsFocused();
    const options = approvalsQuery(useDashboardClient());
    return useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
}

export function useAnswerApproval(onReceipt: (receipt: ApprovalReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: ApprovalAnswerInput & { idempotencyKey: string }) => answerApproval(client, input),
        onSuccess: onReceipt,
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: approvalsKeys.list });
        },
    });
}
