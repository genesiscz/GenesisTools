import type { PrFixInput, PrFixReceiptDto, PrMergeInput, PrMergeReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { checksQuery, fixPr, mergePr, triageQuery } from "@/features/prs/queries";

/** Component-facing PR triage hooks (D32): the screen and its rows never call the queries directly. */
export function usePrTriage(mine: boolean) {
    return useQuery(triageQuery(useDashboardClient(), mine));
}

/** The checks of one opened PR, with the failing step's log tail. */
export function usePrChecks(url: string) {
    return useQuery(checksQuery(useDashboardClient(), url, true));
}

export function useFixPr(handlers: { onReceipt: (receipt: PrFixReceiptDto) => void; onError: (error: Error) => void }) {
    const client = useDashboardClient();

    return useMutation({
        mutationFn: (input: PrFixInput & { idempotencyKey: string }) => fixPr(client, input),
        onSuccess: handlers.onReceipt,
        onError: handlers.onError,
    });
}

/** A merge refetches the triage list after, so a merged PR leaves it (the list holds open PRs only). */
export function useMergePr(handlers: { onReceipt: (receipt: PrMergeReceiptDto) => void; onError: (error: Error) => void }) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: PrMergeInput & { idempotencyKey: string }) => mergePr(client, input),
        onSuccess: handlers.onReceipt,
        onError: handlers.onError,
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: ["prs", "triage"] });
        },
    });
}
