import { useMutation } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { idempotencyKey } from "@/features/answer-queue/units";
import { appendText, clipLink } from "@/features/vault/queries";

export function useClipLink() {
    const client = useDashboardClient();
    return useMutation({
        mutationFn: (input: { url: string; note?: string }) => clipLink(client, { ...input, idempotencyKey: idempotencyKey() }),
    });
}

export function useAppendToVault() {
    const client = useDashboardClient();
    return useMutation({
        mutationFn: (input: { text: string; folder?: string; name?: string }) =>
            appendText(client, { ...input, idempotencyKey: idempotencyKey() }),
    });
}
