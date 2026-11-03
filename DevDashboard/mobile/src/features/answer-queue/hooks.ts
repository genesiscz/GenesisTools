import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import {
    answerForm,
    answerQueueKeys,
    answerQueueQuery,
    type StageInput,
    sendStaged,
    stagePick,
} from "@/features/answer-queue/queries";
import type { Receipt } from "@/features/answer-queue/units";

/**
 * Component-facing answer-queue hooks (D32). Every write invalidates the queue, so a staged pick shows as staged and
 * a sent session drops out on the next read. The idempotency key rides in the variables, so TanStack's retry of the
 * same action sends the same key and the Mac answers it once.
 */

export function useAnswerQueue() {
    return useQuery(answerQueueQuery(useDashboardClient()));
}

/**
 * `onDone` runs on the mutation itself, not on one `mutate` call, so it still runs when the card that sent the write
 * has left the queue; it runs before the invalidation that removes that card.
 */
function useQueueWrite<V, R>(
    write: (client: ReturnType<typeof useDashboardClient>, variables: V) => Promise<R>,
    onDone?: (result: R) => void
) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (variables: V) => write(client, variables),
        onSuccess: (result) => onDone?.(result),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: answerQueueKeys.queue });
        },
    });
}

export function useStagePick() {
    return useQueueWrite((client, input: StageInput) => stagePick(client, input));
}

export function useSendStaged(onReceipt?: (receipt: Receipt) => void) {
    return useQueueWrite(
        (client, input: { session: string; provider?: string; key: string }) => sendStaged(client, input),
        onReceipt
    );
}

export function useAnswerForm(onReceipt?: (receipt: Receipt) => void) {
    return useQueueWrite((client, input: Parameters<typeof answerForm>[1]) => answerForm(client, input), onReceipt);
}
