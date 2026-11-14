import type { QaRow } from "@dd/contract";
import { useMutation } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { clipLink, saveQaAnswer } from "@/features/vault/queries";
import { idempotencyKey } from "@/lib/idempotency";

export function useClipLink() {
    const client = useDashboardClient();
    return useMutation({
        mutationFn: (input: { url: string; note?: string }) => clipLink(client, { ...input, idempotencyKey: idempotencyKey() }),
    });
}

/** Saves a Q→A answer to the vault; a clipped answer is read whole first. */
export function useSaveQaAnswer() {
    const client = useDashboardClient();
    return useMutation({
        mutationFn: (entry: QaRow) => saveQaAnswer(client, { entry, idempotencyKey: idempotencyKey() }),
    });
}
