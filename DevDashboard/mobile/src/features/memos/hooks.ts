import type { MemoActionKind } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { idempotencyKey } from "@/features/answer-queue/units";
import { actOnMemo, memosKeys, memosQuery } from "@/features/memos/queries";

export function useMemos() {
    return useQuery(memosQuery(useDashboardClient()));
}

export function useActOnMemo() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { id: string; action: MemoActionKind; sessionKey?: string }) =>
            actOnMemo(client, { ...input, idempotencyKey: idempotencyKey() }),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: memosKeys.list });
        },
    });
}
